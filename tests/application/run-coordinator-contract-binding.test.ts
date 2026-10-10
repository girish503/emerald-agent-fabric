import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
} from "../../src/domain/index.js";
import {
  AmbiguousContractAuthorityError,
  InvalidMissionContractError,
  InvalidRunError,
  MissionContractTaskMismatchError,
  NoActiveMissionContractError,
  ResourceLimitExceededError,
} from "../../src/domain/errors.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

describe("RunCoordinator: MissionContract Resolution & Durable Binding (Task 1.8C-3)", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;

  const sampleTaskId = "task-coord-test-1";
  const now = "2026-10-10T12:00:00.000Z";

  const defaultPolicy = createDefaultInProcessPolicy("policy-coord-1");
  const defaultVerificationSpec = createVerificationSpec({
    specId: "vspec-coord-1",
    ruleKind: "EXACT_OUTPUT_MATCH",
    expectedValue: { status: "success" },
  });

  const createTestContract = (
    taskId = sampleTaskId,
    contractId = "contract-coord-1",
    version = 1,
    limits = { timeoutMs: 30000, maxAttempts: 3, maxOutputBytes: 1048576 }
  ): MissionContract => {
    return createMissionContract({
      contractId,
      version,
      taskId,
      policy: defaultPolicy,
      verificationSpecs: [defaultVerificationSpec],
      resourceLimits: createResourceLimits(limits),
      credentialScopes: ["github:repo:read"],
    });
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-coord-binding-test-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock(now);
    coordinator = new RunCoordinator(store, clock);

    // Register test task
    coordinator.createTask({
      taskId: sampleTaskId,
      title: "Test Task for RunCoordinator Binding",
      description: "Coordination task",
      inputPayload: { query: "test" },
    });
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // =========================================================================
  // Section 13.1 — Contract Resolution Tests (Tests 1–6)
  // =========================================================================
  describe("Contract resolution (Requirements 1–6)", () => {
    it("1. No ACTIVE contract → Run creation rejected", () => {
      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(NoActiveMissionContractError);

      // Verify no Run created
      const queued = store.findQueuedRuns();
      expect(queued).toHaveLength(0);
    });

    it("2. Exactly one ACTIVE contract → Run binds successfully", () => {
      const contract = createTestContract(sampleTaskId, "contract-active-1", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });

      expect(result.run.status).toBe("CREATED");
      expect(result.run.contractBinding).not.toBeNull();
      expect(result.run.contractBinding?.contractId).toBe("contract-active-1");
      expect(result.run.contractBinding?.version).toBe(1);
      expect(result.run.contractBinding?.contentHash).toBe(contract.contentHash);
      expect(result.run.maxOutputBytes).toBe(1048576);
    });

    it("3. Multiple ACTIVE contracts → Run creation fails closed", () => {
      // Create a scenario with multiple ACTIVE contracts for the same task
      // In SQLite, bypass the partial unique index using a raw table without index to simulate corrupted/concurrent state
      const rawDb = new NodeDatabaseSync(":memory:");
      rawDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, description TEXT, input_payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE workers (worker_id TEXT PRIMARY KEY, hostname TEXT, pid INTEGER, status TEXT, last_heartbeat_at TEXT, created_at TEXT);
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL, version INTEGER NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
          content_hash TEXT NOT NULL, canonical_spec TEXT NOT NULL, created_at TEXT NOT NULL,
          activated_at TEXT, revoked_at TEXT, revocation_reason TEXT, PRIMARY KEY(contract_id, version)
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT UNIQUE,
          current_worker_id TEXT, lease_id TEXT, lease_expires_at TEXT, attempt_count INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3, timeout_ms INTEGER DEFAULT 30000, result_payload TEXT, error_payload TEXT,
          version INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          contract_id TEXT, contract_version INTEGER, contract_hash TEXT, max_output_bytes INTEGER
        );
        CREATE TABLE run_events (
          event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL,
          event_type TEXT NOT NULL, schema_version INTEGER DEFAULT 1, producer TEXT NOT NULL, payload TEXT NOT NULL
        );
        INSERT INTO tasks VALUES ('${sampleTaskId}', 'Task', '', '{}', '${now}', '${now}');
      `);

      const c1 = createTestContract(sampleTaskId, "c-ambig-1", 1);
      const c2 = createTestContract(sampleTaskId, "c-ambig-2", 1);

      rawDb.prepare(`
        INSERT INTO mission_contracts VALUES ('c-ambig-1', 1, '${sampleTaskId}', 'ACTIVE', ?, ?, '${now}', '${now}', null, null)
      `).run(c1.contentHash, JSON.stringify(c1.spec));

      rawDb.prepare(`
        INSERT INTO mission_contracts VALUES ('c-ambig-2', 1, '${sampleTaskId}', 'ACTIVE', ?, ?, '${now}', '${now}', null, null)
      `).run(c2.contentHash, JSON.stringify(c2.spec));

      const corruptStore = new SqliteStateStore(rawDb);
      const corruptCoordinator = new RunCoordinator(corruptStore, clock);

      expect(() => {
        corruptCoordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(AmbiguousContractAuthorityError);
    });

    it("4. DRAFT contract ignored", () => {
      const contract = createTestContract(sampleTaskId, "contract-draft-only", 1);
      store.insertContract(contract);
      // Contract remains in DRAFT

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(NoActiveMissionContractError);
    });

    it("5. REVOKED contract ignored", () => {
      const contract = createTestContract(sampleTaskId, "contract-rev-only", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Deprecation");

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(NoActiveMissionContractError);
    });

    it("6. Contract belonging to another task rejected", () => {
      const otherTaskId = "task-other-task-6";
      coordinator.createTask({
        taskId: otherTaskId,
        title: "Other Task",
        inputPayload: {},
      });

      // Activate contract only for otherTaskId
      const contractOther = createTestContract(otherTaskId, "contract-other", 1);
      store.insertContract(contractOther);
      store.activateContract(contractOther.spec.contractId, contractOther.spec.version);

      // Attempt createRun for sampleTaskId
      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(NoActiveMissionContractError);
    });
  });

  // =========================================================================
  // Section 13.2 — Exact Binding Tests (Tests 7–11)
  // =========================================================================
  describe("Exact binding (Requirements 7–11)", () => {
    it("7. Run contains exact contractId", () => {
      const contract = createTestContract(sampleTaskId, "contract-exact-id-7", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });
      expect(result.run.contractBinding?.contractId).toBe("contract-exact-id-7");
    });

    it("8. Run contains exact version", () => {
      const contract = createTestContract(sampleTaskId, "contract-ver-8", 5);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });
      expect(result.run.contractBinding?.version).toBe(5);
    });

    it("9. Run contains exact contentHash", () => {
      const contract = createTestContract(sampleTaskId, "contract-hash-9", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });
      expect(result.run.contractBinding?.contentHash).toBe(contract.contentHash);
    });

    it("10. Run event contains exact binding", () => {
      const contract = createTestContract(sampleTaskId, "contract-event-10", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });
      const eventPayload = result.event.payload as {
        contractBinding: { contractId: string; version: number; contentHash: string };
        maxOutputBytes: number;
        maxAttempts: number;
        timeoutMs: number;
      };

      expect(eventPayload.contractBinding).toBeDefined();
      expect(eventPayload.contractBinding.contractId).toBe("contract-event-10");
      expect(eventPayload.contractBinding.version).toBe(1);
      expect(eventPayload.contractBinding.contentHash).toBe(contract.contentHash);
      expect(eventPayload.maxOutputBytes).toBe(1048576);
      expect(eventPayload.maxAttempts).toBe(3);
      expect(eventPayload.timeoutMs).toBe(30000);
    });

    it("11. Run binding survives persistence round-trip", () => {
      const contract = createTestContract(sampleTaskId, "contract-survive-11", 2);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });
      const loaded = store.getRun(result.run.runId);

      expect(loaded).not.toBeNull();
      expect(loaded?.contractBinding?.contractId).toBe("contract-survive-11");
      expect(loaded?.contractBinding?.version).toBe(2);
      expect(loaded?.contractBinding?.contentHash).toBe(contract.contentHash);
      expect(loaded?.maxOutputBytes).toBe(1048576);
    });
  });

  // =========================================================================
  // Section 13.3 — Resource Limits Tests (Tests 12–19)
  // =========================================================================
  describe("Resource limits governance (Requirements 12–19)", () => {
    it("12. Omitted requested limits inherit contract ceilings", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-12", 1, {
        timeoutMs: 45000,
        maxAttempts: 5,
        maxOutputBytes: 2097152,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId });
      expect(result.run.timeoutMs).toBe(45000);
      expect(result.run.maxAttempts).toBe(5);
      expect(result.run.maxOutputBytes).toBe(2097152);
    });

    it("13. Narrower timeout accepted", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-13", 1, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId, timeoutMs: 15000 });
      expect(result.run.timeoutMs).toBe(15000);
    });

    it("14. Narrower maxAttempts accepted", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-14", 1, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId, maxAttempts: 2 });
      expect(result.run.maxAttempts).toBe(2);
    });

    it("15. Narrower maxOutputBytes accepted", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-15", 1, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const result = coordinator.createRun({ taskId: sampleTaskId, maxOutputBytes: 65536 });
      expect(result.run.maxOutputBytes).toBe(65536);
    });

    it("16. Timeout above contract ceiling rejected", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-16", 1, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, timeoutMs: 35000 });
      }).toThrow(ResourceLimitExceededError);
    });

    it("17. maxAttempts above ceiling rejected", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-17", 1, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, maxAttempts: 4 });
      }).toThrow(ResourceLimitExceededError);
    });

    it("18. maxOutputBytes above ceiling rejected", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-18", 1, {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      });
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, maxOutputBytes: 2000000 });
      }).toThrow(ResourceLimitExceededError);
    });

    it("19. Zero/negative requested values rejected according to existing domain rules", () => {
      const contract = createTestContract(sampleTaskId, "contract-limits-19", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, timeoutMs: 0 });
      }).toThrow(InvalidRunError);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, timeoutMs: -100 });
      }).toThrow(InvalidRunError);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, maxAttempts: 0 });
      }).toThrow(InvalidRunError);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, maxAttempts: -2 });
      }).toThrow(InvalidRunError);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, maxOutputBytes: 0 });
      }).toThrow(InvalidRunError);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, maxOutputBytes: -500 });
      }).toThrow(InvalidRunError);
    });
  });

  // =========================================================================
  // Section 13.4 — Atomicity Tests (Tests 20–24)
  // =========================================================================
  describe("Transaction atomicity (Requirements 20–24)", () => {
    it("20. Contract resolution failure creates no Run", () => {
      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(NoActiveMissionContractError);

      expect(store.findQueuedRuns()).toHaveLength(0);
    });

    it("21. Resource validation failure creates no Run", () => {
      const contract = createTestContract(sampleTaskId, "contract-atom-21", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId, timeoutMs: 999999 });
      }).toThrow(ResourceLimitExceededError);

      expect(store.findQueuedRuns()).toHaveLength(0);
    });

    it("22. Contract integrity failure creates no Run", () => {
      const contract = createTestContract(sampleTaskId, "contract-atom-22", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      // Tamper with contract spec in database
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.prepare("UPDATE mission_contracts SET canonical_spec = '{\"tampered\":true}' WHERE contract_id = ?").run(
        contract.spec.contractId
      );

      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(InvalidMissionContractError);

      expect(store.findQueuedRuns()).toHaveLength(0);
    });

    it("23. Task mismatch creates no Run", () => {
      // Direct raw database setup with mismatched taskId
      const rawDb = new NodeDatabaseSync(":memory:");
      rawDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, description TEXT, input_payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE workers (worker_id TEXT PRIMARY KEY, hostname TEXT, pid INTEGER, status TEXT, last_heartbeat_at TEXT, created_at TEXT);
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL, version INTEGER NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
          content_hash TEXT NOT NULL, canonical_spec TEXT NOT NULL, created_at TEXT NOT NULL,
          activated_at TEXT, revoked_at TEXT, revocation_reason TEXT, PRIMARY KEY(contract_id, version)
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT UNIQUE,
          current_worker_id TEXT, lease_id TEXT, lease_expires_at TEXT, attempt_count INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3, timeout_ms INTEGER DEFAULT 30000, result_payload TEXT, error_payload TEXT,
          version INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          contract_id TEXT, contract_version INTEGER, contract_hash TEXT, max_output_bytes INTEGER
        );
        CREATE TABLE run_events (
          event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL,
          event_type TEXT NOT NULL, schema_version INTEGER DEFAULT 1, producer TEXT NOT NULL, payload TEXT NOT NULL
        );
        INSERT INTO tasks VALUES ('${sampleTaskId}', 'Task', '', '{}', '${now}', '${now}');
      `);

      // Contract spec has taskId 'other-task' but row was inserted with sampleTaskId
      const mismatchedContract = createTestContract("other-task", "c-mismatch", 1);
      rawDb.prepare(`
        INSERT INTO mission_contracts VALUES ('c-mismatch', 1, '${sampleTaskId}', 'ACTIVE', ?, ?, '${now}', '${now}', null, null)
      `).run(mismatchedContract.contentHash, JSON.stringify(mismatchedContract.spec));

      const mismatchStore = new SqliteStateStore(rawDb);
      const mismatchCoordinator = new RunCoordinator(mismatchStore, clock);

      expect(() => {
        mismatchCoordinator.createRun({ taskId: sampleTaskId });
      }).toThrow(MissionContractTaskMismatchError);

      expect(mismatchStore.findQueuedRuns()).toHaveLength(0);
    });

    it("24. run.created is not persisted without Run", () => {
      expect(() => {
        coordinator.createRun({ taskId: sampleTaskId });
      }).toThrow();

      const db = (store as unknown as { db: DatabaseSync }).db;
      const count = (
        db.prepare("SELECT COUNT(*) AS cnt FROM run_events").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // Section 13.5 — Idempotency Tests (Tests 25–26)
  // =========================================================================
  describe("Idempotency (Requirements 25–26)", () => {
    it("25. Repeated same idempotency key does not create duplicate Run", () => {
      const contract = createTestContract(sampleTaskId, "contract-idem-25", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      const r1 = coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "key-idem-25" });
      const r2 = coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "key-idem-25" });

      expect(r1.run.runId).toBe(r2.run.runId);

      const db = (store as unknown as { db: DatabaseSync }).db;
      const count = (
        db.prepare("SELECT COUNT(*) AS cnt FROM runs").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });

    it("26. Repeated request does not create duplicate event", () => {
      const contract = createTestContract(sampleTaskId, "contract-idem-26", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "key-idem-26" });
      coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "key-idem-26" });

      const db = (store as unknown as { db: DatabaseSync }).db;
      const count = (
        db.prepare("SELECT COUNT(*) AS cnt FROM run_events").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // Section 14 — Concurrency Test (Test 27)
  // =========================================================================
  describe("Concurrency Invariant (Requirement 27)", () => {
    it("27. Concurrent attempts to create a Run for a task with one ACTIVE contract bind identical governance authority", () => {
      const contract = createTestContract(sampleTaskId, "contract-concurrent-27", 1);
      store.insertContract(contract);
      store.activateContract(contract.spec.contractId, contract.spec.version);

      // Execute multiple sequential and pseudo-concurrent run creation calls
      const runs = [
        coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "conc-run-1" }),
        coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "conc-run-2" }),
        coordinator.createRun({ taskId: sampleTaskId, idempotencyKey: "conc-run-3" }),
      ];

      for (const { run } of runs) {
        expect(run.contractBinding).not.toBeNull();
        expect(run.contractBinding?.contractId).toBe("contract-concurrent-27");
        expect(run.contractBinding?.version).toBe(1);
        expect(run.contractBinding?.contentHash).toBe(contract.contentHash);
        expect(run.maxOutputBytes).toBe(1048576);
      }
    });
  });
});
