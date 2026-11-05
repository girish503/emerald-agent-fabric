/**
 * Emerald Agent Fabric — Milestone 2.9A: Recovered Attempt Action-History Verification
 *
 * Deterministic regression tests proving that:
 * 1. Prior completed actions from Attempt 1 are preserved across crash recovery.
 * 2. When a recovered run executes in Attempt 2, ContextSource and ContextEngine
 *    include all prior completed actions in ACTION_HISTORY and ATTEMPT_HISTORY observations.
 * 3. The deterministic model brain in Attempt 2 receives these prior action observations
 *    in its ContextSnapshot.
 * 4. Subsequent actions allocated during Attempt 2 receive monotonically increasing,
 *    gapless sequence numbers starting at `priorActions.length + 1` (e.g. sequence 3).
 * 5. Prior action records in the state store are never silently overwritten or deleted.
 * 6. Explicit limitation documented: ACTION_HISTORY provides epistemic visibility to the model,
 *    but the runtime does NOT claim automatic exactly-once execution or external side-effect deduplication.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { ContextSnapshot } from "../../src/domain/context.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Deterministic Scripted Brain
// ============================================================================

class ScriptedDeterministicBrain implements AgentBrainPort {
  private callCount = 0;
  private readonly handler: (
    request: AgentBrainRequest,
    callNumber: number
  ) => Promise<AgentBrainResult> | AgentBrainResult;

  constructor(
    handler: (
      request: AgentBrainRequest,
      callNumber: number
    ) => Promise<AgentBrainResult> | AgentBrainResult
  ) {
    this.handler = handler;
  }

  get totalCalls(): number {
    return this.callCount;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.callCount++;
    return this.handler(request, this.callCount);
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Milestone 2.9A — Recovered Attempt Action-History Verification", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-recovered-action-test-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-03T10:00:00.000Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp dir cleanup
    }
  });

  function setupGovernedRun() {
    // Title 'echo' maps to recognized capability 'execution.echo' in policy
    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { goal: "Verify action history continuity after crash" },
    });

    createAndActivateContract(store, task.taskId, {
      contractId: `contract-${task.taskId}`,
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: [
          "execution.echo",
          "workspace.file.read",
          "workspace.file.write",
        ],
        isolationRequirement: "IN_PROCESS",
        trustedInProcessOperations: ["echo"],
      }),
      maxAttempts: 3,
      timeoutMs: 30000,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);

    return { task, run };
  }

  it("preserves prior attempt actions, presents them in ACTION_HISTORY to attempt 2, and sequences new actions monotonically", async () => {
    const { task, run } = setupGovernedRun();
    const worker1Id = "worker-attempt-1";
    const worker2Id = "worker-attempt-2";

    coordinator.registerWorker({
      workerId: worker1Id,
      hostname: "node-1",
      pid: 1001,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
    coordinator.registerWorker({
      workerId: worker2Id,
      hostname: "node-2",
      pid: 1002,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    // ------------------------------------------------------------------------
    // Step 1: Attempt 1 claims run and executes two actions
    // ------------------------------------------------------------------------
    const claim1 = coordinator.claimRun(run.runId, worker1Id, 10000);
    coordinator.startRun(run.runId, worker1Id, claim1.lease.leaseId);

    const runtime1 = new WorkerRuntime({
      workerId: worker1Id,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: new GovernedAgentExecutionProvider({ name: "in-process" }),
    });

    const ws1 = await workspaceAdapter.provisionWorkspace(
      {
        workspaceId: `ws-${run.runId}-att1`,
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 1048576,
        maxFileSizeBytes: 1048576,
      } as never,
      { runId: run.runId, leaseId: claim1.lease.leaseId }
    );

    // Persist Action 1 in Attempt 1
    const act1 = await runtime1.executeAction({
      runId: run.runId,
      toolName: "write_file",
      inputPayload: { path: "step1.txt", content: "data from attempt 1 step 1" },
      workspace: ws1,
      leaseId: claim1.lease.leaseId,
    });
    expect(act1.status).toBe("SUCCEEDED");

    // Persist Action 2 in Attempt 1
    const act2 = await runtime1.executeAction({
      runId: run.runId,
      toolName: "read_file",
      inputPayload: { path: "step1.txt" },
      workspace: ws1,
      leaseId: claim1.lease.leaseId,
    });
    expect(act2.status).toBe("SUCCEEDED");

    // Verify Attempt 1 persisted state
    const actionsAfterAttempt1 = store.getActionsForRun(run.runId);
    expect(actionsAfterAttempt1).toHaveLength(2);
    expect(actionsAfterAttempt1[0]?.sequenceNumber).toBe(1);
    expect(actionsAfterAttempt1[1]?.sequenceNumber).toBe(2);
    expect(actionsAfterAttempt1[0]?.actionId).toBe(act1.actionId);
    expect(actionsAfterAttempt1[1]?.actionId).toBe(act2.actionId);

    // ------------------------------------------------------------------------
    // Step 2: Worker 1 crashes (lease expires without renewal) and Recovery sweeps run
    // ------------------------------------------------------------------------
    clock.advanceMs(11000); // Exceed 10000ms TTL

    const recoveryResult = coordinator.recoverExpiredRuns();
    expect(recoveryResult.recoveredCount).toBe(1);

    const runAfterRecovery = store.getRun(run.runId)!;
    expect(runAfterRecovery.status).toBe("QUEUED");
    // attemptCount in domain represents retry count (initial = 0, first retry = 1)
    expect(runAfterRecovery.attemptCount).toBe(1);
    expect(runAfterRecovery.leaseId).toBeNull();
    expect(runAfterRecovery.currentWorkerId).toBeNull();

    // Verify actions survived recovery untouched
    const actionsDuringRecovery = store.getActionsForRun(run.runId);
    expect(actionsDuringRecovery).toHaveLength(2);
    expect(actionsDuringRecovery[0]?.actionId).toBe(act1.actionId);
    expect(actionsDuringRecovery[1]?.actionId).toBe(act2.actionId);

    // ------------------------------------------------------------------------
    // Step 3: Attempt 2 executes through GovernedAgentExecutionProvider + WorkerRuntime
    // ------------------------------------------------------------------------
    let capturedContextSnapshotAttempt2: ContextSnapshot | undefined;
    let attempt2CallCount = 0;

    const brainAttempt2 = new ScriptedDeterministicBrain((req, callNumber) => {
      attempt2CallCount++;
      if (callNumber === 1) {
        capturedContextSnapshotAttempt2 = req.contextSnapshot;

        // Model inspects context and proposes Action 3
        return {
          finishReason: "ACTION_PROPOSED",
          proposal: {
            proposalId: "prop-attempt2-step3",
            toolName: "write_file",
            inputPayload: {
              path: "step3.txt",
              content: "data produced in attempt 2",
            },
            contextSnapshotHash: req.contextSnapshot.contextHash,
            rationale: "Advancing task in attempt 2 after observing action history",
          },
        };
      }

      if (callNumber === 2) {
        return {
          finishReason: "GOAL_REACHED",
          proposal: {
            isGoalReached: true,
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
        };
      }

      return {
        finishReason: "GOAL_REACHED",
        proposal: { isGoalReached: true },
      };
    });

    const executionProviderAttempt2 = new GovernedAgentExecutionProvider({
      name: "in-process",
    });

    const runtime2 = new WorkerRuntime({
      workerId: worker2Id,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: executionProviderAttempt2,
    });

    const stepControllerAttempt2 = new AgentStepController({
      allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
      coordinator,
      stateStore: store,
      workerRuntime: runtime2,
      agentBrain: brainAttempt2,
      clock,
    });

    executionProviderAttempt2.setStepController(stepControllerAttempt2);

    // Execute Attempt 2 via official application entry point
    const worker2Result = await runtime2.runOnce(run.runId);
    expect(worker2Result.status).toBe("COMPLETED");
    expect(attempt2CallCount).toBe(2);

    // ------------------------------------------------------------------------
    // Step 4: Verify Context Observations in Attempt 2
    // ------------------------------------------------------------------------
    expect(capturedContextSnapshotAttempt2).toBeDefined();

    const actionHistoryObs = capturedContextSnapshotAttempt2!.observations.filter(
      (obs) => obs.category === "ACTION_HISTORY"
    );
    expect(actionHistoryObs).toHaveLength(2);

    // Verify Action 1 representation in model context
    expect(actionHistoryObs[0]?.content).toMatchObject({
      actionId: act1.actionId,
      sequenceNumber: 1,
      toolName: "write_file",
      status: "SUCCEEDED",
      totalAttempts: 1,
    });

    // Verify Action 2 representation in model context
    expect(actionHistoryObs[1]?.content).toMatchObject({
      actionId: act2.actionId,
      sequenceNumber: 2,
      toolName: "read_file",
      status: "SUCCEEDED",
      totalAttempts: 1,
    });

    // Verify Attempt history observations are also present
    const attemptHistoryObs = capturedContextSnapshotAttempt2!.observations.filter(
      (obs) => obs.category === "ATTEMPT_HISTORY"
    );
    expect(attemptHistoryObs.length).toBeGreaterThanOrEqual(2);

    // ------------------------------------------------------------------------
    // Step 5: Verify Durable Persistence & Non-Destructive Continuity
    // ------------------------------------------------------------------------
    const finalActions = store.getActionsForRun(run.runId);
    expect(finalActions).toHaveLength(3);

    // Invariant: Prior Action 1 and 2 records were NOT deleted or overwritten
    expect(finalActions[0]?.actionId).toBe(act1.actionId);
    expect(finalActions[0]?.sequenceNumber).toBe(1);
    expect(finalActions[0]?.status).toBe("SUCCEEDED");

    expect(finalActions[1]?.actionId).toBe(act2.actionId);
    expect(finalActions[1]?.sequenceNumber).toBe(2);
    expect(finalActions[1]?.status).toBe("SUCCEEDED");

    // Invariant: Action 3 allocated in Attempt 2 received sequenceNumber 3
    expect(finalActions[2]?.sequenceNumber).toBe(3);
    expect(finalActions[2]?.toolName).toBe("write_file");
    expect(finalActions[2]?.status).toBe("SUCCEEDED");
    expect(finalActions[2]?.actionId).not.toBe(act1.actionId);
    expect(finalActions[2]?.actionId).not.toBe(act2.actionId);

    // Verify final run state
    const finalRun = store.getRun(run.runId)!;
    expect(finalRun.status).toBe("COMPLETED");
    expect(finalRun.attemptCount).toBe(1);
  });

  it("verifies that the runtime permits repeating an equivalent tool proposal across attempts without deduplication", async () => {
    const { task, run } = setupGovernedRun();
    const worker1Id = "worker-attempt-1";
    const worker2Id = "worker-attempt-2";

    coordinator.registerWorker({
      workerId: worker1Id,
      hostname: "node-1",
      pid: 1001,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });
    coordinator.registerWorker({
      workerId: worker2Id,
      hostname: "node-2",
      pid: 1002,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    // Attempt 1: Execute Action 1 (write data.txt)
    const claim1 = coordinator.claimRun(run.runId, worker1Id, 10000);
    coordinator.startRun(run.runId, worker1Id, claim1.lease.leaseId);

    const runtime1 = new WorkerRuntime({
      workerId: worker1Id,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: new GovernedAgentExecutionProvider({ name: "in-process" }),
    });

    const ws1 = await workspaceAdapter.provisionWorkspace(
      {
        workspaceId: `ws-${run.runId}-repeat-1`,
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 1048576,
        maxFileSizeBytes: 1048576,
      } as never,
      { runId: run.runId, leaseId: claim1.lease.leaseId }
    );

    const act1 = await runtime1.executeAction({
      runId: run.runId,
      toolName: "write_file",
      inputPayload: { path: "data.txt", content: "attempt 1 content" },
      workspace: ws1,
      leaseId: claim1.lease.leaseId,
    });
    expect(act1.status).toBe("SUCCEEDED");

    // Worker 1 lease expires
    clock.advanceMs(11000);
    expect(coordinator.recoverExpiredRuns().recoveredCount).toBe(1);

    // Attempt 2: Brain intentionally proposes an action identical to Attempt 1's action
    const brainAttempt2 = new ScriptedDeterministicBrain((req, callNumber) => {
      if (callNumber === 1) {
        return {
          finishReason: "ACTION_PROPOSED",
          proposal: {
            proposalId: "prop-repeat-act1",
            toolName: "write_file",
            inputPayload: { path: "data.txt", content: "attempt 1 content" }, // Identical payload
            contextSnapshotHash: req.contextSnapshot.contextHash,
            rationale: "Repeating write proposal across attempt boundary",
          },
        };
      }
      return {
        finishReason: "GOAL_REACHED",
        proposal: { isGoalReached: true },
      };
    });

    const executionProviderAttempt2 = new GovernedAgentExecutionProvider({
      name: "in-process",
    });

    const runtime2 = new WorkerRuntime({
      workerId: worker2Id,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: executionProviderAttempt2,
    });

    const stepControllerAttempt2 = new AgentStepController({
      allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
      coordinator,
      stateStore: store,
      workerRuntime: runtime2,
      agentBrain: brainAttempt2,
      clock,
    });

    executionProviderAttempt2.setStepController(stepControllerAttempt2);

    const result2 = await runtime2.runOnce(run.runId);
    expect(result2.status).toBe("COMPLETED");

    // Documented Semantics:
    // 1. Runtime DOES NOT reject the proposal as a duplicate across attempts.
    // 2. A new Action aggregate is created with sequenceNumber 2.
    // 3. Action 1 from Attempt 1 is preserved and remains SUCCEEDED.
    const allActions = store.getActionsForRun(run.runId);
    expect(allActions).toHaveLength(2);
    expect(allActions[0]?.sequenceNumber).toBe(1);
    expect(allActions[0]?.actionId).toBe(act1.actionId);
    expect(allActions[1]?.sequenceNumber).toBe(2);
    expect(allActions[1]?.actionId).not.toBe(act1.actionId);
  });
});
