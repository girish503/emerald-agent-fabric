import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  migrateDatabase,
  MigrationConflictError,
} from "../../src/adapters/persistence/schema.js";
import {
  ContractIntegrityError,
  InvalidMissionContractError,
  InvalidRunError,
} from "../../src/domain/errors.js";
import {
  createContractBinding,
  createDefaultInProcessPolicy,
  createMissionContract,
  createResourceLimits,
  createVerificationSpec,
  MissionContract,
  Run,
} from "../../src/domain/index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

describe("Run → MissionContract Persistence Binding (Task 1.8C-2)", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let eventSeq = 0;

  const sampleTaskId = "task-persist-binding-1";
  const now = "2026-10-10T12:00:00.000Z";
  const mockEventIdGen = () => `event-persist-${++eventSeq}`;

  const defaultPolicy = createDefaultInProcessPolicy("policy-binding-1");
  const defaultLimits = createResourceLimits({
    timeoutMs: 30000,
    maxAttempts: 3,
    maxOutputBytes: 1048576,
  });
  const defaultVerificationSpec = createVerificationSpec({
    specId: "vspec-binding-1",
    ruleKind: "EXACT_OUTPUT_MATCH",
    expectedValue: { status: "success" },
  });

  const createTestContract = (
    contractId = "contract-binding-1",
    version = 1,
    taskId = sampleTaskId
  ): MissionContract => {
    return createMissionContract({
      contractId,
      version,
      taskId,
      policy: defaultPolicy,
      verificationSpecs: [defaultVerificationSpec],
      resourceLimits: defaultLimits,
      credentialScopes: ["github:repo:read"],
    });
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-run-binding-test-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    // Seed task and worker
    store.transaction((tx) => {
      tx.insertTask({
        taskId: sampleTaskId,
        title: "Test Task for Run Contract Binding",
        description: "Task used for binding persistence tests",
        inputPayload: { query: "test" },
        createdAt: now,
        updatedAt: now,
      });
      tx.insertWorker({
        workerId: "w-1",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: now,
        createdAt: now,
      });
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
  // Section 14.1 — Fresh Schema Tests (Tests 1–7)
  // =========================================================================
  describe("Fresh schema (Requirements 1–7)", () => {
    it("1. Fresh database contains MissionContract table", () => {
      const db = createSqliteClient({ location: dbPath });
      try {
        const tableRow = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_contracts'")
          .get() as { name: string } | undefined;
        expect(tableRow).toBeDefined();
        expect(tableRow?.name).toBe("mission_contracts");
      } finally {
        db.close();
      }
    });

    it("2. Fresh database contains Run governance columns", () => {
      const db = createSqliteClient({ location: dbPath });
      try {
        const columns = db
          .prepare("PRAGMA table_info(runs)")
          .all() as unknown as { name: string; type: string; notnull: number }[];

        const colMap = new Map(columns.map((c) => [c.name, c]));
        expect(colMap.has("contract_id")).toBe(true);
        expect(colMap.get("contract_id")?.type).toBe("TEXT");
        expect(colMap.get("contract_id")?.notnull).toBe(0);

        expect(colMap.has("contract_version")).toBe(true);
        expect(colMap.get("contract_version")?.type).toBe("INTEGER");
        expect(colMap.get("contract_version")?.notnull).toBe(0);

        expect(colMap.has("contract_hash")).toBe(true);
        expect(colMap.get("contract_hash")?.type).toBe("TEXT");
        expect(colMap.get("contract_hash")?.notnull).toBe(0);

        expect(colMap.has("max_output_bytes")).toBe(true);
        expect(colMap.get("max_output_bytes")?.type).toBe("INTEGER");
        expect(colMap.get("max_output_bytes")?.notnull).toBe(0);
      } finally {
        db.close();
      }
    });

    it("3. Composite Run → MissionContract foreign key exists", () => {
      const db = createSqliteClient({ location: dbPath });
      try {
        const fkList = db
          .prepare("PRAGMA foreign_key_list(runs)")
          .all() as unknown as { table: string; from: string; to: string }[];

        const contractFks = fkList.filter((fk) => fk.table === "mission_contracts");
        expect(contractFks.length).toBe(2);

        const fromCols = contractFks.map((fk) => fk.from).sort();
        const toCols = contractFks.map((fk) => fk.to).sort();

        expect(fromCols).toEqual(["contract_id", "contract_version"]);
        expect(toCols).toEqual(["contract_id", "version"]);
      } finally {
        db.close();
      }
    });

    it("4. Partial unique ACTIVE index exists", () => {
      const db = createSqliteClient({ location: dbPath });
      try {
        const indexRow = db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_contracts_task_active'"
          )
          .get() as { name: string; sql: string } | undefined;

        expect(indexRow).toBeDefined();
        expect(indexRow?.name).toBe("idx_contracts_task_active");
        expect(indexRow?.sql).toMatch(/CREATE UNIQUE INDEX/i);
        expect(indexRow?.sql).toMatch(/WHERE status = 'ACTIVE'/i);
      } finally {
        db.close();
      }
    });

    it("5. Multiple DRAFT contracts allowed for the same task", () => {
      const c1 = createTestContract("contract-draft-1", 1, sampleTaskId);
      const c2 = createTestContract("contract-draft-2", 1, sampleTaskId);

      store.insertContract(c1);
      store.insertContract(c2);

      const r1 = store.getContract(c1.spec.contractId, c1.spec.version);
      const r2 = store.getContract(c2.spec.contractId, c2.spec.version);

      expect(r1?.lifecycle.status).toBe("DRAFT");
      expect(r2?.lifecycle.status).toBe("DRAFT");
    });

    it("6. Multiple REVOKED contracts allowed for the same task", () => {
      const c1 = createTestContract("contract-rev-1", 1, sampleTaskId);
      const c2 = createTestContract("contract-rev-2", 1, sampleTaskId);

      store.insertContract(c1);
      store.activateContract(c1.spec.contractId, c1.spec.version);
      store.revokeContract(c1.spec.contractId, c1.spec.version, "Revoking c1");

      store.insertContract(c2);
      store.activateContract(c2.spec.contractId, c2.spec.version);
      store.revokeContract(c2.spec.contractId, c2.spec.version, "Revoking c2");

      const r1 = store.getContract(c1.spec.contractId, c1.spec.version);
      const r2 = store.getContract(c2.spec.contractId, c2.spec.version);

      expect(r1?.lifecycle.status).toBe("REVOKED");
      expect(r2?.lifecycle.status).toBe("REVOKED");
    });

    it("7. Second ACTIVE contract for same task rejected by partial unique index", () => {
      const c1 = createTestContract("contract-act-1", 1, sampleTaskId);
      const c2 = createTestContract("contract-act-2", 1, sampleTaskId);

      store.insertContract(c1);
      store.activateContract(c1.spec.contractId, c1.spec.version);

      store.insertContract(c2);
      expect(() => {
        store.activateContract(c2.spec.contractId, c2.spec.version);
      }).toThrow(/UNIQUE constraint failed/i);
    });
  });

  // =========================================================================
  // Section 14.2 — Run Binding Persistence Round-Trip Tests (Tests 8–12)
  // =========================================================================
  describe("Run binding persistence (Requirements 8–12)", () => {
    it("8. Governed Run round-trips through SQLite with exact binding", () => {
      const contract = createTestContract("contract-roundtrip", 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-roundtrip-1",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 524288,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      const loaded = store.getRun("run-roundtrip-1");
      expect(loaded).not.toBeNull();
      expect(loaded?.contractBinding).toEqual(binding);
      expect(loaded?.maxOutputBytes).toBe(524288);
    });

    it("9. maxOutputBytes round-trips exactly across distinct numeric values", () => {
      const contract = createTestContract("contract-mob-test", 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      const values = [1024, 65536, 1048576, 16777216];
      for (const maxBytes of values) {
        const runId = `run-mob-${maxBytes}`;
        const { run, event } = Run.create({
          runId,
          taskId: sampleTaskId,
          contractBinding: binding,
          maxOutputBytes: maxBytes,
          now,
          eventIdGenerator: mockEventIdGen,
        });

        store.transaction((tx) => tx.insertRun(run.snapshot, event));
        const loaded = store.getRun(runId);
        expect(loaded?.maxOutputBytes).toBe(maxBytes);
      }
    });

    it("10. contractId round-trips exactly", () => {
      const exactContractId = "mission-contract-uuid-exact-10";
      const contract = createTestContract(exactContractId, 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: exactContractId,
        version: 1,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-cid-exact",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));
      const loaded = store.getRun("run-cid-exact");
      expect(loaded?.contractBinding?.contractId).toBe(exactContractId);
    });

    it("11. contractVersion round-trips exactly", () => {
      const contract = createTestContract("contract-ver-test", 42, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: "contract-ver-test",
        version: 42,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-ver-exact",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));
      const loaded = store.getRun("run-ver-exact");
      expect(loaded?.contractBinding?.version).toBe(42);
    });

    it("12. contractHash round-trips exactly", () => {
      const contract = createTestContract("contract-hash-test", 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-hash-exact",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));
      const loaded = store.getRun("run-hash-exact");
      expect(loaded?.contractBinding?.contentHash).toBe(contract.contentHash);
    });
  });

  // =========================================================================
  // Section 14.3 — Legacy Compatibility Tests (Tests 13–16)
  // =========================================================================
  describe("Legacy compatibility (Requirements 13–16)", () => {
    it("13. Legacy Run with all four columns NULL loads successfully", () => {
      const { run, event } = Run.create({
        runId: "run-legacy-all-null",
        taskId: sampleTaskId,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      const loaded = store.getRun("run-legacy-all-null");
      expect(loaded).not.toBeNull();
      expect(loaded?.contractBinding).toBeNull();
      expect(loaded?.maxOutputBytes).toBeNull();
    });

    it("14. Legacy terminal Run remains readable", () => {
      const { run, event } = Run.create({
        runId: "run-legacy-terminal",
        taskId: sampleTaskId,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      // Transition to terminal state COMPLETED
      const qEvent = run.queue(now);
      store.transaction((tx) => tx.updateRun(run.runId, 1, run.snapshot, qEvent));

      const cEvent = run.claim("w-1", "l-1", "2026-10-10T12:05:00.000Z", now);
      store.transaction((tx) => tx.updateRun(run.runId, 2, run.snapshot, cEvent));

      const sEvent = run.start("w-1", "l-1", now);
      store.transaction((tx) => tx.updateRun(run.runId, 3, run.snapshot, sEvent));

      const doneEvent = run.complete("w-1", "l-1", { result: "finished" }, now);
      store.transaction((tx) => tx.updateRun(run.runId, 4, run.snapshot, doneEvent));

      const loaded = store.getRun("run-legacy-terminal");
      expect(loaded?.status).toBe("COMPLETED");
      expect(loaded?.contractBinding).toBeNull();
      expect(loaded?.maxOutputBytes).toBeNull();
      expect(loaded?.resultPayload).toEqual({ result: "finished" });
    });

    it("15. No synthetic contract is created when loading legacy Runs", () => {
      const db = createSqliteClient({ location: dbPath });
      try {
        const countBefore = (
          db.prepare("SELECT COUNT(*) AS cnt FROM mission_contracts").get() as { cnt: number }
        ).cnt;

        const { run, event } = Run.create({
          runId: "run-legacy-no-synth-contract",
          taskId: sampleTaskId,
          now,
          eventIdGenerator: mockEventIdGen,
        });
        store.transaction((tx) => tx.insertRun(run.snapshot, event));

        // Load the legacy run
        const loaded = store.getRun("run-legacy-no-synth-contract");
        expect(loaded?.contractBinding).toBeNull();

        const countAfter = (
          db.prepare("SELECT COUNT(*) AS cnt FROM mission_contracts").get() as { cnt: number }
        ).cnt;
        expect(countAfter).toBe(countBefore);
      } finally {
        db.close();
      }
    });

    it("16. No synthetic output limit is created when loading legacy Runs", () => {
      const { run, event } = Run.create({
        runId: "run-legacy-no-synth-limit",
        taskId: sampleTaskId,
        now,
        eventIdGenerator: mockEventIdGen,
      });
      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      const loaded = store.getRun("run-legacy-no-synth-limit");
      expect(loaded?.maxOutputBytes).toBeNull();
      expect(loaded?.maxOutputBytes).not.toBe(0);
      expect(loaded?.maxOutputBytes).not.toBe(1048576);
    });
  });

  // =========================================================================
  // Section 14.4 — Malformed Binding Tests (Tests 17–20)
  // =========================================================================
  describe("Malformed binding (Requirements 17–20)", () => {
    it("17. Partial binding columns fail closed", () => {
      const db = createSqliteClient({ location: dbPath });
      try {
        // Direct SQL insert violating check constraint: contract_id set, others NULL
        expect(() => {
          db.prepare(`
            INSERT INTO runs (
              run_id, task_id, status, version, created_at, updated_at,
              contract_id, contract_version, contract_hash, max_output_bytes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run("run-mal-1", sampleTaskId, "CREATED", 1, now, now, "c-1", null, null, null);
        }).toThrow(/CHECK constraint failed/i);

        // Bypassing CHECK constraint by dropping or modifying table: test mapper fails closed
        // Let's verify mapRunRowToSnapshot fails closed if partial binding exists in DB
        const rawDb = new NodeDatabaseSync(":memory:");
        rawDb.exec(`
          CREATE TABLE runs (
            run_id TEXT PRIMARY KEY, task_id TEXT, status TEXT, version INTEGER,
            attempt_count INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, timeout_ms INTEGER DEFAULT 30000,
            idempotency_key TEXT, current_worker_id TEXT, lease_id TEXT, lease_expires_at TEXT,
            result_payload TEXT, error_payload TEXT, created_at TEXT, updated_at TEXT,
            contract_id TEXT, contract_version INTEGER, contract_hash TEXT, max_output_bytes INTEGER
          );
          INSERT INTO runs (
            run_id, task_id, status, version, created_at, updated_at,
            contract_id, contract_version, contract_hash, max_output_bytes
          ) VALUES ('run-mal-mapper', '${sampleTaskId}', 'CREATED', 1, '${now}', '${now}', 'c-1', 1, null, null);
        `);
        const malStore = new SqliteStateStore(rawDb);
        expect(() => {
          malStore.getRun("run-mal-mapper");
        }).toThrow(InvalidRunError);
      } finally {
        db.close();
      }
    });

    it("18. Invalid contract version fails closed", () => {
      const rawDb = new NodeDatabaseSync(":memory:");
      rawDb.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, task_id TEXT, status TEXT, version INTEGER,
          attempt_count INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, timeout_ms INTEGER DEFAULT 30000,
          idempotency_key TEXT, current_worker_id TEXT, lease_id TEXT, lease_expires_at TEXT,
          result_payload TEXT, error_payload TEXT, created_at TEXT, updated_at TEXT,
          contract_id TEXT, contract_version INTEGER, contract_hash TEXT, max_output_bytes INTEGER
        );
        INSERT INTO runs (
          run_id, task_id, status, version, created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES ('run-inv-ver', '${sampleTaskId}', 'CREATED', 1, '${now}', '${now}', 'c-1', 0, '${"a".repeat(64)}', 1024);
      `);
      const malStore = new SqliteStateStore(rawDb);
      expect(() => {
        malStore.getRun("run-inv-ver");
      }).toThrow(InvalidRunError);
    });

    it("19. Invalid hash fails closed", () => {
      const rawDb = new NodeDatabaseSync(":memory:");
      rawDb.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, task_id TEXT, status TEXT, version INTEGER,
          attempt_count INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, timeout_ms INTEGER DEFAULT 30000,
          idempotency_key TEXT, current_worker_id TEXT, lease_id TEXT, lease_expires_at TEXT,
          result_payload TEXT, error_payload TEXT, created_at TEXT, updated_at TEXT,
          contract_id TEXT, contract_version INTEGER, contract_hash TEXT, max_output_bytes INTEGER
        );
        INSERT INTO runs (
          run_id, task_id, status, version, created_at, updated_at,
          contract_id, contract_version, contract_hash, max_output_bytes
        ) VALUES ('run-inv-hash', '${sampleTaskId}', 'CREATED', 1, '${now}', '${now}', 'c-1', 1, 'bad-not-64-hex', 1024);
      `);
      const malStore = new SqliteStateStore(rawDb);
      expect(() => {
        malStore.getRun("run-inv-hash");
      }).toThrow(InvalidRunError);
    });

    it("20. Missing referenced contract fails closed where FK enforcement applies", () => {
      const binding = createContractBinding({
        contractId: "non-existent-contract",
        version: 1,
        contentHash: "a".repeat(64),
      });

      const { run, event } = Run.create({
        runId: "run-fk-missing-contract",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      expect(() => {
        store.transaction((tx) => tx.insertRun(run.snapshot, event));
      }).toThrow(/FOREIGN KEY constraint failed/i);
    });
  });

  // =========================================================================
  // Section 14.5 — Integrity Tests (Tests 21–23)
  // =========================================================================
  describe("Integrity (Requirements 21–23)", () => {
    it("21. Run hash matching MissionContract hash loads successfully", () => {
      const contract = createTestContract("contract-integ-match", 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-integ-match",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      const loaded = store.getRun("run-integ-match");
      expect(loaded).not.toBeNull();
      expect(loaded?.contractBinding?.contentHash).toBe(contract.contentHash);
    });

    it("22. Tampered Run hash fails closed", () => {
      const contract = createTestContract("contract-tamper-hash", 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-tamper-hash",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      // Directly tamper with contract_hash in the database
      const db = createSqliteClient({ location: dbPath });
      try {
        const tamperedHash = "f".repeat(64);
        db.prepare("UPDATE runs SET contract_hash = ? WHERE run_id = ?").run(
          tamperedHash,
          "run-tamper-hash"
        );
      } finally {
        db.close();
      }

      // Loading should fail closed with ContractIntegrityError
      expect(() => {
        store.getRun("run-tamper-hash");
      }).toThrow(ContractIntegrityError);
    });

    it("23. Tampered MissionContract canonical spec fails closed through reconstitution/hash verification", () => {
      const contract = createTestContract("contract-tamper-spec", 1, sampleTaskId);
      store.insertContract(contract);

      const binding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      const { run, event } = Run.create({
        runId: "run-tamper-spec",
        taskId: sampleTaskId,
        contractBinding: binding,
        maxOutputBytes: 1048576,
        now,
        eventIdGenerator: mockEventIdGen,
      });

      store.transaction((tx) => tx.insertRun(run.snapshot, event));

      // Directly tamper with canonical_spec in mission_contracts table
      const db = createSqliteClient({ location: dbPath });
      try {
        const tamperedSpec = {
          ...contract.spec,
          resourceLimits: {
            ...contract.spec.resourceLimits,
            maxAttempts: 999, // tampered value
          },
        };
        db.prepare("UPDATE mission_contracts SET canonical_spec = ? WHERE contract_id = ?").run(
          JSON.stringify(tamperedSpec),
          contract.spec.contractId
        );
      } finally {
        db.close();
      }

      // Loading should fail closed when reconstituting the tampered contract
      expect(() => {
        store.getRun("run-tamper-spec");
      }).toThrow(InvalidMissionContractError);
    });
  });

  // =========================================================================
  // Section 14.6 — Migration Tests (Tests 24–29)
  // =========================================================================
  describe("Migration (Requirements 24–29)", () => {
    it("24. Existing database receives new columns without modifying legacy values", () => {
      const legacyDbPath = path.join(tempDir, "legacy-migration.db");
      const legacyDb = new NodeDatabaseSync(legacyDbPath);

      // Create pre-1.8C schema (without the 4 governance columns on runs)
      legacyDb.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          input_payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          status TEXT NOT NULL,
          idempotency_key TEXT UNIQUE,
          current_worker_id TEXT,
          lease_id TEXT,
          lease_expires_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          timeout_ms INTEGER NOT NULL DEFAULT 30000,
          result_payload TEXT,
          error_payload TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO tasks (task_id, title, description, input_payload, created_at, updated_at)
        VALUES ('task-mig-1', 'Legacy Task', '', '{}', '${now}', '${now}');

        INSERT INTO runs (
          run_id, task_id, status, idempotency_key, attempt_count, max_attempts, timeout_ms,
          result_payload, error_payload, version, created_at, updated_at
        ) VALUES (
          'run-mig-legacy-1', 'task-mig-1', 'COMPLETED', 'idem-1', 1, 3, 30000,
          '{"out":"legacy"}', null, 5, '${now}', '${now}'
        );
      `);

      // Run migration
      migrateDatabase(legacyDb);

      // Check table columns
      const tableInfo = legacyDb.prepare("PRAGMA table_info(runs)").all() as unknown as {
        name: string;
      }[];
      const columnNames = tableInfo.map((c) => c.name);
      expect(columnNames).toContain("contract_id");
      expect(columnNames).toContain("contract_version");
      expect(columnNames).toContain("contract_hash");
      expect(columnNames).toContain("max_output_bytes");

      // Verify legacy row data is preserved and new columns are null
      const row = legacyDb.prepare("SELECT * FROM runs WHERE run_id = 'run-mig-legacy-1'").get() as {
        run_id: string;
        task_id: string;
        status: string;
        attempt_count: number;
        result_payload: string;
        contract_id: unknown;
        contract_version: unknown;
        contract_hash: unknown;
        max_output_bytes: unknown;
      };

      expect(row.run_id).toBe("run-mig-legacy-1");
      expect(row.status).toBe("COMPLETED");
      expect(row.attempt_count).toBe(1);
      expect(row.result_payload).toBe('{"out":"legacy"}');
      expect(row.contract_id).toBeNull();
      expect(row.contract_version).toBeNull();
      expect(row.contract_hash).toBeNull();
      expect(row.max_output_bytes).toBeNull();

      legacyDb.close();
    });

    it("25. Migration is idempotent", () => {
      const migDbPath = path.join(tempDir, "idempotent-migration.db");
      const migDb = createSqliteClient({ location: migDbPath });

      // Run migration multiple times consecutively
      expect(() => {
        migrateDatabase(migDb);
        migrateDatabase(migDb);
        migrateDatabase(migDb);
      }).not.toThrow();

      migDb.close();
    });

    it("26. Duplicate ACTIVE contracts cause migration failure", () => {
      const conflictDbPath = path.join(tempDir, "conflict-migration.db");
      const conflictDb = new NodeDatabaseSync(conflictDbPath);

      // Create pre-1.8C database with duplicate ACTIVE contracts for the same task
      conflictDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, description TEXT, input_payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          canonical_spec TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          revoked_at TEXT,
          revocation_reason TEXT,
          PRIMARY KEY(contract_id, version)
        );
        INSERT INTO tasks VALUES ('task-dup', 'Task', '', '{}', '${now}', '${now}');
        INSERT INTO mission_contracts VALUES ('c1', 1, 'task-dup', 'ACTIVE', 'h1', '{}', '${now}', '${now}', null, null);
        INSERT INTO mission_contracts VALUES ('c2', 2, 'task-dup', 'ACTIVE', 'h2', '{}', '${now}', '${now}', null, null);
      `);

      expect(() => {
        migrateDatabase(conflictDb);
      }).toThrow(MigrationConflictError);

      conflictDb.close();
    });

    it("27. Migration does NOT auto-revoke duplicate contracts", () => {
      const conflictDbPath = path.join(tempDir, "no-auto-revoke.db");
      const conflictDb = new NodeDatabaseSync(conflictDbPath);

      conflictDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, description TEXT, input_payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          canonical_spec TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          revoked_at TEXT,
          revocation_reason TEXT,
          PRIMARY KEY(contract_id, version)
        );
        INSERT INTO tasks VALUES ('task-dup', 'Task', '', '{}', '${now}', '${now}');
        INSERT INTO mission_contracts VALUES ('c1', 1, 'task-dup', 'ACTIVE', 'h1', '{}', '${now}', '${now}', null, null);
        INSERT INTO mission_contracts VALUES ('c2', 2, 'task-dup', 'ACTIVE', 'h2', '{}', '${now}', '${now}', null, null);
      `);

      try {
        migrateDatabase(conflictDb);
      } catch (err) {
        expect(err).toBeInstanceOf(MigrationConflictError);
      }

      // Verify neither contract was mutated or revoked
      const rows = conflictDb.prepare("SELECT contract_id, status FROM mission_contracts").all() as unknown as {
        contract_id: string;
        status: string;
      }[];

      expect(rows).toHaveLength(2);
      expect(rows[0]?.status).toBe("ACTIVE");
      expect(rows[1]?.status).toBe("ACTIVE");

      conflictDb.close();
    });

    it("28. Migration does NOT select latest/highest contract", () => {
      const conflictDbPath = path.join(tempDir, "no-highest-selection.db");
      const conflictDb = new NodeDatabaseSync(conflictDbPath);

      conflictDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, description TEXT, input_payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          canonical_spec TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          revoked_at TEXT,
          revocation_reason TEXT,
          PRIMARY KEY(contract_id, version)
        );
        INSERT INTO tasks VALUES ('task-dup', 'Task', '', '{}', '${now}', '${now}');
        INSERT INTO mission_contracts VALUES ('c1', 1, 'task-dup', 'ACTIVE', 'h1', '{}', '${now}', '${now}', null, null);
        INSERT INTO mission_contracts VALUES ('c1', 2, 'task-dup', 'ACTIVE', 'h2', '{}', '${now}', '${now}', null, null);
      `);

      try {
        migrateDatabase(conflictDb);
      } catch (err) {
        expect(err).toBeInstanceOf(MigrationConflictError);
      }

      // Both remain exactly as they were; v1 was not demoted and v2 was not chosen as sole ACTIVE
      const rows = conflictDb.prepare("SELECT version, status FROM mission_contracts ORDER BY version ASC").all() as unknown as {
        version: number;
        status: string;
      }[];

      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.status).toBe("ACTIVE");
      expect(rows[1]?.version).toBe(2);
      expect(rows[1]?.status).toBe("ACTIVE");

      conflictDb.close();
    });

    it("29. Partial unique index is created successfully when no duplicates exist", () => {
      const validDbPath = path.join(tempDir, "valid-migration.db");
      const validDb = new NodeDatabaseSync(validDbPath);

      validDb.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, description TEXT, input_payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE mission_contracts (
          contract_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          canonical_spec TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          revoked_at TEXT,
          revocation_reason TEXT,
          PRIMARY KEY(contract_id, version)
        );
        INSERT INTO tasks VALUES ('task-valid', 'Task', '', '{}', '${now}', '${now}');
        INSERT INTO mission_contracts VALUES ('c1', 1, 'task-valid', 'ACTIVE', 'h1', '{}', '${now}', '${now}', null, null);
        INSERT INTO mission_contracts VALUES ('c2', 2, 'task-valid', 'DRAFT', 'h2', '{}', '${now}', null, null, null);
      `);

      // Migration should succeed
      expect(() => {
        migrateDatabase(validDb);
      }).not.toThrow();

      // Verify partial unique index was created
      const indexRow = validDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_contracts_task_active'")
        .get() as { name: string } | undefined;
      expect(indexRow?.name).toBe("idx_contracts_task_active");

      // Verify that attempting to insert a second ACTIVE contract now fails with UNIQUE constraint error
      expect(() => {
        validDb
          .prepare(
            "INSERT INTO mission_contracts VALUES ('c3', 3, 'task-valid', 'ACTIVE', 'h3', '{}', ?, ?, null, null)"
          )
          .run(now, now);
      }).toThrow(/UNIQUE constraint failed/i);

      validDb.close();
    });
  });
});
