import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { migrateDatabase } from "../../src/adapters/persistence/schema.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  SubmissionConflictError,
  TaskRouterConfigError,
  TaskRouterService,
  TaskRouterTopologyError,
} from "../../src/application/task-router.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { Run } from "../../src/domain/run.js";
import { createAndActivateContract } from "./test-helpers.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { RunControl } from "../../src/control-plane/run-control.js";

describe("Milestone 2.17 — Durable Task Router", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let router: TaskRouterService;

  const workerId = "worker-router-1";

  const makeTask = (taskId: string) => {
    coordinator.createTask({ taskId, title: taskId, inputPayload: {} });
    createAndActivateContract(store, taskId);
  };

  const makeRouter = (s: SqliteStateStore, c: RunCoordinator, cap: 1 | 2 = 1) =>
    new TaskRouterService(s, c, clock, { maxConcurrentRuns: cap });

  const runOf = (taskId: string) => store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskId)!.runId);
  const statusOf = (taskId: string) => store.getRun(runOf(taskId))!.status;

  /** Drives a QUEUED run through the existing coordinator to a terminal state, as a worker would. */
  const complete = (taskId: string) => {
    const runId = runOf(taskId);
    const claim = coordinator.claimRun(runId, workerId, 60000);
    coordinator.startRun(runId, workerId, claim.lease.leaseId);
    coordinator.completeRun(runId, workerId, claim.lease.leaseId, { ok: true });
  };
  const fail = (taskId: string) => {
    const runId = runOf(taskId);
    const claim = coordinator.claimRun(runId, workerId, 60000);
    coordinator.startRun(runId, workerId, claim.lease.leaseId);
    coordinator.failRun(runId, { message: "boom" }, workerId, claim.lease.leaseId);
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-router-test-"));
    dbPath = path.join(tempDir, "state.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-11-04T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);
    store.transaction((tx) =>
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 4242,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      })
    );
    router = makeRouter(store, coordinator, 1);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe("1. Configuration and migration", () => {
    it("rejects concurrency outside 1..2", () => {
      expect(() => new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 3 as never })).toThrow(
        TaskRouterConfigError
      );
      expect(() => new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 0 as never })).toThrow(
        TaskRouterConfigError
      );
    });

    it("migration is additive and idempotent on an existing database with data", () => {
      makeTask("t-mig");
      router.submitTask({ submissionKey: "k-mig", taskId: "t-mig" });
      // Re-open the same file: migrateDatabase runs again and must not disturb existing rows.
      const reopened = new SqliteStateStore({ location: dbPath });
      const again = reopened.transaction((tx) => tx.getRouterSubmissionByKey("k-mig"));
      expect(again?.taskId).toBe("t-mig");
      expect(() => migrateDatabase((reopened as any).db)).not.toThrow();
    });
  });

  describe("2. Durable parent/child relations", () => {
    it("persists relations with depth and sibling ordinals", () => {
      for (const t of ["root", "a", "b"]) makeTask(t);
      router.submitTask({ submissionKey: "k-root", taskId: "root" });
      router.submitTask({ submissionKey: "k-a", taskId: "a", parentTaskId: "root" });
      router.submitTask({ submissionKey: "k-b", taskId: "b", parentTaskId: "root" });
      const rels = store.transaction((tx) => tx.listChildTaskRelations("root"));
      expect(rels.map((r) => [r.childTaskId, r.depth, r.ordinal])).toEqual([
        ["a", 1, 0],
        ["b", 1, 1],
      ]);
    });

    it("rejects unrouted parent, self-parent, depth overflow and fan-out overflow", () => {
      for (const t of ["root", "c1", "c2", "c3", "ghost"]) makeTask(t);
      const small = new TaskRouterService(store, coordinator, clock, {
        maxConcurrentRuns: 1,
        maxDepth: 2,
        maxChildrenPerParent: 1,
      });
      small.submitTask({ submissionKey: "k-root", taskId: "root" });
      expect(() => small.submitTask({ submissionKey: "k-x", taskId: "c1", parentTaskId: "ghost" })).toThrow(
        TaskRouterTopologyError
      );
      expect(() => small.submitTask({ submissionKey: "k-self", taskId: "c1", parentTaskId: "c1" })).toThrow(
        TaskRouterTopologyError
      );
      small.submitTask({ submissionKey: "k-c1", taskId: "c1", parentTaskId: "root" });
      // fan-out: root already has 1 child (cap 1)
      expect(() => small.submitTask({ submissionKey: "k-c2", taskId: "c2", parentTaskId: "root" })).toThrow(
        TaskRouterTopologyError
      );
      small.submitTask({ submissionKey: "k-c2b", taskId: "c2", parentTaskId: "c1" }); // depth 2 ok
      // depth: c3 under c2 would be depth 3 > 2
      expect(() => small.submitTask({ submissionKey: "k-c3", taskId: "c3", parentTaskId: "c2" })).toThrow(
        TaskRouterTopologyError
      );
    });

    it("rejects routing the same task under a second key", () => {
      makeTask("t1");
      router.submitTask({ submissionKey: "k1", taskId: "t1" });
      expect(() => router.submitTask({ submissionKey: "k1-other", taskId: "t1" })).toThrow(TaskRouterTopologyError);
    });
  });

  describe("3. Duplicate-submission protection", () => {
    it("same key and same request returns the same run and creates nothing new", () => {
      makeTask("t1");
      const first = router.submitTask({ submissionKey: "k1", taskId: "t1" });
      const second = router.submitTask({ submissionKey: "k1", taskId: "t1" });
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.runId).toBe(first.runId);
      expect(store.transaction((tx) => tx.countRunsByStatuses(["CREATED"]))).toBe(1);
    });

    it("same key with a different request is a conflict, not a silent return", () => {
      makeTask("t1");
      makeTask("t2");
      router.submitTask({ submissionKey: "k1", taskId: "t1" });
      expect(() => router.submitTask({ submissionKey: "k1", taskId: "t2" })).toThrow(SubmissionConflictError);
      expect(() => router.submitTask({ submissionKey: "k1", taskId: "t1", maxAttempts: 2 })).toThrow(
        SubmissionConflictError
      );
    });

    it("repairs a crash between run creation and submission recording on retry", () => {
      makeTask("t1");
      // Simulate crash after step 3: run exists with the key, but no router submission row.
      const created = coordinator.createRun({ taskId: "t1", idempotencyKey: "k-crash" });
      expect(store.transaction((tx) => tx.getRouterSubmissionByKey("k-crash"))).toBeNull();
      const res = router.submitTask({ submissionKey: "k-crash", taskId: "t1" });
      expect(res.runId).toBe(created.run.runId);
      expect(store.transaction((tx) => tx.getRouterSubmissionByKey("k-crash"))?.runId).toBe(created.run.runId);
    });

    it("refuses a key already bound to a run for a different task", () => {
      makeTask("t1");
      makeTask("t2");
      coordinator.createRun({ taskId: "t1", idempotencyKey: "k-collide" });
      expect(() => router.submitTask({ submissionKey: "k-collide", taskId: "t2" })).toThrow(SubmissionConflictError);
    });

    it("refuses to route a key whose run was cancelled by an earlier rejection (no silent dead submission)", () => {
      makeTask("t1");
      // Earlier attempt: run was created for the key, then cancelled after the router rejected the submission.
      const created = coordinator.createRun({ taskId: "t1", idempotencyKey: "k-dead" });
      coordinator.cancelRun(created.run.runId, "Router submission rejected");
      expect(() => router.submitTask({ submissionKey: "k-dead", taskId: "t1" })).toThrow(SubmissionConflictError);
      expect(store.transaction((tx) => tx.getRouterSubmissionByKey("k-dead"))).toBeNull();
    });

    it("refuses to route a key whose run was already queued by another path", () => {
      makeTask("t1");
      const created = coordinator.createRun({ taskId: "t1", idempotencyKey: "k-queued" });
      coordinator.queueRun(created.run.runId);
      expect(() => router.submitTask({ submissionKey: "k-queued", taskId: "t1" })).toThrow(SubmissionConflictError);
    });
  });

  describe("4. Deterministic, bounded dispatch", () => {
    it("admits in (depth, ordinal) order and only after the parent COMPLETED", () => {
      for (const t of ["root", "a", "b"]) makeTask(t);
      router.submitTask({ submissionKey: "k-root", taskId: "root" });
      router.submitTask({ submissionKey: "k-a", taskId: "a", parentTaskId: "root" });
      router.submitTask({ submissionKey: "k-b", taskId: "b", parentTaskId: "root" });

      const t1 = router.dispatchTick();
      expect(t1.admittedRunIds).toEqual([runOf("root")]);
      expect(statusOf("a")).toBe("CREATED");

      // Parent still in flight: nothing more is admitted (cap 1 anyway).
      expect(router.dispatchTick().admittedRunIds).toEqual([]);

      complete("root");
      const t2 = router.dispatchTick();
      expect(t2.admittedRunIds).toEqual([runOf("a")]); // cap 1, ordinal 0 first
      complete("a");
      expect(router.dispatchTick().admittedRunIds).toEqual([runOf("b")]);
    });

    it("enforces cap 1 and cap 2 against global in-flight runs", () => {
      for (const t of ["r1", "r2", "r3"]) makeTask(t);
      for (const t of ["r1", "r2", "r3"]) router.submitTask({ submissionKey: `k-${t}`, taskId: t });

      expect(router.dispatchTick().admittedRunIds).toHaveLength(1);
      expect(router.dispatchTick().admittedRunIds).toHaveLength(0);

      const two = makeRouter(store, coordinator, 2);
      const tick = two.dispatchTick();
      expect(tick.inFlight).toBe(1);
      expect(tick.admittedRunIds).toHaveLength(1); // 1 more up to cap 2
      expect(two.dispatchTick().admittedRunIds).toHaveLength(0);
      expect(store.transaction((tx) => tx.countRunsByStatuses(["QUEUED"]))).toBe(2);
    });

    it("counts runs not created through the router toward the cap", () => {
      makeTask("outside");
      makeTask("routed");
      const outside = coordinator.createRun({ taskId: "outside" });
      coordinator.queueRun(outside.run.runId); // in flight, but not routed
      router.submitTask({ submissionKey: "k-routed", taskId: "routed" });
      const tick = router.dispatchTick();
      expect(tick.inFlight).toBe(1);
      expect(tick.admittedRunIds).toEqual([]);
    });

    it("two independent connections to the same database never exceed the cap", () => {
      for (const t of ["r1", "r2", "r3"]) makeTask(t);
      for (const t of ["r1", "r2", "r3"]) router.submitTask({ submissionKey: `k-${t}`, taskId: t });
      const storeB = new SqliteStateStore({ location: dbPath });
      const routerB = makeRouter(storeB, new RunCoordinator(storeB, clock), 1);
      router.dispatchTick();
      routerB.dispatchTick();
      router.dispatchTick();
      routerB.dispatchTick();
      expect(store.transaction((tx) => tx.countRunsByStatuses(["QUEUED", "LEASED", "RUNNING"]))).toBe(1);
    });
  });

  describe("5. Consolidated status derived from durable state", () => {
    it("reports PENDING, RUNNING, COMPLETED and FAILED without storing status", () => {
      for (const t of ["root", "a"]) makeTask(t);
      router.submitTask({ submissionKey: "k-root", taskId: "root" });
      router.submitTask({ submissionKey: "k-a", taskId: "a", parentTaskId: "root" });
      expect(router.getTaskTreeStatus("root").status).toBe("PENDING");

      router.dispatchTick();
      expect(router.getTaskTreeStatus("root").status).toBe("RUNNING");

      complete("root");
      router.dispatchTick();
      complete("a");
      const done = router.getTaskTreeStatus("root");
      expect(done.status).toBe("COMPLETED");
      expect(done.counts["COMPLETED"]).toBe(2);
    });

    it("reports FAILED and cascades cancellation to never-started descendants", () => {
      for (const t of ["root", "a", "b"]) makeTask(t);
      router.submitTask({ submissionKey: "k-root", taskId: "root" });
      router.submitTask({ submissionKey: "k-a", taskId: "a", parentTaskId: "root" });
      router.submitTask({ submissionKey: "k-b", taskId: "b", parentTaskId: "a" });
      router.dispatchTick();
      fail("root");
      const tick = router.dispatchTick();
      expect(tick.cancelledRunIds).toContain(runOf("a"));
      router.dispatchTick(); // next tick cancels b once a is terminal
      expect(statusOf("a")).toBe("CANCELLED");
      expect(statusOf("b")).toBe("CANCELLED");
      expect(statusOf("root")).toBe("FAILED");
      expect(router.getTaskTreeStatus("root").status).toBe("FAILED");
    });
  });

  describe("6. Cancellation propagation", () => {
    it("cancels CREATED, QUEUED and RUNNING runs through cancelRun and reports in-flight honestly", () => {
      for (const t of ["root", "a", "b"]) makeTask(t);
      router.submitTask({ submissionKey: "k-root", taskId: "root" });
      router.submitTask({ submissionKey: "k-a", taskId: "a", parentTaskId: "root" });
      router.submitTask({ submissionKey: "k-b", taskId: "b", parentTaskId: "root" });
      router.dispatchTick();
      const claim = coordinator.claimRun(runOf("root"), workerId, 60000);
      coordinator.startRun(runOf("root"), workerId, claim.lease.leaseId); // root RUNNING

      const res = router.cancelTaskTree("root");
      expect(res.cancelledRunIds).toHaveLength(3);
      expect(res.inFlightCancelRequestedRunIds).toEqual([runOf("root")]);
      expect(res.deferredRecoveringRunIds).toEqual([]);
      for (const t of ["root", "a", "b"]) expect(statusOf(t)).toBe("CANCELLED");

      // Idempotent on repeat: terminal runs are skipped.
      expect(router.cancelTaskTree("root").cancelledRunIds).toEqual([]);
    });

    it("does not cancel RECOVERING runs; leaves them to the recovery supervisor", () => {
      makeTask("t1");
      router.submitTask({ submissionKey: "k1", taskId: "t1" });
      router.dispatchTick();
      const runId = runOf("t1");
      const claim = coordinator.claimRun(runId, workerId, 60000);
      coordinator.startRun(runId, workerId, claim.lease.leaseId);
      // Put the run into RECOVERING through the domain state machine (lease expiry transition).
      store.transaction((tx) => {
        const snap = tx.getRun(runId)!;
        const aggregate = Run.reconstitute(snap);
        const ev = aggregate.expireLease(clock.nowIso());
        tx.updateRun(runId, snap.version, aggregate.snapshot, ev);
      });
      expect(statusOf("t1")).toBe("RECOVERING");
      const res = router.cancelTaskTree("t1");
      expect(res.deferredRecoveringRunIds).toEqual([runId]);
      expect(statusOf("t1")).toBe("RECOVERING");
    });
  });

  describe("7. Restart reconstruction", () => {
    it("a fresh store and router over the same file reproduce identical status and dispatch", () => {
      for (const t of ["root", "a"]) makeTask(t);
      router.submitTask({ submissionKey: "k-root", taskId: "root" });
      router.submitTask({ submissionKey: "k-a", taskId: "a", parentTaskId: "root" });
      router.dispatchTick();
      complete("root");
      const before = router.getTaskTreeStatus("root");

      const store2 = new SqliteStateStore({ location: dbPath });
      const router2 = makeRouter(store2, new RunCoordinator(store2, clock), 1);
      expect(router2.getTaskTreeStatus("root")).toEqual(before);
      const tick = router2.dispatchTick();
      expect(tick.admittedRunIds).toEqual([runOf("a")]);
      // Replaying the same tick admits nothing further (idempotent).
      expect(router2.dispatchTick().admittedRunIds).toEqual([]);
    });
  });

  describe("8. Boundaries", () => {
    it("the router imports no workspace, tool, execution or recovery modules", () => {
      const src = fs.readFileSync(path.join(__dirname, "../../src/application/task-router.ts"), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(imports.sort()).toEqual(
        [
          "../domain/canonical-hash.js",
          "../ports/clock.port.js",
          "../ports/state-store.port.js",
          "./run-coordinator.js",
        ].sort()
      );
    });

    it("production resume remains disabled", () => {
      const rc = new RunControl();
      const run = rc.createRun({
        missionId: "m",
        taskId: "t",
        contract: { spec: { contractId: "c" }, contentHash: "h" },
      } as any);
      rc.transitionStatus(run.runId, "EXECUTING");
      const outcome = new ProductionRecoveryService(rc).recoverRun(run.runId);
      expect(outcome.safeToResume).toBe(false);
      expect(outcome.statusAfter).toBe("FAILED");
    });
  });
});
