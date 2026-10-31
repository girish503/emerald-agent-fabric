import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/index.js";
import { createAndActivateContract } from "../application/test-helpers.js";

/**
 * Two independent SQLite connections to the SAME database file (what two worker/recovery processes see):
 * ownership of a run is decided by the database, not by either process's memory.
 */
describe("Production persistence: two connections to one SQLite file", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-two-conn-"));
    dbPath = path.join(dir, "emerald.sqlite");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const registerWorker = (c: RunCoordinator, workerId: string) =>
    c.registerWorker({
      workerId, hostname: "localhost", pid: 1, status: "ACTIVE",
      lastHeartbeatAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    });

  it("only one of two competing claims on the same queued run wins; the loser changes nothing", () => {
    const storeA = new SqliteStateStore({ location: dbPath });
    const storeB = new SqliteStateStore({ location: dbPath });
    try {
      const a = new RunCoordinator(storeA);
      const b = new RunCoordinator(storeB);
      registerWorker(a, "worker-A");
      registerWorker(b, "worker-B");
      const task = a.createTask({ title: "echo", inputPayload: { n: 1 } });
      createAndActivateContract(storeA, task.taskId);
      const { run } = a.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000 });
      a.queueRun(run.runId);

      const claimA = a.claimRun(run.runId, "worker-A", 30_000);
      const before = b.getRun(run.runId)!; // B's connection sees A's committed claim
      expect(before.currentWorkerId).toBe("worker-A");

      expect(() => b.claimRun(run.runId, "worker-B", 30_000)).toThrow();

      const after = a.getRun(run.runId)!;
      expect(after.currentWorkerId).toBe("worker-A");
      expect(after.leaseId).toBe(claimA.lease.leaseId);
      expect(after.version).toBe(before.version);
      expect(b.getLease(claimA.lease.leaseId)!.state).toBe("ACTIVE");
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it("a worker on one connection is fenced after the other connection reclaims and re-claims the run", () => {
    let clockMs = Date.parse("2026-03-30T10:00:00.000Z");
    const clock = { now: () => new Date(clockMs), nowIso: () => new Date(clockMs).toISOString() };
    const storeA = new SqliteStateStore({ location: dbPath });
    const storeB = new SqliteStateStore({ location: dbPath });
    try {
      const a = new RunCoordinator(storeA, clock);
      const b = new RunCoordinator(storeB, clock);
      registerWorker(a, "worker-A");
      registerWorker(b, "worker-B");
      const task = a.createTask({ title: "echo", inputPayload: { n: 1 } });
      createAndActivateContract(storeA, task.taskId);
      const { run } = a.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 15000 });
      a.queueRun(run.runId);
      const claimA = a.claimRun(run.runId, "worker-A", 5000);
      a.startRun(run.runId, "worker-A", claimA.lease.leaseId);

      clockMs += 6000; // A's lease expires; B's connection sweeps and takes over
      expect(b.recoverExpiredRuns().recoveredCount).toBe(1);
      const claimB = b.claimRun(run.runId, "worker-B", 5000);
      b.startRun(run.runId, "worker-B", claimB.lease.leaseId);

      expect(() => a.completeRun(run.runId, "worker-A", claimA.lease.leaseId, {})).toThrow(/lease/i);
      expect(a.getRun(run.runId)!.currentWorkerId).toBe("worker-B");
      expect(a.getLease(claimB.lease.leaseId)!.state).toBe("ACTIVE");
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});
