/**
 * Tests for GovernedAgentExecutionProvider (Milestone A).
 *
 * Verifies that the GovernedAgentExecutionProvider:
 * 1. Executes a successful multi-step tool workflow via WorkerRuntime.runOnce().
 * 2. Correctly maps all StepControllerResult outcomes to ExecutionResult.
 * 3. Rejects invalid model proposals fail-closed.
 * 4. Handles model and provider errors safely without unhandled crashes.
 * 5. Propagates pre-dispatch and in-flight cancellation signals.
 * 6. Enforces timeout ceilings and maps to TIMED_OUT.
 * 7. Enforces policy authorization and capability fences without bypass.
 * 8. Enforces workspace path containment against traversal attacks.
 * 9. Never performs direct terminal state mutations on the database.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  StepControllerResult,
} from "../../src/application/agent-step-controller.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ExecutionRequest } from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Scripted Deterministic Test Brain
// ============================================================================

class ScriptedDeterministicBrain implements AgentBrainPort {
  private callCount = 0;
  private readonly handler?: (
    request: AgentBrainRequest,
    callNumber: number
  ) => Promise<AgentBrainResult> | AgentBrainResult;

  constructor(
    handler?: (
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
    if (this.handler) {
      return this.handler(request, this.callCount);
    }

    return {
      finishReason: "GOAL_REACHED",
      proposal: {
        isGoalReached: true,
      },
    };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("GovernedAgentExecutionProvider", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-agent-exec-test-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-03T10:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupRunningRun(options?: {
    taskId?: string;
    runId?: string;
    title?: string;
    workerId?: string;
    allowedCapabilities?: string[];
  }) {
    const workerId = options?.workerId ?? "worker-direct-test";
    const task = coordinator.createTask({
      title: options?.title ?? "echo",
      inputPayload: {},
    });

    createAndActivateContract(store, task.taskId, {
      contractId: `contract-${task.taskId}`,
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: options?.allowedCapabilities ?? [
          "execution.echo",
          "workspace.file.read",
          "workspace.file.write",
        ],
        isolationRequirement: "ISOLATED",
      }),
    });

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const runId = options?.runId ?? `run-${crypto.randomUUID().slice(0, 8)}`;
    const { run } = coordinator.createRun({ taskId: task.taskId, runId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 30000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

    return {
      task,
      run,
      workerId,
      leaseId: claim.lease.leaseId,
    };
  }

  it("1. executes a successful multi-step tool workflow through WorkerRuntime.runOnce()", async () => {
    const workerId = "worker-agent-1";
    const brain = new ScriptedDeterministicBrain((req, callNumber) => {
      const hash = req.contextSnapshot.contextHash;
      if (callNumber === 1) {
        return {
          finishReason: "ACTION_PROPOSED",
          proposal: {
            proposalId: "prop-step-1",
            toolName: "write_file",
            inputPayload: {
              path: "result.txt",
              content: "Agent successfully executed tool in workspace",
            },
            contextSnapshotHash: hash,
            rationale: "Writing expected result file",
          },
        };
      }
      if (callNumber === 2) {
        // Invariant: Verify physical file was written to workspace while active
        const hostPath = store.getRunWorkspaceBinding(req.runId);
        if (hostPath) {
          const targetFile = path.join(hostPath, "result.txt");
          expect(fs.existsSync(targetFile)).toBe(true);
          expect(fs.readFileSync(targetFile, "utf8")).toBe(
            "Agent successfully executed tool in workspace"
          );
        }

        return {
          finishReason: "GOAL_REACHED",
          proposal: {
            isGoalReached: true,
            contextSnapshotHash: hash,
          },
        };
      }
      return {
        finishReason: "GOAL_REACHED",
        proposal: {
          isGoalReached: true,
          contextSnapshotHash: hash,
        },
      };
    });

    const executionProvider = new GovernedAgentExecutionProvider({
      name: "governed-agent-test",
    });

    const runtime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      clock,
    });

    executionProvider.setStepController(stepController);

    // Setup task and contract with allowed capabilities
    const task = coordinator.createTask({
      title: "echo",
      inputPayload: { instruction: "Write result.txt" },
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
        isolationRequirement: "ISOLATED",
      }),
    });

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    // Execute runOnce through WorkerRuntime
    const workerResult = await runtime.runOnce(run.runId);

    expect(workerResult.status).toBe("COMPLETED");
    if (workerResult.status === "COMPLETED") {
      expect(workerResult.runId).toBe(run.runId);
      const output = workerResult.output as any;
      expect(output.terminalReason).toBe("COMPLETED");
      expect(output.totalSteps).toBe(2);
      expect(output.totalActions).toBe(1);
    }

    // Verify workspace binding was recorded in state store
    const hostPath = store.getRunWorkspaceBinding(run.runId);
    expect(hostPath).toBeDefined();
    expect(typeof hostPath).toBe("string");

    // Verify Action and Attempt records in SQLite
    const actions = store.getActionsForRun(run.runId);
    expect(actions.length).toBe(1);
    const action = actions[0];
    expect(action).toBeDefined();
    if (!action) throw new Error("Expected action to be defined");
    expect(action.status).toBe("SUCCEEDED");
    expect(action.toolName).toBe("write_file");

    const attempts = store.getAttemptsForAction(action.actionId);
    expect(attempts.length).toBe(1);
    const attempt = attempts[0];
    expect(attempt).toBeDefined();
    if (!attempt) throw new Error("Expected attempt to be defined");
    expect(attempt.status).toBe("SUCCEEDED");
  });

  it("2. correctly maps StepControllerResult outcomes to ExecutionResult contract", async () => {
    const mockController = {
      runStepLoop: async () => {
        return {
          runId: "run-mock-1",
          taskId: "task-mock-1",
          terminalReason: "COMPLETED",
          terminalMessage: "Goal achieved",
          totalSteps: 3,
          totalActions: 2,
          totalProposalRejections: 0,
          totalConsecutiveFailures: 0,
          totalWallClockMs: 150,
          transcript: [],
        } as StepControllerResult;
      },
    } as unknown as AgentStepController;

    const provider = new GovernedAgentExecutionProvider({
      stepController: mockController,
      clock,
    });

    const request: ExecutionRequest = {
      runId: "run-mock-1",
      taskId: "task-mock-1",
      operationName: "agent-task",
      inputPayload: {},
      idempotencyToken: "idem-1",
      attemptNumber: 1,
      timeoutMs: 30000,
    };

    const result = await provider.execute(request);
    expect(result.status).toBe("SUCCESS");
    expect(result.output).toBeDefined();
    expect((result.output as any).terminalReason).toBe("COMPLETED");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.providerMetadata?.providerName).toBe("governed-agent");

    // Test CANCELLED mapping
    const cancellingController = {
      runStepLoop: async () => {
        return {
          runId: "run-mock-2",
          taskId: "task-mock-2",
          terminalReason: "CANCELLED",
          terminalMessage: "Loop cancelled by signal",
          totalSteps: 1,
          totalActions: 0,
          totalProposalRejections: 0,
          totalConsecutiveFailures: 0,
          totalWallClockMs: 20,
          transcript: [],
        } as StepControllerResult;
      },
    } as unknown as AgentStepController;

    provider.setStepController(cancellingController);
    const cancelResult = await provider.execute(request);
    expect(cancelResult.status).toBe("CANCELLED");
    expect(cancelResult.error?.code).toBe("EXECUTION_CANCELLED");

    // Test MAX_WALL_CLOCK mapping
    const timeoutController = {
      runStepLoop: async () => {
        return {
          runId: "run-mock-3",
          taskId: "task-mock-3",
          terminalReason: "MAX_WALL_CLOCK",
          terminalMessage: "Wall clock budget exceeded",
          totalSteps: 2,
          totalActions: 1,
          totalProposalRejections: 0,
          totalConsecutiveFailures: 0,
          totalWallClockMs: 500,
          transcript: [],
        } as StepControllerResult;
      },
    } as unknown as AgentStepController;

    provider.setStepController(timeoutController);
    const timeoutResult = await provider.execute(request);
    expect(timeoutResult.status).toBe("TIMED_OUT");
    expect(timeoutResult.error?.code).toBe("EXECUTION_TIMEOUT");

    // Test FAILED mapping (e.g. MAX_PROPOSAL_REJECTIONS)
    const failureController = {
      runStepLoop: async () => {
        return {
          runId: "run-mock-4",
          taskId: "task-mock-4",
          terminalReason: "MAX_PROPOSAL_REJECTIONS",
          terminalMessage: "Too many proposal rejections",
          totalSteps: 4,
          totalActions: 0,
          totalProposalRejections: 3,
          totalConsecutiveFailures: 0,
          totalWallClockMs: 80,
          transcript: [],
        } as StepControllerResult;
      },
    } as unknown as AgentStepController;

    provider.setStepController(failureController);
    const failResult = await provider.execute(request);
    expect(failResult.status).toBe("FAILED");
    expect(failResult.error?.code).toBe("EXECUTION_FAILED");
    expect((failResult.error?.details as any).terminalReason).toBe(
      "MAX_PROPOSAL_REJECTIONS"
    );
  });

  it("3. rejects invalid model proposals fail-closed with zero attempts created", async () => {
    const workerId = "worker-agent-invalid";
    // Brain repeatedly proposes an invalid / unknown tool
    const brain = new ScriptedDeterministicBrain((req) => {
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-invalid",
          toolName: "non_existent_unregistered_tool",
          inputPayload: { foo: "bar" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Adversarial or hallucinated tool proposal",
        },
      };
    });

    const executionProvider = new GovernedAgentExecutionProvider({
      defaultBudget: { maxProposalRejections: 2 },
    });

    const runtime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      clock,
      defaultBudget: { maxProposalRejections: 2 },
    });

    executionProvider.setStepController(stepController);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: {},
    });

    createAndActivateContract(store, task.taskId, {
      contractId: `contract-${task.taskId}`,
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      }),
    });

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const workerResult = await runtime.runOnce(run.runId);
    expect(workerResult.status).toBe("FAILED");

    // Invariant: zero attempts must have been spawned for invalid proposals
    const actions = store.getActionsForRun(run.runId);
    expect(actions.length).toBe(0);
  });

  it("4. handles model/provider exceptions safely without unhandled crashes", async () => {
    const throwingBrain = new ScriptedDeterministicBrain(() => {
      throw new Error("Local model backend disconnected or crashed");
    });

    const executionProvider = new GovernedAgentExecutionProvider();

    const runtime = new WorkerRuntime({
      workerId: "worker-error-test",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: throwingBrain,
      clock,
    });

    executionProvider.setStepController(stepController);

    const running = setupRunningRun({
      taskId: "task-error-test",
      runId: "run-error-test",
    });

    const request: ExecutionRequest = {
      runId: running.run.runId,
      taskId: running.task.taskId,
      operationName: "echo",
      inputPayload: {},
      idempotencyToken: "idem-err",
      attemptNumber: 1,
      timeoutMs: 10000,
      workerId: running.workerId,
      leaseId: running.leaseId,
    };

    const result = await executionProvider.execute(request);
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("EXECUTION_FAILED");
    expect(result.error?.message).toContain("Local model backend disconnected");
  });

  it("5. propagates pre-dispatch and in-flight cancellation signals", async () => {
    const executionProvider = new GovernedAgentExecutionProvider();

    // Case 5a: Pre-dispatch aborted signal
    const preAbortController = new AbortController();
    preAbortController.abort("Pre-dispatch cancellation requested");

    const requestPreAborted: ExecutionRequest = {
      runId: "run-cancel-1",
      taskId: "task-cancel-1",
      operationName: "agent-task",
      inputPayload: {},
      idempotencyToken: "idem-c1",
      attemptNumber: 1,
      timeoutMs: 10000,
      signal: preAbortController.signal,
    };

    const resultPre = await executionProvider.execute(requestPreAborted);
    expect(resultPre.status).toBe("CANCELLED");
    expect(resultPre.error?.code).toBe("EXECUTION_CANCELLED");
    expect(resultPre.error?.message).toContain("Pre-dispatch cancellation requested");

    // Case 5b: In-flight cancellation
    const inFlightAbortController = new AbortController();
    const cancellableBrain = new ScriptedDeterministicBrain((req, callCount) => {
      if (callCount === 1) {
        // Trigger abort during first turn
        inFlightAbortController.abort("In-flight cancellation triggered");
        return {
          finishReason: "ACTION_PROPOSED",
          proposal: {
            proposalId: "prop-cancel-1",
            toolName: "read_file",
            inputPayload: { path: "nonexistent.txt" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
            rationale: "Step 1 before cancellation",
          },
        };
      }
      return {
        finishReason: "GOAL_REACHED",
        proposal: { isGoalReached: true },
      };
    });

    const runtime = new WorkerRuntime({
      workerId: "worker-cancel-test",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: cancellableBrain,
      clock,
    });

    executionProvider.setStepController(stepController);

    const running = setupRunningRun({
      taskId: "task-cancel-2",
      runId: "run-cancel-2",
    });

    const requestInFlight: ExecutionRequest = {
      runId: running.run.runId,
      taskId: running.task.taskId,
      operationName: "echo",
      inputPayload: {},
      idempotencyToken: "idem-c2",
      attemptNumber: 1,
      timeoutMs: 10000,
      workerId: running.workerId,
      leaseId: running.leaseId,
      signal: inFlightAbortController.signal,
    };

    const resultInFlight = await executionProvider.execute(requestInFlight);
    expect(resultInFlight.status).toBe("CANCELLED");
    expect(resultInFlight.error?.code).toBe("EXECUTION_CANCELLED");
  });

  it("6. enforces timeout limits where supported and maps to TIMED_OUT", async () => {
    const testClock = new SettableClock(new Date("2026-11-03T10:00:00Z"));
    const executionProvider = new GovernedAgentExecutionProvider({
      clock: testClock,
      defaultBudget: { maxWallClockMs: 100 },
    });

    const delayedBrain = new ScriptedDeterministicBrain((req) => {
      // Advance the simulated clock beyond the maxWallClockMs budget
      testClock.advanceMs(200);
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-delay",
          toolName: "read_file",
          inputPayload: { path: "test.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Delayed action",
        },
      };
    });

    const runtime = new WorkerRuntime({
      workerId: "worker-timeout-test",
      coordinator,
      clock: testClock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: delayedBrain,
      clock: testClock,
      defaultBudget: { maxWallClockMs: 100 },
    });

    executionProvider.setStepController(stepController);

    const running = setupRunningRun({
      taskId: "task-timeout-test",
      runId: "run-timeout-test",
    });

    const request: ExecutionRequest = {
      runId: running.run.runId,
      taskId: running.task.taskId,
      operationName: "echo",
      inputPayload: {},
      idempotencyToken: "idem-timeout",
      attemptNumber: 1,
      timeoutMs: 100,
      workerId: running.workerId,
      leaseId: running.leaseId,
    };

    const result = await executionProvider.execute(request);
    expect(result.status).toBe("TIMED_OUT");
    expect(result.error?.code).toBe("EXECUTION_TIMEOUT");
  });

  it("7. prevents policy and tool execution gateway bypass", async () => {
    const workerId = "worker-policy-test";
    // Brain attempts to propose write_file, but contract only permits read_file
    const brain = new ScriptedDeterministicBrain((req) => {
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-unauthorized-write",
          toolName: "write_file",
          inputPayload: { path: "unauthorized.txt", content: "forbidden" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Trying to write without write capability",
        },
      };
    });

    const executionProvider = new GovernedAgentExecutionProvider();

    const runtime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      clock,
      defaultBudget: { maxConsecutiveFailures: 1, maxSteps: 2 },
    });

    executionProvider.setStepController(stepController);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: {},
    });

    // Contract policy strictly grants execution.echo and workspace.file.read, but NOT workspace.file.write
    createAndActivateContract(store, task.taskId, {
      contractId: `contract-${task.taskId}`,
      policy: createExecutionPolicy({
        policyId: `policy-read-only`,
        allowedCapabilities: ["execution.echo", "workspace.file.read"],
        isolationRequirement: "ISOLATED",
      }),
    });

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const workerResult = await runtime.runOnce(run.runId);
    expect(workerResult.status).toBe("FAILED");

    // Invariant: zero files written
    const hostPath = store.getRunWorkspaceBinding(run.runId);
    if (hostPath) {
      const forbiddenFile = path.join(hostPath, "unauthorized.txt");
      expect(fs.existsSync(forbiddenFile)).toBe(false);
    }
  });

  it("8. enforces workspace path containment against directory traversal", async () => {
    const workerId = "worker-traversal-test";
    // Brain attempts relative path traversal out of workspace
    const brain = new ScriptedDeterministicBrain((req) => {
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-traversal",
          toolName: "read_file",
          inputPayload: { path: "../../../etc/passwd" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Attempting traversal escape",
        },
      };
    });

    const executionProvider = new GovernedAgentExecutionProvider({
      defaultBudget: { maxProposalRejections: 1 },
    });

    const runtime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      clock,
      defaultBudget: { maxProposalRejections: 1 },
    });

    executionProvider.setStepController(stepController);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: {},
    });

    createAndActivateContract(store, task.taskId, {
      contractId: `contract-${task.taskId}`,
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["execution.echo", "workspace.file.read"],
        isolationRequirement: "ISOLATED",
      }),
    });

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    const workerResult = await runtime.runOnce(run.runId);
    expect(workerResult.status).toBe("FAILED");
  });

  it("9. never performs duplicate terminal state mutations from the adapter", async () => {
    const workerId = "worker-terminal-check";
    const brain = new ScriptedDeterministicBrain(() => {
      return {
        finishReason: "GOAL_REACHED",
        proposal: { isGoalReached: true },
      };
    });

    const executionProvider = new GovernedAgentExecutionProvider();

    const runtime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });

    const stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      clock,
    });

    executionProvider.setStepController(stepController);

    const task = coordinator.createTask({
      title: "echo",
      inputPayload: {},
    });

    createAndActivateContract(store, task.taskId, {
      contractId: `contract-${task.taskId}`,
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["execution.echo"],
        isolationRequirement: "ISOLATED",
      }),
    });

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 30000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

    // Verify run is RUNNING before provider.execute()
    const runBefore = store.getRun(run.runId);
    expect(runBefore?.status).toBe("RUNNING");

    // Execute provider directly
    const execResult = await executionProvider.execute({
      runId: run.runId,
      taskId: task.taskId,
      operationName: "echo",
      inputPayload: {},
      idempotencyToken: "idem-direct",
      attemptNumber: 1,
      timeoutMs: 30000,
      workerId,
      leaseId: claim.lease.leaseId,
    });

    expect(execResult.status).toBe("SUCCESS");

    // Invariant: The adapter must NOT have mutated the run's terminal status in the DB
    // The run must still be RUNNING!
    const runAfterProvider = store.getRun(run.runId);
    expect(runAfterProvider?.status).toBe("RUNNING");

    // Now, WorkerRuntime.completeRun performs the terminal transition
    coordinator.completeRun(
      run.runId,
      workerId,
      claim.lease.leaseId,
      execResult.output
    );

    const runAfterComplete = store.getRun(run.runId);
    expect(runAfterComplete?.status).toBe("COMPLETED");
  });
});
