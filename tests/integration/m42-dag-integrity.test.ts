import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  TaskRouterService,
  TaskRouterTopologyError,
} from "../../src/application/task-router.js";
import { MultiAgentOrchestrator } from "../../src/application/multi-agent-orchestrator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";

describe("M4.2 WS-B — Durable Multi-Parent DAG Integrity", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let router: TaskRouterService;
  let clock: SettableClock;

  const workerId = "worker-dag-1";

  const makeTask = (
    taskId: string,
    tenantId = "tenant-default",
    extraCapabilities: readonly string[] = []
  ) => {
    const basePolicy = createDefaultInProcessPolicy(`policy-${taskId}`);
    coordinator.createTask({
      taskId,
      title: `Task ${taskId}`,
      inputPayload: { goal: taskId },
    });
    createAndActivateContract(store, taskId, {
      policy: {
        ...basePolicy,
        tenantId,
        allowedCapabilities: [...basePolicy.allowedCapabilities, ...extraCapabilities],
      },
    });
  };

  const runIdOf = (taskId: string): string =>
    store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskId)!.runId);

  const statusOf = (taskId: string): string => store.getRun(runIdOf(taskId))!.status;

  const completeTask = (taskId: string) => {
    const runId = runIdOf(taskId);
    const claim = coordinator.claimRun(runId, workerId, 60_000);
    coordinator.startRun(runId, workerId, claim.lease.leaseId);
    coordinator.completeRun(runId, workerId, claim.lease.leaseId, { ok: true, taskId });
  };

  const failTask = (taskId: string) => {
    const runId = runIdOf(taskId);
    const claim = coordinator.claimRun(runId, workerId, 60_000);
    coordinator.startRun(runId, workerId, claim.lease.leaseId);
    coordinator.failRun(runId, { message: `failed-${taskId}` }, workerId, claim.lease.leaseId);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m42-dag-"));
    dbPath = path.join(tmpDir, "dag.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock("2026-11-12T10:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);
    store.transaction((tx) =>
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      })
    );
    router = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("gates diamond sink C until BOTH A and B reach COMPLETED", () => {
    makeTask("task-root");
    makeTask("task-a");
    makeTask("task-b");
    makeTask("task-c");

    router.submitTask({ taskId: "task-root", tenantId: "tenant-default", submissionKey: "k-root" });
    router.dispatchTick();
    expect(statusOf("task-root")).toBe("QUEUED");

    router.submitTask({
      taskId: "task-a",
      tenantId: "tenant-default",
      submissionKey: "k-a",
      parentTaskId: "task-root",
    });
    router.submitTask({
      taskId: "task-b",
      tenantId: "tenant-default",
      submissionKey: "k-b",
      parentTaskId: "task-root",
    });
    router.submitTask({
      taskId: "task-c",
      tenantId: "tenant-default",
      submissionKey: "k-c",
      parentTaskId: "task-b",
      dependsOnTaskIds: ["task-a", "task-b"],
    });

    completeTask("task-root");
    router.dispatchTick();
    expect(statusOf("task-a")).toBe("QUEUED");
    expect(statusOf("task-b")).toBe("QUEUED");
    expect(statusOf("task-c")).toBe("CREATED");

    // Only A completes -> C MUST remain CREATED because B is not terminal
    completeTask("task-a");
    router.dispatchTick();
    expect(statusOf("task-c")).toBe("CREATED");

    // Put B into WAITING_APPROVAL -> C MUST still remain CREATED
    const bRunId = runIdOf("task-b");
    const bClaim = coordinator.claimRun(bRunId, workerId, 60_000);
    coordinator.startRun(bRunId, workerId, bClaim.lease.leaseId);
    coordinator.requestApprovalTransition(
      bRunId,
      "approval-b-1",
      "run_command",
      { workerId, leaseId: bClaim.lease.leaseId }
    );
    expect(store.getRun(bRunId)!.status).toBe("WAITING_APPROVAL");
    router.dispatchTick();
    expect(statusOf("task-c")).toBe("CREATED");

    // Approve & complete B -> C becomes QUEUED
    coordinator.resumeFromApproval(bRunId, "approval-b-1", "human-reviewer-1");
    completeTask("task-b");
    router.dispatchTick();
    expect(statusOf("task-c")).toBe("QUEUED");
  });

  it("cancels sink C when non-tree dependency A fails, even if tree parent B succeeded", () => {
    makeTask("task-a2");
    makeTask("task-b2");
    makeTask("task-c2");

    router.submitTask({ taskId: "task-a2", tenantId: "tenant-default", submissionKey: "k-a2" });
    router.submitTask({ taskId: "task-b2", tenantId: "tenant-default", submissionKey: "k-b2" });
    router.submitTask({
      taskId: "task-c2",
      tenantId: "tenant-default",
      submissionKey: "k-c2",
      parentTaskId: "task-b2",
      dependsOnTaskIds: ["task-a2", "task-b2"],
    });

    router.dispatchTick();
    completeTask("task-b2");
    failTask("task-a2");

    router.dispatchTick();
    expect(statusOf("task-c2")).toBe("CANCELLED");
  });

  it("cancels downstream dependents when cancelling non-tree dependency A", () => {
    makeTask("task-a3");
    makeTask("task-b3");
    makeTask("task-c3");

    router.submitTask({ taskId: "task-a3", tenantId: "tenant-default", submissionKey: "k-a3" });
    router.submitTask({ taskId: "task-b3", tenantId: "tenant-default", submissionKey: "k-b3" });
    router.submitTask({
      taskId: "task-c3",
      tenantId: "tenant-default",
      submissionKey: "k-c3",
      parentTaskId: "task-b3",
      dependsOnTaskIds: ["task-a3", "task-b3"],
    });

    const cancelled = router.cancelTaskTree("task-a3", "non-tree parent aborted");
    expect(cancelled.cancelledRunIds).toContain(runIdOf("task-a3"));
    expect(cancelled.cancelledRunIds).toContain(runIdOf("task-c3"));
    expect(statusOf("task-c3")).toBe("CANCELLED");
    // Unrelated sibling B stays CREATED/unaffected
    expect(statusOf("task-b3")).toBe("CREATED");
  });

  it("rejects cross-tenant dependencies and cycles cleanly", () => {
    makeTask("t-alpha-1", "tenant-alpha");
    makeTask("t-beta-1", "tenant-beta");

    router.submitTask({ taskId: "t-alpha-1", tenantId: "tenant-alpha", submissionKey: "ka" });

    expect(() =>
      router.submitTask({
        taskId: "t-beta-1",
        tenantId: "tenant-beta",
        submissionKey: "kb",
        dependsOnTaskIds: ["t-alpha-1"],
      })
    ).toThrow();

    // Self-dependency check
    makeTask("t-alpha-2", "tenant-alpha");
    expect(() =>
      router.submitTask({
        taskId: "t-alpha-2",
        tenantId: "tenant-alpha",
        submissionKey: "ka2",
        dependsOnTaskIds: ["t-alpha-2"],
      })
    ).toThrow(TaskRouterTopologyError);
  });

  it("persists DAG dependencies across SQLite restart and multi-agent orchestrator diamond decomposition", () => {
    makeTask("mission-diamond", "tenant-default", [
      "workspace.file.read",
      "workspace.code.search",
      "git.read",
      "process.execute",
    ]);
    router.submitTask({
      taskId: "mission-diamond",
      submissionKey: "k-mission",
    });

    const orchestrator = new MultiAgentOrchestrator(store, coordinator, router, clock, {
      maxDepth: 4,
      maxChildrenPerParent: 8,
    });

    const decomposition = orchestrator.decomposeMission({
      missionTaskId: "mission-diamond",
      subtasks: [
        { subtaskId: "research_a", role: "RESEARCHER", objective: "Analyze A", dependencies: [] },
        { subtaskId: "inspect_b", role: "REVIEWER", objective: "Inspect B", dependencies: [] },
        {
          subtaskId: "synth_c",
          role: "TESTER",
          objective: "Combine A and B",
          dependencies: ["research_a", "inspect_b"],
        },
      ],
    });

    const [taskA, taskB, taskC] = decomposition.subtaskTaskIds as [string, string, string];

    // Close DB and reopen to validate SQLite durability
    store.close();
    store = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(store, clock);
    router = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
    const reopenedOrchestrator = new MultiAgentOrchestrator(store, coordinator, router, clock);

    const treeStatus = router.getTaskTreeStatus("mission-diamond");
    const allTreeNodes: Array<typeof treeStatus.root> = [];
    const stack = [treeStatus.root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      allTreeNodes.push(n);
      stack.push(...n.children);
    }
    const nodeC = allTreeNodes.find((n) => n.taskId === taskC)!;
    expect(nodeC.dependsOnTaskIds).toBeDefined();
    expect(new Set(nodeC.dependsOnTaskIds)).toEqual(new Set([taskA, taskB]));

    const hierarchy = reopenedOrchestrator.getHierarchy("mission-diamond");
    const allHierarchyNodes: Array<typeof hierarchy.root> = [];
    const hStack = [hierarchy.root];
    while (hStack.length > 0) {
      const n = hStack.pop()!;
      allHierarchyNodes.push(n);
      hStack.push(...n.children);
    }
    const hNodeC = allHierarchyNodes.find((n) => n.taskId === taskC)!;
    expect(new Set(hNodeC.dependsOnTaskIds)).toEqual(new Set([taskA, taskB]));

    // Reopened router has maxConcurrentRuns=2: mission-diamond + taskA are admitted; taskC remains CREATED
    router.dispatchTick();
    expect(statusOf(taskA)).toBe("QUEUED");
    expect(statusOf(taskC)).toBe("CREATED");

    // Complete A -> C MUST still remain CREATED; taskB gets admitted next
    completeTask(taskA);
    router.dispatchTick();
    expect(statusOf(taskB)).toBe("QUEUED");
    expect(statusOf(taskC)).toBe("CREATED");

    // Complete B -> now BOTH A and B are COMPLETED, so C becomes QUEUED!
    completeTask(taskB);
    router.dispatchTick();
    expect(statusOf(taskC)).toBe("QUEUED");
  });

  it("H-3: persists both parentTaskId and dependsOnTaskIds immediately before restart with consistent gating", () => {
    makeTask("p-parent");
    makeTask("dep-sibling");
    makeTask("child-both");

    router.submitTask({ taskId: "p-parent", submissionKey: "k-p-parent" });
    router.submitTask({ taskId: "dep-sibling", submissionKey: "k-dep-sibling" });
    router.submitTask({
      taskId: "child-both",
      submissionKey: "k-child-both",
      parentTaskId: "p-parent",
      dependsOnTaskIds: ["dep-sibling"],
    });

    const depsPreRestart = store.transaction((tx) => tx.listTaskDependencies("child-both"));
    expect(depsPreRestart.map((d) => d.parentTaskId)).toEqual(["dep-sibling", "p-parent"]);

    // Admit parents (concurrent=2 admits both p-parent and dep-sibling); child-both stays CREATED
    router.dispatchTick();
    expect(statusOf("child-both")).toBe("CREATED");

    // Completing only dep-sibling must NOT unlock child-both before p-parent completes
    completeTask("dep-sibling");
    router.dispatchTick();
    expect(statusOf("child-both")).toBe("CREATED");

    // Close and reopen SQLite; verify exact same dependencies & ordinals survive
    store.close();
    store = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(store, clock);
    router = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });

    const depsPostRestart = store.transaction((tx) => tx.listTaskDependencies("child-both"));
    expect(depsPostRestart.map((d) => ({ parentTaskId: d.parentTaskId, ordinal: d.ordinal }))).toEqual([
      { parentTaskId: "dep-sibling", ordinal: 0 },
      { parentTaskId: "p-parent", ordinal: 1 },
    ]);

    completeTask("p-parent");
    router.dispatchTick();
    expect(statusOf("child-both")).toBe("QUEUED");
  });
});
