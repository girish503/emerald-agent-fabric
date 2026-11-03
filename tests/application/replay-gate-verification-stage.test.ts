/**
 * Milestone 2.10I — Verification-stage and clean-room replay block handling
 *
 * Verifies that a Tier-1 replay block returned for a verification action:
 * - is recognised by its structured error code (never by message text);
 * - is never dispatched, never creates an Attempt and never invokes the provider;
 * - is not treated as a verification failure or as proof about the earlier execution;
 * - produces mandatory payload-free feedback, and a repeat ends the run with POLICY_DENIED;
 * while UNKNOWN, FENCED and ordinary verification failures keep their existing handling.
 *
 * Test providers declare tenantModel = "NONE" explicitly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { CleanRoomVerifier } from "../../src/application/clean-room-verifier.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import {
  REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
  WorkerRuntime,
  type ExecuteActionParams,
  type WorkerActionResult,
} from "../../src/application/worker-runtime.js";
import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { createVerificationSpec, type CleanRoomVerificationSpec } from "../../src/domain/verification.js";
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
import { createMockGitRepository } from "../adapters/tools/git-test-helper.js";
import { createAndActivateContract } from "./test-helpers.js";

class FixedExitProvider implements ExecutionProvider {
  readonly name = "fixed-exit-provider";
  readonly tenantModel = "NONE" as const;
  readonly invocations: ExecutionRequest[] = [];
  constructor(private readonly exitCode: number) {}

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: {
        exitCode: this.exitCode,
        stdout: "ran",
        stderr: "",
        durationMs: 1,
        outputTruncated: false,
      } as unknown as TOutput,
      durationMs: 1,
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

const goal = (): AgentBrainResult => ({ finishReason: "GOAL_REACHED" });

function replayFeedback(req: AgentBrainRequest) {
  return req.contextSnapshot.observations.filter(
    (o) =>
      o.category === "TOOL_ERROR" &&
      (o.content as Record<string, unknown>).feedbackKind === REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT
  );
}

// Unique tokens so payload leakage into feedback is detectable.
const STAGE_ARGV = ["echo", "stage-argv-token-31f"];
const STAGE_TIMEOUT = 30000; // min(60000, contract timeout) as computed by the verification stage

describe("Milestone 2.10I — replay blocks in verification paths", () => {
  const workerId = "worker-verification-replay";
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let brain: ScriptedBrain;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-replay-verify-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-03T10:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    brain = new ScriptedBrain();
    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 9191,
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

  function runtimeWith(provider: ExecutionProvider): WorkerRuntime {
    return new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: provider,
      isIsolationAvailable: true,
    });
  }

  function controllerFor(
    runtime: Pick<WorkerRuntime, "executeAction">,
    extra: { cleanRoomVerifier?: CleanRoomVerifier } = {}
  ): AgentStepController {
    return new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime as unknown as WorkerRuntime,
      agentBrain: brain,
      proposalValidator: new ProposalValidator({
        coordinator,
        stateStore: store,
        toolRegistry: staticToolRegistry,
        clock,
      }),
      toolRegistry: staticToolRegistry,
      clock,
      ...extra,
    });
  }

  async function setupRun(verificationSpecs: ReturnType<typeof createVerificationSpec>[]) {
    const task = coordinator.createTask({
      title: "Verification replay task",
      description: "Verification replay block",
      inputPayload: { target: "test" },
    });
    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
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
    const claim = coordinator.claimRun(run.runId, workerId, 60000);
    const started = coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
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
      binding: started.run.contractBinding!,
    };
  }

  /** Seeds a prior run_command Action whose Attempt is UNKNOWN, as recovery would leave it. */
  function seedUnknownRunCommand(
    run: { runId: string; leaseId: string; binding: Parameters<typeof Action.create>[0]["contractBinding"] },
    inputPayload: Record<string, unknown>
  ) {
    const now = clock.nowIso();
    const fencing = { workerId, leaseId: run.leaseId };
    const seq = store.getActionsForRun(run.runId).length + 1;
    const actionId = `act-unknown-${seq}`;
    const attemptId = `att-unknown-${seq}`;
    const { action, event } = Action.create({
      actionId,
      runId: run.runId,
      sequenceNumber: seq,
      toolName: "run_command",
      inputPayload,
      contractBinding: run.binding,
      maxAttempts: 3,
      now,
    });
    store.transaction((tx) => {
      tx.insertAction(action.snapshot, event, fencing);
      tx.transitionAction(actionId, { type: "AUTHORIZE", now }, () => crypto.randomUUID());
      tx.transitionAction(actionId, { type: "START_ATTEMPT", attemptNumber: 1, now }, () =>
        crypto.randomUUID()
      );
      const { attempt, event: attEvent } = Attempt.create({
        attemptId,
        actionId,
        runId: run.runId,
        attemptNumber: 1,
        workerId,
        leaseId: run.leaseId,
        now,
      });
      tx.insertAttempt(attempt.snapshot, attEvent, fencing);
      tx.transitionAttempt(attemptId, { type: "DISPATCH", now }, () => crypto.randomUUID());
      tx.transitionAttempt(attemptId, { type: "START", now }, () => crypto.randomUUID());
      tx.transitionAttempt(
        attemptId,
        {
          type: "MARK_UNKNOWN",
          reason: "Worker crashed or lease expired during execution",
          reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
          now,
        },
        () => crypto.randomUUID()
      );
      tx.transitionAction(
        actionId,
        { type: "FAIL", errorPayload: { code: "EXECUTION_UNCERTAIN" }, now },
        () => crypto.randomUUID()
      );
    });
    return { actionId, attemptId };
  }

  function blockedActions(runId: string) {
    return store
      .getActionsForRun(runId)
      .filter(
        (a) =>
          a.status === "FAILED" &&
          (a.errorPayload as { code?: string } | null)?.code === REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT
      );
  }

  const stageSpec = () =>
    createVerificationSpec({
      specId: "stage-exit-zero",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: { toolName: "run_command", argv: STAGE_ARGV, governedStage: true },
    });

  function withExecuteResult(
    runtime: WorkerRuntime,
    override: (params: ExecuteActionParams) => WorkerActionResult
  ): Pick<WorkerRuntime, "executeAction"> {
    return new Proxy(runtime, {
      get(target, prop) {
        if (prop === "executeAction") {
          return async (params: ExecuteActionParams) => override(params);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  // ==========================================================================
  // Verification stage
  // ==========================================================================

  it("V1-V4, V8, V9: a replayed verification command is blocked by code, never dispatched, explained once, and a repeat ends POLICY_DENIED", async () => {
    const provider = new FixedExitProvider(0);
    const runtime = runtimeWith(provider);
    const run = await setupRun([stageSpec()]);
    const prior = seedUnknownRunCommand(run, { argv: STAGE_ARGV, timeoutMs: STAGE_TIMEOUT });

    brain.queue(goal).queue(goal).queue(goal);

    const result = await controllerFor(runtime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      enableGovernedVerificationStage: true,
    });

    // V8: terminates safely when no progress is possible; replay rule, not the failure budget.
    expect(result.terminalReason).toBe("POLICY_DENIED");
    expect(result.totalConsecutiveFailures).toBe(0);
    expect(brain.requests).toHaveLength(2);

    // V1/V2/V3: recognised by code; no Attempt; no provider call; not redispatched.
    const blocked = blockedActions(run.runId);
    expect(blocked).toHaveLength(2);
    for (const a of blocked) {
      expect(store.getAttemptsForAction(a.actionId)).toHaveLength(0);
    }
    expect(provider.invocations).toHaveLength(0);

    // V4: the earlier execution is left exactly as it was: still UNKNOWN, action still FAILED
    // with the original uncertain payload, no success or deterministic-failure rewrite.
    const priorAttempt = store.getAttempt(prior.attemptId)!;
    expect(priorAttempt.status).toBe("UNKNOWN");
    expect(store.getAttemptsForAction(prior.actionId)).toHaveLength(1);
    expect(store.getAction(prior.actionId)!.errorPayload).toEqual({ code: "EXECUTION_UNCERTAIN" });

    // Feedback: first request has none; the next one has exactly one, mandatory, payload-free.
    expect(replayFeedback(brain.requests[0]!)).toHaveLength(0);
    const feedback = replayFeedback(brain.requests[1]!);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.isMandatory).toBe(true);
    expect(feedback[0]!.content).toMatchObject({
      blockCode: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
      source: "VERIFICATION_STAGE",
      toolName: "run_command",
      priorActionId: prior.actionId,
      priorAttemptId: prior.attemptId,
      priorAttemptStatus: "UNKNOWN",
      priorReasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
    });
    // V9: no payload leakage.
    const serialized = JSON.stringify(feedback[0]);
    expect(serialized).not.toContain("stage-argv-token-31f");
    expect(serialized).not.toContain("echo");
  });

  it("V5: an UNKNOWN verification outcome still stops immediately with UNKNOWN_EXECUTION", async () => {
    const runtime = runtimeWith(new FixedExitProvider(0));
    const run = await setupRun([stageSpec()]);
    brain.queue(goal).queue(goal);

    const result = await controllerFor(
      withExecuteResult(runtime, (p) => ({
        status: "UNKNOWN",
        actionId: p.actionId ?? "a",
        runId: p.runId,
        error: { code: "EXECUTION_UNCERTAIN" },
      }))
    ).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      enableGovernedVerificationStage: true,
    });

    expect(result.terminalReason).toBe("UNKNOWN_EXECUTION");
    expect(brain.requests).toHaveLength(1);
  });

  it("V6: a FENCED verification result still ends with LEASE_LOST", async () => {
    const runtime = runtimeWith(new FixedExitProvider(0));
    const run = await setupRun([stageSpec()]);
    brain.queue(goal).queue(goal);

    const result = await controllerFor(
      withExecuteResult(runtime, (p) => ({
        status: "FENCED",
        actionId: p.actionId ?? "a",
        runId: p.runId,
        error: new LeaseLostError(p.runId, "held", "other"),
      }))
    ).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      enableGovernedVerificationStage: true,
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
    expect(brain.requests).toHaveLength(1);
  });

  it("V7: an ordinary failing verification command keeps its existing handling (no replay rule)", async () => {
    const provider = new FixedExitProvider(1);
    const runtime = runtimeWith(provider);
    const run = await setupRun([stageSpec()]);
    brain.queue(goal).queue(goal).queue(goal).queue(goal);

    const result = await controllerFor(runtime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      enableGovernedVerificationStage: true,
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.terminalReason).not.toBe("POLICY_DENIED");
    expect(provider.invocations).toHaveLength(1); // dispatched once; not re-run on the same failed state
    expect(blockedActions(run.runId)).toHaveLength(0);
    for (const req of brain.requests) {
      expect(replayFeedback(req)).toHaveLength(0);
    }
  });

  it("V1b: only the structured code counts; a look-alike FAILED result is an ordinary verification failure", async () => {
    const runtime = runtimeWith(new FixedExitProvider(0));
    const run = await setupRun([stageSpec()]);
    brain.queue(goal).queue(goal).queue(goal).queue(goal);

    const result = await controllerFor(
      withExecuteResult(runtime, (p) => ({
        status: "FAILED",
        actionId: p.actionId ?? "a",
        runId: p.runId,
        error: { code: "TOOL_EXECUTION_FAILED", message: "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT in text" },
      }))
    ).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      enableGovernedVerificationStage: true,
    });

    expect(result.terminalReason).not.toBe("POLICY_DENIED");
    for (const req of brain.requests) {
      expect(replayFeedback(req)).toHaveLength(0);
    }
  });

  // ==========================================================================
  // Clean-room verification
  // ==========================================================================

  async function setupCleanRoom() {
    const provider = new FixedExitProvider(0);
    const runtime = runtimeWith(provider);

    // Authentic mock git baseline so the verifier reaches its first test command.
    const task = coordinator.createTask({
      title: "Clean-room replay task",
      description: "Clean-room replay block",
      inputPayload: { directive: "fix" },
    });
    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${task.taskId.slice(0, 8)}`,
      runId: `run-${task.taskId.slice(0, 8)}`,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    const { commitSha } = await createMockGitRepository(ws.hostPath, [
      { path: "package.json", content: '{\n  "name": "m",\n  "version": "1.0.0"\n}\n' },
      { path: "src/math.js", content: "module.exports = { add: (a, b) => a - b };\n" },
      { path: "test/math.target.test.js", content: "// target\n" },
      { path: "test/math.regress.test.js", content: "// regress\n" },
    ]);
    const F2P = ["node", "test/math.target.test.js"];
    const cleanSpec: CleanRoomVerificationSpec = {
      specId: "clean-room-replay-spec",
      baselineCommitSha: commitSha,
      failToPass: {
        testCommand: F2P,
        expectedBaselineExitCode: 1,
        expectedPatchedExitCode: 0,
        minTestCount: 2,
        suiteRanRegex: "PASS:?\\s*2\\s+of\\s+2",
      },
      passToPass: {
        testCommand: ["node", "test/math.regress.test.js"],
        expectedBaselineExitCode: 0,
        expectedPatchedExitCode: 0,
        minTestCount: 3,
        suiteRanRegex: "PASS:?\\s*3\\s+of\\s+3",
      },
      allowedPathPatterns: ["src/**/*.js"],
      timeoutMs: 30000,
    };
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "workspace.code.search",
          "git.read",
          "process.execute",
        ],
        isolationRequirement: "ISOLATED",
      }),
      verificationSpecs: [
        createVerificationSpec({
          specId: cleanSpec.specId,
          ruleKind: "CLEAN_ROOM_DUAL_GATE",
          expectedValue: cleanSpec,
        }),
      ],
      timeoutMs: 60_000,
      maxAttempts: 5,
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 60000);
    const started = coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

    // Prior uncertain execution of the exact clean-room baseline command (payload as the verifier builds it).
    const prior = seedUnknownRunCommand(
      { runId: run.runId, leaseId: claim.lease.leaseId, binding: started.run.contractBinding! },
      { argv: F2P, timeoutMs: cleanSpec.timeoutMs }
    );

    const verifier = new CleanRoomVerifier({
      workspacePort: workspaceAdapter,
      workerRuntime: runtime,
      coordinator,
      stateStore: store,
      clock,
    });

    const writeFix = (req: AgentBrainRequest): AgentBrainResult => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-fix",
        toolName: "write_file",
        inputPayload: { path: "src/math.js", content: "module.exports = { add: (a, b) => a + b };\n" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "fix",
      },
    });

    return {
      provider,
      runtime,
      verifier,
      prior,
      run,
      ws,
      leaseId: claim.lease.leaseId,
      writeFix,
    };
  }

  function expectCleanRoomFeedback(
    req: AgentBrainRequest,
    prior: { attemptId: string }
  ) {
    const feedback = replayFeedback(req);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.isMandatory).toBe(true);
    expect(feedback[0]!.content).toMatchObject({
      blockCode: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
      source: "CLEAN_ROOM_VERIFICATION",
      priorAttemptId: prior.attemptId,
      priorAttemptStatus: "UNKNOWN",
    });
    const serialized = JSON.stringify(feedback[0]);
    expect(serialized).not.toContain("math.target.test.js");
    expect(serialized).not.toContain("src/math.js");
  }

  it("C1: a blocked clean-room command at the completion gate is not read as a test result; a repeat ends POLICY_DENIED", async () => {
    const f = await setupCleanRoom();
    brain.queue(f.writeFix).queue(goal).queue(goal).queue(goal);

    const result = await controllerFor(f.runtime, { cleanRoomVerifier: f.verifier }).runStepLoop({
      runId: f.run.runId,
      workerId,
      leaseId: f.leaseId,
      workspace: f.ws,
      // Isolate the completion-gate path: no intermediate test feedback / post-pass clean-room gate.
      budget: { enableIntermediateTestFeedback: false },
    });

    expect(result.terminalReason).toBe("POLICY_DENIED");
    expect(result.terminalMessage).toContain("clean-room");
    expect(brain.requests).toHaveLength(3);

    const blocked = blockedActions(f.run.runId);
    expect(blocked).toHaveLength(2);
    for (const a of blocked) {
      expect(store.getAttemptsForAction(a.actionId)).toHaveLength(0);
    }
    expect(f.provider.invocations).toHaveLength(0);
    expect(store.getAttempt(f.prior.attemptId)!.status).toBe("UNKNOWN");

    expect(replayFeedback(brain.requests[1]!)).toHaveLength(0);
    expectCleanRoomFeedback(brain.requests[2]!, f.prior);
  });

  it("C2: a blocked clean-room command in the post-pass gate is explained, and the next block ends POLICY_DENIED", async () => {
    const f = await setupCleanRoom();
    brain.queue(f.writeFix).queue(goal).queue(goal);

    const result = await controllerFor(f.runtime, { cleanRoomVerifier: f.verifier }).runStepLoop({
      runId: f.run.runId,
      workerId,
      leaseId: f.leaseId,
      workspace: f.ws,
    });

    // Post-pass gate blocks once (feedback), the completion gate blocks again (terminate).
    expect(result.terminalReason).toBe("POLICY_DENIED");
    expect(brain.requests).toHaveLength(2);
    expectCleanRoomFeedback(brain.requests[1]!, f.prior);

    const blocked = blockedActions(f.run.runId);
    expect(blocked).toHaveLength(2);
    for (const a of blocked) {
      expect(store.getAttemptsForAction(a.actionId)).toHaveLength(0);
    }
    // Only the controller's direct intermediate F2P/P2P test runs reached the provider (a path outside
    // the gate); the blocked clean-room commands did not add any call.
    expect(f.provider.invocations).toHaveLength(2);
    expect(store.getAttempt(f.prior.attemptId)!.status).toBe("UNKNOWN");
  });
});
