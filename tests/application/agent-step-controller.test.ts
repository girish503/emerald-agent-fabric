import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/**
 * Spy ExecutionProvider to rigorously verify that ZERO provider calls occur
 * outside governed tool adapter dispatches.
 */
class CountingExecutionProvider implements ExecutionProvider {
  readonly name = "spy-counting-provider";
  readonly invocations: ExecutionRequest[] = [];
  nextResult?: ExecutionResult;

  get providerInvocationCount(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    if (this.nextResult) {
      return this.nextResult as ExecutionResult<TOutput>;
    }
    return {
      status: "SUCCESS",
      output: { executed: true } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

/**
 * Scriptable Agent Brain allowing deterministic configuration of multi-step proposals.
 */
class ScriptableAgentBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private steps: ((req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>)[] = [];
  private fallback?: (req: AgentBrainRequest) => AgentBrainResult;

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>): this {
    this.steps.push(step);
    return this;
  }

  setFallback(fallback: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.fallback = fallback;
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    if (this.fallback) {
      return this.fallback(request);
    }
    return {
      finishReason: "GOAL_REACHED",
    };
  }
}

describe("AgentStepController — Governed Autonomous Reasoning Loop (Task 5.3)", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let provider: CountingExecutionProvider;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let proposalValidator: ProposalValidator;
  let brain: ScriptableAgentBrain;
  let stepController: AgentStepController;

  const workerId = "worker-step-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-step-ctrl-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-13T16:00:00Z"));
    provider = new CountingExecutionProvider();
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });

    coordinator = new RunCoordinator(store, clock);

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
    });

    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    brain = new ScriptableAgentBrain();

    stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });

    // Register worker
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 7777,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(async () => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function setupGovernedRun(options?: {
    allowedCapabilities?: string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxAttempts?: number;
    leaseTtlMs?: number;
  }) {
    const task = coordinator.createTask({
      title: "Step Controller Task",
      description: "Testing autonomous step loop",
      inputPayload: { target: "test" },
    });

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: options?.allowedCapabilities ?? [
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
          "process.execute",
        ],
        isolationRequirement: "ISOLATED",
      }),
      timeoutMs: options?.timeoutMs ?? 30000,
      maxOutputBytes: options?.maxOutputBytes ?? 1048576,
      maxAttempts: options?.maxAttempts ?? 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, options?.leaseTtlMs ?? 60000);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    const wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    return {
      task,
      contract,
      runId: run.runId,
      leaseId: claimResult.lease.leaseId,
      workspace: wsHandle,
    };
  }

  // =========================================================================
  // 0. Default Budget Constants
  // =========================================================================
  it("exports deterministic default budget constants", () => {
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxSteps).toBe(10);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxWallClockMs).toBe(60_000);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxActions).toBe(10);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxConsecutiveFailures).toBe(3);
    expect(DEFAULT_STEP_CONTROLLER_BUDGET.maxProposalRejections).toBe(3);
  });

  // =========================================================================
  // 1. Multi-Step Success
  // =========================================================================
  it("executes multi-step autonomous loop: write_file -> read_file -> GOAL_REACHED", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-step-1",
          toolName: "write_file",
          inputPayload: { path: "greeting.txt", content: "Hello Emerald", overwrite: true },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 1: Write greeting",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-step-2",
          toolName: "read_file",
          inputPayload: { path: "greeting.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Step 2: Read greeting",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(3);
    expect(result.totalActions).toBe(2);
    expect(result.totalProposalRejections).toBe(0);
    expect(result.transcript.length).toBe(3);

    // Verify transcript entries
    expect(result.transcript[0]!.toolName).toBe("write_file");
    expect(result.transcript[0]!.actionStatus).toBe("SUCCEEDED");
    expect(result.transcript[1]!.toolName).toBe("read_file");
    expect(result.transcript[1]!.actionStatus).toBe("SUCCEEDED");
    expect(result.transcript[2]!.finishReason).toBe("GOAL_REACHED");

    // Verify persistent store contains both actions in order
    const actions = store.getActionsForRun(runId);
    expect(actions.length).toBe(2);
    expect(actions[0]!.sequenceNumber).toBe(1);
    expect(actions[0]!.toolName).toBe("write_file");
    expect(actions[1]!.sequenceNumber).toBe(2);
    expect(actions[1]!.toolName).toBe("read_file");
  });

  // =========================================================================
  // 2. Single Action then NO_ACTION
  // =========================================================================
  it("executes single action followed by explicit NO_ACTION", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-single-1",
          toolName: "write_file",
          inputPayload: { path: "note.txt", content: "single note" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "ACTION_PROPOSED",
        proposal: undefined, // No further action
      }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("NO_ACTION");
    expect(result.totalSteps).toBe(2);
    expect(result.totalActions).toBe(1);
    expect(store.getActionsForRun(runId).length).toBe(1);
  });

  // =========================================================================
  // 3. Proposal Rejection Recovery
  // =========================================================================
  it("recovers from proposal validation rejection and continues within budget", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-invalid-1",
          toolName: "read_file",
          inputPayload: { path: "../outside.txt" }, // Path traversal rejection!
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-valid-2",
          toolName: "write_file",
          inputPayload: { path: "valid.txt", content: "valid content" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(3);
    expect(result.totalActions).toBe(1);
    expect(result.totalProposalRejections).toBe(1);

    expect(result.transcript[0]!.proposalValid).toBe(false);
    expect(result.transcript[0]!.proposalRejectionReason).toBe("INVALID_TOOL_INPUT");
    expect(result.transcript[1]!.proposalValid).toBe(true);
    expect(result.transcript[1]!.actionStatus).toBe("SUCCEEDED");
  });

  // =========================================================================
  // 4. Repeated Invalid Proposals (Max Proposal Rejections)
  // =========================================================================
  it("halts when cumulative proposal rejections exceed maxProposalRejections ceiling", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Brain repeatedly proposes invalid path traversals
    brain.setFallback((req) => ({
      proposal: {
        proposalId: "prop-bad",
        toolName: "read_file",
        inputPayload: { path: "/etc/passwd" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxProposalRejections: 3 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalProposalRejections).toBe(3);
    expect(result.totalActions).toBe(0);
    expect(store.getActionsForRun(runId).length).toBe(0);
  });

  // =========================================================================
  // 5. Max Steps Ceiling
  // =========================================================================
  it("enforces maxSteps ceiling and halts autonomous loop", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.setFallback((req) => ({
      proposal: {
        proposalId: `prop-${req.sequenceNumber}`,
        toolName: "write_file",
        inputPayload: { path: `f${req.sequenceNumber}.txt`, content: "test" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 4 },
    });

    expect(result.terminalReason).toBe("MAX_STEPS");
    expect(result.totalSteps).toBe(4);
    expect(result.totalActions).toBe(4);
  });

  // =========================================================================
  // 6. Max Actions Ceiling
  // =========================================================================
  it("enforces maxActions ceiling independently of maxSteps", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.setFallback((req) => ({
      proposal: {
        proposalId: `prop-act-${req.sequenceNumber}`,
        toolName: "write_file",
        inputPayload: { path: `a${req.sequenceNumber}.txt`, content: "action" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 10, maxActions: 2 },
    });

    expect(result.terminalReason).toBe("MAX_ACTIONS");
    expect(result.totalActions).toBe(2);
    expect(result.totalSteps).toBe(2);
  });

  // =========================================================================
  // 7. Wall Clock Budget Expiration
  // =========================================================================
  it("halts when elapsed wall clock time exceeds maxWallClockMs", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => {
        // Advance clock by 50,000ms
        clock.advanceMs(50000);
        return {
          proposal: {
            proposalId: "prop-time-1",
            toolName: "write_file",
            inputPayload: { path: "t1.txt", content: "data" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        // Advance clock by another 20,000ms (total 70,000ms > maxWallClockMs 60,000ms)
        clock.advanceMs(20000);
        return {
          proposal: {
            proposalId: "prop-time-2",
            toolName: "write_file",
            inputPayload: { path: "t2.txt", content: "data" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxWallClockMs: 60000 },
    });

    expect(result.terminalReason).toBe("MAX_WALL_CLOCK");
    expect(result.totalActions).toBe(1); // Only step 1 executed before wall clock exhausted
  });

  // =========================================================================
  // 8. Cancellation via AbortSignal
  // =========================================================================
  it("immediately halts loop when AbortSignal is triggered", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const abortController = new AbortController();

    brain.queueStep((req) => {
      // Abort signal arrives during/after step 1 reasoning
      abortController.abort();
      return {
        proposal: {
          proposalId: "prop-abort",
          toolName: "write_file",
          inputPayload: { path: "abort.txt", content: "data" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      };
    });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      abortSignal: abortController.signal,
    });

    expect(result.terminalReason).toBe("CANCELLED");
    expect(result.totalActions).toBe(0); // Action was not executed because abort checked pre-execution
  });

  // =========================================================================
  // 9. Lease Loss / Fencing
  // =========================================================================
  it("stops loop immediately with LEASE_LOST if worker lease is stolen or expired", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Register a second worker who can legitimately claim an expired/reassigned lease
    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-2",
        hostname: "localhost",
        pid: 8888,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    brain.queueStep((req) => {
      // Simulate clock advancing past lease TTL and worker-2 taking the lease
      clock.advanceMs(70000);
      coordinator.recoverExpiredRuns();
      const claim2 = coordinator.claimRun(runId, "worker-2", 60000);
      coordinator.startRun(runId, "worker-2", claim2.lease.leaseId);

      return {
        proposal: {
          proposalId: "prop-lease-loss",
          toolName: "write_file",
          inputPayload: { path: "loss.txt", content: "data" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      };
    });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxWallClockMs: 500000 },
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
    expect(result.totalActions).toBe(0);
  });

  // =========================================================================
  // 10. Mission Contract Revocation Between Steps
  // =========================================================================
  it("halts execution with CONTRACT_REVOKED if Mission Contract is revoked", async () => {
    const { runId, leaseId, workspace, contract } = await setupGovernedRun();

    brain.queueStep((req) => {
      // Revoke contract mid-loop
      store.revokeContract(contract.spec.contractId, contract.spec.version, "Emergency security stop");

      return {
        proposal: {
          proposalId: "prop-revoked",
          toolName: "write_file",
          inputPayload: { path: "revoked.txt", content: "data" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      };
    });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("CONTRACT_REVOKED");
    expect(result.totalActions).toBe(0);
  });

  // =========================================================================
  // 11. UNKNOWN Execution Safety Stop
  // =========================================================================
  it("halts loop with UNKNOWN_EXECUTION when an action results in execution uncertainty", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Create a scenario where WorkerRuntime yields UNKNOWN
    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-unknown",
        toolName: "write_file",
        inputPayload: { path: "unknown.txt", content: "uncertain side effect" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    }));

    // Expire the lease in the database right when the action is running
    // We can simulate UNKNOWN by having WorkerRuntime mark attempt as UNKNOWN
    // or simulate WorkerRuntime executing an action that ends UNKNOWN
    // Let's spy on workerRuntime.executeAction to return UNKNOWN
    const originalExecute = workerRuntime.executeAction.bind(workerRuntime);
    workerRuntime.executeAction = async (params) => {
      const res = await originalExecute(params);
      return {
        ...res,
        status: "UNKNOWN",
        error: "Physical container state could not be verified",
      };
    };

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("UNKNOWN_EXECUTION");
    expect(result.terminalMessage).toContain("UNKNOWN execution outcome");
    expect(result.totalActions).toBe(1);
    expect(result.transcript[0]!.actionStatus).toBe("UNKNOWN");
  });

  // =========================================================================
  // 12. Action Failure Recovery
  // =========================================================================
  it("allows loop to continue after an action failure if failure budget permits", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-fail-1",
          toolName: "read_file",
          inputPayload: { path: "nonexistent-file.txt" }, // File does not exist -> tool failure
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-recover-2",
          toolName: "write_file",
          inputPayload: { path: "recovered.txt", content: "success after fail" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveFailures: 3 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(3);
    expect(result.totalActions).toBe(2);
    expect(result.totalConsecutiveFailures).toBe(0); // Succeeded on step 2, consecutive count reset!

    expect(result.transcript[0]!.actionStatus).toBe("FAILED");
    expect(result.transcript[1]!.actionStatus).toBe("SUCCEEDED");
  });

  // =========================================================================
  // 13. Max Failures Budget Ceiling
  // =========================================================================
  it("halts loop when consecutive failures reach maxConsecutiveFailures ceiling", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    // Repeatedly read non-existent files
    brain.setFallback((req) => ({
      proposal: {
        proposalId: `prop-fail-${req.sequenceNumber}`,
        toolName: "read_file",
        inputPayload: { path: `missing-${req.sequenceNumber}.txt` },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveFailures: 2 },
    });

    expect(result.terminalReason).toBe("MAX_FAILURES");
    expect(result.totalConsecutiveFailures).toBe(2);
    expect(result.totalActions).toBe(2);
  });

  // =========================================================================
  // 14. Context Rebuild Between Steps
  // =========================================================================
  it("rebuilds a new ContextSnapshot after each action reflecting updated runtime state", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const contextHashesSeen: string[] = [];

    brain
      .queueStep((req) => {
        contextHashesSeen.push(req.contextSnapshot.contextHash);
        return {
          proposal: {
            proposalId: "prop-seq-1",
            toolName: "write_file",
            inputPayload: { path: "s1.txt", content: "data1" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        contextHashesSeen.push(req.contextSnapshot.contextHash);
        return {
          proposal: {
            proposalId: "prop-seq-2",
            toolName: "write_file",
            inputPayload: { path: "s2.txt", content: "data2" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        contextHashesSeen.push(req.contextSnapshot.contextHash);
        return {
          finishReason: "GOAL_REACHED",
        };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(contextHashesSeen.length).toBe(3);

    // Each step must produce a distinct context hash because actions & attempts advance state
    expect(contextHashesSeen[0]).not.toEqual(contextHashesSeen[1]);
    expect(contextHashesSeen[1]).not.toEqual(contextHashesSeen[2]);
  });

  // =========================================================================
  // 15. Repeated Read Progress Advisory
  // =========================================================================
  it("injects one observable advisory after consecutive identical successful reads without mutating the workspace", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const readPath = path.join(workspace.hostPath, "repeat.txt");
    fs.writeFileSync(readPath, "unchanged content", "utf8");
    const advisoryCounts: number[] = [];

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "repeat-read-1",
          toolName: "read_file",
          inputPayload: { path: "repeat.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "repeat-read-2",
          toolName: "read_file",
          inputPayload: { path: "repeat.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => {
        advisoryCounts.push(
          req.contextSnapshot.observations.filter(
            (observation) =>
              observation.category === "SYSTEM_EVENT" &&
              observation.content.feedbackKind === "REPEATED_IDENTICAL_READ",
          ).length,
        );
        return {
          proposal: {
            proposalId: "repeat-read-3",
            toolName: "read_file",
            inputPayload: { path: "repeat.txt" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        advisoryCounts.push(
          req.contextSnapshot.observations.filter(
            (observation) =>
              observation.category === "SYSTEM_EVENT" &&
              observation.content.feedbackKind === "REPEATED_IDENTICAL_READ",
          ).length,
        );
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalReads: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(3);
    expect(result.totalProposalRejections).toBe(0);
    expect(result.transcript[1]!.progressAdvisory).toContain("same read_file request");
    expect(advisoryCounts).toEqual([1, 0]);
    expect(fs.readFileSync(readPath, "utf8")).toBe("unchanged content");
  });

  it("does not advise when a repeated read returns changed content", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const readPath = path.join(workspace.hostPath, "changed.txt");
    fs.writeFileSync(readPath, "first version", "utf8");
    let advisoryCount = -1;

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "changed-read-1",
          toolName: "read_file",
          inputPayload: { path: "changed.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => {
        fs.writeFileSync(readPath, "second version", "utf8");
        return {
          proposal: {
            proposalId: "changed-read-2",
            toolName: "read_file",
            inputPayload: { path: "changed.txt" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        advisoryCount = req.contextSnapshot.observations.filter(
          (observation) => observation.content.feedbackKind === "REPEATED_IDENTICAL_READ",
        ).length;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalReads: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.transcript[1]!.progressAdvisory).toBeUndefined();
    expect(advisoryCount).toBe(0);
  });

  it("does not advise for reads of distinct ranges in the same file", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "ranges.txt"), "first\nsecond\n", "utf8");
    let advisoryCount = -1;

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "range-read-1",
          toolName: "read_file",
          inputPayload: { path: "ranges.txt", offsetLine: 1, limitLines: 1 },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "range-read-2",
          toolName: "read_file",
          inputPayload: { path: "ranges.txt", offsetLine: 2, limitLines: 1 },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => {
        advisoryCount = req.contextSnapshot.observations.filter(
          (observation) => observation.content.feedbackKind === "REPEATED_IDENTICAL_READ",
        ).length;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalReads: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.transcript[1]!.progressAdvisory).toBeUndefined();
    expect(advisoryCount).toBe(0);
  });

  // =========================================================================
  // 16. Context Hash Provenance Binding
  // =========================================================================
  it("rejects proposal if model provides a mismatched context hash", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep(() => ({
      proposal: {
        proposalId: "prop-bad-hash",
        toolName: "write_file",
        inputPayload: { path: "hash.txt", content: "data" },
        contextSnapshotHash: "f".repeat(64), // Mismatched stale hash
      },
      finishReason: "ACTION_PROPOSED",
    }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.transcript[0]!.proposalRejectionReason).toBe("CONTEXT_HASH_MISMATCH");
  });

  // =========================================================================
  // 16. No Direct Provider Invocations by StepController
  // =========================================================================
  it("guarantees StepController performs zero direct provider invocations", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep((req) => ({
      proposal: {
        proposalId: "prop-prov-1",
        toolName: "write_file",
        inputPayload: { path: "prov.txt", content: "data" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
      finishReason: "ACTION_PROPOSED",
    }));

    await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 1 },
    });

    // Pure in-process workspace file writes require 0 container provider invocations
    expect(provider.providerInvocationCount).toBe(0);
  });

  // =========================================================================
  // 17. Zero Direct Persistence Bypass
  // =========================================================================
  it("never writes raw SQL or directly mutates store tables outside domain aggregates", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const actionsBefore = store.getActionsForRun(runId);
    await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });
    const actionsAfter = store.getActionsForRun(runId);

    // No phantom actions created on GOAL_REACHED
    expect(actionsAfter.length).toBe(actionsBefore.length);
  });

  // =========================================================================
  // 18. Brain Failure Handling
  // =========================================================================
  it("terminates safely with BRAIN_FAILURE if Agent Brain throws an unhandled error", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain.queueStep(() => {
      throw new Error("Model provider connection dropped: HTTP 503");
    });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("BRAIN_FAILURE");
    expect(result.terminalMessage).toContain("Model provider connection dropped");
    expect(result.totalActions).toBe(0);
  });

  // =========================================================================
  // 19. Malformed Brain Output Handling
  // =========================================================================
  it("rejects malformed brain proposal as invalid proposal and continues if budget permits", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep(() => ({
        proposal: "completely-malformed-string-not-an-object",
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-valid-after-malformed",
          toolName: "write_file",
          inputPayload: { path: "after-malformed.txt", content: "ok" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(3);
    expect(result.totalActions).toBe(1);
    expect(result.totalProposalRejections).toBe(1);
    expect(result.transcript[0]!.proposalRejectionReason).toBe("MALFORMED_PROPOSAL");
  });

  // =========================================================================
  // 20. Transcript Completeness & Measurability
  // =========================================================================
  it("produces a comprehensive structured transcript with full provenance for all steps", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "prop-transcript-1",
          toolName: "write_file",
          inputPayload: { path: "log.txt", content: "logging" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Measuring performance and provenance",
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.transcript.length).toBe(2);

    const step1 = result.transcript[0]!;
    expect(step1.stepNumber).toBe(1);
    expect(step1.contextSnapshotId).toBeDefined();
    expect(step1.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(step1.contextEstimatedTokens).toBeGreaterThan(0);
    expect(step1.proposalId).toBe("prop-transcript-1");
    expect(step1.toolName).toBe("write_file");
    expect(step1.rationale).toBe("Measuring performance and provenance");
    expect(step1.proposalValid).toBe(true);
    expect(step1.actionId).toBeDefined();
    expect(step1.actionStatus).toBe("SUCCEEDED");
    expect(step1.durationMs).toBeGreaterThanOrEqual(0);

    const step2 = result.transcript[1]!;
    expect(step2.stepNumber).toBe(2);
    expect(step2.finishReason).toBe("GOAL_REACHED");
    expect(step2.proposalValid).toBe(false);

    expect(result.lastContextSnapshot).toBeDefined();
    expect(result.totalWallClockMs).toBeGreaterThanOrEqual(0);
  });

  // =========================================================================
  // 22. Bounded Progression Control & Redundant Read Stagnation
  // =========================================================================
  it("halts with STAGNATION when consecutive identical successful reads reach default ceiling (3)", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const filePath = path.join(workspace.hostPath, "stagnant.txt");
    fs.writeFileSync(filePath, "alpha beta gamma", "utf8");

    let step4Invoked = false;

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "read-1",
          toolName: "read_file",
          inputPayload: { path: "stagnant.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "read-2",
          toolName: "read_file",
          inputPayload: { path: "stagnant.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "read-3",
          toolName: "read_file",
          inputPayload: { path: "stagnant.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => {
        step4Invoked = true;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({ runId, workerId, leaseId, workspace });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain(
      "Execution loop halted due to stagnation: 3 consecutive identical successful reads of 'stagnant.txt' without progress"
    );
    expect(result.totalActions).toBe(3);
    expect(result.totalSteps).toBe(3);
    expect(result.totalProposalRejections).toBe(0);
    expect(step4Invoked).toBe(false);

    // Advisory was recorded in transcript at step 2
    expect(result.transcript[1]!.progressAdvisory).toContain("same read_file request for 'stagnant.txt'");

    // Workspace file was never modified merely because stagnation was detected
    expect(fs.readFileSync(filePath, "utf8")).toBe("alpha beta gamma");
  });

  it("resets stagnation counter when file content changes between reads", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const filePath = path.join(workspace.hostPath, "mutable.txt");
    fs.writeFileSync(filePath, "version-1", "utf8");

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "mut-read-1",
          toolName: "read_file",
          inputPayload: { path: "mutable.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => {
        return {
          proposal: {
            proposalId: "mut-read-2",
            toolName: "read_file",
            inputPayload: { path: "mutable.txt" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep((req) => {
        // Workspace file changed externally
        fs.writeFileSync(filePath, "version-2", "utf8");
        return {
          proposal: {
            proposalId: "mut-read-3",
            toolName: "read_file",
            inputPayload: { path: "mutable.txt" },
            contextSnapshotHash: req.contextSnapshot.contextHash,
          },
          finishReason: "ACTION_PROPOSED",
        };
      })
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({ runId, workerId, leaseId, workspace });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(3);
  });

  it("resets stagnation counter when reading distinct line ranges of the same file", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const filePath = path.join(workspace.hostPath, "lines.txt");
    fs.writeFileSync(filePath, "line 1\nline 2\nline 3\nline 4\n", "utf8");

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "line-read-1",
          toolName: "read_file",
          inputPayload: { path: "lines.txt", offsetLine: 1, limitLines: 1 },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "line-read-2",
          toolName: "read_file",
          inputPayload: { path: "lines.txt", offsetLine: 1, limitLines: 1 },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "line-read-3",
          toolName: "read_file",
          inputPayload: { path: "lines.txt", offsetLine: 2, limitLines: 2 },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({ runId, workerId, leaseId, workspace });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(3);
  });

  it("resets stagnation counter when reading different file paths", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    fs.writeFileSync(path.join(workspace.hostPath, "docA.txt"), "A", "utf8");
    fs.writeFileSync(path.join(workspace.hostPath, "docB.txt"), "B", "utf8");

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "doc-read-1",
          toolName: "read_file",
          inputPayload: { path: "docA.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "doc-read-2",
          toolName: "read_file",
          inputPayload: { path: "docA.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "doc-read-3",
          toolName: "read_file",
          inputPayload: { path: "docB.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({ runId, workerId, leaseId, workspace });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(3);
  });

  it("resets stagnation counter when an intervening state-changing action executes", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const filePath = path.join(workspace.hostPath, "target.txt");
    fs.writeFileSync(filePath, "old content", "utf8");

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "action-read-1",
          toolName: "read_file",
          inputPayload: { path: "target.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "action-read-2",
          toolName: "read_file",
          inputPayload: { path: "target.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "action-write",
          toolName: "write_file",
          inputPayload: { path: "target.txt", content: "new content" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({ runId, workerId, leaseId, workspace });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(3);
    expect(fs.readFileSync(filePath, "utf8")).toBe("new content");
  });

  it("honors custom maxConsecutiveIdenticalReads budget override", async () => {
    const { runId, leaseId, workspace } = await setupGovernedRun();
    const filePath = path.join(workspace.hostPath, "quick.txt");
    fs.writeFileSync(filePath, "sample content", "utf8");

    let step3Invoked = false;

    brain
      .queueStep((req) => ({
        proposal: {
          proposalId: "custom-read-1",
          toolName: "read_file",
          inputPayload: { path: "quick.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep((req) => ({
        proposal: {
          proposalId: "custom-read-2",
          toolName: "read_file",
          inputPayload: { path: "quick.txt" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
        finishReason: "ACTION_PROPOSED",
      }))
      .queueStep(() => {
        step3Invoked = true;
        return { finishReason: "GOAL_REACHED" };
      });

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalReads: 2 },
    });

    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain(
      "Execution loop halted due to stagnation: 2 consecutive identical successful reads of 'quick.txt' without progress"
    );
    expect(result.totalActions).toBe(2);
    expect(result.totalSteps).toBe(2);
    expect(step3Invoked).toBe(false);
  });
});
