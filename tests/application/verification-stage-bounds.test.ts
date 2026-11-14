/**
 * Verification stage bounds — regression tests for defects found in the Step 12 source audit:
 * A. The per-action verification timeout must not exceed maxVerificationWallClockMs.
 * B. A system verification command must not be treated as a workspace mutation: with several
 *    EXIT_CODE_ZERO specs, an earlier pass stays valid and is not re-executed.
 * C. Checkpoints written after verification actions must remain restorable, and agent and
 *    verification action counters must stay independent across a checkpoint restore.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController, type StepControllerBudget } from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import {
  createVerificationSpec,
  type VerificationSpec,
} from "../../src/domain/verification.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { validateStepLoopDurableState } from "../../src/application/step-loop-checkpoint.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Test Mock Providers
// ============================================================================

interface HandlerResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  status?: ExecutionResult["status"];
  error?: ExecutionResult["error"];
}

class ControllableExecutionProvider implements ExecutionProvider {
  readonly name = "controllable-mock-provider";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;
  readonly invocations: ExecutionRequest[] = [];

  constructor(
    private handler?: (req: ExecutionRequest) => HandlerResult
  ) {}

  setHandler(handler: (req: ExecutionRequest) => HandlerResult) {
    this.handler = handler;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    const res = this.handler
      ? this.handler(request)
      : ({ exitCode: 0, stdout: "ok\n", stderr: "", status: "SUCCESS" } as HandlerResult);

    return {
      status: res.status ?? "SUCCESS",
      output: {
        exitCode: res.exitCode,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        durationMs: 5,
        outputTruncated: false,
        commandHash: "mock-hash-" + res.exitCode,
      } as unknown as TOutput,
      error: res.error,
      durationMs: 5,
    };
  }
}

class ScriptedBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private readonly steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];

  queue(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (!next) {
      return {
        proposal: null,
        finishReason: "GOAL_REACHED",
      };
    }
    return next(request);
  }
}

describe("Verification stage bounds: timeout cap, multi-spec completion and checkpoint accounting", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let provider: ControllableExecutionProvider;
  let brain: ScriptedBrain;
  const workerId = "worker-vstage-bounds";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-vstage-bounds-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock(new Date("2026-11-10T12:00:00.000Z"));
    coordinator = new RunCoordinator(store, clock);
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 12345,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    provider = new ControllableExecutionProvider();
    brain = new ScriptedBrain();
  });

  afterEach(() => {
    try {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function runtimeWith(p: ExecutionProvider): WorkerRuntime {
    return new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: p,
      isIsolationAvailable: true,
    });
  }

  function controllerFor(runtime: WorkerRuntime, defaultBudget?: Partial<StepControllerBudget>): AgentStepController {
    return new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      proposalValidator: new ProposalValidator({
        coordinator,
        stateStore: store,
        toolRegistry: staticToolRegistry,
        clock,
      }),
      toolRegistry: staticToolRegistry,
      clock,
      enableGovernedVerificationStage: true,
      defaultBudget,
    });
  }

  async function setupRun(verificationSpecs?: VerificationSpec[]) {
    const task = coordinator.createTask({
      title: "Budget hardening test task",
      description: "Test verification budget hardening",
      inputPayload: { file: "test.txt" },
    });

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        tenantId: "tenant-acceptance",
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "git.read",
          "process.execute",
        ],
        isolationRequirement: "ISOLATED",
      }),
      verificationSpecs,
      timeoutMs: 30000,
      maxAttempts: 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 1_000_000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
    const workspace = await workspaceAdapter.provisionWorkspace({
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
      leaseId: claim.lease.leaseId,
      workspace,
    };
  }

  const defaultVerifySpec = () =>
    createVerificationSpec({
      specId: "vspec-test-command",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: {
        toolName: "run_command",
        argv: ["node", "-e", "process.exit(0)"],
      },
    });


  const writeThenGoal = (goalCount: number) => {
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "code.txt", content: "data" },
        rationale: "mutation",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    for (let i = 0; i < goalCount; i++) {
      brain.queue(() => ({ proposal: null, finishReason: "GOAL_REACHED" }));
    }
  };

  const spec = (id: string, argv: string[]) =>
    createVerificationSpec({
      specId: id,
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: { toolName: "run_command", argv },
    });

  it("A: verification command timeout is capped by maxVerificationWallClockMs", async () => {
    writeThenGoal(1);
    const controller = controllerFor(runtimeWith(provider), { maxVerificationWallClockMs: 5_000 });
    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({ runId, leaseId, workerId, workspace });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(provider.invocations.length).toBe(1);
    expect(provider.invocations[0]!.timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("B1: two passing EXIT_CODE_ZERO specs complete the run with exactly one execution each", async () => {
    writeThenGoal(1);
    const controller = controllerFor(runtimeWith(provider));
    const { runId, leaseId, workspace } = await setupRun([spec("v1", ["cmd1"]), spec("v2", ["cmd2"])]);

    const result = await controller.runStepLoop({ runId, leaseId, workerId, workspace });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalVerificationActions).toBe(2);
    expect(provider.invocations.map((r) => (r.inputPayload as any).argv[0])).toEqual(["cmd1", "cmd2"]);
  });

  it("B2: a passed spec is not re-executed when a later spec fails and the agent repeats GOAL_REACHED", async () => {
    provider.setHandler((req) => ({ exitCode: (req.inputPayload as any).argv[0] === "cmd2" ? 1 : 0 }));
    writeThenGoal(3);
    const controller = controllerFor(runtimeWith(provider), { maxProposalRejections: 3 });
    const { runId, leaseId, workspace } = await setupRun([spec("v1", ["cmd1"]), spec("v2", ["cmd2"])]);

    const result = await controller.runStepLoop({ runId, leaseId, workerId, workspace });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(provider.invocations.map((r) => (r.inputPayload as any).argv[0])).toEqual(["cmd1", "cmd2"]);
    expect(result.totalVerificationActions).toBe(2);
  });

  it("C: a checkpoint written after verification actions is valid and records the verification count separately", async () => {
    provider.setHandler((req) => ({ exitCode: (req.inputPayload as any).argv[0] === "cmd2" ? 1 : 0 }));
    writeThenGoal(3);
    const controller = controllerFor(runtimeWith(provider), { maxProposalRejections: 3 });
    const { runId, leaseId, workspace } = await setupRun([spec("v1", ["cmd1"]), spec("v2", ["cmd2"])]);

    const first = await controller.runStepLoop({ runId, leaseId, workerId, workspace });
    expect(first.totalAgentActions).toBe(1);
    expect(first.totalVerificationActions).toBe(2);

    const checkpoint = store.getLatestCheckpoint(runId);
    expect(checkpoint).toBeTruthy();
    const state = validateStepLoopDurableState(checkpoint!.durableState, runId);
    expect((state as any).verificationActionCount).toBe(2);

    expect(state.actionCount).toBe(3);
    expect(state.stepCount).toBeGreaterThanOrEqual(2);

    // Older checkpoints (no verificationActionCount) keep the original invariant; inconsistent values are rejected.
    const base = { ...(checkpoint!.durableState as Record<string, unknown>) };
    expect(() => validateStepLoopDurableState({ ...base, stepCount: 2, verificationActionCount: undefined }, runId)).toThrow(
      /cannot exceed stepCount/
    );
    expect(() => validateStepLoopDurableState({ ...base, verificationActionCount: 4 }, runId)).toThrow(
      /verificationActionCount/
    );
  });
});
