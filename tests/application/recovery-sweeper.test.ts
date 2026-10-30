/**
 * RecoverySweeper: the supported entry point that runs the supervisor rollback BEFORE the
 * coordinator retry sweep, so runs holding workspace mutations are neither stuck nor retried
 * without rollback.
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
import { RecoverySweeper } from "../../src/recovery/recovery-sweeper.js";
import { computeRecoveryDedupToken } from "../../src/domain/mutation-intent.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

const sha256 = (c: string) => createHash("sha256").update(c).digest("hex");

describe("RecoverySweeper", () => {
  let tempDir: string;
  let ws: string;
  let clock: SettableClock;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eaf-sweeper-"));
    ws = path.join(tempDir, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    clock = new SettableClock(new Date().toISOString());
    store = new SqliteStateStore();
    coordinator = new RunCoordinator(store, clock);
    coordinator.registerWorker({
      workerId: "worker-1", hostname: "localhost", pid: process.pid, status: "ACTIVE",
      lastHeartbeatAt: clock.nowIso(), createdAt: clock.nowIso(),
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

  const sweeper = () =>
    new RecoverySweeper({
      supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock }),
      coordinator,
    });

  function crashedRun(opts: { withMutation: boolean; bindWorkspace: boolean }) {
    const task = coordinator.createTask({ title: "echo", inputPayload: { v: 1 } });
    createAndActivateContract(store, task.taskId);
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000, maxOutputBytes: 1048576 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-1", 5000);
    coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

    const target = path.join(ws, "src", "x.ts");
    if (opts.withMutation) {
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
    }
    if (opts.bindWorkspace) store.bindRunWorkspace(run.runId, fs.realpathSync(ws), clock.nowIso());
    clock.advanceMs(6000);
    return { runId: run.runId, target };
  }

  it("one sweep rolls the workspace back and requeues the run (supervisor first, then coordinator)", async () => {
    const { runId, target } = crashedRun({ withMutation: true, bindWorkspace: true });

    const result = await sweeper().sweepOnce();

    expect(result.scan.recoveredCount).toBe(1);
    expect(result.retry.recoveredCount).toBe(1);
    expect(result.heldForRollbackRunIds).toEqual([]);
    expect(result.needsAttention).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("BASE");
    expect(store.getIntent("m1")?.lifecycleStatus).toBe("ROLLED_BACK");
    expect(coordinator.getRun(runId)!.status).toBe("QUEUED");
  });

  it("a run with mutations but no resolvable workspace stays held, untouched, and is flagged for attention", async () => {
    const { runId, target } = crashedRun({ withMutation: true, bindWorkspace: false });

    const result = await sweeper().sweepOnce();

    expect(result.retry.recoveredCount).toBe(0);
    expect(result.heldForRollbackRunIds).toEqual([runId]);
    expect(result.needsAttention.map((a) => a.runId)).toEqual([runId]);
    expect(fs.readFileSync(target, "utf8")).toBe("MUT");
    expect(coordinator.getRun(runId)!.status).toBe("RUNNING");
  });

  it("a crashed run that never mutated anything and has no workspace is simply retried, with no spurious attention item", async () => {
    const { runId } = crashedRun({ withMutation: false, bindWorkspace: false });

    const result = await sweeper().sweepOnce();

    expect(result.retry.recoveredCount).toBe(1);
    expect(result.needsAttention).toEqual([]);
    expect(coordinator.getRun(runId)!.status).toBe("QUEUED");
  });

  it("a second sweep is a no-op once everything is reconciled", async () => {
    crashedRun({ withMutation: true, bindWorkspace: true });
    await sweeper().sweepOnce();

    const second = await sweeper().sweepOnce();

    expect(second.scan.scannedCount).toBe(0);
    expect(second.retry.recoveredCount).toBe(0);
  });

  it("a failed crashed-workspace disposal is surfaced as needing attention even though the run is requeued", async () => {
    const { runId } = crashedRun({ withMutation: false, bindWorkspace: false });
    coordinator.recordWorkspaceEvent({
      eventId: crypto.randomUUID(), runId, timestamp: clock.nowIso(), eventType: "workspace.leased",
      schemaVersion: 1, producer: "test", payload: { workspaceId: "ws-stuck", runId },
    });
    const failingPort = {
      disposeWorkspaceSync: () => {
        throw new Error("EBUSY: directory in use");
      },
    };
    const gated = new RunCoordinator(store, clock, undefined, failingPort as never);
    const s = new RecoverySweeper({
      supervisor: new RecoverySupervisor({ stateStore: store, rollbackEngine: new DurableRollbackEngine(store), clock }),
      coordinator: gated,
    });

    const result = await s.sweepOnce();

    expect(result.retry.workspaceCleanupFailedRunIds).toEqual([runId]);
    expect(result.needsAttention).toEqual([expect.objectContaining({ runId, status: "WORKSPACE_CLEANUP_FAILED" })]);
    expect(gated.getRun(runId)!.status).toBe("QUEUED");
  });

  it("overlapping sweeps are rejected", async () => {
    const s = sweeper();
    const first = s.sweepOnce();
    await expect(s.sweepOnce()).rejects.toThrow(/already in progress/);
    await first;
  });

  describe("periodic loop", () => {
    const stubs = () => {
      let sweeps = 0;
      let concurrent = 0;
      let maxConcurrent = 0;
      const supervisor = {
        getClock: () => clock,
        scanAndRecover: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          sweeps++;
          await new Promise((r) => setTimeout(r, 15));
          concurrent--;
          return { scannedCount: 0, recoveredCount: 0, unverifiedCount: 0, skippedCount: 0, failedCount: 0, outcomes: [] };
        },
      };
      const retryCoordinator = { recoverExpiredRuns: () => ({ recoveredCount: 0, runs: [] }) };
      return { supervisor, retryCoordinator, count: () => sweeps, maxConcurrent: () => maxConcurrent };
    };

    it("sweeps repeatedly, never concurrently, and stop() waits for the in-flight sweep", async () => {
      const { supervisor, retryCoordinator, count, maxConcurrent } = stubs();
      const seen: number[] = [];
      const s = new RecoverySweeper({
        supervisor: supervisor as never,
        coordinator: retryCoordinator,
        onSweep: () => {
          seen.push(1);
        },
      });

      s.start(5);
      await new Promise((r) => setTimeout(r, 120));
      await s.stop();
      const after = count();

      expect(after).toBeGreaterThanOrEqual(2);
      expect(maxConcurrent()).toBe(1);
      expect(seen.length).toBe(after);
      await new Promise((r) => setTimeout(r, 40));
      expect(count()).toBe(after); // no sweeps after stop()
    });

    it("keeps running after a sweep throws and reports the error", async () => {
      let calls = 0;
      const errors: unknown[] = [];
      const s = new RecoverySweeper({
        supervisor: {
          getClock: () => clock,
          scanAndRecover: async () => {
            calls++;
            if (calls === 1) throw new Error("boom");
            return { scannedCount: 0, recoveredCount: 0, unverifiedCount: 0, skippedCount: 0, failedCount: 0, outcomes: [] };
          },
        } as never,
        coordinator: { recoverExpiredRuns: () => ({ recoveredCount: 0, runs: [] }) },
        onError: (e) => errors.push(e),
      });

      s.start(5);
      await new Promise((r) => setTimeout(r, 80));
      await s.stop();

      expect(errors).toHaveLength(1);
      expect(calls).toBeGreaterThanOrEqual(2);
    });

    it("rejects an interval above 2^31-1 ms (setTimeout would clamp it to a 1 ms spin)", () => {
      const { supervisor, retryCoordinator } = stubs();
      const s = new RecoverySweeper({ supervisor: supervisor as never, coordinator: retryCoordinator });
      expect(() => s.start(2_147_483_648)).toThrow(/2147483647/);
      expect(() => s.start(99_999_999_999)).toThrow();
    });

    it("rejects a non-positive interval", () => {
      const { supervisor, retryCoordinator } = stubs();
      const s = new RecoverySweeper({ supervisor: supervisor as never, coordinator: retryCoordinator });
      expect(() => s.start(0)).toThrow();
    });
  });
});
