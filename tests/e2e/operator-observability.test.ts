import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import {
  explainRunFailure,
  redactSensitivePayload,
  getRunEventTimeline,
  inspectRun,
  isPathInsideCanonicalRoot,
} from "../../src/application/operator-observability.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

describe("Milestone 2.21 — Operator Observability & Durable Run Inspection", () => {
  let dir: string;
  let db: string;
  let artifactRoot: string;
  const cli = new EmeraldCli();
  const clock = new SystemClock();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-operator-obs-"));
    db = path.join(dir, "emerald.sqlite");
    artifactRoot = path.join(dir, "artifacts");
    fs.mkdirSync(artifactRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore temp dir cleanup contention on Windows
    }
  });

  function setupStore() {
    const store = new SqliteStateStore({ location: db });
    const coordinator = new RunCoordinator(store, clock);
    const nowIso = new Date().toISOString();
    // Register test workers
    for (const w of ["worker-1", "worker-err", "worker-active", "w-1"]) {
      coordinator.registerWorker({
        workerId: w,
        hostname: "test-host",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: nowIso,
        createdAt: nowIso,
      });
    }
    return { store, coordinator };
  }

  function insertRawEvent(event: {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: string;
    eventType: string;
    producer: string;
    payload: unknown;
  }) {
    const rawDb = new NodeDatabaseSync(db);
    try {
      rawDb
        .prepare(
          `INSERT INTO run_events (event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          event.eventId,
          event.runId,
          event.sequence,
          event.timestamp,
          event.eventType,
          event.producer,
          typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)
        );
    } finally {
      rawDb.close();
    }
  }

  // --------------------------------------------------------------------------
  // Scenario 1: Completed run inspection
  // --------------------------------------------------------------------------
  it("Scenario 1: Inspect a completed run with actions, verification, and artifacts", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, {
        operation: "test_op",
        task: "Fix calculator defect",
        idempotencyKey: "calc-fix-1",
      });
      runId = sub.runId;

      // Claim run
      const claimed = coordinator.claimRun(runId, "worker-1", 30000);
      coordinator.startRun(runId, "worker-1", claimed.lease.leaseId);

      // Record clean-room verification passing event
      insertRawEvent({
        eventId: "evt-v1",
        runId,
        sequence: 5,
        timestamp: new Date().toISOString(),
        eventType: "verification.completed",
        producer: "clean-room-verifier",
        payload: { passed: true, classification: "PASS" },
      });

      // Complete run
      coordinator.completeRun(runId, "worker-1", claimed.lease.leaseId, { success: true });

      // Export fixture artifact
      const attemptDir = path.join(artifactRoot, runId, "attempt-1");
      fs.mkdirSync(attemptDir, { recursive: true });
      fs.writeFileSync(
        path.join(attemptDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          runId,
          attempt: 1,
          totals: {
            changedFiles: 1,
            added: 0,
            modified: 1,
            deleted: 0,
            linesAdded: 3,
            linesRemoved: 1,
          },
        }),
        "utf8"
      );
      fs.writeFileSync(path.join(attemptDir, "patch.diff"), "--- a/calc.js\n+++ b/calc.js\n@@ -1 +1 @@\n-old\n+new", "utf8");
    } finally {
      store.close();
    }

    // Inspect via CLI text
    const textRes = await cli.run([
      "run",
      "inspect",
      "--db",
      db,
      "--run-id",
      runId,
      "--artifact-root",
      artifactRoot,
    ]);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain(`Run Inspection: ${runId}`);
    expect(textRes.output).toContain("Status:             COMPLETED");
    expect(textRes.output).toContain("Verification:");
    expect(textRes.output).toContain("Artifacts:");
    expect(textRes.output).toContain("Exported:         Yes");
    expect(textRes.output).toContain("Changed Files:    1 (+3 / -1 lines)");

    // Inspect via CLI JSON
    const jsonRes = await cli.run([
      "run",
      "inspect",
      "--db",
      db,
      "--run-id",
      runId,
      "--artifact-root",
      artifactRoot,
      "--json",
    ]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.run.runId).toBe(runId);
    expect(parsed.run.status).toBe("COMPLETED");
    expect(parsed.artifacts.exists).toBe(true);
    expect(parsed.artifacts.changedFiles).toBe(1);
    expect(parsed.failure).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Failed run inspection
  // --------------------------------------------------------------------------
  it("Scenario 2: Inspect a failed run and report failure diagnosis", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "fail_op" });
      runId = sub.runId;
      const claimed = coordinator.claimRun(runId, "worker-err", 30000);
      coordinator.startRun(runId, "worker-err", claimed.lease.leaseId);
      coordinator.failRun(
        runId,
        { code: "VERIFICATION_FAILED", message: "Unit tests failed on calculator.test.ts" },
        "worker-err",
        claimed.lease.leaseId
      );
    } finally {
      store.close();
    }

    const res = await cli.run(["run", "inspect", "--db", db, "--run-id", runId]);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("Status:             FAILED");
    expect(res.output).toContain("Failure Explanation:");
    expect(res.output).toContain("Failure Code:     VERIFICATION_FAILED");
    expect(res.output).toContain("Affected Stage:   VERIFICATION");
    expect(res.output).toContain("Recommended Next:");
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Cancelled run inspection
  // --------------------------------------------------------------------------
  it("Scenario 3: Inspect a cancelled run with reason", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "cancel_op" });
      runId = sub.runId;
      coordinator.cancelRun(runId, "Manual operator termination");
    } finally {
      store.close();
    }

    const res = await cli.run(["run", "inspect", "--db", db, "--run-id", runId, "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.run.status).toBe("CANCELLED");
    expect(parsed.failure.code).toBe("CANCELLED");
    expect(parsed.failure.stage).toBe("CONTROL");
    expect(parsed.failure.fact).toContain("Manual operator termination");
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Running run inspection
  // --------------------------------------------------------------------------
  it("Scenario 4: Inspect an actively running run without failure diagnosis", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "running_op" });
      runId = sub.runId;
      const claimed = coordinator.claimRun(runId, "worker-active", 60000);
      coordinator.startRun(runId, "worker-active", claimed.lease.leaseId);
    } finally {
      store.close();
    }

    const res = await cli.run(["run", "inspect", "--db", db, "--run-id", runId, "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.run.status).toBe("RUNNING");
    expect(parsed.run.worker.currentWorkerId).toBe("worker-active");
    expect(parsed.failure).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Unknown run ID
  // --------------------------------------------------------------------------
  it("Scenario 5: Unknown run ID fails closed with exit code 1", async () => {
    const { store } = setupStore();
    store.close();

    const res = await cli.run(["run", "inspect", "--db", db, "--run-id", "non-existent-run-id"]);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("Error: Run not found: non-existent-run-id");
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Parent-child task tree (multi-level hierarchy)
  // --------------------------------------------------------------------------
  it("Scenario 6: Inspect a multi-level parent-child task tree", async () => {
    const { store, coordinator } = setupStore();
    let rootTaskId: string;
    try {
      // Create root task
      const rootSub = submitDurableTask(store, coordinator, { task: "Root task", idempotencyKey: "root-1" });
      rootTaskId = rootSub.taskId;
      const rootClaimed = coordinator.claimRun(rootSub.runId, "w-1", 30000);
      coordinator.startRun(rootSub.runId, "w-1", rootClaimed.lease.leaseId);
      coordinator.completeRun(rootSub.runId, "w-1", rootClaimed.lease.leaseId, null);

      // Record router submission for root
      store.transaction((tx) => {
        (tx as any).insertRouterSubmission({
          submissionKey: "root-key",
          taskId: rootTaskId,
          runId: rootSub.runId,
          requestHash: "hash-root",
          createdAt: new Date().toISOString(),
        });
      });

      // Create child task 1
      const child1Sub = submitDurableTask(store, coordinator, { task: "Child task 1", idempotencyKey: "child-1" });
      store.transaction((tx) => {
        (tx as any).insertTaskRelation({
          childTaskId: child1Sub.taskId,
          parentTaskId: rootTaskId,
          depth: 1,
          ordinal: 0,
          createdAt: new Date().toISOString(),
        });
        (tx as any).insertRouterSubmission({
          submissionKey: "child1-key",
          taskId: child1Sub.taskId,
          runId: child1Sub.runId,
          requestHash: "hash-child1",
          createdAt: new Date().toISOString(),
        });
      });

      // Complete child 1
      const child1Claimed = coordinator.claimRun(child1Sub.runId, "w-1", 30000);
      coordinator.startRun(child1Sub.runId, "w-1", child1Claimed.lease.leaseId);
      coordinator.completeRun(child1Sub.runId, "w-1", child1Claimed.lease.leaseId, null);

      // Create grandchild under child 1 (deferQueue: true so it stays CREATED and eligible)
      const grandSub = submitDurableTask(store, coordinator, {
        task: "Grandchild task",
        idempotencyKey: "grand-1",
        deferQueue: true,
      });
      store.transaction((tx) => {
        (tx as any).insertTaskRelation({
          childTaskId: grandSub.taskId,
          parentTaskId: child1Sub.taskId,
          depth: 2,
          ordinal: 0,
          createdAt: new Date().toISOString(),
        });
        (tx as any).insertRouterSubmission({
          submissionKey: "grand-key",
          taskId: grandSub.taskId,
          runId: grandSub.runId,
          requestHash: "hash-grand",
          createdAt: new Date().toISOString(),
        });
      });
    } finally {
      store.close();
    }

    const textRes = await cli.run(["task", "tree", "--db", db, "--task-id", rootTaskId]);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain(`Task Tree: ${rootTaskId}`);
    expect(textRes.output).toContain("3 node(s)");
    expect(textRes.output).toContain("DISPATCHED");
    expect(textRes.output).toContain("READY - Parent task");

    const jsonRes = await cli.run(["task", "tree", "--db", db, "--task-id", rootTaskId, "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.totalNodes).toBe(3);
    expect(parsed.tree.children).toHaveLength(1);
    expect(parsed.tree.children[0].children).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Partially completed task tree (dispatch eligibility)
  // --------------------------------------------------------------------------
  it("Scenario 7: Inspect partially completed task tree reporting waiting vs ready", async () => {
    const { store, coordinator } = setupStore();
    let rootTaskId: string;
    try {
      // Root task is still RUNNING
      const rootSub = submitDurableTask(store, coordinator, { task: "In-progress root" });
      rootTaskId = rootSub.taskId;
      const rootClaimed = coordinator.claimRun(rootSub.runId, "w-1", 30000);
      coordinator.startRun(rootSub.runId, "w-1", rootClaimed.lease.leaseId);

      store.transaction((tx) => {
        (tx as any).insertRouterSubmission({
          submissionKey: "root-key-prog",
          taskId: rootTaskId,
          runId: rootSub.runId,
          requestHash: "hash-prog",
          createdAt: new Date().toISOString(),
        });
      });

      // Child task is created, waiting for root
      const childSub = submitDurableTask(store, coordinator, { task: "Waiting child" });
      store.transaction((tx) => {
        (tx as any).insertTaskRelation({
          childTaskId: childSub.taskId,
          parentTaskId: rootTaskId,
          depth: 1,
          ordinal: 0,
          createdAt: new Date().toISOString(),
        });
        (tx as any).insertRouterSubmission({
          submissionKey: "child-wait-key",
          taskId: childSub.taskId,
          runId: childSub.runId,
          requestHash: "hash-child-wait",
          createdAt: new Date().toISOString(),
        });
      });
    } finally {
      store.close();
    }

    const res = await cli.run(["task", "tree", "--db", db, "--task-id", rootTaskId, "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.tree.dispatchEligibility).toBe("DISPATCHED");
    expect(parsed.tree.children[0].dispatchEligibility).toBe("WAITING_PARENT");
    expect(parsed.tree.children[0].eligibilityReason).toContain("still in progress");
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Orphaned task
  // --------------------------------------------------------------------------
  it("Scenario 8: Inspect an orphaned task (task without router submission or runs)", async () => {
    const { store } = setupStore();
    const orphanTaskId = "orphan-task-999";
    try {
      store.transaction((tx) => {
        tx.insertTask({
          taskId: orphanTaskId,
          title: "Standalone unrouted task",
          description: "No router submission",
          inputPayload: JSON.stringify({}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
    } finally {
      store.close();
    }

    const res = await cli.run(["task", "tree", "--db", db, "--task-id", orphanTaskId, "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.totalNodes).toBe(1);
    expect(parsed.tree.runId).toBeNull();
    expect(parsed.tree.dispatchEligibility).toBe("UNROUTED");
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Empty event history
  // --------------------------------------------------------------------------
  it("Scenario 9: Inspect empty event history returns valid empty list", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "empty_events" });
      runId = sub.runId;
      // Clear events table for this test
      store.transaction((tx) => {
        (tx as any).db.exec("DELETE FROM run_events");
      });
    } finally {
      store.close();
    }

    const textRes = await cli.run(["run", "events", "--db", db, "--run-id", runId]);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain("Total Events: 0 | Returned: 0");

    const jsonRes = await cli.run(["run", "events", "--db", db, "--run-id", runId, "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.totalEvents).toBe(0);
    expect(parsed.events).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Paginated event history
  // --------------------------------------------------------------------------
  it("Scenario 10: Inspect paginated event history with --limit and --after-sequence", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "paginated_events" });
      runId = sub.runId;

      // Existing events: seq 1 (created), seq 2 (queued). Add seq 3 to 16.
      for (let i = 3; i <= 16; i++) {
        insertRawEvent({
          eventId: `evt-${i}`,
          runId,
          sequence: i,
          timestamp: new Date().toISOString(),
          eventType: "agent.step.started",
          producer: "agent",
          payload: { stepNumber: i },
        });
      }
    } finally {
      store.close();
    }

    const res = await cli.run([
      "run",
      "events",
      "--db",
      db,
      "--run-id",
      runId,
      "--after-sequence",
      "5",
      "--limit",
      "4",
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.afterSequence).toBe(5);
    expect(parsed.limit).toBe(4);
    expect(parsed.returnedCount).toBe(4);
    expect(parsed.events[0].sequence).toBe(6);
    expect(parsed.events[3].sequence).toBe(9);
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Deterministic sequence ordering
  // --------------------------------------------------------------------------
  it("Scenario 11: Verify deterministic sequence ordering regardless of timestamp insertion", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "ordering_test" });
      runId = sub.runId;

      // Existing events: seq 1 (created), seq 2 (queued). Insert seq 3 and 4 out of order by timestamp.
      insertRawEvent({
        eventId: "evt-seq-3",
        runId,
        sequence: 3,
        timestamp: "2026-11-05T12:00:00.000Z",
        eventType: "worker.claimed",
        producer: "worker",
        payload: {},
      });
      insertRawEvent({
        eventId: "evt-seq-4",
        runId,
        sequence: 4,
        timestamp: "2026-11-05T11:00:00.000Z", // earlier timestamp, but higher sequence
        eventType: "tool.requested",
        producer: "agent",
        payload: {},
      });
    } finally {
      store.close();
    }

    const report = getRunEventTimeline({ dbPath: db, runId });
    expect(report.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Explain known failure codes
  // --------------------------------------------------------------------------
  it("Scenario 12: Explain all known failure codes deterministically", () => {
    const baseRun = {
      runId: "run-diag",
      taskId: "task-diag",
      version: 1,
      attemptCount: 1,
      maxAttempts: 3,
      timeoutMs: 30000,
      idempotencyKey: null,
      currentWorkerId: "w-1",
      leaseId: "l-1",
      leaseExpiresAt: null,
      resultPayload: null,
      contractBinding: null,
      maxOutputBytes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 1. LeaseLost
    const expLost = explainRunFailure(
      { ...baseRun, status: "FAILED", errorPayload: { code: "LEASE_LOST", message: "Fencing token mismatch" } },
      []
    );
    expect(expLost?.code).toBe("LEASE_LOST");
    expect(expLost?.stage).toBe("EXECUTION");

    // 2. LeaseExpired
    const expExp = explainRunFailure(
      { ...baseRun, status: "FAILED", errorPayload: { code: "LEASE_EXPIRED", message: "Lease TTL expired" } },
      []
    );
    expect(expExp?.code).toBe("LEASE_EXPIRED");
    expect(expExp?.stage).toBe("EXECUTION");

    // 3. VerificationFailed
    const expVer = explainRunFailure(
      { ...baseRun, status: "FAILED", errorPayload: { code: "VERIFICATION_FAILED", message: "F2P tests failed" } },
      []
    );
    expect(expVer?.code).toBe("VERIFICATION_FAILED");
    expect(expVer?.stage).toBe("VERIFICATION");

    // 4. ReplayBlockedUncertainPriorAttempt
    const expReplay = explainRunFailure(
      {
        ...baseRun,
        status: "FAILED",
        errorPayload: { code: "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT", message: "Prior attempt outcome uncertain" },
      },
      []
    );
    expect(expReplay?.code).toBe("REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT");
    expect(expReplay?.stage).toBe("RECOVERY");

    // 5. SQLite busy
    const expBusy = explainRunFailure(
      { ...baseRun, status: "FAILED", errorPayload: { code: "SQLITE_BUSY", message: "database is locked" } },
      []
    );
    expect(expBusy?.code).toBe("SQLITE_BUSY");
    expect(expBusy?.stage).toBe("PERSISTENCE");

    // 6. Model provider failure
    const expModel = explainRunFailure(
      { ...baseRun, status: "FAILED", errorPayload: { code: "MODEL_PROVIDER_FAILURE", message: "Ollama timeout" } },
      []
    );
    expect(expModel?.code).toBe("MODEL_PROVIDER_FAILURE");
    expect(expModel?.stage).toBe("REASONING");

    // 7. Timed out
    const expTimeout = explainRunFailure({ ...baseRun, status: "TIMED_OUT", errorPayload: null }, []);
    expect(expTimeout?.code).toBe("TIMED_OUT");
    expect(expTimeout?.stage).toBe("EXECUTION");

    // 8. Cancelled
    const expCancel = explainRunFailure({ ...baseRun, status: "CANCELLED", errorPayload: { reason: "User stopped" } }, []);
    expect(expCancel?.code).toBe("CANCELLED");
    expect(expCancel?.stage).toBe("CONTROL");
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Handle unknown failure codes without inventing explanations
  // --------------------------------------------------------------------------
  it("Scenario 13: Handle unknown failure codes cleanly as UNKNOWN_FAILURE without speculating", () => {
    const baseRun = {
      runId: "run-unknown",
      taskId: "task-unknown",
      version: 1,
      attemptCount: 1,
      maxAttempts: 3,
      timeoutMs: 30000,
      idempotencyKey: null,
      currentWorkerId: "w-1",
      leaseId: "l-1",
      leaseExpiresAt: null,
      resultPayload: null,
      contractBinding: null,
      maxOutputBytes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const exp = explainRunFailure(
      { ...baseRun, status: "FAILED", errorPayload: { code: "CUSTOM_UNKNOWN_CODE_99", message: "Unusual cosmic ray error" } },
      []
    );
    expect(exp?.code).toBe("UNKNOWN_FAILURE");
    expect(exp?.stage).toBe("UNKNOWN");
    expect(exp?.inference).toContain("Unclassified failure code");
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Redact sensitive event payload content
  // --------------------------------------------------------------------------
  it("Scenario 14: Redact sensitive event payload content and truncate large strings", () => {
    const rawPayload = {
      apiKey: "secret-key-12345",
      userToken: "bearer-token-abc",
      password: "my-password",
      authorization: "Bearer eyJhbGciOi...",
      prompt: "Full system instructions and secret guidance",
      regularField: "Normal value",
      giantText: "A".repeat(500),
    };

    const sanitized = redactSensitivePayload(rawPayload) as any;
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect(sanitized.userToken).toBe("[REDACTED]");
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.authorization).toBe("[REDACTED]");
    expect(sanitized.prompt).toBe("[REDACTED]");
    expect(sanitized.regularField).toBe("Normal value");
    expect(sanitized.giantText).toContain("... [truncated 340 chars]");
  });

  // --------------------------------------------------------------------------
  // Scenario 15: Run inspection after closing and reopening SQLite
  // --------------------------------------------------------------------------
  it("Scenario 15: Run inspection works seamlessly across process/connection restart", async () => {
    let runId: string;
    {
      const { store, coordinator } = setupStore();
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "restart_test" });
        runId = sub.runId;
      } finally {
        store.close();
      }
    }

    // Inspect through new connection
    const res = await cli.run(["run", "inspect", "--db", db, "--run-id", runId, "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.run.runId).toBe(runId);
    expect(parsed.run.status).toBe("QUEUED");
  });

  // --------------------------------------------------------------------------
  // Scenario 16: Verify inspection does not modify durable state
  // --------------------------------------------------------------------------
  it("Scenario 16: Verify inspection commands do not modify durable state", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    let taskId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "immutable_test" });
      runId = sub.runId;
      taskId = sub.taskId;
    } finally {
      store.close();
    }

    const statBefore = fs.statSync(db);

    // Run all 3 inspection commands
    await cli.run(["run", "inspect", "--db", db, "--run-id", runId]);
    await cli.run(["task", "tree", "--db", db, "--task-id", taskId]);
    await cli.run(["run", "events", "--db", db, "--run-id", runId]);

    const statAfter = fs.statSync(db);
    expect(statAfter.size).toBe(statBefore.size);

    // Verify row count and status unchanged
    const storeVerify = new SqliteStateStore({ location: db });
    try {
      const run = storeVerify.getRun(runId);
      expect(run?.status).toBe("QUEUED");
      expect(run?.version).toBe(2);
    } finally {
      storeVerify.close();
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 17: Inspection fails closed and does not create missing DB
  // --------------------------------------------------------------------------
  it("Scenario 17: Inspection fails closed and never creates a missing DB file", async () => {
    const nonExistentDb = path.join(dir, "absent_db.sqlite");
    expect(fs.existsSync(nonExistentDb)).toBe(false);

    const res1 = await cli.run(["run", "inspect", "--db", nonExistentDb, "--run-id", "some-run"]);
    expect(res1.exitCode).toBe(1);
    expect(res1.output).toContain("database not found (inspect never creates one)");
    expect(fs.existsSync(nonExistentDb)).toBe(false);

    const res2 = await cli.run(["task", "tree", "--db", nonExistentDb, "--task-id", "some-task"]);
    expect(res2.exitCode).toBe(1);
    expect(res2.output).toContain("database not found (inspect never creates one)");
    expect(fs.existsSync(nonExistentDb)).toBe(false);

    const res3 = await cli.run(["run", "events", "--db", nonExistentDb, "--run-id", "some-run"]);
    expect(res3.exitCode).toBe(1);
    expect(res3.output).toContain("database not found (inspect never creates one)");
    expect(fs.existsSync(nonExistentDb)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario 18: Inspection cannot dispatch or recover a run
  // --------------------------------------------------------------------------
  it("Scenario 18: Inspection cannot trigger dispatch, acquire leases, or invoke recovery", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "dispatch_test" });
      runId = sub.runId;
    } finally {
      store.close();
    }

    await cli.run(["run", "inspect", "--db", db, "--run-id", runId]);

    const storeVerify = new SqliteStateStore({ location: db });
    try {
      const run = storeVerify.getRun(runId);
      expect(run?.status).toBe("QUEUED");
      expect(run?.leaseId).toBeNull();
      expect(run?.currentWorkerId).toBeNull();
    } finally {
      storeVerify.close();
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 19: Stable, valid JSON output across all commands
  // --------------------------------------------------------------------------
  it("Scenario 19: Verify JSON output is stable, valid, and machine-parseable across all commands", async () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    let taskId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "json_stability_test" });
      runId = sub.runId;
      taskId = sub.taskId;
    } finally {
      store.close();
    }

    const r1 = await cli.run(["run", "inspect", "--db", db, "--run-id", runId, "--json"]);
    expect(r1.exitCode).toBe(0);
    expect(() => JSON.parse(r1.output)).not.toThrow();

    const r2 = await cli.run(["task", "tree", "--db", db, "--task-id", taskId, "--json"]);
    expect(r2.exitCode).toBe(0);
    expect(() => JSON.parse(r2.output)).not.toThrow();

    const r3 = await cli.run(["run", "events", "--db", db, "--run-id", runId, "--json"]);
    expect(r3.exitCode).toBe(0);
    expect(() => JSON.parse(r3.output)).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // Scenario 20: Bounded memory under large event histories
  // --------------------------------------------------------------------------
  it("Scenario 20: Large event histories are bounded via pagination and limit bounds", () => {
    const { store, coordinator } = setupStore();
    let runId: string;
    try {
      const sub = submitDurableTask(store, coordinator, { operation: "large_events" });
      runId = sub.runId;

      // Clear initial 2 events and insert exactly 100 events (seq 1 to 100)
      const rawDb = new NodeDatabaseSync(db);
      try {
        rawDb.prepare(`DELETE FROM run_events WHERE run_id = ?`).run(runId);
      } finally {
        rawDb.close();
      }

      for (let i = 1; i <= 100; i++) {
        insertRawEvent({
          eventId: `evt-bulk-${i}`,
          runId,
          sequence: i,
          timestamp: new Date().toISOString(),
          eventType: "agent.step.started",
          producer: "agent",
          payload: { step: i, data: "small" },
        });
      }
    } finally {
      store.close();
    }

    // Default limit should be respected
    const repDefault = getRunEventTimeline({ dbPath: db, runId, limit: 10 });
    expect(repDefault.totalEvents).toBe(100);
    expect(repDefault.returnedCount).toBe(10);
    expect(repDefault.events).toHaveLength(10);

    // After sequence boundary
    const repPaged = getRunEventTimeline({ dbPath: db, runId, limit: 5, afterSequence: 95 });
    expect(repPaged.returnedCount).toBe(5);
    expect(repPaged.events.map((e) => e.sequence)).toEqual([96, 97, 98, 99, 100]);
  });

  // --------------------------------------------------------------------------
  // Scenario 21: Artifact symlink and canonical path traversal security
  // --------------------------------------------------------------------------
  describe("Artifact canonical root boundary and symlink security", () => {
    function tryCreateSymlink(target: string, linkPath: string, type: "file" | "dir" | "junction"): boolean {
      try {
        fs.symlinkSync(target, linkPath, type);
        return true;
      } catch {
        return false;
      }
    }

    const dirType = process.platform === "win32" ? "junction" : "dir";

    it("Case 1: Artifact root is a normal directory", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case1" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const runDir = path.join(artifactRoot, runId, "attempt-1");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "manifest.json"),
        JSON.stringify({ totals: { changedFiles: 1, linesAdded: 5, linesRemoved: 0 } })
      );

      const rep = inspectRun({ dbPath: db, runId, artifactRoot });
      expect(rep.artifacts.exists).toBe(true);
      expect(rep.artifacts.attempt).toBe(1);
      expect(rep.artifacts.totals?.changedFiles).toBe(1);
    });

    it("Case 2: Artifact root itself is a symlink", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case2" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const realRoot = path.join(dir, "real-artifacts");
      fs.mkdirSync(realRoot, { recursive: true });
      const runDir = path.join(realRoot, runId, "attempt-1");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "manifest.json"),
        JSON.stringify({ totals: { changedFiles: 2, linesAdded: 10, linesRemoved: 1 } })
      );

      const symlinkRoot = path.join(dir, "symlink-artifacts");
      const created = tryCreateSymlink(realRoot, symlinkRoot, dirType);
      if (created) {
        const rep = inspectRun({ dbPath: db, runId, artifactRoot: symlinkRoot });
        expect(rep.artifacts.exists).toBe(true);
        expect(rep.artifacts.totals?.changedFiles).toBe(2);
      }
    });

    it("Case 3: <artifact-root>/<run-id> is a symlink pointing outside the root", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case3" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const outsideDir = path.join(dir, "outside-secret-dir");
      fs.mkdirSync(path.join(outsideDir, "attempt-1"), { recursive: true });
      fs.writeFileSync(
        path.join(outsideDir, "attempt-1", "manifest.json"),
        JSON.stringify({ totals: { changedFiles: 99 } })
      );

      const runDir = path.join(artifactRoot, runId);
      const created = tryCreateSymlink(outsideDir, runDir, dirType);
      if (created) {
        const rep = inspectRun({ dbPath: db, runId, artifactRoot });
        // Must reject and not follow outside symlink
        expect(rep.artifacts.exists).toBe(false);
      }
    });

    it("Case 4: An attempt-N directory is a symlink pointing outside the root", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case4" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const outsideAttempt = path.join(dir, "outside-attempt");
      fs.mkdirSync(outsideAttempt, { recursive: true });
      fs.writeFileSync(
        path.join(outsideAttempt, "manifest.json"),
        JSON.stringify({ totals: { changedFiles: 77 } })
      );

      const runDir = path.join(artifactRoot, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const attempt1 = path.join(runDir, "attempt-1");
      const created = tryCreateSymlink(outsideAttempt, attempt1, dirType);
      if (created) {
        const rep = inspectRun({ dbPath: db, runId, artifactRoot });
        // Must reject attempt directory symlink pointing outside root
        expect(rep.artifacts.exists).toBe(false);
      }
    });

    it("Case 5: manifest.json is a symlink pointing outside the root", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case5" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const outsideFile = path.join(dir, "secret-manifest.json");
      fs.writeFileSync(outsideFile, JSON.stringify({ totals: { changedFiles: 88 } }));

      const runDir = path.join(artifactRoot, runId, "attempt-1");
      fs.mkdirSync(runDir, { recursive: true });
      const manifestPath = path.join(runDir, "manifest.json");
      const created = tryCreateSymlink(outsideFile, manifestPath, "file");

      if (created) {
        const rep = inspectRun({ dbPath: db, runId, artifactRoot });
        expect(rep.artifacts.exists).toBe(false);
      } else {
        // When OS unprivileged file symlink creation fails, verify canonical checker rejects outside path
        expect(isPathInsideCanonicalRoot(outsideFile, artifactRoot)).toBe(false);
      }
    });

    it("Case 6: A symlink points to another location inside the root", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case6" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const sharedDir = path.join(artifactRoot, "shared-attempt");
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, "manifest.json"),
        JSON.stringify({ totals: { changedFiles: 3, linesAdded: 2, linesRemoved: 1 } })
      );

      const runDir = path.join(artifactRoot, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const attempt1 = path.join(runDir, "attempt-1");
      const created = tryCreateSymlink(sharedDir, attempt1, dirType);
      if (created) {
        const rep = inspectRun({ dbPath: db, runId, artifactRoot });
        // Allowed because destination is strictly inside canonical artifact root
        expect(rep.artifacts.exists).toBe(true);
        expect(rep.artifacts.totals?.changedFiles).toBe(3);
      }
    });

    it("Case 7: An artifact directory does not exist", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case7" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      const nonExistentRoot = path.join(dir, "does-not-exist");
      const rep = inspectRun({ dbPath: db, runId, artifactRoot: nonExistentRoot });
      expect(rep.artifacts.exists).toBe(false);
      expect(rep.artifacts.manifestPath).toBeNull();
    });

    it("Case 8: A manifest is missing or malformed", () => {
      const { store, coordinator } = setupStore();
      let runId: string;
      try {
        const sub = submitDurableTask(store, coordinator, { operation: "art_case8" });
        runId = sub.runId;
      } finally {
        store.close();
      }

      // Missing manifest
      const runDir = path.join(artifactRoot, runId, "attempt-1");
      fs.mkdirSync(runDir, { recursive: true });
      const rep1 = inspectRun({ dbPath: db, runId, artifactRoot });
      expect(rep1.artifacts.exists).toBe(false);

      // Malformed manifest
      fs.writeFileSync(path.join(runDir, "manifest.json"), "{ invalid json: 123");
      const rep2 = inspectRun({ dbPath: db, runId, artifactRoot });
      expect(rep2.artifacts.exists).toBe(false);
    });
  });
});
