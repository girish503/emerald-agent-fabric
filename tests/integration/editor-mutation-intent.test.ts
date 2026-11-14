import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { migrateDatabase } from "../../src/adapters/persistence/schema.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  LineAnchoredEditor,
  LineAnchoredMutationOptions,
} from "../../src/production/repair/line-anchored-editor.js";
import { MutationAuthorityContext } from "../../src/ports/mutation-intent-store.port.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { EditFileToolAdapter } from "../../src/adapters/tools/edit-file.tool-adapter.js";
import { createWorkspaceToolAdapterRegistry } from "../../src/adapters/tools/tool-adapter-registry.factory.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  DigestMismatchError,
  GovernedWamiRequiredError,
  IncompletePriorMutationError,
  LeaseExpiredError,
  LeaseLostError,
  MissingMutationAuthorityError,
  PostWriteVerificationError,
  PreRenameConflictError,
  SnapshotContainmentError,
  SnapshotCreationError,
  ToolCancelledError,
  ToolOutputLimitExceededError,
  ToolPreconditionFailedError,
  ToolWorkspaceBoundaryViolationError,
} from "../../src/domain/errors.js";
import { RunSnapshot } from "../../src/domain/invariants.js";
import { ToolExecutionContext } from "../../src/ports/tool-adapter.port.js";
import { WorkspacePort } from "../../src/ports/workspace.port.js";
import { ProductionToolGateway } from "../../src/tools/production-tools.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { CapabilityFence } from "../../src/domain/capability-fence.js";
import {
  ProductionRepairOrchestrator,
  TestFailureLocalizer,
} from "../../src/production/repair/index.js";
import { createProductionConfig } from "../../src/config/production-config.js";
import { MissionControl } from "../../src/control-plane/mission-control.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { EvidenceControl } from "../../src/control-plane/evidence-control.js";
import { ProductionVerifier } from "../../src/verification/production-verifier.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { SourceDiagnosticEngine } from "../../src/production/diagnostics/index.js";
import { ModelAdapter } from "../../src/runtime/production-runtime-engine.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Phase 48AF: Editor Integration & Pre-Mutation Intent", () => {
  let db: DatabaseSync;
  let store: SqliteStateStore;
  let tempDir: string;
  let workspaceRoot: string;
  let editor: LineAnchoredEditor;

  const TEST_RUN_ID = "run-editor-48af";
  const TEST_TASK_ID = "task-editor-48af";
  const TEST_WORKER_ID = "worker-editor-48af";
  const TEST_LEASE_ID = "lease-editor-48af";
  const TIMED_OUT_LEASE_ID = "lease-timed-out-48af";
  const EXPIRED_LEASE_ID = "lease-expired-48af";
  const TEST_SUPERVISOR_ID = "supervisor-editor-48af";
  const TEST_SUPERVISOR_LEASE_ID = "supervisor-lease-editor-48af";

  const defaultWorkerAuthority: MutationAuthorityContext = {
    authority: "WORKER",
    fencing: {
      workerId: TEST_WORKER_ID,
      leaseId: TEST_LEASE_ID,
      nowIso: "2026-10-28T12:00:00.000Z",
    },
  };

  const defaultSupervisorAuthority: MutationAuthorityContext = {
    authority: "SUPERVISOR",
    supervisorFencing: {
      supervisorId: TEST_SUPERVISOR_ID,
      leaseId: TEST_SUPERVISOR_LEASE_ID,
      nowIso: "2026-10-28T12:00:00.000Z",
    },
  };

  beforeEach(() => {
    // 1. In-memory SQLite store
    db = createSqliteClient({ location: ":memory:" });
    migrateDatabase(db);
    store = new SqliteStateStore(db);

    // 2. Initialize baseline task, worker, run, and leases
    store.transaction((tx) => {
      tx.insertTask({
        taskId: TEST_TASK_ID,
        title: "Phase 48AF Editor Integration Task",
        description: "Testing ADR-0036 Workstream 2 pre-mutation intent",
        inputPayload: {},
        createdAt: "2026-10-28T12:00:00.000Z",
        updatedAt: "2026-10-28T12:00:00.000Z",
      });

      tx.insertWorker({
        workerId: TEST_WORKER_ID,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: "2026-10-28T12:00:00.000Z",
        createdAt: "2026-10-28T12:00:00.000Z",
      });

      const runSnapshot: RunSnapshot = {
        runId: TEST_RUN_ID,
        taskId: TEST_TASK_ID,
        status: "RUNNING",
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        timeoutMs: 30000,
        idempotencyKey: null,
        currentWorkerId: TEST_WORKER_ID,
        leaseId: TEST_LEASE_ID,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        resultPayload: null,
        errorPayload: null,
        createdAt: "2026-10-28T12:00:00.000Z",
        updatedAt: "2026-10-28T12:00:00.000Z",
        contractBinding: null,
        maxOutputBytes: null,
      };

      tx.insertRun(runSnapshot, {
        eventId: "evt-run-created-48af",
        runId: TEST_RUN_ID,
        timestamp: "2026-10-28T12:00:00.000Z",
        eventType: "run.created",
        schemaVersion: 1,
        producer: "TEST",
        payload: {},
      });

      // Active lease
      tx.insertLease({
        leaseId: TEST_LEASE_ID,
        runId: TEST_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: "2026-10-28T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });

      // Timed-out lease (active state but past expiration timestamp)
      tx.insertLease({
        leaseId: TIMED_OUT_LEASE_ID,
        runId: TEST_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:01:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });

      // Revoked/expired lease state
      tx.insertLease({
        leaseId: EXPIRED_LEASE_ID,
        runId: TEST_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:01:00.000Z",
        releasedAt: null,
        state: "EXPIRED",
      });

      // Active supervisor lease
      db.prepare(`
        INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE')
      `).run(TEST_SUPERVISOR_LEASE_ID, TEST_RUN_ID, TEST_SUPERVISOR_ID, "2026-10-28T12:00:00.000Z", "2099-01-01T00:00:00.000Z");
    });

    // 3. Isolated temp workspace
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-48af-"));
    workspaceRoot = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    editor = new LineAnchoredEditor();
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Safe cleanup ignore
    }
  });

  function createExecutionContext(leaseId: string = TEST_LEASE_ID): ToolExecutionContext {
    return {
      runId: TEST_RUN_ID,
      taskId: TEST_TASK_ID,
      workerId: TEST_WORKER_ID,
      leaseId,
      toolName: "edit_file",
      requiredCapability: "workspace.file.write",
      isolationRequirement: "WORKSPACE",
      workspace: {
        workspaceId: "ws-editor-48af",
        hostPath: workspaceRoot,
      },
      resourceLimits: {
        timeoutMs: 10000,
        maxOutputBytes: 1048576,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Scenario 1: Pre-mutation intent lifecycle succeeds end-to-end
  // --------------------------------------------------------------------------
  it("Scenario 1: Pre-mutation intent lifecycle succeeds and persists COMMITTED intent before returning", () => {
    const filePath = path.join(workspaceRoot, "src", "math.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const initialContent = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
    fs.writeFileSync(filePath, initialContent, "utf8");

    const baseDigest = sha256(initialContent);

    const mutationOptions: LineAnchoredMutationOptions = {
      runId: TEST_RUN_ID,
      workerId: TEST_WORKER_ID,
      workerLeaseId: TEST_LEASE_ID,
      store,
    };

    const result = editor.applyEdit(
      {
        path: "src/math.ts",
        searchAnchor: "return a - b;",
        replacementText: "return a + b;",
      },
      workspaceRoot,
      mutationOptions
    );

    expect(result.success).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.originalDigest).toBe(baseDigest);

    const updatedContent = fs.readFileSync(filePath, "utf8");
    const resultingDigest = sha256(updatedContent);
    expect(result.resultingDigest).toBe(resultingDigest);
    expect(updatedContent).toContain("return a + b;");

    // Verify durable intent record in SQLite
    const intent = store.getLatestIntentForPath(TEST_RUN_ID, "src/math.ts");
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("COMMITTED");
    expect(intent?.baseDigest).toBe(baseDigest);
    expect(intent?.expectedResultingDigest).toBe(resultingDigest);
    expect(intent?.pathMutationVersion).toBe(1);
    expect(intent?.parentMutationId).toBeNull();
    expect(intent?.relativePath).toBe("src/math.ts");

    // Verify pre-mutation snapshot file exists on disk and matches baseline
    expect(intent?.snapshotRef).toBeDefined();
    expect(fs.existsSync(intent!.snapshotRef)).toBe(true);
    const snapContent = fs.readFileSync(intent!.snapshotRef, "utf8");
    expect(snapContent).toBe(initialContent);
    expect(sha256(snapContent)).toBe(baseDigest);

    // Verify domain events persisted
    const events = store.getEventsForRun(TEST_RUN_ID);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("file.snapshot_written");
    expect(eventTypes).toContain("file.applying_mutation");
    expect(eventTypes).toContain("file.mutation_committed");
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Intent persistence failure leaves target file completely untouched
  // --------------------------------------------------------------------------
  it("Scenario 2: Intent persistence failure leaves target file byte-for-byte unchanged", () => {
    const filePath = path.join(workspaceRoot, "src", "service.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "const port = 8080;\n";
    fs.writeFileSync(filePath, originalContent, "utf8");

    // Proxy store to throw on recordIntent
    const mockStore = Object.create(store);
    mockStore.recordIntent = () => {
      throw new Error("Simulated SQLite database lock failure");
    };

    const mutationOptions: LineAnchoredMutationOptions = {
      runId: TEST_RUN_ID,
      workerId: TEST_WORKER_ID,
      workerLeaseId: TEST_LEASE_ID,
      store: mockStore,
    };

    expect(() => {
      editor.applyEdit(
        {
          path: "src/service.ts",
          searchAnchor: "8080",
          replacementText: "9090",
        },
        workspaceRoot,
        mutationOptions
      );
    }).toThrow(/Simulated SQLite database lock failure/);

    // Disk must remain 100% untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);

    // Zero intents should be persisted in store
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/service.ts")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Expired or invalid lease prevents mutation
  // --------------------------------------------------------------------------
  it("Scenario 3: Expired or invalid worker lease throws LeaseExpiredError / LeaseLostError and leaves file unchanged", () => {
    const filePath = path.join(workspaceRoot, "src", "config.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "export const debug = false;\n";
    fs.writeFileSync(filePath, originalContent, "utf8");

    // Case 3a: Timed-out lease timestamp throws LeaseExpiredError
    store.transaction((tx) => {
      (tx as any).db.prepare("UPDATE runs SET lease_id = ? WHERE run_id = ?").run(TIMED_OUT_LEASE_ID, TEST_RUN_ID);
    });
    try {
      expect(() => {
        editor.applyEdit(
          {
            path: "src/config.ts",
            searchAnchor: "debug = false",
            replacementText: "debug = true",
          },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: TEST_WORKER_ID,
            workerLeaseId: TIMED_OUT_LEASE_ID,
            store,
          }
        );
      }).toThrow(LeaseExpiredError);
    } finally {
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET lease_id = ? WHERE run_id = ?").run(TEST_LEASE_ID, TEST_RUN_ID);
      });
    }

    // Case 3b: Revoked/non-active lease state throws LeaseLostError
    store.transaction((tx) => {
      (tx as any).db.prepare("UPDATE runs SET lease_id = ? WHERE run_id = ?").run(EXPIRED_LEASE_ID, TEST_RUN_ID);
    });
    try {
      expect(() => {
        editor.applyEdit(
          {
            path: "src/config.ts",
            searchAnchor: "debug = false",
            replacementText: "debug = true",
          },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: TEST_WORKER_ID,
            workerLeaseId: EXPIRED_LEASE_ID,
            store,
          }
        );
      }).toThrow(LeaseLostError);
    } finally {
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET lease_id = ? WHERE run_id = ?").run(TEST_LEASE_ID, TEST_RUN_ID);
      });
    }

    // Disk remains untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/config.ts")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Stale digest / optimistic concurrency rejection leaves file unchanged
  // --------------------------------------------------------------------------
  it("Scenario 4: Stale digest rejection fails closed without modifying file or recording intent", () => {
    const filePath = path.join(workspaceRoot, "src", "auth.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "export const secret = 'initial';\n";
    fs.writeFileSync(filePath, originalContent, "utf8");

    const staleDigest = "a".repeat(64); // Wrong digest

    const mutationOptions: LineAnchoredMutationOptions = {
      runId: TEST_RUN_ID,
      workerId: TEST_WORKER_ID,
      workerLeaseId: TEST_LEASE_ID,
      store,
    };

    expect(() => {
      editor.applyEdit(
        {
          path: "src/auth.ts",
          searchAnchor: "initial",
          replacementText: "updated",
          expectedDigest: staleDigest,
        },
        workspaceRoot,
        mutationOptions
      );
    }).toThrow(/Stale edit precondition failed/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/auth.ts")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Invalid anchors, ambiguous anchors, and no-op edits fail closed
  // --------------------------------------------------------------------------
  it("Scenario 5a: Missing search anchor fails closed with zero modifications and zero intents", () => {
    const filePath = path.join(workspaceRoot, "src", "data.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "const x = 1;\n";
    fs.writeFileSync(filePath, content, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/data.ts",
          searchAnchor: "const y = 2;",
          replacementText: "const y = 3;",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/Search anchor not found/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/data.ts")).toBeNull();
  });

  it("Scenario 5b: Ambiguous search anchor fails closed when allowMultipleMatches is false", () => {
    const filePath = path.join(workspaceRoot, "src", "dup.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "repeat\nrepeat\n";
    fs.writeFileSync(filePath, content, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/dup.ts",
          searchAnchor: "repeat",
          replacementText: "single",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/Ambiguous search anchor/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/dup.ts")).toBeNull();
  });

  it("Scenario 5c: Identical searchAnchor and replacementText (no-op edit) fails closed", () => {
    const filePath = path.join(workspaceRoot, "src", "noop.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "const id = 42;\n";
    fs.writeFileSync(filePath, content, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/noop.ts",
          searchAnchor: "const id = 42;",
          replacementText: "const id = 42;",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/searchAnchor' and 'replacementText' are identical/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/noop.ts")).toBeNull();
  });

  it("Scenario 5d: Whitespace-only search anchor fails closed", () => {
    const filePath = path.join(workspaceRoot, "src", "ws.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "hello world\n";
    fs.writeFileSync(filePath, content, "utf8");

    expect(() => {
      editor.applyEdit(
        {
          path: "src/ws.ts",
          searchAnchor: "   \n\t  ",
          replacementText: "something",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/searchAnchor' cannot be empty or whitespace-only/);

    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Filesystem write failure leaves intent in APPLYING_MUTATION (CP4/CP4a)
  // --------------------------------------------------------------------------
  it("Scenario 6: Filesystem write failure leaves persisted intent in APPLYING_MUTATION state (CP4a)", () => {
    const filePath = path.join(workspaceRoot, "src", "locked.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "const value = 'initial';\n";
    fs.writeFileSync(filePath, originalContent, "utf8");

    const customMutationId = "mut-fail-write-01";

    // Set file to read-only (0o444) so that atomic replacement renameSync fails with EPERM
    fs.chmodSync(filePath, 0o444);

    try {
      expect(() => {
        editor.applyEdit(
          {
            path: "src/locked.ts",
            searchAnchor: "initial",
            replacementText: "failed_write",
          },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: TEST_WORKER_ID,
            workerLeaseId: TEST_LEASE_ID,
            store,
            mutationId: customMutationId,
          }
        );
      }).toThrow(/Failed to commit atomic edit/);
    } finally {
      // Restore write permissions for safe cleanup
      try {
        fs.chmodSync(filePath, 0o666);
      } catch {}
    }

    // In SQLite, the intent MUST remain in APPLYING_MUTATION (CP4a)
    const intent = store.getIntent(customMutationId);
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("APPLYING_MUTATION");

    // Snapshot file must still exist
    expect(fs.existsSync(intent!.snapshotRef)).toBe(true);

    // Target file on disk remains at initial content (D_0)
    expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Per-path digest chain ordering and versioning (D_0 -> D_1 -> D_2 -> D_3)
  // --------------------------------------------------------------------------
  it("Scenario 7: Successive mutations to the same path maintain strict version incrementing and parent chaining", () => {
    const filePath = path.join(workspaceRoot, "src", "pipeline.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "step: 0\n", "utf8");

    const d0 = sha256("step: 0\n");

    // Edit 1: step 0 -> step 1
    const res1 = editor.applyEdit(
      { path: "src/pipeline.ts", searchAnchor: "step: 0", replacementText: "step: 1" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store, mutationId: "mut-pipe-01" }
    );
    const d1 = res1.resultingDigest;

    // Edit 2: step 1 -> step 2
    const res2 = editor.applyEdit(
      { path: "src/pipeline.ts", searchAnchor: "step: 1", replacementText: "step: 2" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store, mutationId: "mut-pipe-02" }
    );
    const d2 = res2.resultingDigest;

    // Edit 3: step 2 -> step 3
    const res3 = editor.applyEdit(
      { path: "src/pipeline.ts", searchAnchor: "step: 2", replacementText: "step: 3" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store, mutationId: "mut-pipe-03" }
    );
    const d3 = res3.resultingDigest;

    // Verify history chain
    const history = store.getIntentsForPath(TEST_RUN_ID, "src/pipeline.ts");
    expect(history.length).toBe(3);

    expect(history[0].mutationId).toBe("mut-pipe-01");
    expect(history[0].pathMutationVersion).toBe(1);
    expect(history[0].parentMutationId).toBeNull();
    expect(history[0].baseDigest).toBe(d0);
    expect(history[0].expectedResultingDigest).toBe(d1);

    expect(history[1].mutationId).toBe("mut-pipe-02");
    expect(history[1].pathMutationVersion).toBe(2);
    expect(history[1].parentMutationId).toBe("mut-pipe-01");
    expect(history[1].baseDigest).toBe(d1);
    expect(history[1].expectedResultingDigest).toBe(d2);

    expect(history[2].mutationId).toBe("mut-pipe-03");
    expect(history[2].pathMutationVersion).toBe(3);
    expect(history[2].parentMutationId).toBe("mut-pipe-02");
    expect(history[2].baseDigest).toBe(d2);
    expect(history[2].expectedResultingDigest).toBe(d3);

    expect(fs.readFileSync(filePath, "utf8")).toBe("step: 3\n");
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Digest chain broken rejection
  // --------------------------------------------------------------------------
  it("Scenario 8: Digest chain continuity violation rejects out-of-order or externally modified edit", () => {
    const filePath = path.join(workspaceRoot, "src", "state.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "v1\n", "utf8");

    // Mutation 1 succeeds
    editor.applyEdit(
      { path: "src/state.ts", searchAnchor: "v1", replacementText: "v2" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );

    // Uncooperative external modification changes file out of band!
    fs.writeFileSync(filePath, "v2_externally_modified\n", "utf8");

    // Mutation 2 must fail closed because disk digest != latest intent expectedResultingDigest
    expect(() => {
      editor.applyEdit(
        { path: "src/state.ts", searchAnchor: "v2", replacementText: "v3" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/Digest chain continuity violation/);

    expect(fs.readFileSync(filePath, "utf8")).toBe("v2_externally_modified\n");
    expect(store.getIntentsForPath(TEST_RUN_ID, "src/state.ts").length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Pre-read size limit (1 MiB guard)
  // --------------------------------------------------------------------------
  it("Scenario 9: Pre-read size guard rejects files exceeding 1 MiB (1,048,576 bytes)", () => {
    const filePath = path.join(workspaceRoot, "src", "huge.txt");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Create 1 MiB + 1 byte file
    const hugeBuffer = Buffer.alloc(1048577, "a");
    fs.writeFileSync(filePath, hugeBuffer);

    expect(() => {
      editor.applyEdit(
        {
          path: "src/huge.txt",
          searchAnchor: "a",
          replacementText: "b",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/File size limit exceeded for line-anchored edit: 1048577 bytes exceeds maximum 1048576 bytes/);

    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/huge.txt")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Post-read binary null byte rejection
  // --------------------------------------------------------------------------
  it("Scenario 10: Binary file containing null bytes (0x00) is rejected before mutation", () => {
    const filePath = path.join(workspaceRoot, "src", "binary.bin");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const binaryBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
    fs.writeFileSync(filePath, binaryBuffer);

    expect(() => {
      editor.applyEdit(
        {
          path: "src/binary.bin",
          searchAnchor: "Hello",
          replacementText: "Goodbye",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/Binary file detected: target file contains null bytes \(0x00\)/);

    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/binary.bin")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Post-read UTF-8 validation
  // --------------------------------------------------------------------------
  it("Scenario 11: File containing invalid UTF-8 byte sequences is rejected", () => {
    const filePath = path.join(workspaceRoot, "src", "invalid-utf8.txt");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // 0xC3 0x28 is an invalid 2-byte UTF-8 sequence
    const invalidUtf8Buffer = Buffer.from([0x66, 0x6f, 0x6f, 0xc3, 0x28, 0x62, 0x61, 0x72]);
    fs.writeFileSync(filePath, invalidUtf8Buffer);

    expect(() => {
      editor.applyEdit(
        {
          path: "src/invalid-utf8.txt",
          searchAnchor: "foo",
          replacementText: "baz",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/Invalid UTF-8 encoding in target file/);

    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/invalid-utf8.txt")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Path containment and symlink protection
  // --------------------------------------------------------------------------
  it("Scenario 12: Path traversal outside workspace boundary is rejected", () => {
    expect(() => {
      editor.applyEdit(
        {
          path: "../outside.txt",
          searchAnchor: "foo",
          replacementText: "bar",
        },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(/Path traversal denied outside workspace/);

    expect(store.getIntentsForRun(TEST_RUN_ID).length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Backwards compatibility without mutation options
  // --------------------------------------------------------------------------
  it("Scenario 13: Legacy direct execution without mutationOptions continues to function as before", () => {
    const filePath = path.join(workspaceRoot, "src", "legacy.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const v = 1;\n", "utf8");

    const result = editor.applyEdit(
      {
        path: "src/legacy.ts",
        searchAnchor: "const v = 1;",
        replacementText: "const v = 2;",
      },
      workspaceRoot
    );

    expect(result.success).toBe(true);
    expect(result.applied).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("const v = 2;\n");
    expect(result.mutationId).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Scenario 14: EditFileToolAdapter integration with MutationIntentStorePort
  // --------------------------------------------------------------------------
  it("Scenario 14: EditFileToolAdapter integrates with MutationIntentStorePort and executes WAMI lifecycle", async () => {
    const filePath = path.join(workspaceRoot, "src", "adapter.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const active = false;\n", "utf8");

    const adapter = new EditFileToolAdapter(undefined, editor, store);
    const context = createExecutionContext();

    const output = await adapter.execute(context, {
      path: "src/adapter.ts",
      searchAnchor: "active = false",
      replacementText: "active = true",
    });

    expect(output.applied).toBe(true);
    expect(output.path).toBe("src/adapter.ts");

    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(onDisk).toBe("const active = true;\n");
    expect(output.resultingDigest).toBe(sha256(onDisk));

    const intent = store.getLatestIntentForPath(TEST_RUN_ID, "src/adapter.ts");
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("COMMITTED");
  });

  // --------------------------------------------------------------------------
  // Scenario 15: EditFileToolAdapter cancellation check
  // --------------------------------------------------------------------------
  it("Scenario 15: Tool cancellation check aborts before mutation or intent creation", async () => {
    const filePath = path.join(workspaceRoot, "src", "cancel.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "unmodified\n";
    fs.writeFileSync(filePath, content, "utf8");

    const adapter = new EditFileToolAdapter(undefined, editor, store);
    const context = createExecutionContext();

    const controller = new AbortController();
    controller.abort(new Error("Operation cancelled by supervisor"));

    const cancelledContext: ToolExecutionContext = {
      ...context,
      abortSignal: controller.signal,
    };

    await expect(
      adapter.execute(cancelledContext, {
        path: "src/cancel.ts",
        searchAnchor: "unmodified",
        replacementText: "modified",
      })
    ).rejects.toThrow(ToolCancelledError);

    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/cancel.ts")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 16: PlanEdit provides deterministic pre-mutation calculations without modifying filesystem
  // --------------------------------------------------------------------------
  it("Scenario 16: planEdit computes expected resulting digest in memory without touching filesystem", () => {
    const filePath = path.join(workspaceRoot, "src", "plan.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "function compute() { return 10; }\n";
    fs.writeFileSync(filePath, content, "utf8");

    const plan = editor.planEdit(
      {
        path: "src/plan.ts",
        searchAnchor: "return 10;",
        replacementText: "return 20;",
      },
      workspaceRoot
    );

    expect(plan.relativePath).toBe("src/plan.ts");
    expect(plan.originalContent).toBe(content);
    expect(plan.originalDigest).toBe(sha256(content));
    expect(plan.newContent).toBe("function compute() { return 20; }\n");
    expect(plan.resultingDigest).toBe(sha256("function compute() { return 20; }\n"));
    expect(plan.occurrences).toBe(1);
    expect(plan.replacedCount).toBe(1);

    // Verify disk was NOT modified by planEdit
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // Verify zero temp files or snapshot directories created
    expect(fs.existsSync(path.join(workspaceRoot, ".emerald"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario 17: Governed repair mode fails closed when WAMI store is missing
  // --------------------------------------------------------------------------
  it("Scenario 17: Governed repair mode fails closed with GovernedWamiRequiredError when mutationStore is missing", async () => {
    const filePath = path.join(workspaceRoot, "src", "governed-fail.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "const state = 'unmodified';\n";
    fs.writeFileSync(filePath, content, "utf8");

    // Adapter created without mutationStore
    const adapter = new EditFileToolAdapter();
    const context: ToolExecutionContext = {
      ...createExecutionContext(),
      governedBenchmarkRepairMode: true,
    };

    await expect(
      adapter.execute(context, {
        path: "src/governed-fail.ts",
        searchAnchor: "unmodified",
        replacementText: "modified",
      })
    ).rejects.toThrow(GovernedWamiRequiredError);

    // Target file remains 100% untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Scenario 18: Production registry wires MutationIntentStorePort to EditFileToolAdapter
  // --------------------------------------------------------------------------
  it("Scenario 18: createWorkspaceToolAdapterRegistry wires mutationStore and executes WAMI lifecycle", async () => {
    const filePath = path.join(workspaceRoot, "src", "registry.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "let counter = 0;\n";
    fs.writeFileSync(filePath, content, "utf8");

    const mockWorkspacePort: WorkspacePort = {
      provisionWorkspace: async () => ({ workspaceId: "ws-reg", hostPath: workspaceRoot, runId: TEST_RUN_ID, containerMountPath: "/workspace", createdAt: "2026-11-12T10:00:00.000Z", maxWorkspaceBytes: 10485760 }),
      resumeWorkspace: async () => ({ workspaceId: "ws-reg", hostPath: workspaceRoot, runId: TEST_RUN_ID, containerMountPath: "/workspace", createdAt: "2026-11-12T10:00:00.000Z", maxWorkspaceBytes: 10485760 }),
      resolvePath: async (_wsId, relPath) => path.join(workspaceRoot, relPath),
      disposeWorkspace: async () => {},
      cleanupOrphanedWorkspaces: async () => [],
    };

    const registry = createWorkspaceToolAdapterRegistry(mockWorkspacePort, undefined, {
      mutationStore: store,
    });

    const editAdapter = registry.getAdapter("edit_file") as EditFileToolAdapter;
    expect(editAdapter).toBeDefined();

    const context = createExecutionContext();
    const result = await editAdapter.execute(context, {
      path: "src/registry.ts",
      searchAnchor: "counter = 0",
      replacementText: "counter = 1",
    });

    expect(result.applied).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("let counter = 1;\n");

    const intent = store.getLatestIntentForPath(TEST_RUN_ID, "src/registry.ts");
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("COMMITTED");
  });

  // --------------------------------------------------------------------------
  // Scenario 19: WorkerRuntime automatically supplies MutationIntentStorePort to tool registry
  // --------------------------------------------------------------------------
  it("Scenario 19: WorkerRuntime defaults to supplying MutationIntentStorePort from coordinator.store", async () => {
    const filePath = path.join(workspaceRoot, "src", "worker-wire.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "export const mode = 'initial';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const coordinator = new RunCoordinator(store);
    const mockWorkspacePort: WorkspacePort = {
      provisionWorkspace: async () => ({ workspaceId: "ws-work", hostPath: workspaceRoot, runId: "run-worker-wire", containerMountPath: "/workspace", createdAt: "2026-11-12T10:00:00.000Z", maxWorkspaceBytes: 10485760 }),
      resumeWorkspace: async () => ({ workspaceId: "ws-work", hostPath: workspaceRoot, runId: "run-worker-wire", containerMountPath: "/workspace", createdAt: "2026-11-12T10:00:00.000Z", maxWorkspaceBytes: 10485760 }),
      resolvePath: async (_wsId, relPath) => path.join(workspaceRoot, relPath),
      disposeWorkspace: async () => {},
      cleanupOrphanedWorkspaces: async () => [],
    };

    const worker = new WorkerRuntime({
      coordinator,
      workspacePort: mockWorkspacePort,
    });

    const gateway = worker.gateway;
    const adapter = gateway.adapters?.getAdapter("edit_file") as EditFileToolAdapter;
    expect(adapter).toBeDefined();

    const context = createExecutionContext();
    const result = await adapter.execute(context, {
      path: "src/worker-wire.ts",
      searchAnchor: "initial",
      replacementText: "wired",
    });

    expect(result.applied).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("export const mode = 'wired';\n");

    const intent = store.getLatestIntentForPath(TEST_RUN_ID, "src/worker-wire.ts");
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("COMMITTED");
  });

  // --------------------------------------------------------------------------
  // Scenario 20: Pre-rename target modification detection (TOCTOU fencing)
  // --------------------------------------------------------------------------
  it("Scenario 20: Pre-rename digest check detects concurrent external modification and aborts with PreRenameConflictError", () => {
    const filePath = path.join(workspaceRoot, "src", "race.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const initialContent = "line 1\nline 2\n";
    fs.writeFileSync(filePath, initialContent, "utf8");

    // Mock store to intercept transition to APPLYING_MUTATION and simulate concurrent edit before rename
    const proxyStore = Object.create(store);
    proxyStore.transitionMutationStatus = (params: any) => {
      const res = store.transitionMutationStatus(params);
      if (params.toStatus === "APPLYING_MUTATION") {
        // Concurrently modify target file on disk right before rename
        fs.writeFileSync(filePath, "line 1\nline 2 MODIFIED EXTERNALLY\n", "utf8");
      }
      return res;
    };

    expect(() => {
      editor.applyEdit(
        {
          path: "src/race.ts",
          searchAnchor: "line 2",
          replacementText: "line 2 REPLACED",
        },
        workspaceRoot,
        {
          runId: TEST_RUN_ID,
          workerId: TEST_WORKER_ID,
          workerLeaseId: TEST_LEASE_ID,
          store: proxyStore,
        }
      );
    }).toThrow(PreRenameConflictError);

    // CRITICAL: The external modification MUST NOT be clobbered
    const currentOnDisk = fs.readFileSync(filePath, "utf8");
    expect(currentOnDisk).toBe("line 1\nline 2 MODIFIED EXTERNALLY\n");

    // Temporary .emerald.tmp file must be cleaned up
    const dirFiles = fs.readdirSync(path.dirname(filePath));
    const tempFiles = dirFiles.filter((f) => f.startsWith(".emerald.tmp"));
    expect(tempFiles.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 21: Post-write on-disk verification prevents COMMITTED transition on digest mismatch
  // --------------------------------------------------------------------------
  it("Scenario 21: Post-write verification fails if disk content does not match expectedResultingDigest", () => {
    const filePath = path.join(workspaceRoot, "src", "post-verify.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "alpha\n", "utf8");

    const customMutationId = "mut-post-verify-01";

    class CorruptedPlanEditor extends LineAnchoredEditor {
      public override planEdit(rawInput: Record<string, unknown>, workspace: string) {
        const plan = super.planEdit(rawInput, workspace);
        return {
          ...plan,
          resultingDigest: "0".repeat(64),
        };
      }
    }
    const corruptEditor = new CorruptedPlanEditor();

    expect(() => {
      corruptEditor.applyEdit(
        {
          path: "src/post-verify.ts",
          searchAnchor: "alpha",
          replacementText: "beta",
        },
        workspaceRoot,
        {
          runId: TEST_RUN_ID,
          workerId: TEST_WORKER_ID,
          workerLeaseId: TEST_LEASE_ID,
          store,
          mutationId: customMutationId,
        }
      );
    }).toThrow(PostWriteVerificationError);

    // In SQLite, status MUST remain APPLYING_MUTATION (never COMMITTED)
    const intent = store.getIntent(customMutationId);
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("APPLYING_MUTATION");
  });

  // --------------------------------------------------------------------------
  // Scenario 22: Lease fencing at every transition — lease revoked before SNAPSHOT_WRITTEN
  // --------------------------------------------------------------------------
  it("Scenario 22: Lease fencing rejects SNAPSHOT_WRITTEN transition if lease is revoked", () => {
    const filePath = path.join(workspaceRoot, "src", "fence-snap.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "baseline\n";
    fs.writeFileSync(filePath, content, "utf8");

    const fenceLeaseId = "lease-fence-snap";
    store.transaction((tx) => {
      tx.insertLease({
        leaseId: fenceLeaseId,
        runId: TEST_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: "2026-10-28T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });
    });

    const proxyStore = Object.create(store);
    proxyStore.recordIntent = (intent: any) => {
      store.recordIntent(intent);
      // Revoke lease immediately after recording intent
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE leases SET state = 'REVOKED' WHERE lease_id = ?").run(fenceLeaseId);
      });
    };

    expect(() => {
      editor.applyEdit(
        {
          path: "src/fence-snap.ts",
          searchAnchor: "baseline",
          replacementText: "updated",
        },
        workspaceRoot,
        {
          runId: TEST_RUN_ID,
          workerId: TEST_WORKER_ID,
          workerLeaseId: fenceLeaseId,
          store: proxyStore,
        }
      );
    }).toThrow(LeaseLostError);

    // Target file remains untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Scenario 23: Lease fencing at every transition — lease expires before APPLYING_MUTATION
  // --------------------------------------------------------------------------
  it("Scenario 23: Lease fencing rejects APPLYING_MUTATION transition if lease timestamp expires", () => {
    const filePath = path.join(workspaceRoot, "src", "fence-apply.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "baseline\n";
    fs.writeFileSync(filePath, content, "utf8");

    const proxyStore = Object.create(store);
    proxyStore.transitionMutationStatus = (params: any) => {
      if (params.toStatus === "APPLYING_MUTATION") {
        // Expire lease immediately before APPLYING_MUTATION
        store.transaction((tx) => {
          (tx as any).db.prepare("UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE lease_id = ?").run(TEST_LEASE_ID);
        });
      }
      return store.transitionMutationStatus(params);
    };

    try {
      expect(() => {
        editor.applyEdit(
          {
            path: "src/fence-apply.ts",
            searchAnchor: "baseline",
            replacementText: "updated",
          },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: TEST_WORKER_ID,
            workerLeaseId: TEST_LEASE_ID,
            store: proxyStore,
          }
        );
      }).toThrow(LeaseExpiredError);
    } finally {
      // Restore active lease expiry
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE leases SET expires_at = '2099-01-01T00:00:00.000Z' WHERE lease_id = ?").run(TEST_LEASE_ID);
      });
    }

    // Target file remains untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Scenario 24: Lease fencing at every transition — lease stolen/revoked before COMMITTED
  // --------------------------------------------------------------------------
  it("Scenario 24: Lease fencing rejects COMMITTED transition if worker lease is stolen after rename", () => {
    const filePath = path.join(workspaceRoot, "src", "fence-commit.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "before\n";
    fs.writeFileSync(filePath, content, "utf8");

    const customMutationId = "mut-fence-commit-01";

    const proxyStore = Object.create(store);
    proxyStore.transitionMutationStatus = (params: any) => {
      if (params.toStatus === "COMMITTED") {
        // Steal lease (reassign run to another worker) right before COMMITTED transition
        store.transaction((tx) => {
          tx.insertWorker({
            workerId: "other-worker",
            hostname: "localhost",
            pid: process.pid,
            status: "ACTIVE",
            lastHeartbeatAt: "2026-10-28T12:00:00.000Z",
            createdAt: "2026-10-28T12:00:00.000Z",
          });
          tx.insertLease({
            leaseId: "other-lease",
            runId: TEST_RUN_ID,
            workerId: "other-worker",
            acquiredAt: "2026-10-28T12:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            releasedAt: null,
            state: "ACTIVE",
          });
          (tx as any).db.prepare("UPDATE runs SET current_worker_id = 'other-worker', lease_id = 'other-lease' WHERE run_id = ?").run(TEST_RUN_ID);
        });
      }
      return store.transitionMutationStatus(params);
    };

    try {
      expect(() => {
        editor.applyEdit(
          {
            path: "src/fence-commit.ts",
            searchAnchor: "before",
            replacementText: "after",
          },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: TEST_WORKER_ID,
            workerLeaseId: TEST_LEASE_ID,
            store: proxyStore,
            mutationId: customMutationId,
          }
        );
      }).toThrow(LeaseLostError);
    } finally {
      // Restore worker on runs
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET current_worker_id = ? WHERE run_id = ?").run(TEST_WORKER_ID, TEST_RUN_ID);
      });
    }

    // Intent in SQLite must remain APPLYING_MUTATION (never COMMITTED)
    const intent = store.getIntent(customMutationId);
    expect(intent?.lifecycleStatus).toBe("APPLYING_MUTATION");
  });

  // --------------------------------------------------------------------------
  // Scenario 25: Incomplete prior mutation blocks subsequent edits with typed IncompletePriorMutationError
  // --------------------------------------------------------------------------
  it("Scenario 25: Prior mutation in incomplete or conflict states blocks subsequent edits with IncompletePriorMutationError", () => {
    const filePath = path.join(workspaceRoot, "src", "unresolved.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "initial\n", "utf8");

    // 25a: Prior intent in RECORDED
    const mutRecorded = "mut-unres-rec";
    store.recordIntent({
      mutationId: mutRecorded,
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/unresolved.ts",
      canonicalPath: filePath,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256("initial\n"),
      expectedResultingDigest: sha256("step1\n"),
      snapshotRef: path.join(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID, `${mutRecorded}.snap`),
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutRecorded, "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(() => {
      editor.applyEdit(
        { path: "src/unresolved.ts", searchAnchor: "initial", replacementText: "step2" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(IncompletePriorMutationError);

    // 25b: Transition prior intent to SNAPSHOT_WRITTEN
    store.transitionMutationStatus({
      mutationId: mutRecorded,
      fromStatus: "RECORDED",
      toStatus: "SNAPSHOT_WRITTEN",
      event: {
        eventId: "evt-snap",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.snapshot_written",
        schemaVersion: 1,
        producer: "TEST",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutRecorded, "SNAPSHOT_WRITTEN"),
      authorityContext: defaultWorkerAuthority,
    });

    expect(() => {
      editor.applyEdit(
        { path: "src/unresolved.ts", searchAnchor: "initial", replacementText: "step2" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(IncompletePriorMutationError);

    // 25c: Transition prior intent to APPLYING_MUTATION
    store.transitionMutationStatus({
      mutationId: mutRecorded,
      fromStatus: "SNAPSHOT_WRITTEN",
      toStatus: "APPLYING_MUTATION",
      event: {
        eventId: "evt-apply",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.applying_mutation",
        schemaVersion: 1,
        producer: "TEST",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutRecorded, "APPLYING_MUTATION"),
      authorityContext: defaultWorkerAuthority,
    });

    expect(() => {
      editor.applyEdit(
        { path: "src/unresolved.ts", searchAnchor: "initial", replacementText: "step2" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(IncompletePriorMutationError);

    // 25d: Transition prior intent to ROLLBACK_CONFLICT_LOST_UPDATE
    store.transitionMutationStatus({
      mutationId: mutRecorded,
      fromStatus: "APPLYING_MUTATION",
      toStatus: "ROLLBACK_CONFLICT_LOST_UPDATE",
      event: {
        eventId: "evt-conflict",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.conflict_halted",
        schemaVersion: 1,
        producer: "TEST",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutRecorded, "ROLLBACK_CONFLICT_LOST_UPDATE"),
      authorityContext: defaultSupervisorAuthority,
    });

    expect(() => {
      editor.applyEdit(
        { path: "src/unresolved.ts", searchAnchor: "initial", replacementText: "step2" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(IncompletePriorMutationError);
  });

  // --------------------------------------------------------------------------
  // Scenario 26: Snapshot path containment and identifier validation
  // --------------------------------------------------------------------------
  it("Scenario 26: Snapshot directory and file identifiers reject path traversal", () => {
    const filePath = path.join(workspaceRoot, "src", "contain.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "clean\n", "utf8");

    // Invalid runId with directory traversal
    expect(() => {
      editor.applyEdit(
        { path: "src/contain.ts", searchAnchor: "clean", replacementText: "dirty" },
        workspaceRoot,
        { runId: "../../escaped-run", workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(SnapshotContainmentError);

    // Invalid mutationId with directory traversal
    expect(() => {
      editor.applyEdit(
        { path: "src/contain.ts", searchAnchor: "clean", replacementText: "dirty" },
        workspaceRoot,
        {
          runId: TEST_RUN_ID,
          workerId: TEST_WORKER_ID,
          workerLeaseId: TEST_LEASE_ID,
          store,
          mutationId: "mut/traversal/escape",
        }
      );
    }).toThrow(SnapshotContainmentError);

    // Outside snapshot directory
    expect(() => {
      editor.applyEdit(
        { path: "src/contain.ts", searchAnchor: "clean", replacementText: "dirty" },
        workspaceRoot,
        {
          runId: TEST_RUN_ID,
          workerId: TEST_WORKER_ID,
          workerLeaseId: TEST_LEASE_ID,
          store,
          snapshotDir: path.resolve(tempDir, "outside-snapshots"),
        }
      );
    }).toThrow(SnapshotContainmentError);
  });

  // --------------------------------------------------------------------------
  // Scenario 27: Snapshot failure handling cleans up temp files and prevents mutation
  // --------------------------------------------------------------------------
  it("Scenario 27: Snapshot write failure cleans up temporary files and prevents target mutation", () => {
    const filePath = path.join(workspaceRoot, "src", "snap-fail.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "never_modified\n";
    fs.writeFileSync(filePath, content, "utf8");

    const customMutationId = "mut-snap-fail-01";
    const snapshotDir = path.resolve(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID);
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Block snapshot atomic rename by pre-creating snapshotRef as a directory
    const snapshotRef = path.resolve(snapshotDir, `${customMutationId}.snap`);
    fs.mkdirSync(snapshotRef, { recursive: true });

    try {
      expect(() => {
        editor.applyEdit(
          { path: "src/snap-fail.ts", searchAnchor: "never_modified", replacementText: "attempted" },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: TEST_WORKER_ID,
            workerLeaseId: TEST_LEASE_ID,
            store,
            mutationId: customMutationId,
          }
        );
      }).toThrow(SnapshotCreationError);
    } finally {
      try {
        fs.rmdirSync(snapshotRef);
      } catch {}
    }

    // Target file must remain 100% untouched
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // Any temporary snapshot files must be cleaned up
    const snapFiles = fs.readdirSync(snapshotDir);
    const tempSnaps = snapFiles.filter((f) => f.includes(customMutationId));
    expect(tempSnaps.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 28: Governed repair mode fails closed when context fields are missing or invalid
  // --------------------------------------------------------------------------
  it("Scenario 28: Governed repair mode fails closed with GovernedWamiRequiredError when context fields are missing", async () => {
    const filePath = path.join(workspaceRoot, "src", "scen28.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "const original = 10;\n";
    fs.writeFileSync(filePath, content, "utf8");

    const adapter = new EditFileToolAdapter(undefined, editor, store);

    // 28a: Missing runId
    const baseCtx = createExecutionContext();
    const ctxNoRunId: ToolExecutionContext = {
      ...baseCtx,
      runId: "",
      governedBenchmarkRepairMode: true,
    };
    await expect(
      adapter.execute(ctxNoRunId, {
        path: "src/scen28.ts",
        searchAnchor: "10",
        replacementText: "20",
      })
    ).rejects.toThrow(GovernedWamiRequiredError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // 28b: Missing workerId
    const ctxNoWorker: ToolExecutionContext = {
      ...baseCtx,
      workerId: "",
      governedBenchmarkRepairMode: true,
    };
    await expect(
      adapter.execute(ctxNoWorker, {
        path: "src/scen28.ts",
        searchAnchor: "10",
        replacementText: "20",
      })
    ).rejects.toThrow(GovernedWamiRequiredError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // 28c: Missing leaseId
    const ctxNoLease: ToolExecutionContext = {
      ...baseCtx,
      leaseId: "",
      governedBenchmarkRepairMode: true,
    };
    await expect(
      adapter.execute(ctxNoLease, {
        path: "src/scen28.ts",
        searchAnchor: "10",
        replacementText: "20",
      })
    ).rejects.toThrow(GovernedWamiRequiredError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // 28d: Missing workspace hostPath
    const ctxNoWorkspace: ToolExecutionContext = {
      ...baseCtx,
      workspace: { workspaceId: "ws-nowhere", hostPath: "" },
      governedBenchmarkRepairMode: true,
    };
    await expect(
      adapter.execute(ctxNoWorkspace, {
        path: "src/scen28.ts",
        searchAnchor: "10",
        replacementText: "20",
      })
    ).rejects.toThrow(GovernedWamiRequiredError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Scenario 29: ProductionToolGateway governed fail-closed and WAMI wiring
  // --------------------------------------------------------------------------
  it("Scenario 29: ProductionToolGateway enforces WAMI in governed mode and falls back in non-governed mode", async () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);

    const testFence: CapabilityFence = {
      fenceId: TEST_LEASE_ID,
      subjectId: TEST_WORKER_ID,
      roleId: "developer",
      harnessId: "harness-48af",
      allowedCapabilities: ["READ_WORKSPACE", "WRITE_TEMPORARY_OUTPUT"],
      forbiddenCapabilities: ["NETWORK_ACCESS"],
      scope: {
        allowedWorkspacePaths: [workspaceRoot],
        forbiddenWorkspacePaths: ["/etc"],
        allowedTools: ["edit_file_anchor", "read_file"],
        maxOperations: 100,
        maxMemoryBytes: 1024 * 1024 * 10,
        networkAllowed: false,
        gitWriteAllowed: false,
      },
      trustLabel: "GOVERNED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: "contract-48af",
      missionContractHash: "hash-48af",
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      hash: "fence-hash-48af",
    };
    fenceEnforcer.registerFence(testFence);

    const filePath = path.join(workspaceRoot, "src", "gateway-test.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "const x = 1;\n", "utf8");

    // 29a: Governed mode without mutationStore fails closed
    const unjournaledGateway = new ProductionToolGateway(governance);
    const resGovernedMissingStore = await unjournaledGateway.executeTool(
      "edit_file_anchor",
      { path: "src/gateway-test.ts", searchAnchor: "1", replacementText: "2" },
      {
        runId: TEST_RUN_ID,
        subjectId: TEST_WORKER_ID,
        fenceId: TEST_LEASE_ID,
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: workspaceRoot,
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: true,
      }
    );
    expect(resGovernedMissingStore.success).toBe(false);
    expect(resGovernedMissingStore.error).toContain("Governed mutation requires WAMI");
    expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 1;\n");

    // 29b: Governed mode with mutationStore executes WAMI lifecycle
    const wamiGateway = new ProductionToolGateway(governance, store);
    const resGovernedSuccess = await wamiGateway.executeTool(
      "edit_file_anchor",
      { path: "src/gateway-test.ts", searchAnchor: "1", replacementText: "2" },
      {
        runId: TEST_RUN_ID,
        subjectId: TEST_WORKER_ID,
        fenceId: TEST_LEASE_ID,
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: workspaceRoot,
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: true,
      }
    );
    expect(resGovernedSuccess.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("const x = 2;\n");

    // Verify intent in SQLite
    const intent = store.getLatestIntentForPath(TEST_RUN_ID, "src/gateway-test.ts");
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("COMMITTED");
    expect(intent?.baseDigest).toBe(sha256("const x = 1;\n"));
    expect(intent?.expectedResultingDigest).toBe(sha256("const x = 2;\n"));

    // 29c: Non-governed mode without mutationStore executes legacy edit without WAMI
    const nonGovFilePath = path.join(workspaceRoot, "src", "legacy.ts");
    fs.writeFileSync(nonGovFilePath, "let legacy = 100;\n", "utf8");
    const resLegacy = await unjournaledGateway.executeTool(
      "edit_file_anchor",
      { path: "src/legacy.ts", searchAnchor: "100", replacementText: "200" },
      {
        runId: TEST_RUN_ID,
        subjectId: TEST_WORKER_ID,
        fenceId: TEST_LEASE_ID,
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: workspaceRoot,
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: false,
      }
    );
    expect(resLegacy.success).toBe(true);
    expect(fs.readFileSync(nonGovFilePath, "utf8")).toBe("let legacy = 200;\n");
    expect(store.getLatestIntentForPath(TEST_RUN_ID, "src/legacy.ts")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 30: ProductionRepairOrchestrator real tool gateway wiring in governed mode
  // --------------------------------------------------------------------------
  it("Scenario 30: ProductionRepairOrchestrator executes WAMI edits and persists mutation intents during repair", async () => {
    const repoDir = path.join(tempDir, "repair-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize git repo for baseline capture
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "TestRunner"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@emerald.fabric"], { cwd: repoDir, stdio: "ignore" });

    fs.writeFileSync(
      path.join(repoDir, "calc.js"),
      "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(repoDir, "test.js"),
      "const { add } = require('./calc.js');\nconst assert = require('node:assert');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ALL_TESTS_PASSED');\n",
      "utf8"
    );

    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial defect commit"], { cwd: repoDir, stdio: "ignore" });

    const prodConfig = createProductionConfig({ workspaceRoot: repoDir });
    const missionControl = new MissionControl();
    const runControl = new RunControl(undefined, store);
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const evidenceControl = new EvidenceControl();
    const verifier = new ProductionVerifier();
    const recoveryService = new ProductionRecoveryService(runControl, fenceEnforcer);
    const diagnosticEngine = new SourceDiagnosticEngine();
    const testLocalizer = new TestFailureLocalizer();

    const orchestrator = new ProductionRepairOrchestrator(
      prodConfig,
      missionControl,
      runControl,
      fenceEnforcer,
      crossGateway,
      evidenceControl,
      verifier,
      recoveryService,
      diagnosticEngine,
      testLocalizer,
      undefined,
      undefined,
      store // Pass SQLite store as mutationStore
    );

    const mission = missionControl.createMission({
      title: "Fix calc.js addition defect under WAMI",
      description: "Repair add function",
      repositoryPath: repoDir,
      governedBenchmarkRepairMode: true,
    });

    const mockModel: ModelAdapter = {
      async proposeAction(_ctx: string) {
        return {
          thought: "Fix minus to plus via line-anchored edit",
          toolName: "edit_file_anchor",
          toolInput: {
            path: "calc.js",
            searchAnchor: "return a - b;",
            replacementText: "return a + b;",
          },
        };
      },
    };

    const outcome = await orchestrator.executeRepairSession(mission.missionId, mockModel, {
      testCommand: { cmd: "node", args: ["test.js"] },
      expectedFiles: ["calc.js"],
    });

    expect(outcome.session.classification).toBe("SOVEREIGN_VERIFIED_SUCCESS");
    expect(outcome.session.sovereignVerified).toBe(true);
    expect(fs.readFileSync(path.join(repoDir, "calc.js"), "utf8")).toContain("return a + b;");

    // Inspect the persisted mutation intent
    const intent = store.getLatestIntentForPath(outcome.session.runId, "calc.js");
    expect(intent).not.toBeNull();
    expect(intent?.lifecycleStatus).toBe("COMMITTED");
    expect(intent?.pathMutationVersion).toBe(1);
    expect(intent?.baseDigest).toBe(sha256("function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n"));
    expect(intent?.expectedResultingDigest).toBe(sha256(fs.readFileSync(path.join(repoDir, "calc.js"), "utf8")));
  });

  // --------------------------------------------------------------------------
  // Scenario 31: Digest continuity after ROLLED_BACK
  // --------------------------------------------------------------------------
  it("Scenario 31: Subsequent edit validates disk against authoritative baseline after ROLLED_BACK", () => {
    const filePath = path.join(workspaceRoot, "src", "rollback-cont.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const baselineContent = "export function value() { return 100; }\n";
    fs.writeFileSync(filePath, baselineContent, "utf8");

    // First edit: 100 -> 200
    const mut1 = editor.applyEdit(
      { path: "src/rollback-cont.ts", searchAnchor: "return 100;", replacementText: "return 200;" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );
    expect(mut1.success).toBe(true);

    const intent1 = store.getLatestIntentForPath(TEST_RUN_ID, "src/rollback-cont.ts")!;
    expect(intent1.lifecycleStatus).toBe("COMMITTED");

    // Simulate rollback: restore disk to baselineContent (D_0) and transition intent1 to ROLLED_BACK
    fs.writeFileSync(filePath, baselineContent, "utf8");
    store.transitionMutationStatus({
      mutationId: intent1.mutationId,
      fromStatus: "COMMITTED",
      toStatus: "ROLLED_BACK",
      event: {
        eventId: "evt-rollback-sim",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.rollback_completed",
        schemaVersion: 1,
        producer: "SUPERVISOR",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, intent1.mutationId, "ROLLED_BACK"),
      authorityContext: defaultSupervisorAuthority,
    });

    // 31a: Disk matches baseDigest (D_0) -> subsequent edit succeeds and increments version to 2
    const mut2 = editor.applyEdit(
      { path: "src/rollback-cont.ts", searchAnchor: "return 100;", replacementText: "return 300;" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );
    expect(mut2.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("export function value() { return 300; }\n");

    const intent2 = store.getLatestIntentForPath(TEST_RUN_ID, "src/rollback-cont.ts")!;
    expect(intent2.lifecycleStatus).toBe("COMMITTED");
    expect(intent2.pathMutationVersion).toBe(2);
    expect(intent2.parentMutationId).toBe(intent1.mutationId);
    expect(intent2.baseDigest).toBe(sha256(baselineContent));

    // 31b: If disk does NOT match baseDigest after ROLLED_BACK -> throws DigestMismatchError
    store.transitionMutationStatus({
      mutationId: intent2.mutationId,
      fromStatus: "COMMITTED",
      toStatus: "ROLLED_BACK",
      event: {
        eventId: "evt-rollback-sim-2",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.rollback_completed",
        schemaVersion: 1,
        producer: "SUPERVISOR",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, intent2.mutationId, "ROLLED_BACK"),
      authorityContext: defaultSupervisorAuthority,
    });

    // Corrupt disk so it does NOT match intent2.baseDigest
    fs.writeFileSync(filePath, "corrupted content\n", "utf8");
    expect(() => {
      editor.applyEdit(
        { path: "src/rollback-cont.ts", searchAnchor: "corrupted", replacementText: "fixed" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(DigestMismatchError);

    // Disk remains corrupted, intent not created
    expect(fs.readFileSync(filePath, "utf8")).toBe("corrupted content\n");
  });

  // --------------------------------------------------------------------------
  // Scenario 32: Digest continuity after ABORTED_UNMUTATED
  // --------------------------------------------------------------------------
  it("Scenario 32: Subsequent edit validates disk against authoritative baseline after ABORTED_UNMUTATED", () => {
    const filePath = path.join(workspaceRoot, "src", "abort-cont.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const baselineContent = "let mode = 'normal';\n";
    fs.writeFileSync(filePath, baselineContent, "utf8");

    const mutId1 = "mut-aborted-01";
    store.recordIntent({
      mutationId: mutId1,
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/abort-cont.ts",
      canonicalPath: filePath,
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256(baselineContent),
      expectedResultingDigest: sha256("let mode = 'aborted';\n"),
      snapshotRef: path.join(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID, `${mutId1}.snap`),
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId1, "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    store.transitionMutationStatus({
      mutationId: mutId1,
      fromStatus: "RECORDED",
      toStatus: "ABORTED_UNMUTATED",
      event: {
        eventId: "evt-abort-01",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.mutation_aborted",
        schemaVersion: 1,
        producer: "SUPERVISOR",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId1, "ABORTED_UNMUTATED"),
      authorityContext: defaultSupervisorAuthority,
    });

    // 32a: Disk is still at baseDigest -> edit succeeds, version becomes 2, parent is mutId1
    const res1 = editor.applyEdit(
      { path: "src/abort-cont.ts", searchAnchor: "normal", replacementText: "safe" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );
    expect(res1.success).toBe(true);

    const intent2 = store.getLatestIntentForPath(TEST_RUN_ID, "src/abort-cont.ts")!;
    expect(intent2.lifecycleStatus).toBe("COMMITTED");
    expect(intent2.pathMutationVersion).toBe(2);
    expect(intent2.parentMutationId).toBe(mutId1);

    // 32b: If disk was tampered with after ABORTED_UNMUTATED -> throws DigestMismatchError
    const mutId3 = "mut-aborted-02";
    store.recordIntent({
      mutationId: mutId3,
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/abort-tamper.ts",
      canonicalPath: path.join(workspaceRoot, "src", "abort-tamper.ts"),
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256("original\n"),
      expectedResultingDigest: sha256("attempted\n"),
      snapshotRef: path.join(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID, `${mutId3}.snap`),
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId3, "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    store.transitionMutationStatus({
      mutationId: mutId3,
      fromStatus: "RECORDED",
      toStatus: "ABORTED_UNMUTATED",
      event: {
        eventId: "evt-abort-02",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.mutation_aborted",
        schemaVersion: 1,
        producer: "SUPERVISOR",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId3, "ABORTED_UNMUTATED"),
      authorityContext: defaultSupervisorAuthority,
    });

    // Write different content to disk
    fs.writeFileSync(path.join(workspaceRoot, "src", "abort-tamper.ts"), "tampered\n", "utf8");

    expect(() => {
      editor.applyEdit(
        { path: "src/abort-tamper.ts", searchAnchor: "tampered", replacementText: "new" },
        workspaceRoot,
        { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
      );
    }).toThrow(DigestMismatchError);
  });

  // --------------------------------------------------------------------------
  // Scenario 33: SQLite recordIntent enforces run, worker, and lease association
  // --------------------------------------------------------------------------
  it("Scenario 33: SQLite recordIntent atomically verifies run, worker, and lease triad inside transaction", () => {
    const OTHER_RUN_ID = "run-other-48af";
    const OTHER_LEASE_ID = "lease-other-48af";
    const OTHER_WORKER_ID = "worker-other-48af";

    store.transaction((tx) => {
      tx.insertWorker({
        workerId: OTHER_WORKER_ID,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

      const otherRun: RunSnapshot = {
        runId: OTHER_RUN_ID,
        taskId: TEST_TASK_ID,
        status: "RUNNING",
        version: 1,
        attemptCount: 1,
        maxAttempts: 3,
        timeoutMs: 30000,
        idempotencyKey: null,
        currentWorkerId: OTHER_WORKER_ID,
        leaseId: OTHER_LEASE_ID,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        resultPayload: null,
        errorPayload: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contractBinding: null,
        maxOutputBytes: null,
      };

      tx.insertRun(otherRun, {
        eventId: "evt-other-run-created",
        runId: OTHER_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "run.created",
        schemaVersion: 1,
        producer: "TEST",
        payload: {},
      });

      tx.insertLease({
        leaseId: OTHER_LEASE_ID,
        runId: OTHER_RUN_ID,
        workerId: OTHER_WORKER_ID,
        acquiredAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: null,
        state: "ACTIVE",
      });
    });

    // 33a: Active lease belonging to another run
    expect(() => {
      store.recordIntent({
        mutationId: "mut-wrong-run-lease",
        runId: TEST_RUN_ID,
        workerLeaseId: OTHER_LEASE_ID,
        relativePath: "src/triad.ts",
        canonicalPath: path.join(workspaceRoot, "src", "triad.ts"),
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: sha256("a"),
        expectedResultingDigest: sha256("b"),
        snapshotRef: "ref",
        recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-wrong-run-lease", "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }).toThrow(LeaseLostError);

    // 33b: Stale worker on run
    store.transaction((tx) => {
      (tx as any).db.prepare("UPDATE runs SET current_worker_id = ? WHERE run_id = ?").run(OTHER_WORKER_ID, TEST_RUN_ID);
    });
    try {
      expect(() => {
        store.recordIntent({
          mutationId: "mut-stale-worker",
          runId: TEST_RUN_ID,
          workerLeaseId: TEST_LEASE_ID,
          relativePath: "src/triad.ts",
          canonicalPath: path.join(workspaceRoot, "src", "triad.ts"),
          parentMutationId: null,
          pathMutationVersion: 1,
          baseDigest: sha256("a"),
          expectedResultingDigest: sha256("b"),
          snapshotRef: "ref",
          recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-stale-worker", "RECORDED"),
          lifecycleStatus: "RECORDED",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }).toThrow(LeaseLostError);
    } finally {
      // Restore worker
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET current_worker_id = ? WHERE run_id = ?").run(TEST_WORKER_ID, TEST_RUN_ID);
      });
    }

    // 33c: Expired lease
    store.transaction((tx) => {
      (tx as any).db.prepare("UPDATE runs SET lease_id = ? WHERE run_id = ?").run(TIMED_OUT_LEASE_ID, TEST_RUN_ID);
    });
    try {
      expect(() => {
        store.recordIntent({
          mutationId: "mut-expired-lease",
          runId: TEST_RUN_ID,
          workerLeaseId: TIMED_OUT_LEASE_ID,
          relativePath: "src/triad.ts",
          canonicalPath: path.join(workspaceRoot, "src", "triad.ts"),
          parentMutationId: null,
          pathMutationVersion: 1,
          baseDigest: sha256("a"),
          expectedResultingDigest: sha256("b"),
          snapshotRef: "ref",
          recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-expired-lease", "RECORDED"),
          lifecycleStatus: "RECORDED",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }).toThrow(LeaseExpiredError);
    } finally {
      store.transaction((tx) => {
        (tx as any).db.prepare("UPDATE runs SET lease_id = ? WHERE run_id = ?").run(TEST_LEASE_ID, TEST_RUN_ID);
      });
    }

    // 33d: Valid matching lease succeeds
    store.recordIntent({
      mutationId: "mut-valid-triad",
      runId: TEST_RUN_ID,
      workerLeaseId: TEST_LEASE_ID,
      relativePath: "src/triad.ts",
      canonicalPath: path.join(workspaceRoot, "src", "triad.ts"),
      parentMutationId: null,
      pathMutationVersion: 1,
      baseDigest: sha256("a"),
      expectedResultingDigest: sha256("b"),
      snapshotRef: "ref",
      recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-valid-triad", "RECORDED"),
      lifecycleStatus: "RECORDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(store.getIntent("mut-valid-triad")).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 34: ProductionToolGateway fails closed when individual context fields are missing
  // --------------------------------------------------------------------------
  it("Scenario 34: ProductionToolGateway fails closed with GovernedWamiRequiredError when context fields are empty", async () => {
    const fenceEnforcer = new CapabilityFenceEnforcer();
    const crossGateway = new CrossHarnessGateway(fenceEnforcer);
    const governance = new ProductionGovernanceFacade(fenceEnforcer, crossGateway);

    const testFence: CapabilityFence = {
      fenceId: TEST_LEASE_ID,
      subjectId: TEST_WORKER_ID,
      roleId: "developer",
      harnessId: "harness-48af",
      allowedCapabilities: ["READ_WORKSPACE", "WRITE_TEMPORARY_OUTPUT"],
      forbiddenCapabilities: ["NETWORK_ACCESS"],
      scope: {
        allowedWorkspacePaths: [workspaceRoot],
        forbiddenWorkspacePaths: ["/etc"],
        allowedTools: ["edit_file_anchor"],
        maxOperations: 100,
        maxMemoryBytes: 1024 * 1024 * 10,
        networkAllowed: false,
        gitWriteAllowed: false,
      },
      trustLabel: "GOVERNED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: "contract-48af",
      missionContractHash: "hash-48af",
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      hash: "fence-hash-48af",
    };
    fenceEnforcer.registerFence(testFence);

    const gateway = new ProductionToolGateway(governance, store);
    const filePath = path.join(workspaceRoot, "src", "gateway-fields.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = "const intact = true;\n";
    fs.writeFileSync(filePath, content, "utf8");

    // 34a: Missing runId
    const resNoRun = await gateway.executeTool(
      "edit_file_anchor",
      { path: "src/gateway-fields.ts", searchAnchor: "true", replacementText: "false" },
      {
        runId: "",
        subjectId: TEST_WORKER_ID,
        fenceId: TEST_LEASE_ID,
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: workspaceRoot,
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: true,
      }
    );
    expect(resNoRun.success).toBe(false);
    expect(resNoRun.error).toContain("Governed mutation requires WAMI");
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // 34b: Missing subjectId
    const resNoSubject = await gateway.executeTool(
      "edit_file_anchor",
      { path: "src/gateway-fields.ts", searchAnchor: "true", replacementText: "false" },
      {
        runId: TEST_RUN_ID,
        subjectId: "",
        fenceId: TEST_LEASE_ID,
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: workspaceRoot,
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: true,
      }
    );
    expect(resNoSubject.success).toBe(false);
    expect(resNoSubject.error).toContain("Governed mutation requires WAMI");
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // 34c: Missing fenceId
    const resNoFence = await gateway.executeTool(
      "edit_file_anchor",
      { path: "src/gateway-fields.ts", searchAnchor: "true", replacementText: "false" },
      {
        runId: TEST_RUN_ID,
        subjectId: TEST_WORKER_ID,
        fenceId: "",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: workspaceRoot,
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: true,
      }
    );
    expect(resNoFence.success).toBe(false);
    expect(resNoFence.error).toMatch(/(Governed mutation requires WAMI|Governance denial)/);
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // 34d: Missing workspacePath
    const resNoWs = await gateway.executeTool(
      "edit_file_anchor",
      { path: "src/gateway-fields.ts", searchAnchor: "true", replacementText: "false" },
      {
        runId: TEST_RUN_ID,
        subjectId: TEST_WORKER_ID,
        fenceId: TEST_LEASE_ID,
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: "",
        missionContractHash: "hash-48af",
        governedBenchmarkRepairMode: true,
      }
    );
    expect(resNoWs.success).toBe(false);
    expect(resNoWs.error).toContain("Governed mutation requires WAMI");
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
  });

  // --------------------------------------------------------------------------
  // Scenario 35: Chained digest progression across multiple edits
  // --------------------------------------------------------------------------
  it("Scenario 35: Chained digest progression across multiple committed and rolled back edits maintains digest and version history", () => {
    const filePath = path.join(workspaceRoot, "src", "chain.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const d0 = "version = 0;\n";
    fs.writeFileSync(filePath, d0, "utf8");

    // Edit 1: D0 -> D1
    const r1 = editor.applyEdit(
      { path: "src/chain.ts", searchAnchor: "0", replacementText: "1" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );
    expect(r1.success).toBe(true);
    const i1 = store.getLatestIntentForPath(TEST_RUN_ID, "src/chain.ts")!;
    expect(i1.pathMutationVersion).toBe(1);
    expect(i1.parentMutationId).toBeNull();
    expect(i1.baseDigest).toBe(sha256(d0));
    expect(i1.expectedResultingDigest).toBe(sha256("version = 1;\n"));

    // Edit 2: D1 -> D2
    const r2 = editor.applyEdit(
      { path: "src/chain.ts", searchAnchor: "1", replacementText: "2" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );
    expect(r2.success).toBe(true);
    const i2 = store.getLatestIntentForPath(TEST_RUN_ID, "src/chain.ts")!;
    expect(i2.pathMutationVersion).toBe(2);
    expect(i2.parentMutationId).toBe(i1.mutationId);
    expect(i2.baseDigest).toBe(sha256("version = 1;\n"));
    expect(i2.expectedResultingDigest).toBe(sha256("version = 2;\n"));

    // Simulate rollback: restore disk to i2.baseDigest ("version = 1;\n") and mark i2 as ROLLED_BACK
    fs.writeFileSync(filePath, "version = 1;\n", "utf8");
    store.transitionMutationStatus({
      mutationId: i2.mutationId,
      fromStatus: "COMMITTED",
      toStatus: "ROLLED_BACK",
      event: {
        eventId: "evt-rollback-chain",
        runId: TEST_RUN_ID,
        timestamp: new Date().toISOString(),
        eventType: "file.rollback_completed",
        schemaVersion: 1,
        producer: "SUPERVISOR",
        payload: {},
      },
      nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, i2.mutationId, "ROLLED_BACK"),
      authorityContext: defaultSupervisorAuthority,
    });

    // Edit 3: D1 -> D3
    const r3 = editor.applyEdit(
      { path: "src/chain.ts", searchAnchor: "1", replacementText: "3" },
      workspaceRoot,
      { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
    );
    expect(r3.success).toBe(true);
    const i3 = store.getLatestIntentForPath(TEST_RUN_ID, "src/chain.ts")!;
    expect(i3.pathMutationVersion).toBe(3);
    expect(i3.parentMutationId).toBe(i2.mutationId);
    expect(i3.baseDigest).toBe(sha256("version = 1;\n"));
    expect(i3.expectedResultingDigest).toBe(sha256("version = 3;\n"));
  });

  // --------------------------------------------------------------------------
  // Scenario 36: Terminal conflict states permanently block subsequent automated edits
  // --------------------------------------------------------------------------
  it("Scenario 36: Terminal conflict states (LOST_UPDATE, HASH_MISMATCH, RESTORE_FAILED) block further edits with IncompletePriorMutationError", () => {
    const conflictStates = [
      "ROLLBACK_CONFLICT_LOST_UPDATE",
      "ROLLBACK_CONFLICT_HASH_MISMATCH",
      "RESTORE_FAILED",
    ] as const;

    for (const conflictState of conflictStates) {
      const relPath = `src/conflict-${conflictState.toLowerCase()}.ts`;
      const filePath = path.join(workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "data = 1;\n", "utf8");

      const mutId = `mut-${conflictState.toLowerCase()}`;
      store.recordIntent({
        mutationId: mutId,
        runId: TEST_RUN_ID,
        workerLeaseId: TEST_LEASE_ID,
        relativePath: relPath,
        canonicalPath: filePath,
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: sha256("data = 1;\n"),
        expectedResultingDigest: sha256("data = 2;\n"),
        snapshotRef: path.join(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID, `${mutId}.snap`),
        recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId, "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Legal progression per ADR-0036
      store.transitionMutationStatus({
        mutationId: mutId,
        fromStatus: "RECORDED",
        toStatus: "SNAPSHOT_WRITTEN",
        event: {
          eventId: `evt-${mutId}-snap`,
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.snapshot_written",
          schemaVersion: 1,
          producer: "TEST",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId, "SNAPSHOT_WRITTEN"),
        authorityContext: defaultWorkerAuthority,
      });

      store.transitionMutationStatus({
        mutationId: mutId,
        fromStatus: "SNAPSHOT_WRITTEN",
        toStatus: "APPLYING_MUTATION",
        event: {
          eventId: `evt-${mutId}-apply`,
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.applying_mutation",
          schemaVersion: 1,
          producer: "TEST",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId, "APPLYING_MUTATION"),
        authorityContext: defaultWorkerAuthority,
      });

      store.transitionMutationStatus({
        mutationId: mutId,
        fromStatus: "APPLYING_MUTATION",
        toStatus: "ROLLING_BACK",
        event: {
          eventId: `evt-${mutId}-rollback`,
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.rollback_started",
          schemaVersion: 1,
          producer: "SUPERVISOR",
          payload: {},
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId, "ROLLING_BACK"),
        authorityContext: defaultSupervisorAuthority,
      });

      // Transition to conflict state
      store.transitionMutationStatus({
        mutationId: mutId,
        fromStatus: "ROLLING_BACK",
        toStatus: conflictState,
        event: {
          eventId: `evt-${conflictState}`,
          runId: TEST_RUN_ID,
          timestamp: new Date().toISOString(),
          eventType: "file.conflict_halted",
          schemaVersion: 1,
          producer: "SUPERVISOR",
          payload: { reason: conflictState },
        },
        nextDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, mutId, conflictState),
        authorityContext: defaultSupervisorAuthority,
      });

      // Verify subsequent edit throws IncompletePriorMutationError
      expect(() => {
        editor.applyEdit(
          { path: relPath, searchAnchor: "data = 1;", replacementText: "data = 3;" },
          workspaceRoot,
          { runId: TEST_RUN_ID, workerId: TEST_WORKER_ID, workerLeaseId: TEST_LEASE_ID, store }
        );
      }).toThrow(IncompletePriorMutationError);

      // Verify file remains untouched
      expect(fs.readFileSync(filePath, "utf8")).toBe("data = 1;\n");
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 37: recordIntent fails when lease is released or run does not exist
  // --------------------------------------------------------------------------
  it("Scenario 37: recordIntent rejects non-existent run or non-active lease state without persisting intent", () => {
    // 37a: Non-existent run
    expect(() => {
      store.recordIntent({
        mutationId: "mut-ghost-run",
        runId: "run-does-not-exist",
        workerLeaseId: TEST_LEASE_ID,
        relativePath: "src/ghost.ts",
        canonicalPath: path.join(workspaceRoot, "src", "ghost.ts"),
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: sha256("x"),
        expectedResultingDigest: sha256("y"),
        snapshotRef: "ref",
        recoveryDedupToken: computeRecoveryDedupToken("run-does-not-exist", "mut-ghost-run", "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }).toThrow(LeaseLostError);
    expect(store.getIntent("mut-ghost-run")).toBeNull();

    // 37b: Lease in RELEASED state
    const RELEASED_LEASE_ID = "lease-released-48af";
    store.transaction((tx) => {
      tx.insertLease({
        leaseId: RELEASED_LEASE_ID,
        runId: TEST_RUN_ID,
        workerId: TEST_WORKER_ID,
        acquiredAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        releasedAt: new Date().toISOString(),
        state: "RELEASED",
      });
    });

    expect(() => {
      store.recordIntent({
        mutationId: "mut-released-lease",
        runId: TEST_RUN_ID,
        workerLeaseId: RELEASED_LEASE_ID,
        relativePath: "src/ghost.ts",
        canonicalPath: path.join(workspaceRoot, "src", "ghost.ts"),
        parentMutationId: null,
        pathMutationVersion: 1,
        baseDigest: sha256("x"),
        expectedResultingDigest: sha256("y"),
        snapshotRef: "ref",
        recoveryDedupToken: computeRecoveryDedupToken(TEST_RUN_ID, "mut-released-lease", "RECORDED"),
        lifecycleStatus: "RECORDED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }).toThrow(LeaseLostError);
    expect(store.getIntent("mut-released-lease")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 38: Phase 48AG.2.2 Fail-closed worker identity validation in editor
  // --------------------------------------------------------------------------
  it("Scenario 38: editor.applyEdit rejects missing, empty, whitespace, or invalid workerId with MissingMutationAuthorityError before modifying disk or writing snapshot files", () => {
    const filePath = path.join(workspaceRoot, "src", "auth-editor-fail.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "export const flag = false;\n";
    fs.writeFileSync(filePath, originalContent, "utf8");

    const snapshotDir = path.resolve(workspaceRoot, ".emerald", "snapshots", TEST_RUN_ID);
    const getSnapshotFiles = () => {
      if (!fs.existsSync(snapshotDir)) return [];
      return fs.readdirSync(snapshotDir);
    };

    const invalidWorkerIds = [
      { label: "missing", id: undefined as any },
      { label: "empty string", id: "" },
      { label: "whitespace only", id: "   \t\n" },
      { label: "invalid characters", id: "worker/with/slashes" },
    ];

    for (const testCase of invalidWorkerIds) {
      const snapshotsBefore = getSnapshotFiles();
      const intentsBefore = store.getIntentsForPath(TEST_RUN_ID, "src/auth-editor-fail.ts");

      expect(() => {
        editor.applyEdit(
          {
            path: "src/auth-editor-fail.ts",
            searchAnchor: "flag = false",
            replacementText: "flag = true",
          },
          workspaceRoot,
          {
            runId: TEST_RUN_ID,
            workerId: testCase.id,
            workerLeaseId: TEST_LEASE_ID,
            store,
            mutationId: `mut-invalid-worker-${testCase.label.replace(/\s+/g, "-")}`,
          }
        );
      }).toThrow(MissingMutationAuthorityError);

      // Verify disk content unchanged
      expect(fs.readFileSync(filePath, "utf8")).toBe(originalContent);

      // Verify no snapshot files were created
      const snapshotsAfter = getSnapshotFiles();
      expect(snapshotsAfter).toEqual(snapshotsBefore);

      // Verify zero new mutation intents persisted
      const intentsAfter = store.getIntentsForPath(TEST_RUN_ID, "src/auth-editor-fail.ts");
      expect(intentsAfter.length).toBe(intentsBefore.length);
    }
  });
});
