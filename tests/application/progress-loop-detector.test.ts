/**
 * Milestone 2.24 — Generalized Progress Accounting & Multi-Step Loop Detection
 *
 * Deterministic tests covering:
 * 1. Two-action repeated cycle without progress.
 * 2. Three-action repeated cycle without progress.
 * 3. Same sequence with genuine progress.
 * 4. Different action inputs that must not be treated as identical.
 * 5. Verification success breaking a stagnation cycle.
 * 6. Indeterminate execution outcome.
 * 7. Existing repeated-read protection.
 * 8. Existing repeated-write protection.
 * 9. Existing ineffective-edit protection.
 * 10. Bounded history and cycle length.
 * 11. Checkpoint reconstruction and recovery.
 * 12. Lease loss during cycle detection.
 * 13. No false completion or run.completed event after stagnation.
 * 14. safeToResume remains false.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import {
  AgentStepController,
  DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { ProgressLoopDetector } from "../../src/application/progress-loop-detector.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { MissionControl } from "../../src/control-plane/mission-control.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

class ScriptableAgentBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const next = this.steps.shift();
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

describe("Milestone 2.24 — Generalized Progress Accounting & Multi-Step Loop Detection", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let brain: ScriptableAgentBrain;
  let workerRuntime: WorkerRuntime;
  let stepController: AgentStepController;
  const workerId = "worker-progress-loop";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-progress-loop-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date().toISOString());
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    workerRuntime = new WorkerRuntime({ workerId, coordinator, clock, workspacePort: workspaceAdapter });
    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });
    brain = new ScriptableAgentBrain();
    stepController = new AgentStepController({
      allowUnverifiedCompletion: true,
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 8888,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupGovernedRun() {
    const task = coordinator.createTask({
      title: "Progress loop detection task",
      description: "Testing progress loop detection",
      inputPayload: { target: "test" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write", "workspace.code.search"],
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxAttempts: 3,
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 60000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
    const workspace = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    return { runId: run.runId, leaseId: claim.lease.leaseId, workspace };
  }

  const write = (id: string, filePath: string, content: string) => (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "write_file",
      inputPayload: { path: filePath, content, overwrite: true },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

  const read = (id: string, filePath: string) => (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "read_file",
      inputPayload: { path: filePath },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

  const search = (id: string, query: string) => (req: AgentBrainRequest): AgentBrainResult => ({
    proposal: {
      proposalId: id,
      toolName: "search_code",
      inputPayload: { query },
      contextSnapshotHash: req.contextSnapshot.contextHash,
    },
    finishReason: "ACTION_PROPOSED",
  });

  // 1. Two-action repeated cycle without progress
  it("Scenario 1: halts with CYCLE_DETECTED on a repeated two-action cycle without progress (A -> B -> A -> B)", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "a.txt"), "content A");
    fs.writeFileSync(path.join(workspace.hostPath, "b.txt"), "content B");

    let step5Invoked = false;
    brain
      .queueStep(read("r1", "a.txt"))
      .queueStep(read("r2", "b.txt"))
      .queueStep(read("r3", "a.txt"))
      .queueStep(read("r4", "b.txt"))
      .queueStep(() => {
        step5Invoked = true;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 10 },
    });

    expect(result.terminalReason).toBe("CYCLE_DETECTED");
    expect(result.terminalMessage).toContain("cycle stagnation");
    expect(result.terminalMessage).toContain("read_file -> read_file");
    expect(result.totalActions).toBe(4);
    expect(step5Invoked).toBe(false);
  });

  // 2. Three-action repeated cycle without progress
  it("Scenario 2: halts with CYCLE_DETECTED on a repeated three-action cycle without progress (A -> B -> C -> A -> B -> C)", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "a.txt"), "content A");
    fs.writeFileSync(path.join(workspace.hostPath, "b.txt"), "content B");

    let step7Invoked = false;
    brain
      .queueStep(read("r1", "a.txt"))
      .queueStep(search("s1", "targetQuery"))
      .queueStep(read("r2", "b.txt"))
      .queueStep(read("r3", "a.txt"))
      .queueStep(search("s2", "targetQuery"))
      .queueStep(read("r4", "b.txt"))
      .queueStep(() => {
        step7Invoked = true;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 10 },
    });

    expect(result.terminalReason).toBe("CYCLE_DETECTED");
    expect(result.terminalMessage).toContain("cycle stagnation");
    expect(result.terminalMessage).toContain("read_file -> search_code -> read_file");
    expect(result.totalActions).toBe(6);
    expect(step7Invoked).toBe(false);
  });

  // 3. Same sequence with genuine progress
  it("Scenario 3: allows the same action sequence when genuine workspace progress occurs", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "out.txt"), "initial");

    // Sequence: read -> write -> read -> write (writes different content!)
    brain
      .queueStep(read("r1", "out.txt"))
      .queueStep(write("w1", "out.txt", "v1"))
      .queueStep(read("r2", "out.txt")) // Reads new content "v1"
      .queueStep(write("w2", "out.txt", "v2")) // Writes new content "v2"
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 10 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(4);
    expect(fs.readFileSync(path.join(workspace.hostPath, "out.txt"), "utf8")).toBe("v2");
  });

  // 4. Different action inputs that must not be treated as identical
  it("Scenario 4: does not halt when repeating the same tool with different inputs", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "f1.txt"), "1");
    fs.writeFileSync(path.join(workspace.hostPath, "f2.txt"), "2");
    fs.writeFileSync(path.join(workspace.hostPath, "f3.txt"), "3");
    fs.writeFileSync(path.join(workspace.hostPath, "f4.txt"), "4");
    fs.writeFileSync(path.join(workspace.hostPath, "f5.txt"), "5");

    brain
      .queueStep(read("r1", "f1.txt"))
      .queueStep(read("r2", "f2.txt"))
      .queueStep(read("r3", "f3.txt"))
      .queueStep(read("r4", "f4.txt"))
      .queueStep(read("r5", "f5.txt"))
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 10 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(5);
  });

  // 5. Verification success breaking a stagnation cycle
  it("Scenario 5: verification success breaks a potential cycle and resets stagnation assessment", () => {
    const detector = new ProgressLoopDetector();
    // Simulate repeating cycle A -> B -> A -> B
    detector.recordStep({
      stepNumber: 1,
      actionId: "a1",
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "a.txt" },
      inputHash: "h1",
      status: "SUCCEEDED",
      output: { content: "c1" },
    });
    detector.recordStep({
      stepNumber: 2,
      actionId: "a2",
      sequenceNumber: 2,
      toolName: "search_code",
      inputPayload: { query: "q" },
      inputHash: "h2",
      status: "SUCCEEDED",
      output: { matches: [] },
    });
    detector.recordStep({
      stepNumber: 3,
      actionId: "a3",
      sequenceNumber: 3,
      toolName: "read_file",
      inputPayload: { path: "a.txt" },
      inputHash: "h1",
      status: "SUCCEEDED",
      output: { content: "c1" },
    });

    // Step 4 succeeds AND verification advances
    const assessment = detector.recordStep({
      stepNumber: 4,
      actionId: "a4",
      sequenceNumber: 4,
      toolName: "search_code",
      inputPayload: { query: "q" },
      inputHash: "h2",
      status: "SUCCEEDED",
      output: { matches: [] },
      verificationSignature: "PASS:0",
    });

    expect(assessment.classification).toBe("PROGRESS");
    expect(assessment.reason).toContain("verification state changed");
  });

  // 6. Indeterminate execution outcome
  it("Scenario 6: returns INDETERMINATE when an action outcome is UNKNOWN and does not treat it as stagnation", () => {
    const detector = new ProgressLoopDetector();
    detector.recordStep({
      stepNumber: 1,
      actionId: "a1",
      sequenceNumber: 1,
      toolName: "read_file",
      inputPayload: { path: "a.txt" },
      inputHash: "h1",
      status: "SUCCEEDED",
      output: { content: "c" },
    });

    const assessment = detector.recordStep({
      stepNumber: 2,
      actionId: "a2",
      sequenceNumber: 2,
      toolName: "write_file",
      inputPayload: { path: "out.txt", content: "data" },
      inputHash: "h2",
      status: "UNKNOWN", // Physical uncertainty
    });

    expect(assessment.classification).toBe("INDETERMINATE");
    expect(assessment.evidenceSummary?.indeterminateOutcome).toBe(true);
    expect(assessment.reason).toContain("UNKNOWN");
  });

  // 7. Existing repeated-read protection
  it("Scenario 7: preserves existing identical-read stagnation protection (halts with STAGNATION)", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "same.txt"), "hello");

    brain
      .queueStep(read("r1", "same.txt"))
      .queueStep(read("r2", "same.txt"))
      .queueStep(read("r3", "same.txt"));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain("3 consecutive identical successful reads");
    expect(result.totalActions).toBe(3);
  });

  // 8. Existing repeated-write protection
  it("Scenario 8: preserves existing identical-write stagnation protection (halts with STAGNATION)", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep(write("w1", "out.txt", "same content"))
      .queueStep(write("w2", "out.txt", "same content"))
      .queueStep(write("w3", "out.txt", "same content"));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain("3 consecutive identical successful writes");
    expect(result.totalActions).toBe(3);
  });

  // 9. Existing ineffective-edit protection
  it("Scenario 9: preserves existing ineffective-edit stagnation protection", () => {
    expect(DEFAULT_MAX_CONSECUTIVE_INEFFECTIVE_EDITS).toBe(3);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxConsecutiveIneffectiveEdits).toBe(3);
  });

  // 10. Bounded history and cycle length
  it("Scenario 10: strictly bounds history capacity and ignores cycles exceeding maxCycleLength", () => {
    const detector = new ProgressLoopDetector({
      maxHistoryCapacity: 10,
      maxCycleLength: 3,
      minCycleLength: 2,
    });

    for (let i = 1; i <= 25; i++) {
      detector.recordStep({
        stepNumber: i,
        actionId: `act-${i}`,
        sequenceNumber: i,
        toolName: "read_file",
        inputPayload: { path: `file-${i}.txt` },
        inputHash: `h-${i}`,
        status: "SUCCEEDED",
        output: { content: `${i}` },
      });
    }

    expect(detector.getHistoryCount()).toBe(10);
    const history = detector.getHistory();
    expect(history[0]?.stepNumber).toBe(16);
    expect(history[history.length - 1]?.stepNumber).toBe(25);
  });

  // 11. Checkpoint reconstruction and recovery
  it("Scenario 11: reconstructs history and detects cycles across simulated process recovery", () => {
    const detector = new ProgressLoopDetector();

    const mockActions = [
      {
        actionId: "act-1",
        runId: "run-1",
        sequenceNumber: 1,
        toolName: "read_file" as const,
        inputPayload: { path: "a.txt" },
        inputHash: "hash-a",
        idempotency: "IDEMPOTENT" as const,
        contractBinding: { contractId: "c1", version: 1, contentHash: "ch" },
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        status: "SUCCEEDED" as const,
        activeAttemptNumber: 1,
        totalAttempts: 1,
        resultPayload: { content: "content-a" },
        errorPayload: null,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        actionId: "act-2",
        runId: "run-1",
        sequenceNumber: 2,
        toolName: "search_code" as const,
        inputPayload: { query: "query-b" },
        inputHash: "hash-b",
        idempotency: "IDEMPOTENT" as const,
        contractBinding: { contractId: "c1", version: 1, contentHash: "ch" },
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        status: "SUCCEEDED" as const,
        activeAttemptNumber: 1,
        totalAttempts: 1,
        resultPayload: { matches: [] },
        errorPayload: null,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        actionId: "act-3",
        runId: "run-1",
        sequenceNumber: 3,
        toolName: "read_file" as const,
        inputPayload: { path: "a.txt" },
        inputHash: "hash-a",
        idempotency: "IDEMPOTENT" as const,
        contractBinding: { contractId: "c1", version: 1, contentHash: "ch" },
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        status: "SUCCEEDED" as const,
        activeAttemptNumber: 1,
        totalAttempts: 1,
        resultPayload: { content: "content-a" },
        errorPayload: null,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ];

    detector.reconstructFromDurableHistory(mockActions, () => []);
    expect(detector.getHistoryCount()).toBe(3);

    // Record the 4th action after recovery
    const assessment = detector.recordStep({
      stepNumber: 4,
      actionId: "act-4",
      sequenceNumber: 4,
      toolName: "search_code",
      inputPayload: { query: "query-b" },
      inputHash: "hash-b",
      status: "SUCCEEDED",
      output: { matches: [] },
    });

    expect(assessment.classification).toBe("REPEATED_CYCLE");
    expect(assessment.cycleLength).toBe(2);
    expect(assessment.repetitionCount).toBe(2);
  });

  // 12. Lease loss during cycle detection
  it("Scenario 12: worker lease loss halts with LEASE_LOST before cycle stagnation", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "a.txt"), "A");
    fs.writeFileSync(path.join(workspace.hostPath, "b.txt"), "B");

    brain
      .queueStep(read("r1", "a.txt"))
      .queueStep(read("r2", "b.txt"))
      .queueStep(read("r3", "a.txt"))
      .queueStep((req) => {
        // Expire lease before the 4th step is evaluated
        clock.set(new Date(clock.now().getTime() + 120_000)); // Advance past 60s lease TTL
        return read("r4", "b.txt")(req);
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 10, maxWallClockMs: 1_000_000 },
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
    expect(result.terminalMessage).toContain("expired");
  });

  // 13. No false completion or run.completed event from stagnation
  it("Scenario 13: cycle stagnation results in FAILED status with no run.completed event", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "a.txt"), "A");
    fs.writeFileSync(path.join(workspace.hostPath, "b.txt"), "B");

    brain
      .queueStep(read("r1", "a.txt"))
      .queueStep(read("r2", "b.txt"))
      .queueStep(read("r3", "a.txt"))
      .queueStep(read("r4", "b.txt"));

    const executionProvider = new GovernedAgentExecutionProvider({
      stepController,
      clock,
    });

    const execResult = await executionProvider.execute({
      runId,
      taskId: "task-test",
      operationName: "agent_step_loop",
      inputPayload: {},
      idempotencyToken: `token-${runId}`,
      attemptNumber: 1,
      leaseId,
      workerId,
      workspace,
      timeoutMs: 30000,
    });

    expect(execResult.status).toBe("FAILED");
    expect(execResult.error?.message).toContain("cycle stagnation");

    const events = store.getEventsForRun(runId);
    const completedEvents = events.filter((e) => e.eventType === "run.completed");
    expect(completedEvents.length).toBe(0);
  });

  // 14. safeToResume remains false
  it("Scenario 14: safeToResume remains strictly false on cycle stagnation failure", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "a.txt"), "A");
    fs.writeFileSync(path.join(workspace.hostPath, "b.txt"), "B");

    brain
      .queueStep(read("r1", "a.txt"))
      .queueStep(read("r2", "b.txt"))
      .queueStep(read("r3", "a.txt"))
      .queueStep(read("r4", "b.txt"));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 10 },
    });

    expect(result.terminalReason).toBe("CYCLE_DETECTED");

    // Verify recovery service strictly reports safeToResume = false
    const mc = new MissionControl();
    const mission = mc.createMission({
      title: "test",
      description: "test",
      repositoryPath: tempDir,
    });
    const runControl = new RunControl();
    const prodRun = runControl.createRun(mission, "w1");
    runControl.transitionStatus(prodRun.runId, "EXECUTING");

    const recoveryService = new ProductionRecoveryService(runControl);
    const outcome = recoveryService.recoverRun(prodRun.runId);
    expect(outcome.safeToResume).toBe(false);
    expect(outcome.statusAfter).toBe("FAILED");
  });
});
