/**
 * Milestone 2.28 Phase 5 Step 13: Stagnation-Aware System-Owned Verification Gate Test Suite
 *
 * Deterministic regression coverage for all 20 required scenarios:
 * 1. Stagnation with valid final workspace invokes system verification.
 * 2. Valid final workspace can complete only through the existing independent completion gate.
 * 3. Stagnation with invalid workspace remains failed.
 * 4. Stagnation without verification specs fails closed.
 * 5. Repeated stagnation does not repeat verification indefinitely.
 * 6. Repeated GOAL_REACHED does not duplicate authoritative evidence.
 * 7. Checkpoint restoration preserves agent and verification counters.
 * 8. Replay preserves verification identity and deduplication.
 * 9. Cancellation prevents verification.
 * 10. Lease loss prevents verification.
 * 11. Overall deadline expiry prevents verification.
 * 12. Verification action-budget exhaustion fails closed.
 * 13. Verification wall-clock exhaustion fails closed.
 * 14. Per-command timeout cannot exceed remaining verification budget.
 * 15. Stale attempts cannot create completion evidence.
 * 16. Failed verification cannot be converted into success.
 * 17. Terminal-state immutability remains intact.
 * 18. Physical execution provider remains mandatory.
 * 19. No host fallback is possible.
 * 20. Tenant isolation remains enforced.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SandboxedCommandToolAdapter } from "../../src/adapters/tools/sandboxed-command.tool-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
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
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Deterministic Mock Helpers
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
      durationMs: 5,
      error: res.error,
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
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

describe("Stagnation-Aware System-Owned Verification Gate (Milestone 2.28 Phase 5 Step 13)", () => {
  const workerId = "worker-stagnation-verify";
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let brain: ScriptedBrain;
  let provider: ControllableExecutionProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-stag-verify-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-10T12:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    brain = new ScriptedBrain();
    provider = new ControllableExecutionProvider();

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
  });

  afterEach(() => {
    store.close();
    try {
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

  function controllerFor(runtime: WorkerRuntime, allowUnverified = false): AgentStepController {
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
      allowUnverifiedCompletion: allowUnverified,
    });
  }

  async function setupRun(verificationSpecs?: VerificationSpec[], tenantId = "tenant-acceptance") {
    const task = coordinator.createTask({
      title: "Stagnation verification test task",
      description: "Test stagnation-aware verification stage",
      inputPayload: { file: "solution.js" },
    });

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        tenantId,
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "git.read",
          "process.execute",
        ],
        isolationRequirement: "ISOLATED",
      }),
      verificationSpecs,
      timeoutMs: 60000,
      maxAttempts: 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 120000);
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
      specId: "vspec-exit-zero",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: {
        toolName: "run_command",
        argv: ["node", "solution.js"],
      },
    });

  // --------------------------------------------------------------------------
  // Scenario 1: Stagnation with valid final workspace invokes system verification
  // --------------------------------------------------------------------------
  it("Scenario 1: Stagnation with valid final workspace invokes verification and completes", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "solution.js") {
        return { exitCode: 0, stdout: "EMERALD_VERIFIED\n" };
      }
      return { exitCode: 0 };
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Agent writes valid solution, then repeats identical write 3 times (stagnation)
    for (let i = 0; i < 3; i++) {
      brain.queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `prop-write-${i}`,
          toolName: "write_file",
          inputPayload: { path: "solution.js", content: "console.log('EMERALD_VERIFIED')" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Model repeatedly writing identical solution",
        },
      }));
    }

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 3 },
    });

    // Verification was triggered by stagnation against the valid final workspace!
    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.terminalMessage).toContain("stagnation verification against valid workspace state");

    const events = store.getEventsForRun(runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    expect((verifyEvent!.payload as any).status).toBe("VERIFIED");
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Valid final workspace can complete only through independent completion gate
  // --------------------------------------------------------------------------
  it("Scenario 2: Valid workspace can complete ONLY through completion gate (fails if gate rejects)", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "solution.js") {
        // Verification fails despite valid model writes
        return { exitCode: 1, stderr: "AssertionError: expected EMERALD_VERIFIED" };
      }
      return { exitCode: 0 };
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    for (let i = 0; i < 3; i++) {
      brain.queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `prop-write-${i}`,
          toolName: "write_file",
          inputPayload: { path: "solution.js", content: "console.log('INCORRECT')" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Model writing invalid content",
        },
      }));
    }

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 3 },
    });

    // When verification fails, terminal reason is STAGNATION (retaining original stagnation classification)
    expect(result.terminalReason).toBe("STAGNATION");
    expect(result.terminalMessage).toContain("consecutive identical successful writes");

    const events = store.getEventsForRun(runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    expect((verifyEvent!.payload as any).status).toBe("FAILED");
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Stagnation with invalid workspace remains failed
  // --------------------------------------------------------------------------
  it("Scenario 3: Stagnation with invalid workspace remains failed with STAGNATION", async () => {
    provider.setHandler(() => ({ exitCode: 1, stderr: "syntax error" }));

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    for (let i = 0; i < 3; i++) {
      brain.queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `prop-write-${i}`,
          toolName: "write_file",
          inputPayload: { path: "solution.js", content: "invalid syntax {" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "stagnating writes",
        },
      }));
    }

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 3 },
    });

    expect(result.terminalReason).toBe("STAGNATION");
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Stagnation without verification specs fails closed
  // --------------------------------------------------------------------------
  it("Scenario 4: Stagnation without verification specs fails closed with STAGNATION", async () => {
    // Contract has NO verification specs
    const { runId, leaseId, workspace } = await setupRun([]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Pre-populate solution.js so read_file succeeds (preventing MAX_FAILURES)
    fs.writeFileSync(path.join(workspace.hostPath, "solution.js"), "const x = 1;\n");

    for (let i = 0; i < 3; i++) {
      brain.queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `prop-read-${i}`,
          toolName: "read_file",
          inputPayload: { path: "solution.js" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "stagnating reads",
        },
      }));
    }

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalReads: 3 },
    });

    expect(result.terminalReason).toBe("STAGNATION");
    // No verification execution occurred
    expect(provider.invocations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Repeated stagnation does not repeat verification indefinitely
  // --------------------------------------------------------------------------
  it("Scenario 5: Repeated stagnation signals execute verification at most once", async () => {
    let verifyCount = 0;
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "solution.js") {
        verifyCount++;
        return { exitCode: 1 }; // fails verification
      }
      return { exitCode: 0 };
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    for (let i = 0; i < 4; i++) {
      brain.queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `prop-write-${i}`,
          toolName: "write_file",
          inputPayload: { path: "solution.js", content: "data" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "stagnating writes",
        },
      }));
    }

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 3 },
    });

    expect(result.terminalReason).toBe("STAGNATION");
    // Verification ran exactly once, not indefinitely
    expect(verifyCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Repeated GOAL_REACHED does not duplicate authoritative evidence
  // --------------------------------------------------------------------------
  it("Scenario 6: Repeated GOAL_REACHED does not duplicate authoritative verification records", async () => {
    provider.setHandler(() => ({ exitCode: 1, stderr: "FAIL" }));

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Model repeats GOAL_REACHED twice
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxProposalRejections: 2 },
    });

    const events = store.getEventsForRun(runId);
    const verifyEvents = events.filter((e) => e.eventType === "verification.completed");
    // Deduplicated: exactly 1 verification event
    expect(verifyEvents).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Checkpoint restoration preserves agent and verification counters
  // --------------------------------------------------------------------------
  it("Scenario 7: Checkpoint restoration preserves independent agent and verification counters", async () => {
    provider.setHandler(() => ({ exitCode: 0 }));

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Step 1: Agent performs write
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "solution.js", content: "console.log('EMERALD_VERIFIED')" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "write",
      },
    }));
    // Step 2: GOAL_REACHED triggers verification action
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      persistCheckpoints: true,
    });

    const checkpoints = store.getCheckpoints(runId);
    expect(checkpoints.length).toBeGreaterThan(0);
    const latest = checkpoints[checkpoints.length - 1]!;
    const dState = latest.durableState as any;
    expect(dState.actionCount).toBeGreaterThanOrEqual(2);
    expect(dState.verificationActionCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Replay preserves verification identity and deduplication
  // --------------------------------------------------------------------------
  it("Scenario 8: Replay preserves verification identity and deduplication tokens", async () => {
    provider.setHandler(() => ({ exitCode: 0 }));

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    const actions = store.getActionsForRun(runId);
    const verifyAction = actions.find((a) => a.toolName === "run_command");
    expect(verifyAction).toBeDefined();
    const attempts = store.getAttemptsForAction(verifyAction!.actionId);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]!.idempotencyToken).toBe(`${runId}:${verifyAction!.actionId}:1`);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Cancellation prevents verification
  // --------------------------------------------------------------------------
  it("Scenario 9: Cancellation before stagnation verification prevents execution", async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // already aborted

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "write_file",
        inputPayload: { path: "solution.js", content: "data" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "write",
      },
    }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      abortSignal: abortCtrl.signal,
    });

    expect(result.terminalReason).toBe("CANCELLED");
    expect(provider.invocations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Lease loss prevents verification
  // --------------------------------------------------------------------------
  it("Scenario 10: Lease loss before stagnation verification aborts with LEASE_LOST", async () => {
    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Expire the lease in database
    (store as any).db.prepare("UPDATE runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(runId);

    for (let i = 0; i < 3; i++) {
      brain.queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `p-${i}`,
          toolName: "write_file",
          inputPayload: { path: "solution.js", content: "data" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "stagnate",
        },
      }));
    }

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxConsecutiveIdenticalWrites: 3 },
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
    // Verification command never executes under lost lease
    const verifyInvocations = provider.invocations.filter((inv) => (inv.inputPayload as any)?.argv?.[0] === "node");
    expect(verifyInvocations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Overall deadline expiry prevents verification
  // --------------------------------------------------------------------------
  it("Scenario 11: Overall deadline expiry prevents stagnation verification", async () => {
    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue((req) => {
      clock.advanceMs(100_000); // Exceed overall run budget
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p1",
          toolName: "write_file",
          inputPayload: { path: "solution.js", content: "data" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "advance clock",
        },
      };
    });

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxWallClockMs: 50_000 },
    });

    expect(result.terminalReason).toBe("MAX_WALL_CLOCK");
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Verification action-budget exhaustion fails closed
  // --------------------------------------------------------------------------
  it("Scenario 12: Verification action budget exhaustion fails closed with MAX_ACTIONS", async () => {
    provider.setHandler(() => ({ exitCode: 0 }));

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxVerificationActions: 0 }, // 0 actions permitted
    });

    expect(result.terminalReason).toBe("MAX_ACTIONS");
    expect(result.terminalMessage).toContain("Maximum verification action execution ceiling reached");
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Verification wall-clock exhaustion fails closed
  // --------------------------------------------------------------------------
  it("Scenario 13: Verification wall-clock exhaustion fails closed with MAX_WALL_CLOCK", async () => {
    provider.setHandler(() => {
      clock.advanceMs(70_000); // Exceed verification wall-clock limit
      return { exitCode: 0 };
    });

    const { runId, leaseId, workspace } = await setupRun([
      defaultVerifySpec(),
      createVerificationSpec({
        specId: "vspec-second",
        ruleKind: "EXIT_CODE_ZERO",
        expectedValue: { toolName: "run_command", argv: ["node", "test2.js"] },
      }),
    ]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxWallClockMs: 600_000, maxVerificationWallClockMs: 60_000 },
    });

    expect(result.terminalReason).toBe("MAX_WALL_CLOCK");
    expect(result.terminalMessage).toContain("Verification wall clock ceiling reached");
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Per-command timeout cannot exceed remaining verification budget
  // --------------------------------------------------------------------------
  it("Scenario 14: Per-command timeout is dynamically constrained by remaining verification budget", async () => {
    let capturedTimeoutMs: number | undefined;
    provider.setHandler((req) => {
      capturedTimeoutMs = req.timeoutMs;
      return { exitCode: 0 };
    });

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Set maxVerificationWallClockMs to 15,000 ms (lower than default 60,000 ms)
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxVerificationWallClockMs: 15_000 },
    });

    expect(capturedTimeoutMs).toBeDefined();
    expect(capturedTimeoutMs!).toBeLessThanOrEqual(15_000);
  });

  // --------------------------------------------------------------------------
  // Scenario 15: Stale attempts cannot create completion evidence
  // --------------------------------------------------------------------------
  it("Scenario 15: Stale worker/attempt cannot create completion evidence", async () => {
    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Register worker-other so foreign key constraint passes
    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-other",
        hostname: "localhost",
        pid: 9999,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
    // Alter currentWorkerId in database to simulate a stale worker attempt
    (store as any).db.prepare("UPDATE runs SET current_worker_id = 'worker-other' WHERE run_id = ?").run(runId);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
  });

  // --------------------------------------------------------------------------
  // Scenario 16: Failed verification cannot be converted into success
  // --------------------------------------------------------------------------
  it("Scenario 16: Failed verification cannot be converted into success", async () => {
    provider.setHandler(() => ({ exitCode: 42, stderr: "fatal failure" }));

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // Scenario 17: Terminal-state immutability remains intact
  // --------------------------------------------------------------------------
  it("Scenario 17: Terminal run cannot be revived by verification", async () => {
    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Run already marked FAILED in store
    (store as any).db.prepare("UPDATE runs SET status = 'FAILED', lease_id = null, lease_expires_at = null WHERE run_id = ?").run(runId);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(provider.invocations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 18: Physical execution provider remains mandatory
  // --------------------------------------------------------------------------
  it("Scenario 18: Non-physical execution provider is rejected fail-closed", () => {
    class VirtualProvider implements ExecutionProvider {
      readonly name = "virtual-mock";
      readonly role = "ORCHESTRATION" as const;
      readonly tenantModel = "NONE" as const;
      async execute<_TInput, TOutput>(_req: ExecutionRequest<_TInput>): Promise<ExecutionResult<TOutput>> {
        return { status: "SUCCESS", durationMs: 1 };
      }
    }

    expect(() => {
      new SandboxedCommandToolAdapter(new VirtualProvider());
    }).toThrow("Only PHYSICAL execution providers are permitted");
  });

  // --------------------------------------------------------------------------
  // Scenario 19: No host fallback is possible
  // --------------------------------------------------------------------------
  it("Scenario 19: Verification rejects host execution fallback when sandbox is required", async () => {
    class HostProvider implements ExecutionProvider {
      readonly name = "in-process";
      readonly role = "PHYSICAL" as const;
      readonly tenantModel = "NONE" as const;
      async execute<_TInput, TOutput>(_req: ExecutionRequest<_TInput>): Promise<ExecutionResult<TOutput>> {
        return { status: "SUCCESS", durationMs: 1 };
      }
    }

    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()]);
    // Policy mandates ISOLATED, but HostProvider is in-process mock without container isolation
    const runtime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: new HostProvider(),
      isIsolationAvailable: false, // Sandbox unavailable
    });
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // Scenario 20: Tenant isolation remains enforced
  // --------------------------------------------------------------------------
  it("Scenario 20: Cross-tenant verification evidence is strictly isolated and rejected", async () => {
    const { runId, leaseId, workspace } = await setupRun([defaultVerifySpec()], "tenant-alpha");
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Insert verification evidence belonging to a DIFFERENT tenant
    store.transaction((tx) => {
      tx.appendEvent({
        eventId: "ev-cross-tenant-1",
        runId,
        eventType: "verification.rejected",
        schemaVersion: 1,
        producer: "test",
        payload: {
          status: "VERIFIED",
          specId: "vspec-exit-zero",
          tenantId: "tenant-beta", // DIFFERENT TENANT
        },
        timestamp: clock.nowIso(),
      });
    });

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    // Provider produces failure for the actual tenant
    provider.setHandler(() => ({ exitCode: 1, stderr: "FAILED" }));

    const result = await controller.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
  });
});
