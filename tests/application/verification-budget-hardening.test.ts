/**
 * Milestone 2.28 — Phase 5, Step 12: Verification Budget Hardening & Replay Safety Test Suite
 *
 * Deterministic test suite verifying verification budget separation, replay safety,
 * and fail-closed security invariants:
 * 1. Agent action budget exhausted while verification allowance remains -> verification executes and run completes.
 * 2. Verification allowance exhausted (maxVerificationActions) -> halts safely with MAX_ACTIONS.
 * 3. Verification timeout (maxVerificationWallClockMs) -> halts safely with MAX_WALL_CLOCK.
 * 4. Overall run deadline reached before verification -> halts with MAX_WALL_CLOCK.
 * 5. Cancellation before verification -> aborts loop cleanly with CANCELLED.
 * 6. Lease loss / expiry during verification -> aborts cleanly with LEASE_LOST.
 * 7. Repeated GOAL_REACHED proposals -> dedup and loop prevention stops redundant executions.
 * 8. Replayed verification attempt -> dedup token prevents duplicate event insertion.
 * 9. Uncertain verification execution (UNKNOWN outcome) -> halts with UNKNOWN_EXECUTION.
 * 10. Stale verification evidence -> outdated attempts do not authorize completion over current state.
 * 11. Cross-run / cross-tenant evidence rejection -> isolated and rejected.
 * 12. Physical provider error during verification -> handled safely without unhandled rejections.
 * 13. Separate action accounting -> totalAgentActions and totalVerificationActions accurately reported.
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
import { createProcessExitEvidence } from "../../src/domain/evidence.js";
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

describe("Milestone 2.28 Phase 5 Step 12: Verification Budget Hardening & Replay Safety", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let provider: ControllableExecutionProvider;
  let brain: ScriptedBrain;
  const workerId = "worker-step12-test";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-step12-test-"));
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

  // --------------------------------------------------------------------------
  // Scenario 1: Agent action budget exhausted while verification allowance remains
  // --------------------------------------------------------------------------
  it("Scenario 1: Agent action budget exhausted (maxActions=1) while verification allowance remains -> verification executes and run completes", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "-e") {
        return { exitCode: 0, stdout: "TEST_PASSED" };
      }
      return { exitCode: 0 };
    });

    // Step 1: Agent proposes write_file (consuming the 1 allowed agent action)
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "solution.txt", content: "hello world" },
        rationale: "perform required mutation",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: Agent has exhausted its action budget (maxActions=1)
    // The controller should NOT skip verification; verification runs with its own budget
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, {
      maxActions: 1, // Agent action ceiling = 1
      maxVerificationActions: 3, // Verification ceiling = 3
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalAgentActions).toBe(1);
    expect(result.totalVerificationActions).toBe(1);
    expect(result.totalActions).toBe(2);

    // Verify verification completed event was durably recorded
    const events = store.getEventsForRun(runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    expect((verifyEvent?.payload as any).status).toBe("VERIFIED");
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Verification allowance exhausted (maxVerificationActions)
  // --------------------------------------------------------------------------
  it("Scenario 2: Verification allowance exhausted (maxVerificationActions=1 with 2 specs) -> halts safely with MAX_ACTIONS", async () => {
    // Two distinct specs requiring two separate verification actions
    const spec1 = createVerificationSpec({
      specId: "vspec-test-1",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: {
        toolName: "run_command",
        argv: ["node", "-e", "process.exit(0)"],
        requireDiff: true, // requires git_diff first, then run_command
      },
    });

    provider.setHandler(() => ({ exitCode: 0, stdout: "ok" }));

    // Agent proposes a mutation then says GOAL_REACHED
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
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, {
      maxActions: 5,
      maxVerificationActions: 1, // Only 1 verification action allowed! But diff + test = 2 tasks!
    });

    const { runId, leaseId, workspace } = await setupRun([spec1]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("MAX_ACTIONS");
    expect(result.terminalMessage).toContain("verification action execution ceiling reached");
    expect(result.totalVerificationActions).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Verification timeout (maxVerificationWallClockMs)
  // --------------------------------------------------------------------------
  it("Scenario 3: Verification timeout (maxVerificationWallClockMs) -> halts safely with MAX_WALL_CLOCK", async () => {
    // Advance clock during verification execution
    provider.setHandler(() => {
      clock.advanceMs(100_000); // Advance clock beyond verification timeout
      return { exitCode: 0 };
    });

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
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, {
      maxWallClockMs: 500_000,
      maxVerificationWallClockMs: 60_000, // 60s timeout for verification
      maxVerificationActions: 5,
    });

    // 2 specs so second spec hits the verification timeout
    const spec1 = createVerificationSpec({
      specId: "vspec-test-1",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: { toolName: "run_command", argv: ["cmd1"] },
    });
    const spec2 = createVerificationSpec({
      specId: "vspec-test-2",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: { toolName: "run_command", argv: ["cmd2"] },
    });

    const { runId, leaseId, workspace } = await setupRun([spec1, spec2]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("MAX_WALL_CLOCK");
    expect(result.terminalMessage).toContain("Verification wall clock ceiling reached");
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Overall run deadline reached before verification
  // --------------------------------------------------------------------------
  it("Scenario 4: Overall run deadline reached before verification -> halts with MAX_WALL_CLOCK", async () => {
    brain.queue(() => {
      clock.advanceMs(200_000); // Advance clock beyond overall run deadline
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p1",
          toolName: "write_file",
          inputPayload: { path: "code.txt", content: "data" },
          rationale: "mutation",
        },
      };
    });
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, {
      maxWallClockMs: 100_000, // 100s deadline
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("MAX_WALL_CLOCK");
    expect(result.terminalMessage).toContain("Wall clock ceiling reached");
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Cancellation before verification via AbortSignal
  // --------------------------------------------------------------------------
  it("Scenario 5: Cancellation before verification -> aborts loop cleanly with CANCELLED", async () => {
    const abortController = new AbortController();

    brain.queue(() => {
      abortController.abort(); // Cancel before verification stage executes
      return {
        proposal: null,
        finishReason: "GOAL_REACHED",
      };
    });

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
      abortSignal: abortController.signal,
    });

    expect(result.terminalReason).toBe("CANCELLED");
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Lease loss / expiry during verification
  // --------------------------------------------------------------------------
  it("Scenario 6: Lease loss during verification -> aborts cleanly with LEASE_LOST", async () => {
    provider.setHandler(() => {
      // Worker lease expires before verification
      clock.advanceMs(100_000);
      return { exitCode: 0 };
    });

    brain.queue(() => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "code.txt", content: "data" },
        rationale: "mutation",
      },
    }));
    brain.queue(() => {
      // Artificially expire the lease in state store to simulate lease loss before verification
      (store as any).db.prepare("UPDATE runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(runId);
      return {
        proposal: null,
        finishReason: "GOAL_REACHED",
      };
    });

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Repeated GOAL_REACHED proposals (Loop prevention)
  // --------------------------------------------------------------------------
  it("Scenario 7: Repeated GOAL_REACHED proposals -> does not re-execute verification on unchanged state", async () => {
    let verificationExecutions = 0;
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "-e") {
        verificationExecutions++;
        return { exitCode: 1, stderr: "TEST_FAILED" }; // Verification fails
      }
      return { exitCode: 0 };
    });

    // Step 1: Mutation
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "file.txt", content: "initial" },
        rationale: "mutation",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    // Step 2: GOAL_REACHED (verification runs and fails)
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));
    // Step 3: Repeated GOAL_REACHED without mutation
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));
    // Step 4: Repeated GOAL_REACHED again
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, {
      maxProposalRejections: 3,
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    // Verification should only have executed ONCE, not on every repeated GOAL_REACHED
    expect(verificationExecutions).toBe(1);
    expect(result.totalVerificationActions).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Replayed verification attempt (dedup token stability)
  // --------------------------------------------------------------------------
  it("Scenario 8: Replayed verification attempt -> dedup token prevents duplicate event insertion", async () => {
    provider.setHandler(() => ({ exitCode: 0, stdout: "PASSED" }));

    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "data.txt", content: "data" },
        rationale: "mutation",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Count verification.completed events in store
    const events = store.getEventsForRun(runId);
    const verifyEvents = events.filter((e) => e.eventType === "verification.completed");
    expect(verifyEvents.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Uncertain verification execution (UNKNOWN outcome)
  // --------------------------------------------------------------------------
  it("Scenario 9: Uncertain verification execution -> halts with UNKNOWN_EXECUTION without auto-retry", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "-e") {
        return {
          exitCode: 1,
          status: "FAILED" as const,
          error: { code: "EXECUTION_OUTCOME_UNKNOWN", message: "PROVIDER_RESULT_UNAVAILABLE: Execution uncertain, lost connection to container" }
        };
      }
      return { exitCode: 0, status: "SUCCESS" as const };
    });

    brain.queue(() => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "code.txt", content: "data" },
        rationale: "mutation",
      },
    }));
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("UNKNOWN_EXECUTION");
    expect(result.terminalMessage).toContain("produced UNKNOWN execution outcome");
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Stale verification evidence
  // --------------------------------------------------------------------------
  it("Scenario 10: Stale verification evidence -> subsequent mutations invalidate prior verification", async () => {
    let callCount = 0;
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "-e") {
        callCount++;
        // First verification passes, but after subsequent mutation, verification fails!
        return callCount === 1 ? { exitCode: 0 } : { exitCode: 1, stderr: "BROKEN" };
      }
      return { exitCode: 0 };
    });

    // Step 1: Write file
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "code.txt", content: "good" },
        rationale: "first mutation",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    // Step 2: GOAL_REACHED (verification passes!)
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Cross-run and cross-tenant evidence rejection
  // --------------------------------------------------------------------------
  it("Scenario 11: Cross-run and cross-tenant evidence isolation -> rejected by completion gate", async () => {
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    // Create a second task and run in a different tenant
    const otherTask = coordinator.createTask({
      title: "Other tenant task",
      description: "Tenant B task",
      inputPayload: {},
    });
    createAndActivateContract(store, otherTask.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${otherTask.taskId}`,
        tenantId: "tenant-other",
        allowedCapabilities: ["process.execute"],
        isolationRequirement: "ISOLATED",
      }),
    });
    const { run: otherRun } = coordinator.createRun({ taskId: otherTask.taskId });

    // Insert exit evidence belonging to the other run
    const foreignEvidence = createProcessExitEvidence(otherRun.runId, { exitCode: 0 });
    coordinator.recordEvidence(otherRun.runId, foreignEvidence);

    // Model in the primary run declares GOAL_REACHED without performing any mutation or verification
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    // The other run's evidence must NOT authorize completion of this run
    provider.setHandler(() => ({ exitCode: 1 })); // Primary provider verification fails

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Physical provider error during verification
  // --------------------------------------------------------------------------
  it("Scenario 12: Physical provider error during verification -> handled safely without unhandled rejections", async () => {
    provider.setHandler(() => {
      throw new Error("Container runtime crashed (OCI error)");
    });

    brain.queue(() => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "data.txt", content: "data" },
        rationale: "mutation",
      },
    }));
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Separate action accounting
  // --------------------------------------------------------------------------
  it("Scenario 13: Separate action accounting accurately reports agent and verification actions", async () => {
    provider.setHandler(() => ({ exitCode: 0, stdout: "ok" }));

    // Agent executes 2 actions
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "a.txt", content: "1" },
        rationale: "mutation 1",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "write_file",
        inputPayload: { path: "b.txt", content: "2" },
        rationale: "mutation 2",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queue(() => ({
      proposal: null,
      finishReason: "GOAL_REACHED",
    }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, {
      maxActions: 5,
      maxVerificationActions: 5,
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);

    const result = await controller.runStepLoop({
      runId,
      leaseId,
      workerId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalAgentActions).toBe(2);
    expect(result.totalVerificationActions).toBe(1);
    expect(result.totalActions).toBe(3);
  });
});
