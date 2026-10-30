/**
 * Retry gate: RunCoordinator.recoverExpiredRuns must not requeue a crashed run (or discard its
 * workspace) while the run holds unreconciled workspace mutations. The RecoverySupervisor rolls
 * the workspace back and hands the run over (left RECOVERING); only then does the coordinator
 * apply its normal retry semantics.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/index.js";
import { DurableRollbackEngine } from "../../src/recovery/durable-rollback-engine.js";
import { RecoverySupervisor } from "../../src/recovery/recovery-supervisor.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");

describe("Coordinator retry gate on unreconciled workspace mutations", () => {
  let tempDir: string;
  let ws: string;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-gate-"));
    ws = path.join(tempDir, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    // Real "now": supervisor fencing compares against the real clock
    clock = new SettableClock(new Date().toISOString());
    store = new SqliteStateStore();
    coordinator = new RunCoordinator(store, clock);
    coordinator.registerWorker({
      workerId: "worker-1",
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(),
      createdAt: clock.nowIso(),
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Starts a run on worker-1, records one COMMITTED mutation in `ws`, then lets the lease expire. */
  function crashedRunWithMutation(maxAttempts: number) {
    const task = coordinator.createTask({ title: "echo", inputPayload: { v: 1 } });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts, timeoutMs: 15000, maxOutputBytes: 1048576 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
    coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

    const target = path.join(ws, "src", "x.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "MUT");
    const snapDir = path.join(ws, ".emerald", "snapshots", run.runId);
    fs.mkdirSync(snapDir, { recursive: true });
    const snap = path.join(snapDir, "m1.snap");
    fs.writeFileSync(snap, "BASE");
    store.recordIntent({
      mutationId: "m1", runId: run.runId, workerLeaseId: claim.lease.leaseId, relativePath: "src/x.ts", canonicalPath: target,
      parentMutationId: null, pathMutationVersion: 1, baseDigest: sha256("BASE"), expectedResultingDigest: sha256("MUT"),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(run.runId, "m1", "COMMITTED"),
      lifecycleStatus: "COMMITTED", createdAt: 1, updatedAt: 1,
    });

    clock.advanceMs(6000); // worker lease (5s) expires
    return { runId: run.runId, target };
  }

  const makeSupervisor = () =>
    new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock, supervisorId: "sup-gate" });

  it("holds an expired run that has an unreconciled mutation: no requeue, no state change", () => {
    const { runId, target } = crashedRunWithMutation(3);
    const before = coordinator.getRun(runId)!;

    const result = coordinator.recoverExpiredRuns();

    expect(result.recoveredCount).toBe(0);
    expect(result.heldForRollbackRunIds).toEqual([runId]);
    const after = coordinator.getRun(runId)!;
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(fs.readFileSync(target, "utf8")).toBe("MUT"); // nothing discarded or restored by the coordinator
  });

  it("after the supervisor rolls the workspace back, the coordinator requeues the run", async () => {
    const { runId, target } = crashedRunWithMutation(3);
    expect(coordinator.recoverExpiredRuns().recoveredCount).toBe(0);

    const outcome = await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });
    expect(outcome.status).toBe("RECOVERED");
    expect(outcome.statusAfter).toBe("RECOVERING");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");

    const result = coordinator.recoverExpiredRuns();

    expect(result.recoveredCount).toBe(1);
    expect(result.heldForRollbackRunIds).toBeUndefined();
    expect(coordinator.getRun(runId)!.status).toBe("QUEUED");
  });

  it("a run left RECOVERING with a non-terminal mutation (supervisor crashed mid-way) stays held", () => {
    const { runId } = crashedRunWithMutation(3);
    // Simulate: lease expired and run moved to RECOVERING, but rollback never ran.
    db(store).prepare(`UPDATE runs SET status = 'RECOVERING' WHERE run_id = ?`).run(runId);

    const result = coordinator.recoverExpiredRuns();

    expect(result.recoveredCount).toBe(0);
    expect(result.heldForRollbackRunIds).toEqual([runId]);
    expect(coordinator.getRun(runId)!.status).toBe("RECOVERING");
  });

  it("when attempts are exhausted, a clean rollback ends the run FAILED instead of handing it off", async () => {
    const { runId } = crashedRunWithMutation(1);
    // attemptCount counts retries already consumed: set it to the maximum (no retry left)
    db(store).prepare(`UPDATE runs SET attempt_count = max_attempts WHERE run_id = ?`).run(runId);

    const outcome = await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });

    expect(outcome.status).toBe("RECOVERED");
    expect(outcome.statusAfter).toBe("FAILED");
    expect(coordinator.getRun(runId)!.status).toBe("FAILED");
  });

  it("a crashed run with no mutation intents is retried by the coordinator exactly as before", () => {
    const task = coordinator.createTask({ title: "echo", inputPayload: { v: 1 } });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000, maxOutputBytes: 1048576 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
    coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);
    clock.advanceMs(6000);

    const result = coordinator.recoverExpiredRuns();

    expect(result.recoveredCount).toBe(1);
    expect(result.heldForRollbackRunIds).toBeUndefined();
    expect(coordinator.getRun(run.runId)!.status).toBe("QUEUED");
  });

  // ---------------------------------------------------------------------------
  // Repeat crash: crash -> rollback -> retry -> crash again -> the NEW mutations are rolled back
  // ---------------------------------------------------------------------------
  /** Second attempt: claims the requeued run, records a chained mutation (v2) and lets the lease expire. */
  function secondAttemptMutation(runId: string, target: string) {
    const claim = coordinator.claimRun(runId, "worker-1", 5000);
    coordinator.startRun(runId, "worker-1", claim.lease.leaseId);
    const snap = path.join(ws, ".emerald", "snapshots", runId, "m2.snap");
    fs.writeFileSync(snap, "BASE");
    fs.writeFileSync(target, "MUT2");
    store.recordIntent({
      mutationId: "m2", runId, workerLeaseId: claim.lease.leaseId, relativePath: "src/x.ts", canonicalPath: target,
      parentMutationId: "m1", pathMutationVersion: 2, baseDigest: sha256("BASE"), expectedResultingDigest: sha256("MUT2"),
      snapshotRef: snap, recoveryDedupToken: computeRecoveryDedupToken(runId, "m2", "COMMITTED"),
      lifecycleStatus: "COMMITTED", createdAt: Date.now(), updatedAt: Date.now(),
    });
    clock.advanceMs(6000);
  }

  it("a second crash after a retry rolls back the NEW mutations instead of reporting the old rollback", async () => {
    const { runId, target } = crashedRunWithMutation(3);
    const sup = makeSupervisor();
    expect((await sup.recoverRun(runId, { workspaceRoot: ws })).statusAfter).toBe("RECOVERING");
    expect(coordinator.recoverExpiredRuns().recoveredCount).toBe(1); // requeued
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");

    secondAttemptMutation(runId, target);
    expect(fs.readFileSync(target, "utf8")).toBe("MUT2");
    // Gate holds it: the new intent is unreconciled even though an old rollback record is COMPLETED
    const held = coordinator.recoverExpiredRuns();
    expect(held.heldForRollbackRunIds).toEqual([runId]);

    const outcome = await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });

    expect(outcome.status).toBe("RECOVERED");
    expect(outcome.statusAfter).toBe("RECOVERING");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE"); // the second attempt's mutation really was undone
    expect(store.getIntent("m2")?.lifecycleStatus).toBe("ROLLED_BACK");
    expect(store.getIntent("m1")?.lifecycleStatus).toBe("ROLLED_BACK");
    expect(coordinator.recoverExpiredRuns().recoveredCount).toBe(1); // not stuck: requeued again
    expect(coordinator.getRun(runId)!.status).toBe("QUEUED");
  });

  it("the first attempt's snapshots are not needed: a second crash recovers even after the old snapshot is gone", async () => {
    const { runId, target } = crashedRunWithMutation(3);
    await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });
    coordinator.recoverExpiredRuns();
    // Workspace cleanup between attempts removes attempt 1's snapshot directory contents
    fs.rmSync(path.join(ws, ".emerald", "snapshots", runId, "m1.snap"));

    secondAttemptMutation(runId, target);
    const outcome = await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });

    expect(outcome.status).toBe("RECOVERED");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    expect(store.getIntent("m2")?.lifecycleStatus).toBe("ROLLED_BACK");
  });

  it("a crashed run whose only mutation is VERIFIED_PASS is still held until rolled back, then retried", async () => {
    const { runId, target } = crashedRunWithMutation(3);
    db(store).prepare(`UPDATE mutation_intents SET lifecycle_status = 'VERIFIED_PASS' WHERE mutation_id = 'm1'`).run();

    expect(coordinator.recoverExpiredRuns().heldForRollbackRunIds).toEqual([runId]);

    const outcome = await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });
    expect(outcome.statusAfter).toBe("RECOVERING");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    expect(store.getIntent("m1")?.lifecycleStatus).toBe("ROLLED_BACK");
    expect(coordinator.recoverExpiredRuns().recoveredCount).toBe(1);
  });

  it("a second crash with attempts exhausted restores the file before the run is failed", async () => {
    const { runId, target } = crashedRunWithMutation(3);
    await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });
    coordinator.recoverExpiredRuns();
    secondAttemptMutation(runId, target);
    db(store).prepare(`UPDATE runs SET attempt_count = max_attempts WHERE run_id = ?`).run(runId);

    const outcome = await makeSupervisor().recoverRun(runId, { workspaceRoot: ws });

    expect(outcome.statusAfter).toBe("FAILED");
    expect(fs.readFileSync(target, "utf8")).toBe("BASE"); // not left mutated under a "clean" report
    expect(store.getIntent("m2")?.lifecycleStatus).toBe("ROLLED_BACK");
  });
});

// Test-only access to the underlying connection for fixture manipulation.
function db(store: SqliteStateStore): { prepare(sql: string): { run(...a: unknown[]): unknown } } {
  return (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
}
