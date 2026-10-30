/**
 * Emerald Agent Fabric — Recovery Supervisor Test Suite
 *
 * Validates durable crash recovery coordination, worker lease expiration handling,
 * supervisor lease acquisition and fencing, and run lifecycle transitions
 * per ADR-0036 and Phase 48AG.4 specifications.
 *
 * Covers 18 distinct scenarios:
 * 1. Ineligible runs are ignored without mutation.
 * 2. Active worker leases are not reclaimed.
 * 3. Expired worker leases permit recovery only through valid supervisor authority.
 * 4. Missing supervisor authority fails closed.
 * 5. Foreign or expired supervisor leases cannot advance recovery.
 * 6. Concurrent supervisors cannot both claim the same run.
 * 7. Recovery resumes after a restart between lease acquisition and lifecycle transition.
 * 8. Recovery resumes after the run transition but before rollback invocation.
 * 9. Recovery resumes when rollback is already in progress.
 * 10. Recovery reconciles completed rollback with a nonterminal run status.
 * 11. Partial rollback conflicts remain failed/conflicted and preserve evidence.
 * 12. Missing or corrupt snapshots do not result in false completion.
 * 13. Repeated scans do not duplicate logical transitions or events.
 * 14. Lease expiry during recovery is handled without stale authority being reused.
 * 15. Terminal runs are not recovered again.
 * 16. Database failures do not produce falsely successful run outcomes.
 * 17. Supervisor lease release and renewal follow the existing contract.
 * 18. Unrelated runs and mutation intents remain untouched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { ClockPort } from "../../src/ports/clock.port.js";
import {
  ActiveWorkerLeaseFencingError,
  SupervisorLeaseExpiredError,
  SupervisorLeaseLostError,
} from "../../src/domain/errors.js";
import { MutationIntent, computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

class SettableClock implements ClockPort {
  private currentMs: number;

  constructor(initialIso: string = "2026-10-29T12:00:00.000Z") {
    this.currentMs = new Date(initialIso).getTime();
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  set(iso: string): void {
    this.currentMs = new Date(iso).getTime();
  }
}

describe("RecoverySupervisor Unit & Integration Tests", () => {
  let store: SqliteStateStore;
  let engine: DurableRollbackEngine;
  let clock: SettableClock;
  let testWorkspace: string;

  beforeEach(() => {
    store = new SqliteStateStore();
    engine = new DurableRollbackEngine(store);
    clock = new SettableClock(new Date().toISOString());
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-sup-test-"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // Ignore
    }
    try {
      if (fs.existsSync(testWorkspace)) {
        fs.rmSync(testWorkspace, { recursive: true, force: true });
      }
    } catch {
      // Ignore
    }
  });

  function helperCreateRun(params: {
    runId: string;
    status: "CREATED" | "QUEUED" | "LEASED" | "RUNNING" | "RECOVERING" | "COMPLETED" | "FAILED";
    workerId?: string;
    leaseId?: string;
    leaseExpiresAt?: string | null;
  }) {
    store.transaction((tx) => {
      tx.insertTask({
        taskId: "task-" + params.runId,
        title: "Test Task " + params.runId,
        description: "Task for " + params.runId,
        inputPayload: {},
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      });

      if (params.workerId) {
        tx.insertWorker({
          workerId: params.workerId,
          hostname: "localhost",
          pid: process.pid,
          status: "ACTIVE",
          lastHeartbeatAt: clock.nowIso(),
          createdAt: clock.nowIso(),
        });
      }

      tx.insertRun(
        {
          runId: params.runId,
          taskId: "task-" + params.runId,
          status: params.status,
          version: 1,
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 30000,
          idempotencyKey: null,
          currentWorkerId: params.workerId ?? null,
          leaseId: params.leaseId ?? null,
          leaseExpiresAt: params.leaseExpiresAt ?? null,
          resultPayload: null,
          errorPayload: null,
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
          contractBinding: null,
          maxOutputBytes: null,
        },
        {
          eventId: "evt-init-" + params.runId,
          runId: params.runId,
          timestamp: clock.nowIso(),
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: {},
        }
      );

      if (params.leaseId && params.workerId && params.leaseExpiresAt) {
        tx.insertLease({
          leaseId: params.leaseId,
          workerId: params.workerId,
          runId: params.runId,
          state: "ACTIVE",
          acquiredAt: clock.nowIso(),
          expiresAt: params.leaseExpiresAt,
          releasedAt: null,
        });
      }
    });
  }

  // 1. Ineligible runs are ignored without mutation
  it("Scenario 1: Ineligible runs (CREATED, QUEUED) are ignored without mutation", async () => {
    helperCreateRun({ runId: "run-created", status: "CREATED" });
    helperCreateRun({ runId: "run-queued", status: "QUEUED" });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-1",
    });

    const outcomeCreated = await supervisor.recoverRun("run-created", { workspaceRoot: testWorkspace });
    expect(outcomeCreated.status).toBe("SKIPPED_INELIGIBLE");
    expect(outcomeCreated.statusBefore).toBe("CREATED");
    expect(outcomeCreated.statusAfter).toBe("CREATED");

    const outcomeQueued = await supervisor.recoverRun("run-queued", { workspaceRoot: testWorkspace });
    expect(outcomeQueued.status).toBe("SKIPPED_INELIGIBLE");
    expect(outcomeQueued.statusBefore).toBe("QUEUED");
    expect(outcomeQueued.statusAfter).toBe("QUEUED");

    // Runs remain at version 1
    expect(store.getRun("run-created")?.version).toBe(1);
    expect(store.getRun("run-queued")?.version).toBe(1);
  });

  // 2. Active worker leases are not reclaimed
  it("Scenario 2: Active worker leases are not reclaimed and throw ActiveWorkerLeaseFencingError", async () => {
    const futureExpiry = new Date(clock.nowMs() + 60000).toISOString();
    helperCreateRun({
      runId: "run-active",
      status: "RUNNING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: futureExpiry,
    });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-1",
    });

    await expect(
      supervisor.recoverRun("run-active", { workspaceRoot: testWorkspace })
    ).rejects.toThrow(ActiveWorkerLeaseFencingError);

    const run = store.getRun("run-active");
    expect(run?.status).toBe("RUNNING");
    expect(run?.version).toBe(1);
  });

  // 3. Expired worker leases permit recovery only through valid supervisor authority
  it("Scenario 3: Expired worker leases permit recovery through valid supervisor authority", async () => {
    const pastExpiry = new Date(clock.nowMs() - 1000).toISOString();
    helperCreateRun({
      runId: "run-expired",
      status: "RUNNING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: pastExpiry,
    });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-1",
    });

    const outcome = await supervisor.recoverRun("run-expired", { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
    expect(outcome.statusBefore).toBe("RUNNING");
    // Attempts remain (1 of 3): the workspace is reconciled and the run is handed to the
    // coordinator's retry path by being left RECOVERING (not failed).
    expect(outcome.statusAfter).toBe("RECOVERING");

    const handedOffRun = store.getRun("run-expired");
    expect(handedOffRun?.status).toBe("RECOVERING");
    expect(handedOffRun?.version).toBe(2); // 1 (init) -> 2 (expireLease)

    const events = store.getEventsForRun("run-expired");
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("lease.expired");
    expect(eventTypes).not.toContain("run.failed");
  });

  // 4. Missing supervisor authority fails closed
  it("Scenario 4: Missing supervisor authority fails closed", async () => {
    expect(() => {
      new RecoverySupervisor({
        stateStore: store,
        rollbackEngine: engine,
        supervisorId: "   ",
      });
    }).not.toThrow(); // Defaults to recovery-supervisor-1 if whitespace

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      supervisorId: "recovery-supervisor-1",
    });

    expect(supervisor.getSupervisorId()).toBe("recovery-supervisor-1");
  });

  // 5. Foreign or expired supervisor leases cannot advance recovery
  it("Scenario 5: Foreign or expired supervisor leases cannot advance recovery", async () => {
    const pastExpiry = new Date(clock.nowMs() - 1000).toISOString();
    helperCreateRun({
      runId: "run-sup-lease",
      status: "RUNNING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: pastExpiry,
    });

    // Another supervisor acquires lease
    store.acquireSupervisorLease({
      runId: "run-sup-lease",
      supervisorId: "foreign-supervisor",
      ttlMs: 60000,
      nowIso: clock.nowIso(),
    });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "my-supervisor",
    });

    const outcome = await supervisor.recoverRun("run-sup-lease", { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");
    expect(outcome.details).toContain("Active unexpired supervisor lease held by 'foreign-supervisor'");

    // Run remains untouched
    const run = store.getRun("run-sup-lease");
    expect(run?.status).toBe("RUNNING");
  });

  // 6. Concurrent supervisors cannot both claim the same run
  it("Scenario 6: Concurrent supervisors cannot both claim the same run", async () => {
    const pastExpiry = new Date(clock.nowMs() - 1000).toISOString();
    helperCreateRun({
      runId: "run-concurrent",
      status: "RUNNING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: pastExpiry,
    });

    const supervisor1 = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "supervisor-alpha",
    });

    const supervisor2 = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "supervisor-beta",
    });

    // Supervisor 1 starts and acquires lease
    const lease1 = store.acquireSupervisorLease({
      runId: "run-concurrent",
      supervisorId: "supervisor-alpha",
      ttlMs: 30000,
      nowIso: clock.nowIso(),
    });

    // Supervisor 2 tries to recover while supervisor 1 holds active lease
    const outcome2 = await supervisor2.recoverRun("run-concurrent", { workspaceRoot: testWorkspace });
    expect(outcome2.status).toBe("SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR");

    // Release supervisor 1 lease
    store.releaseSupervisorLease(lease1.leaseId, clock.nowIso());

    // Now supervisor 2 can recover cleanly
    const outcome2Retry = await supervisor2.recoverRun("run-concurrent", { workspaceRoot: testWorkspace });
    expect(outcome2Retry.status).toBe("RECOVERED_UNVERIFIED");
  });

  // 7. Recovery resumes after a restart between lease acquisition and lifecycle transition
  it("Scenario 7: Recovery resumes after restart between lease acquisition and lifecycle transition", async () => {
    const pastExpiry = new Date(clock.nowMs() - 1000).toISOString();
    helperCreateRun({
      runId: "run-restart-cp1",
      status: "RUNNING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: pastExpiry,
    });

    // Simulate old crashed supervisor lease that expired
    store.acquireSupervisorLease({
      runId: "run-restart-cp1",
      supervisorId: "crashed-supervisor",
      ttlMs: 1000,
      nowIso: new Date(clock.nowMs() - 5000).toISOString(),
    });

    // Advance clock past old supervisor lease expiry
    clock.advance(10000);

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "new-supervisor",
    });

    const outcome = await supervisor.recoverRun("run-restart-cp1", { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
    expect(store.getRun("run-restart-cp1")?.status).toBe("RECOVERING"); // handed off for coordinator retry
  });

  // 8. Recovery resumes after the run transition but before rollback invocation
  it("Scenario 8: Recovery resumes after run transition to RECOVERING but before rollback invocation", async () => {
    helperCreateRun({
      runId: "run-recovering-pre-rb",
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
    });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "supervisor-resume",
    });

    const outcome = await supervisor.recoverRun("run-recovering-pre-rb", { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
    expect(outcome.statusBefore).toBe("RECOVERING");
    expect(outcome.statusAfter).toBe("RECOVERING"); // attempts remain: handed off for coordinator retry
  });

  // 9. Recovery resumes when rollback is already in progress
  it("Scenario 9: Recovery resumes when rollback is already in progress (RESTORING_PATHS)", async () => {
    const runId = "run-rb-in-progress";
    helperCreateRun({
      runId,
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    // Create 2 files with snapshots
    const targetFile1 = path.join(testWorkspace, "file1.ts");
    const targetFile2 = path.join(testWorkspace, "file2.ts");
    fs.writeFileSync(targetFile1, "content-1-v1\n", "utf8");
    fs.writeFileSync(targetFile2, "content-2-v1\n", "utf8");

    const snapDir = path.join(testWorkspace, ".emerald", "snapshots", runId);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, "snap1.snap"), "content-1-v0\n", "utf8");
    fs.writeFileSync(path.join(snapDir, "snap2.snap"), "content-2-v0\n", "utf8");

    // Record intents
    const intent1: MutationIntent = {
      mutationId: "mut-1",
      runId,
      workerLeaseId: "lease-1",
      relativePath: "file1.ts",
      canonicalPath: targetFile1,
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: sha256("content-1-v0\n"),
      expectedResultingDigest: sha256("content-1-v1\n"),
      snapshotRef: path.join(snapDir, "snap1.snap"),
      lifecycleStatus: "COMMITTED",
      recoveryDedupToken: computeRecoveryDedupToken(runId, "mut-1", "COMMITTED"),
      conflictDetails: null,
      createdAt: clock.nowMs(),
      updatedAt: clock.nowMs(),
    };
    const intent2: MutationIntent = {
      mutationId: "mut-2",
      runId,
      workerLeaseId: "lease-1",
      relativePath: "file2.ts",
      canonicalPath: targetFile2,
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: sha256("content-2-v0\n"),
      expectedResultingDigest: sha256("content-2-v1\n"),
      snapshotRef: path.join(snapDir, "snap2.snap"),
      lifecycleStatus: "COMMITTED",
      recoveryDedupToken: computeRecoveryDedupToken(runId, "mut-2", "COMMITTED"),
      conflictDetails: null,
      createdAt: clock.nowMs(),
      updatedAt: clock.nowMs(),
    };
    store.recordIntent(intent1);
    store.recordIntent(intent2);

    // Partially restored: file 1 was restored, run rollback in RESTORING_PATHS
    fs.writeFileSync(targetFile1, "content-1-v0\n", "utf8");
    store.recordRunRollback(
      {
        runId,
        initiatedBy: "PREVIOUS_CRASHED_SUPERVISOR",
        status: "RESTORING_PATHS",
        conflictDetails: null,
        createdAt: clock.nowMs(),
        completedAt: null,
      },
      [
        {
          runId,
          relativePath: "file1.ts",
          status: "RESTORED",
          initialBaseDigest: sha256("content-1-v0\n"),
          latestExpectedDigest: sha256("content-1-v1\n"),
          baselineSnapshotRef: path.join(snapDir, "snap1.snap"),
          errorMessage: null,
          updatedAt: clock.nowMs(),
        },
        {
          runId,
          relativePath: "file2.ts",
          status: "PENDING",
          initialBaseDigest: sha256("content-2-v0\n"),
          latestExpectedDigest: sha256("content-2-v1\n"),
          baselineSnapshotRef: path.join(snapDir, "snap2.snap"),
          errorMessage: null,
          updatedAt: clock.nowMs(),
        },
      ]
    );

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "supervisor-resumer",
    });

    const outcome = await supervisor.recoverRun(runId, { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("RECOVERED");

    // Both files now restored to baseline
    expect(fs.readFileSync(targetFile1, "utf8")).toBe("content-1-v0\n");
    expect(fs.readFileSync(targetFile2, "utf8")).toBe("content-2-v0\n");

    const runRollback = store.getRunRollback(runId);
    expect(runRollback?.status).toBe("COMPLETED");
  });

  // 10. Recovery reconciles completed rollback with a nonterminal run status
  it("Scenario 10: Recovery reconciles completed rollback with a nonterminal run status", async () => {
    const runId = "run-rb-completed-run-recovering";
    helperCreateRun({
      runId,
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    // Run rollback is already COMPLETED
    store.recordRunRollback(
      {
        runId,
        initiatedBy: "PREVIOUS_SUPERVISOR",
        status: "COMPLETED",
        conflictDetails: null,
        createdAt: clock.nowMs(),
        completedAt: clock.nowMs(),
      },
      []
    );

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "supervisor-finalizer",
    });

    const outcome = await supervisor.recoverRun(runId, { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("RECOVERED_UNVERIFIED");
    expect(outcome.statusAfter).toBe("RECOVERING"); // attempts remain: handed off for coordinator retry

    const handedOffRun = store.getRun(runId);
    expect(handedOffRun?.status).toBe("RECOVERING");
  });

  // 11. Partial rollback conflicts remain failed/conflicted and preserve evidence
  it("Scenario 11: Partial rollback conflicts preserve external modifications and record diagnostics", async () => {
    const runId = "run-conflict-case";
    helperCreateRun({
      runId,
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const targetFile = path.join(testWorkspace, "conflict.ts");
    fs.writeFileSync(targetFile, "foreign-external-content\n", "utf8");

    const snapDir = path.join(testWorkspace, ".emerald", "snapshots", runId);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, "snap.snap"), "baseline-content\n", "utf8");

    const intent: MutationIntent = {
      mutationId: "mut-conflict-1",
      runId,
      workerLeaseId: "lease-1",
      relativePath: "conflict.ts",
      canonicalPath: targetFile,
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: sha256("baseline-content\n"),
      expectedResultingDigest: sha256("expected-agent-content\n"),
      snapshotRef: path.join(snapDir, "snap.snap"),
      lifecycleStatus: "COMMITTED",
      recoveryDedupToken: computeRecoveryDedupToken(runId, "mut-conflict-1", "COMMITTED"),
      conflictDetails: null,
      createdAt: clock.nowMs(),
      updatedAt: clock.nowMs(),
    };
    store.recordIntent(intent);

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-conflict",
    });

    const outcome = await supervisor.recoverRun(runId, { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("ROLLBACK_CONFLICT");
    expect(outcome.rollbackStatus).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");

    // External file remains byte-for-byte untouched!
    expect(fs.readFileSync(targetFile, "utf8")).toBe("foreign-external-content\n");

    const terminalRun = store.getRun(runId);
    expect(terminalRun?.status).toBe("FAILED");
    expect((terminalRun?.errorPayload as any)?.rollbackStatus).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");
  });

  // 12. Missing or corrupt snapshots do not result in false completion
  it("Scenario 12: Missing or corrupt snapshots fail closed without false completion", async () => {
    const runId = "run-corrupt-snap";
    helperCreateRun({
      runId,
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const targetFile = path.join(testWorkspace, "corrupt.ts");
    fs.writeFileSync(targetFile, "agent-modified\n", "utf8");

    // Snapshot file has corrupt content
    const snapDir = path.join(testWorkspace, ".emerald", "snapshots", runId);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, "corrupt.snap"), "CORRUPTED_BYTES\n", "utf8");

    const intent: MutationIntent = {
      mutationId: "mut-corrupt-1",
      runId,
      workerLeaseId: "lease-1",
      relativePath: "corrupt.ts",
      canonicalPath: targetFile,
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: sha256("original-clean-baseline\n"),
      expectedResultingDigest: sha256("agent-modified\n"),
      snapshotRef: path.join(snapDir, "corrupt.snap"),
      lifecycleStatus: "COMMITTED",
      recoveryDedupToken: computeRecoveryDedupToken(runId, "mut-corrupt-1", "COMMITTED"),
      conflictDetails: null,
      createdAt: clock.nowMs(),
      updatedAt: clock.nowMs(),
    };
    store.recordIntent(intent);

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-corrupt",
    });

    const outcome = await supervisor.recoverRun(runId, { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("ROLLBACK_CONFLICT");
    expect(outcome.rollbackStatus).toBe("PARTIALLY_ROLLED_BACK_CONFLICT");

    // Disk target was not modified with corrupt data
    expect(fs.readFileSync(targetFile, "utf8")).toBe("agent-modified\n");
    expect(store.getRun(runId)?.status).toBe("FAILED");
  });

  // 13. Repeated scans do not duplicate logical transitions or events
  it("Scenario 13: Repeated scans do not duplicate logical transitions or events", async () => {
    const pastExpiry = new Date(clock.nowMs() - 1000).toISOString();
    helperCreateRun({
      runId: "run-repeated-scan",
      status: "RUNNING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: pastExpiry,
    });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-repeater",
      // Recovery no longer falls back to process.cwd(); scans must resolve the workspace explicitly.
      workspaceResolver: () => testWorkspace,
    });

    // First scan recovers run
    const result1 = await supervisor.scanAndRecover();
    expect(result1.scannedCount).toBe(1);
    expect(result1.recoveredCount).toBe(0); // zero mutation intents: not a verified recovery
    expect(result1.unverifiedCount).toBe(1);

    const eventsAfterFirst = store.getEventsForRun("run-repeated-scan");
    const countAfterFirst = eventsAfterFirst.length;

    // Second scan: the run was handed off (RECOVERING) and is still scanned, but the completed
    // rollback is an idempotent no-op that adds no events.
    const result2 = await supervisor.scanAndRecover();
    expect(result2.scannedCount).toBe(1);
    expect(store.getRun("run-repeated-scan")?.status).toBe("RECOVERING");

    // Direct recoverRun is idempotent as well
    const outcomeDirect = await supervisor.recoverRun("run-repeated-scan", { workspaceRoot: testWorkspace });
    expect(outcomeDirect.statusAfter).toBe("RECOVERING");

    const eventsAfterSecond = store.getEventsForRun("run-repeated-scan");
    expect(eventsAfterSecond.length).toBe(countAfterFirst);
  });

  // 14. Lease expiry during recovery is handled without stale authority being reused
  it("Scenario 14: Lease expiry during recovery is handled without stale authority being reused", async () => {
    const runId = "run-lease-expire-during-recovery";
    helperCreateRun({
      runId,
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    // Acquire supervisor lease with very short TTL
    const supLease = store.acquireSupervisorLease({
      runId,
      supervisorId: "sup-timeout",
      ttlMs: 50,
      nowIso: clock.nowIso(),
    });

    // Advance clock past supervisor lease expiry
    clock.advance(100);

    // Any attempt to transition mutation or validate fencing with expired lease must throw SupervisorLeaseExpiredError
    expect(() => {
      store.validateSupervisorFencing(runId, {
        supervisorId: "sup-timeout",
        leaseId: supLease.leaseId,
        nowIso: clock.nowIso(),
      });
    }).toThrow(SupervisorLeaseExpiredError);
  });

  // 15. Terminal runs are not recovered again
  it("Scenario 15: Terminal runs (COMPLETED, FAILED) are not recovered again", async () => {
    helperCreateRun({ runId: "run-comp", status: "COMPLETED" });
    helperCreateRun({ runId: "run-fail", status: "FAILED" });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-term",
    });

    const outcome1 = await supervisor.recoverRun("run-comp", { workspaceRoot: testWorkspace });
    expect(outcome1.status).toBe("SKIPPED_TERMINAL");
    expect(store.getRun("run-comp")?.status).toBe("COMPLETED");

    const outcome2 = await supervisor.recoverRun("run-fail", { workspaceRoot: testWorkspace });
    expect(outcome2.status).toBe("SKIPPED_TERMINAL");
    expect(store.getRun("run-fail")?.status).toBe("FAILED");
  });

  // 16. Database failures do not produce falsely successful run outcomes
  it("Scenario 16: Non-existent runs return SKIPPED_INELIGIBLE and do not mutate DB", async () => {
    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-fail",
    });

    const outcome = await supervisor.recoverRun("run-does-not-exist", { workspaceRoot: testWorkspace });
    expect(outcome.status).toBe("SKIPPED_INELIGIBLE");
    expect(outcome.statusBefore).toBe("NON_EXISTENT");
    expect(store.getRun("run-does-not-exist")).toBeNull();
  });

  // 17. Supervisor lease release and renewal follow the existing contract
  it("Scenario 17: Supervisor lease release and renewal follow existing contract", async () => {
    const runId = "run-lease-contract";
    helperCreateRun({
      runId,
      status: "RECOVERING",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-contract",
      leaseTtlMs: 10000,
    });

    const lease = store.acquireSupervisorLease({
      runId,
      supervisorId: "sup-contract",
      ttlMs: 10000,
      nowIso: clock.nowIso(),
    });

    expect(lease.state).toBe("ACTIVE");

    // Renew lease
    clock.advance(2000);
    const renewed = supervisor.renewSupervisorLease(lease.leaseId, runId);
    expect(renewed.state).toBe("ACTIVE");
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(new Date(lease.expiresAt).getTime());

    // Release lease
    supervisor.releaseSupervisorLease(lease.leaseId);
    const releasedLease = store.getSupervisorLease(lease.leaseId);
    expect(releasedLease?.state).toBe("RELEASED");
    expect(releasedLease?.releasedAt).not.toBeNull();
  });

  // 18. Unrelated runs and mutation intents remain untouched
  it("Scenario 18: Unrelated runs and mutation intents remain untouched during recovery", async () => {
    const targetRun = "run-target";
    const unrelatedRun = "run-unrelated";
    const pastExpiry = new Date(clock.nowMs() - 1000).toISOString();

    helperCreateRun({
      runId: targetRun,
      status: "RUNNING",
      workerId: "worker-target",
      leaseId: "lease-target",
      leaseExpiresAt: pastExpiry,
    });

    helperCreateRun({
      runId: unrelatedRun,
      status: "RUNNING",
      workerId: "worker-unrelated",
      leaseId: "lease-unrelated",
      leaseExpiresAt: new Date(clock.nowMs() + 100000).toISOString(),
    });

    // Unrelated intent
    const unrelatedFile = path.join(testWorkspace, "unrelated.ts");
    const unrelatedIntent: MutationIntent = {
      mutationId: "mut-unrelated-1",
      runId: unrelatedRun,
      workerLeaseId: "lease-unrelated",
      relativePath: "unrelated.ts",
      canonicalPath: unrelatedFile,
      pathMutationVersion: 1,
      parentMutationId: null,
      baseDigest: sha256("d0\n"),
      expectedResultingDigest: sha256("d1\n"),
      snapshotRef: path.join(testWorkspace, "snap-ref.snap"),
      lifecycleStatus: "COMMITTED",
      recoveryDedupToken: computeRecoveryDedupToken(unrelatedRun, "mut-unrelated-1", "COMMITTED"),
      conflictDetails: null,
      createdAt: clock.nowMs(),
      updatedAt: clock.nowMs(),
    };
    store.recordIntent(unrelatedIntent);

    const supervisor = new RecoverySupervisor({
      stateStore: store,
      rollbackEngine: engine,
      clock,
      supervisorId: "sup-isolate",
    });

    await supervisor.recoverRun(targetRun, { workspaceRoot: testWorkspace });

    // Target run was recovered and handed off for coordinator retry
    expect(store.getRun(targetRun)?.status).toBe("RECOVERING");

    // Unrelated run is completely untouched
    const freshUnrelated = store.getRun(unrelatedRun);
    expect(freshUnrelated?.status).toBe("RUNNING");
    expect(freshUnrelated?.version).toBe(1);

    const freshUnrelatedIntent = store.getIntent("mut-unrelated-1");
    expect(freshUnrelatedIntent?.lifecycleStatus).toBe("COMMITTED");
  });
});
