import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  SubmissionConflictError,
  TaskRouterService,
  TaskRouterTopologyError,
} from "../../src/application/task-router.js";
import { MultiAgentOrchestrator } from "../../src/application/multi-agent-orchestrator.js";
import { createMissionContract, createResourceLimits } from "../../src/domain/mission-contract.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { SuperAgentDecompositionError } from "../../src/domain/super-agent.js";
import { createVerificationSpec, DeterministicVerifier } from "../../src/domain/verification.js";
import { SettableClock } from "../../src/ports/clock.port.js";

function createTestContext(options?: {
  dbPath?: string;
  maxConcurrentRuns?: 1 | 2;
  maxDepth?: number;
  maxChildrenPerParent?: number;
}) {
  const store = new SqliteStateStore(options?.dbPath ? { location: options.dbPath } : undefined);
  const clock = new SettableClock(new Date("2026-11-12T10:00:00.000Z"));
  const coordinator = new RunCoordinator(store, clock);
  const router = new TaskRouterService(store, coordinator, clock, {
    maxConcurrentRuns: options?.maxConcurrentRuns ?? 2,
    maxDepth: options?.maxDepth ?? 4,
    maxChildrenPerParent: options?.maxChildrenPerParent ?? 8,
  });
  const orchestrator = new MultiAgentOrchestrator(store, coordinator, router, clock);
  store.transaction((tx) => {
    if (!tx.getWorker("worker-dag")) {
      tx.insertWorker({
        workerId: "worker-dag",
        hostname: "localhost",
        pid: 4242,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    }
  });
  return { store, clock, coordinator, router, orchestrator };
}

function registerTask(
  store: SqliteStateStore,
  coordinator: RunCoordinator,
  taskId: string,
  opts?: { tenantId?: string | null; payloadTenantId?: string; capabilities?: readonly string[]; verificationSpecs?: readonly any[] }
) {
  coordinator.createTask({
    taskId,
    title: `Task ${taskId}`,
    description: `DAG scenario task ${taskId}`,
    inputPayload: opts?.payloadTenantId ? { tenantId: opts.payloadTenantId } : {},
  });
  const effectiveTenant = opts?.tenantId === null ? undefined : (opts?.tenantId ?? "tenant-default");
  const contract = createMissionContract({
    contractId: `contract-${taskId}`,
    version: 1,
    taskId,
    policy: createExecutionPolicy({
      policyId: `policy-${taskId}`,
      ...(effectiveTenant ? { tenantId: effectiveTenant } : {}),
      allowedCapabilities: [...(opts?.capabilities ?? ["workspace.file.read", "workspace.code.search"])],
      isolationRequirement: "IN_PROCESS",
    }),
    verificationSpecs: [...(opts?.verificationSpecs ?? [])],
    resourceLimits: createResourceLimits({ timeoutMs: 60_000, maxAttempts: 3, maxOutputBytes: 1_048_576 }),
  });
  store.insertContract(contract);
  store.activateContract(contract.spec.contractId, 1, "2026-11-12T10:00:00.000Z");
}

function claimStartComplete(coordinator: RunCoordinator, store: SqliteStateStore, clock: SettableClock, runId: string) {
  const claim = coordinator.claimRun(runId, "worker-dag", 60_000);
  coordinator.startRun(runId, "worker-dag", claim.lease.leaseId);
  coordinator.recordVerificationResult(
    runId,
    {
      status: "VERIFIED",
      verifierId: DeterministicVerifier.VERIFIER_ID,
      specId: "dag-test-spec",
      evidenceIds: [],
      message: "Verified in DAG test",
      verifiedAt: clock.nowIso(),
    },
    `dag-verify:${runId}`
  );
  coordinator.completeRun(runId, "worker-dag", claim.lease.leaseId, "Done");
}

describe("M4.2 WS-B — Comprehensive 20-Scenario Durable DAG Integrity & Migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-dag20-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. Executes linear chain Root -> A -> B strictly in topological order", () => {
    const { store, clock, coordinator, router } = createTestContext();
    try {
      for (const id of ["root", "node-a", "node-b"]) registerTask(store, coordinator, id);
      const rRoot = router.submitTask({ submissionKey: "s-root", taskId: "root" });
      const rA = router.submitTask({ submissionKey: "s-a", taskId: "node-a", parentTaskId: "root" });
      const rB = router.submitTask({ submissionKey: "s-b", taskId: "node-b", parentTaskId: "node-a" });

      const t1 = router.dispatchTick();
      expect(t1.admittedRunIds).toEqual([rRoot.runId]);
      expect(coordinator.getRun(rA.runId)?.status).toBe("CREATED");
      expect(coordinator.getRun(rB.runId)?.status).toBe("CREATED");

      claimStartComplete(coordinator, store, clock, rRoot.runId);
      const t2 = router.dispatchTick();
      expect(t2.admittedRunIds).toEqual([rA.runId]);
      expect(coordinator.getRun(rB.runId)?.status).toBe("CREATED");

      claimStartComplete(coordinator, store, clock, rA.runId);
      const t3 = router.dispatchTick();
      expect(t3.admittedRunIds).toEqual([rB.runId]);
    } finally {
      store.close();
    }
  });

  it("2. Gates multi-parent diamond sink until ALL parents reach COMPLETED", () => {
    const { store, clock, coordinator, router } = createTestContext({ maxConcurrentRuns: 2 });
    try {
      for (const id of ["root", "left", "right", "sink"]) registerTask(store, coordinator, id);
      const rRoot = router.submitTask({ submissionKey: "d-root", taskId: "root" });
      const rLeft = router.submitTask({ submissionKey: "d-left", taskId: "left", parentTaskId: "root" });
      const rRight = router.submitTask({ submissionKey: "d-right", taskId: "right", parentTaskId: "root" });
      const rSink = router.submitTask({
        submissionKey: "d-sink",
        taskId: "sink",
        parentTaskId: "left",
        dependsOnTaskIds: ["left", "right"],
      });

      router.dispatchTick();
      claimStartComplete(coordinator, store, clock, rRoot.runId);
      const tBranches = router.dispatchTick();
      expect(new Set(tBranches.admittedRunIds)).toEqual(new Set([rLeft.runId, rRight.runId]));

      claimStartComplete(coordinator, store, clock, rLeft.runId);
      router.dispatchTick();
      expect(coordinator.getRun(rSink.runId)?.status).toBe("CREATED");

      claimStartComplete(coordinator, store, clock, rRight.runId);
      const tSink = router.dispatchTick();
      expect(tSink.admittedRunIds).toEqual([rSink.runId]);
    } finally {
      store.close();
    }
  });

  it("3. Cascades CANCELLED to dependent children when ANY parent ends in FAILED", () => {
    const { store, clock, coordinator, router } = createTestContext();
    try {
      for (const id of ["p1", "p2", "child"]) registerTask(store, coordinator, id);
      const r1 = router.submitTask({ submissionKey: "f-p1", taskId: "p1" });
      const r2 = router.submitTask({ submissionKey: "f-p2", taskId: "p2" });
      const rChild = router.submitTask({
        submissionKey: "f-child",
        taskId: "child",
        parentTaskId: "p1",
        dependsOnTaskIds: ["p1", "p2"],
      });

      router.dispatchTick();
      claimStartComplete(coordinator, store, clock, r1.runId);
      const claim2 = coordinator.claimRun(r2.runId, "worker-dag", 60_000);
      coordinator.startRun(r2.runId, "worker-dag", claim2.lease.leaseId);
      coordinator.failRun(r2.runId, "boom", "worker-dag", claim2.lease.leaseId);

      const tick = router.dispatchTick();
      expect(tick.cancelledRunIds).toEqual([rChild.runId]);
      expect(coordinator.getRun(rChild.runId)?.status).toBe("CANCELLED");
    } finally {
      store.close();
    }
  });

  it("4. Cascades CANCELLED to dependent children when parent is CANCELLED", () => {
    const { store, coordinator, router } = createTestContext();
    try {
      for (const id of ["p", "c"]) registerTask(store, coordinator, id);
      const rp = router.submitTask({ submissionKey: "c-p", taskId: "p" });
      const rc = router.submitTask({ submissionKey: "c-c", taskId: "c", dependsOnTaskIds: ["p"] });
      coordinator.cancelRun(rp.runId, "Operator cancelled parent");
      const tick = router.dispatchTick();
      expect(tick.cancelledRunIds).toEqual([rc.runId]);
      expect(coordinator.getRun(rc.runId)?.status).toBe("CANCELLED");
    } finally {
      store.close();
    }
  });

  it("5. Cascades CANCELLED to dependent children when parent ends in TIMED_OUT", () => {
    const { store, coordinator, router } = createTestContext();
    try {
      for (const id of ["p", "c"]) registerTask(store, coordinator, id);
      const rp = router.submitTask({ submissionKey: "to-p", taskId: "p" });
      const rc = router.submitTask({ submissionKey: "to-c", taskId: "c", dependsOnTaskIds: ["p"] });
      router.dispatchTick();
      const claim = coordinator.claimRun(rp.runId, "worker-dag", 60_000);
      coordinator.startRun(rp.runId, "worker-dag", claim.lease.leaseId);
      coordinator.timeoutRun(rp.runId, "Timed out", { workerId: "worker-dag", leaseId: claim.lease.leaseId });

      const tick = router.dispatchTick();
      expect(tick.cancelledRunIds).toEqual([rc.runId]);
      expect(coordinator.getRun(rc.runId)?.status).toBe("CANCELLED");
    } finally {
      store.close();
    }
  });

  it("6. Keeps dependent child blocked in CREATED while parent is WAITING_APPROVAL", () => {
    const { store, coordinator, router } = createTestContext();
    try {
      for (const id of ["p", "c"]) registerTask(store, coordinator, id);
      const rp = router.submitTask({ submissionKey: "wa-p", taskId: "p" });
      const rc = router.submitTask({ submissionKey: "wa-c", taskId: "c", dependsOnTaskIds: ["p"] });
      router.dispatchTick();
      const claim = coordinator.claimRun(rp.runId, "worker-dag", 60_000);
      coordinator.startRun(rp.runId, "worker-dag", claim.lease.leaseId);
      coordinator.requestApprovalTransition(rp.runId, "approval-1", "write_file", {
        workerId: "worker-dag",
        leaseId: claim.lease.leaseId,
      });

      const tick = router.dispatchTick();
      expect(tick.admittedRunIds).toEqual([]);
      expect(tick.cancelledRunIds).toEqual([]);
      expect(coordinator.getRun(rc.runId)?.status).toBe("CREATED");
    } finally {
      store.close();
    }
  });

  it("7. Keeps dependent child blocked in CREATED while parent is QUEUED/LEASED/RUNNING", () => {
    const { store, coordinator, router } = createTestContext();
    try {
      for (const id of ["p", "c"]) registerTask(store, coordinator, id);
      const rp = router.submitTask({ submissionKey: "run-p", taskId: "p" });
      const rc = router.submitTask({ submissionKey: "run-c", taskId: "c", dependsOnTaskIds: ["p"] });
      router.dispatchTick(); // queues p
      expect(coordinator.getRun(rp.runId)?.status).toBe("QUEUED");
      expect(coordinator.getRun(rc.runId)?.status).toBe("CREATED");

      const claim = coordinator.claimRun(rp.runId, "worker-dag", 60_000);
      router.dispatchTick();
      expect(coordinator.getRun(rc.runId)?.status).toBe("CREATED");

      coordinator.startRun(rp.runId, "worker-dag", claim.lease.leaseId);
      router.dispatchTick();
      expect(coordinator.getRun(rc.runId)?.status).toBe("CREATED");
    } finally {
      store.close();
    }
  });

  it("8. Fails closed (cancels dependent child) when parent MissionContract is REVOKED", () => {
    const { store, clock, coordinator, router } = createTestContext();
    try {
      registerTask(store, coordinator, "p-rev", { tenantId: "tenant-a" });
      registerTask(store, coordinator, "c-rev", { tenantId: "tenant-a" });
      const rp = router.submitTask({ submissionKey: "rev-p", taskId: "p-rev" });
      const rc = router.submitTask({ submissionKey: "rev-c", taskId: "c-rev", dependsOnTaskIds: ["p-rev"] });
      router.dispatchTick();
      expect(coordinator.getRun(rp.runId)?.status).toBe("QUEUED");

      store.revokeContract("contract-p-rev", 1, "Security revocation", clock.nowIso());
      const tick = router.dispatchTick();
      expect(tick.cancelledRunIds).toContain(rc.runId);
      expect(coordinator.getRun(rc.runId)?.status).toBe("CANCELLED");
    } finally {
      store.close();
    }
  });

  it("9. Blocks child when parent emits verification.rejected / UNVERIFIABLE and remains non-completed", () => {
    const { store, clock, coordinator, router } = createTestContext();
    try {
      for (const id of ["p-unv", "c-unv"]) registerTask(store, coordinator, id);
      const rp = router.submitTask({ submissionKey: "unv-p", taskId: "p-unv" });
      const rc = router.submitTask({ submissionKey: "unv-c", taskId: "c-unv", dependsOnTaskIds: ["p-unv"] });
      router.dispatchTick();
      const claim = coordinator.claimRun(rp.runId, "worker-dag", 60_000);
      coordinator.startRun(rp.runId, "worker-dag", claim.lease.leaseId);
      store.transaction((tx) =>
        tx.appendEvent({
          eventId: "evt-ver-rej-1",
          runId: rp.runId,
          timestamp: clock.nowIso(),
          eventType: "verification.rejected",
          schemaVersion: 1,
          producer: "application.step_controller",
          payload: { rejectionCode: "NO_VERIFICATION_SPECS" },
        })
      );

      const tick = router.dispatchTick();
      expect(tick.admittedRunIds).toEqual([]);
      expect(coordinator.getRun(rc.runId)?.status).toBe("CREATED");
    } finally {
      store.close();
    }
  });

  it("10. Rejects self-dependency in both TaskRouterService and MultiAgentOrchestrator", () => {
    const { store, coordinator, router, orchestrator } = createTestContext();
    try {
      registerTask(store, coordinator, "self-t");
      expect(() =>
        router.submitTask({ submissionKey: "self-router-1", taskId: "self-t", dependsOnTaskIds: ["self-t"] })
      ).toThrow(TaskRouterTopologyError);

      registerTask(store, coordinator, "mission-self", { tenantId: "t1" });
      const mRun = router.submitTask({ submissionKey: "self-mission", taskId: "mission-self" });
      expect(mRun.taskId).toBe("mission-self");
      expect(() =>
        orchestrator.decomposeMission({
          missionTaskId: "mission-self",
          subtasks: [{ subtaskId: "s1", role: "RESEARCHER", objective: "Self", dependencies: ["s1"] }],
        })
      ).toThrow(SuperAgentDecompositionError);
    } finally {
      store.close();
    }
  });

  it("11. Rejects unknown / unrouted dependency task IDs", () => {
    const { store, coordinator, router, orchestrator } = createTestContext();
    try {
      registerTask(store, coordinator, "child-u");
      registerTask(store, coordinator, "unrouted-parent");
      expect(() =>
        router.submitTask({ submissionKey: "u-1", taskId: "child-u", dependsOnTaskIds: ["nonexistent"] })
      ).toThrow(TaskRouterTopologyError);
      expect(() =>
        router.submitTask({ submissionKey: "u-2", taskId: "child-u", dependsOnTaskIds: ["unrouted-parent"] })
      ).toThrow(TaskRouterTopologyError);

      registerTask(store, coordinator, "mission-u", { tenantId: "t1" });
      router.submitTask({ submissionKey: "u-m", taskId: "mission-u" });
      expect(() =>
        orchestrator.decomposeMission({
          missionTaskId: "mission-u",
          subtasks: [{ subtaskId: "s1", role: "RESEARCHER", objective: "Bad dep", dependencies: ["missing-subtask"] }],
        })
      ).toThrow(SuperAgentDecompositionError);
    } finally {
      store.close();
    }
  });

  it("12. Rejects cycles in MultiAgentOrchestrator decomposition and router ancestor checks", () => {
    const { store, coordinator, router, orchestrator } = createTestContext();
    try {
      registerTask(store, coordinator, "mission-cyc", { tenantId: "t1" });
      router.submitTask({ submissionKey: "cyc-m", taskId: "mission-cyc" });
      expect(() =>
        orchestrator.decomposeMission({
          missionTaskId: "mission-cyc",
          subtasks: [
            { subtaskId: "s1", role: "RESEARCHER", objective: "A", dependencies: ["s2"] },
            { subtaskId: "s2", role: "TESTER", objective: "B", dependencies: ["s1"] },
          ],
        })
      ).toThrow(SuperAgentDecompositionError);

      // Router topological cycle defense even when submitting valid existing tasks (self-cycle blocked)
      registerTask(store, coordinator, "r1");
      registerTask(store, coordinator, "r2");
      router.submitTask({ submissionKey: "cyc-r1", taskId: "r1" });
      router.submitTask({ submissionKey: "cyc-r2", taskId: "r2", parentTaskId: "r1" });
      expect(() =>
        router.submitTask({ submissionKey: "cyc-r2-self", taskId: "r2", parentTaskId: "r2" })
      ).toThrow(TaskRouterTopologyError);
    } finally {
      store.close();
    }
  });

  it("13. Rejects cross-tenant dependencies via MissionContract tenant or payload tenant", () => {
    const { store, coordinator, router } = createTestContext();
    try {
      registerTask(store, coordinator, "t-alpha", { tenantId: "tenant-alpha" });
      registerTask(store, coordinator, "t-beta", { tenantId: "tenant-beta" });
      registerTask(store, coordinator, "t-payload-gamma", { tenantId: null, payloadTenantId: "tenant-gamma" });
      registerTask(store, coordinator, "t-unscoped", { tenantId: null });

      router.submitTask({ submissionKey: "xt-a", taskId: "t-alpha" });
      expect(() =>
        router.submitTask({ submissionKey: "xt-b", taskId: "t-beta", dependsOnTaskIds: ["t-alpha"] })
      ).toThrow(/cross-tenant/i);
      expect(() =>
        router.submitTask({ submissionKey: "xt-g", taskId: "t-payload-gamma", dependsOnTaskIds: ["t-alpha"] })
      ).toThrow(/cross-tenant/i);
      expect(() =>
        router.submitTask({ submissionKey: "xt-u", taskId: "t-unscoped", dependsOnTaskIds: ["t-alpha"] })
      ).toThrow(/cross-tenant/i);
    } finally {
      store.close();
    }
  });

  it("14. Rejects duplicate edges in dependsOnTaskIds, decomposition dependencies, and SQL store", () => {
    const { store, clock, coordinator, router, orchestrator } = createTestContext();
    try {
      for (const id of ["dup-p", "dup-c1", "dup-c2"]) registerTask(store, coordinator, id);
      router.submitTask({ submissionKey: "dup-p", taskId: "dup-p" });

      expect(() =>
        router.submitTask({ submissionKey: "dup-c1", taskId: "dup-c1", dependsOnTaskIds: ["dup-p", "dup-p"] })
      ).toThrow(/duplicate/i);

      expect(() =>
        store.transaction((tx) => {
          tx.insertTaskDependencies?.("dup-c2", ["dup-p", "dup-p"], clock.nowIso());
        })
      ).toThrow(/Duplicate dependency/i);

      registerTask(store, coordinator, "mission-dup", { tenantId: "t1" });
      router.submitTask({ submissionKey: "dup-m", taskId: "mission-dup" });
      expect(() =>
        orchestrator.decomposeMission({
          missionTaskId: "mission-dup",
          subtasks: [
            { subtaskId: "s1", role: "RESEARCHER", objective: "First" },
            { subtaskId: "s2", role: "TESTER", objective: "Dup", dependencies: ["s1", "s1"] },
          ],
        })
      ).toThrow(SuperAgentDecompositionError);
    } finally {
      store.close();
    }
  });

  it("15. Enforces maxDepth along longest multi-parent DAG dependency path", () => {
    const { store, coordinator, router } = createTestContext({ maxDepth: 2 });
    try {
      for (const id of ["d0", "d1", "d2", "d3"]) registerTask(store, coordinator, id);
      router.submitTask({ submissionKey: "d0", taskId: "d0" }); // depth 0
      router.submitTask({ submissionKey: "d1", taskId: "d1", dependsOnTaskIds: ["d0"] }); // depth 1
      router.submitTask({ submissionKey: "d2", taskId: "d2", dependsOnTaskIds: ["d1"] }); // depth 2
      // Shallow primary parent (d0, depth 0) + deeper secondary edge (d2, depth 2) => depth 3 > maxDepth(2)
      expect(() =>
        router.submitTask({
          submissionKey: "d3",
          taskId: "d3",
          parentTaskId: "d0",
          dependsOnTaskIds: ["d0", "d2"],
        })
      ).toThrow(/maxDepth/i);
    } finally {
      store.close();
    }
  });

  it("16. Enforces maxChildrenPerParent across BOTH tree relations and secondary DAG dependencies", () => {
    const { store, coordinator, router } = createTestContext({ maxChildrenPerParent: 2 });
    try {
      for (const id of ["p-fan", "alt", "c1", "c2", "c3"]) registerTask(store, coordinator, id);
      router.submitTask({ submissionKey: "f-p", taskId: "p-fan" });
      router.submitTask({ submissionKey: "f-alt", taskId: "alt" });
      router.submitTask({ submissionKey: "f-c1", taskId: "c1", parentTaskId: "p-fan" });
      router.submitTask({ submissionKey: "f-c2", taskId: "c2", parentTaskId: "alt", dependsOnTaskIds: ["alt", "p-fan"] });

      expect(() =>
        router.submitTask({ submissionKey: "f-c3", taskId: "c3", dependsOnTaskIds: ["p-fan"] })
      ).toThrow(/maxChildrenPerParent/i);
    } finally {
      store.close();
    }
  });

  it("17. Enforces post-creation/post-start immutability of task_dependencies", () => {
    const { store, clock, coordinator, router } = createTestContext();
    try {
      for (const id of ["imm-p1", "imm-p2", "imm-c"]) registerTask(store, coordinator, id);
      router.submitTask({ submissionKey: "imm-1", taskId: "imm-p1" });
      router.submitTask({ submissionKey: "imm-2", taskId: "imm-p2" });
      router.submitTask({ submissionKey: "imm-c", taskId: "imm-c", dependsOnTaskIds: ["imm-p1"] });

      expect(() =>
        store.transaction((tx) => {
          tx.insertTaskDependencies?.("imm-c", ["imm-p2"], clock.nowIso());
        })
      ).toThrow(/immutable/i);

      expect(() =>
        router.submitTask({
          submissionKey: "imm-c-newkey",
          taskId: "imm-c",
          dependsOnTaskIds: ["imm-p1", "imm-p2"],
        })
      ).toThrow(/already routed/i);

      // Even after running root-only without task_dependencies rows, cannot append deps to non-CREATED task
      const rRun = router.submitTask({ submissionKey: "imm-1", taskId: "imm-p1" });
      expect(rRun.duplicate).toBe(true);
      router.dispatchTick(); // moves imm-p1 to QUEUED
      expect(() =>
        store.transaction((tx) => {
          tx.insertTaskDependencies?.("imm-p1", ["imm-p2"], clock.nowIso());
        })
      ).toThrow(/Cannot mutate dependencies.*QUEUED/i);
    } finally {
      store.close();
    }
  });

  it("18. Preserves diamond DAG edges and ordinal ordering across SQLite restart", () => {
    const dbPath = path.join(tmpDir, "dag-restart.db");
    let sinkRunId = "";
    let leftRunId = "";
    let rightRunId = "";

    {
      const { store, clock, coordinator, router } = createTestContext({ dbPath, maxConcurrentRuns: 2 });
      try {
        for (const id of ["r-root", "r-left", "r-right", "r-sink"]) registerTask(store, coordinator, id);
        const rr = router.submitTask({ submissionKey: "rs-root", taskId: "r-root" });
        leftRunId = router.submitTask({ submissionKey: "rs-left", taskId: "r-left", parentTaskId: "r-root" }).runId;
        rightRunId = router.submitTask({ submissionKey: "rs-right", taskId: "r-right", parentTaskId: "r-root" }).runId;
        sinkRunId = router.submitTask({
          submissionKey: "rs-sink",
          taskId: "r-sink",
          parentTaskId: "r-left",
          dependsOnTaskIds: ["r-right", "r-left"],
        }).runId;

        router.dispatchTick();
        claimStartComplete(coordinator, store, clock, rr.runId);
        router.dispatchTick();
        claimStartComplete(coordinator, store, clock, leftRunId);
        router.dispatchTick();
        expect(coordinator.getRun(sinkRunId)?.status).toBe("CREATED");
      } finally {
        store.close();
      }
    }

    // Reopen fresh instances from disk
    {
      const { store, clock, coordinator, router } = createTestContext({ dbPath, maxConcurrentRuns: 2 });
      try {
        const tree = router.getTaskTreeStatus("r-root");
        const sinkNode = tree.root.children.flatMap((c) => c.children).find((n) => n.taskId === "r-sink");
        expect(sinkNode?.dependsOnTaskIds).toEqual(["r-right", "r-left"]);

        router.dispatchTick();
        expect(coordinator.getRun(sinkRunId)?.status).toBe("CREATED");

        claimStartComplete(coordinator, store, clock, rightRunId);
        const tickAfterRestart = router.dispatchTick();
        expect(tickAfterRestart.admittedRunIds).toEqual([sinkRunId]);
      } finally {
        store.close();
      }
    }
  });

  it("19. Enforces submission idempotency, conflict rejection, and maxConcurrentRuns across fan-out DAG", () => {
    const { store, coordinator, router } = createTestContext({ maxConcurrentRuns: 1 });
    try {
      for (const id of ["f1", "f2", "f3"]) registerTask(store, coordinator, id);
      const first = router.submitTask({ submissionKey: "idem-k1", taskId: "f1" });
      const retry = router.submitTask({ submissionKey: "idem-k1", taskId: "f1" });
      expect(retry.duplicate).toBe(true);
      expect(retry.runId).toBe(first.runId);

      expect(() =>
        router.submitTask({ submissionKey: "idem-k1", taskId: "f2" })
      ).toThrow(SubmissionConflictError);

      const s2 = router.submitTask({ submissionKey: "idem-k2", taskId: "f2" });
      const s3 = router.submitTask({ submissionKey: "idem-k3", taskId: "f3" });
      const tick1 = router.dispatchTick();
      expect(tick1.admittedRunIds).toHaveLength(1);
      expect(tick1.inFlight).toBe(0);
      expect(router.dispatchTick().inFlight).toBe(1);
      expect(coordinator.getRun(s2.runId)?.status).toBe("CREATED");
      expect(coordinator.getRun(s3.runId)?.status).toBe("CREATED");
    } finally {
      store.close();
    }
  });

  it("20. Migrates legacy task_relations rows cleanly into task_dependencies and supports MultiAgentOrchestrator diamond synthesis", () => {
    // Part A: Legacy DB with task_relations only (no task_dependencies table yet)
    const legacyDbPath = path.join(tmpDir, "legacy.db");
    {
      const raw = new DatabaseSync(legacyDbPath);
      raw.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          input_payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE task_relations (
          child_task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
          parent_task_id TEXT NOT NULL REFERENCES tasks(task_id),
          depth INTEGER NOT NULL CHECK (depth >= 1),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          created_at TEXT NOT NULL
        );
        INSERT INTO tasks VALUES ('leg-root', 'Root', '', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO tasks VALUES ('leg-child', 'Child', '', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO task_relations VALUES ('leg-child', 'leg-root', 1, 0, '2026-01-01T00:00:00Z');
      `);
      raw.close();
    }

    const migratedStore = new SqliteStateStore({ location: legacyDbPath });
    try {
      const migratedDeps = migratedStore.transaction((tx) => tx.listTaskDependencies("leg-child"));
      expect(migratedDeps).toEqual([
        {
          childTaskId: "leg-child",
          parentTaskId: "leg-root",
          ordinal: 0,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]);
      expect(migratedStore.transaction((tx) => tx.listDependentTaskIds("leg-root"))).toEqual(["leg-child"]);
      const idxCheck = new DatabaseSync(legacyDbPath, { readOnly: true });
      try {
        const idxRow = idxCheck
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_dependencies_child'")
          .get() as { name?: string } | undefined;
        expect(idxRow?.name).toBe("idx_task_dependencies_child");
      } finally {
        idxCheck.close();
      }
    } finally {
      migratedStore.close();
    }

    // Part B: MultiAgentOrchestrator diamond decomposition + capability fencing + zero self-approval synthesis
    const { store, clock, coordinator, router, orchestrator } = createTestContext();
    try {
      registerTask(store, coordinator, "mission-20", {
        tenantId: "tenant-20",
        capabilities: ["workspace.file.read", "workspace.code.search", "git.read"],
      });
      const mSub = router.submitTask({ submissionKey: "sub-m20", taskId: "mission-20" });
      router.dispatchTick();
      const mClaim = coordinator.claimRun(mSub.runId, "worker-dag", 60_000);
      coordinator.startRun(mSub.runId, "worker-dag", mClaim.lease.leaseId);

      const subtaskVerif = [createVerificationSpec({ specId: "dag-test-spec", ruleKind: "EXIT_CODE_ZERO" })];
      const decomp = orchestrator.decomposeMission({
        missionTaskId: "mission-20",
        subtasks: [
          { subtaskId: "sub-a", role: "RESEARCHER", objective: "Read A", verificationSpecs: subtaskVerif },
          { subtaskId: "sub-b", role: "RESEARCHER", objective: "Read B", verificationSpecs: subtaskVerif },
          { subtaskId: "sub-join", role: "REVIEWER", objective: "Review both", dependencies: ["sub-a", "sub-b"], verificationSpecs: subtaskVerif },
        ],
      });

      const taskA = decomp.subtaskTaskIds[decomp.subtasks.findIndex((s) => s.subtaskId === "sub-a")]!;
      const taskB = decomp.subtaskTaskIds[decomp.subtasks.findIndex((s) => s.subtaskId === "sub-b")]!;
      const taskJoin = decomp.subtaskTaskIds[decomp.subtasks.findIndex((s) => s.subtaskId === "sub-join")]!;
      const joinDeps = store.transaction((tx) => tx.listTaskDependencies(taskJoin));
      expect(new Set(joinDeps.map((d) => d.parentTaskId))).toEqual(new Set([taskA, taskB]));

      const t1 = router.dispatchTick();
      // mission-20 is itself RUNNING (1/2 concurrency slots), so 1 child branch is admitted first
      expect(t1.admittedRunIds).toHaveLength(1);
      const joinSub = store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskJoin))!;
      expect(coordinator.getRun(joinSub.runId)?.status).toBe("CREATED");

      const reportInProgress = orchestrator.synthesizeMission("mission-20");
      expect(reportInProgress.verdict).toBe("IN_PROGRESS");

      const runA = store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskA))!.runId;
      const runB = store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskB))!.runId;
      claimStartComplete(coordinator, store, clock, runA);
      const t1b = router.dispatchTick();
      expect(t1b.admittedRunIds).toEqual([runB]);
      expect(coordinator.getRun(joinSub.runId)?.status).toBe("CREATED");
      claimStartComplete(coordinator, store, clock, runB);

      const t2 = router.dispatchTick();
      expect(t2.admittedRunIds).toEqual([joinSub.runId]);
      claimStartComplete(coordinator, store, clock, joinSub.runId);

      const finalReport = orchestrator.synthesizeMission("mission-20");
      expect(finalReport.verdict).toBe("SUCCESS");
      expect(finalReport.verifiedCount).toBe(3);
    } finally {
      store.close();
    }
  });
});
