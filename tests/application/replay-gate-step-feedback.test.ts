/**
 * Milestone 2.10G — Replay Block Feedback and Repeat-Block Termination
 *
 * Verifies the model-facing half of the Tier-1 replay gate in AgentStepController:
 * - the first replay block queues a mandatory, structured, payload-free TOOL_ERROR observation that
 *   reaches the next AgentBrainRequest;
 * - a second replay block in the same run ends the loop with POLICY_DENIED;
 * - unrelated failures, UNKNOWN_EXECUTION and lease fencing keep their existing behaviour.
 *
 * Test providers declare tenantModel = "NONE" explicitly and do not rely on stale legacy fixtures.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
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

class NoTenantCountingProvider implements ExecutionProvider {
  readonly name = "no-tenant-counting-provider";
  readonly tenantModel = "NONE" as const;
  readonly invocations: ExecutionRequest[] = [];

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return { status: "SUCCESS", output: {} as unknown as TOutput, durationMs: 1 };
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

const propose = (
  id: string,
  toolName: "write_file" | "read_file",
  inputPayload: Record<string, unknown>
) =>
  (req: AgentBrainRequest): AgentBrainResult => ({
    finishReason: "ACTION_PROPOSED",
    proposal: {
      proposalId: id,
      toolName,
      inputPayload,
      contextSnapshotHash: req.contextSnapshot.contextHash,
      rationale: id,
    },
  });

const SECRET_CONTENT = "SECRET-PAYLOAD-CONTENT-7f3a";
const BLOCKED_PATH = "leak-check-path.txt";
const blockedPayload = { path: BLOCKED_PATH, content: SECRET_CONTENT, overwrite: true };

function replayFeedback(req: AgentBrainRequest) {
  return req.contextSnapshot.observations.filter(
    (o) =>
      o.category === "TOOL_ERROR" &&
      (o.content as Record<string, unknown>).feedbackKind === REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT
  );
}

describe("Milestone 2.10G — replay block feedback and repeat-block termination", () => {
  const workerId = "worker-replay-feedback";
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let provider: NoTenantCountingProvider;
  let workerRuntime: WorkerRuntime;
  let brain: ScriptedBrain;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-replay-feedback-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-03T10:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    provider = new NoTenantCountingProvider();
    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: provider,
    });
    brain = new ScriptedBrain();
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
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function controllerFor(runtime: Pick<WorkerRuntime, "executeAction">): AgentStepController {
    return new AgentStepController({
      allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
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
    });
  }

  async function setupRun() {
    const task = coordinator.createTask({
      title: "Replay feedback task",
      description: "Replay block feedback",
      inputPayload: { target: "test" },
    });
    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
        isolationRequirement: "ISOLATED",
      }),
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
      runId: run.runId,
      leaseId: claim.lease.leaseId,
      workspace,
      binding: started.run.contractBinding!,
      contractId: contract.spec.contractId,
    };
  }

  /** Seeds a prior write_file Action whose Attempt is UNKNOWN, as recovery would leave it. */
  function seedUnknownPrior(
    run: Awaited<ReturnType<typeof setupRun>>,
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
      toolName: "write_file",
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

  function replayBlockedActions(runId: string) {
    return store
      .getActionsForRun(runId)
      .filter(
        (a) =>
          a.status === "FAILED" &&
          (a.errorPayload as { code?: string } | null)?.code === REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT
      );
  }

  it("T1: first replay block reaches the next brain request as a mandatory, payload-free TOOL_ERROR", async () => {
    const run = await setupRun();
    const prior = seedUnknownPrior(run, blockedPayload);

    brain
      .queue(propose("p-blocked", "write_file", blockedPayload))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controllerFor(workerRuntime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(brain.requests).toHaveLength(2);

    const blocked = replayBlockedActions(run.runId);
    expect(blocked).toHaveLength(1);
    expect(store.getAttemptsForAction(blocked[0]!.actionId)).toHaveLength(0);

    // Feedback is in the NEXT brain request, not the first, and exactly once.
    expect(replayFeedback(brain.requests[0]!)).toHaveLength(0);
    const feedback = replayFeedback(brain.requests[1]!);
    expect(feedback).toHaveLength(1);
    const obs = feedback[0]!;
    expect(obs.isMandatory).toBe(true);
    expect(obs.content).toMatchObject({
      feedbackKind: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
      blockCode: REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT,
      toolName: "write_file",
      priorActionId: prior.actionId,
      priorAttemptId: prior.attemptId,
      priorAttemptStatus: "UNKNOWN",
      priorReasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
    });
    expect(JSON.stringify(obs.content)).toContain("will not be dispatched");

    // No input payload or content leaks into the replay observation.
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain(SECRET_CONTENT);
    expect(serialized).not.toContain(BLOCKED_PATH);
    expect(provider.invocations).toHaveLength(0);
  });

  it("T2: a materially different proposal after the block is dispatched and the run completes", async () => {
    const run = await setupRun();
    seedUnknownPrior(run, blockedPayload);

    brain
      .queue(propose("p-blocked", "write_file", blockedPayload))
      .queue(propose("p-different", "write_file", { path: "other.txt", content: "different", overwrite: true }))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controllerFor(workerRuntime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(brain.requests).toHaveLength(3);
    const different = store
      .getActionsForRun(run.runId)
      .find((a) => (a.inputPayload as { path?: string }).path === "other.txt");
    expect(different?.status).toBe("SUCCEEDED");
    expect(store.getAttemptsForAction(different!.actionId)).toHaveLength(1);
    expect(fs.existsSync(path.join(run.workspace.hostPath, "other.txt"))).toBe(true);
    expect(fs.existsSync(path.join(run.workspace.hostPath, BLOCKED_PATH))).toBe(false);
    // The feedback is not re-queued for the third request.
    expect(replayFeedback(brain.requests[2]!)).toHaveLength(0);
  });

  it("T3: a second replay block in the same run ends with POLICY_DENIED and no further brain call", async () => {
    const run = await setupRun();
    seedUnknownPrior(run, blockedPayload);

    brain
      .queue(propose("p-blocked-1", "write_file", blockedPayload))
      .queue(propose("p-blocked-2", "write_file", blockedPayload))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controllerFor(workerRuntime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("POLICY_DENIED");
    expect(result.terminalMessage).toContain("blocked by an uncertain prior execution");
    expect(brain.requests).toHaveLength(2);
    const blocked = replayBlockedActions(run.runId);
    expect(blocked).toHaveLength(2);
    for (const a of blocked) {
      expect(store.getAttemptsForAction(a.actionId)).toHaveLength(0);
    }
    // Terminated by the replay rule, not the ordinary failure budget.
    expect(result.totalConsecutiveFailures).toBe(0);
    expect(fs.existsSync(path.join(run.workspace.hostPath, BLOCKED_PATH))).toBe(false);
  });

  it("T4a: an ordinary FAILED action does not touch the replay counter", async () => {
    const run = await setupRun();

    brain
      .queue(propose("p-missing", "read_file", { path: "missing-a.txt" }))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controllerFor(workerRuntime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalConsecutiveFailures).toBe(1);
    expect(replayBlockedActions(run.runId)).toHaveLength(0);
    for (const req of brain.requests) {
      expect(replayFeedback(req)).toHaveLength(0);
    }
  });

  it("T4b: the ordinary failure budget still terminates after 3 consecutive failures", async () => {
    const run = await setupRun();

    brain
      .queue(propose("p1", "read_file", { path: "missing-a.txt" }))
      .queue(propose("p2", "read_file", { path: "missing-b.txt" }))
      .queue(propose("p3", "read_file", { path: "missing-c.txt" }))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controllerFor(workerRuntime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("MAX_FAILURES");
    expect(result.totalConsecutiveFailures).toBe(3);
    expect(brain.requests).toHaveLength(3);
  });

  /** Wraps the real runtime and overrides executeAction's result, keeping everything else real. */
  function withExecuteResult(
    override: (params: ExecuteActionParams) => WorkerActionResult
  ): Pick<WorkerRuntime, "executeAction"> {
    return new Proxy(workerRuntime, {
      get(target, prop) {
        if (prop === "executeAction") {
          return async (params: ExecuteActionParams) => override(params);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("T5: an UNKNOWN execution outcome still stops immediately with UNKNOWN_EXECUTION", async () => {
    const run = await setupRun();
    brain
      .queue(propose("p-unknown", "write_file", { path: "u.txt", content: "x", overwrite: true }))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const runtime = withExecuteResult((params) => ({
      status: "UNKNOWN",
      actionId: params.actionId ?? "a",
      runId: params.runId,
      error: { code: "EXECUTION_UNCERTAIN" },
    }));
    const result = await controllerFor(runtime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("UNKNOWN_EXECUTION");
    expect(brain.requests).toHaveLength(1);
  });

  it("T6: a fenced result still ends with LEASE_LOST and no further execution", async () => {
    const run = await setupRun();
    brain
      .queue(propose("p-fenced", "write_file", { path: "f.txt", content: "x", overwrite: true }))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const runtime = withExecuteResult((params) => ({
      status: "FENCED",
      actionId: params.actionId ?? "a",
      runId: params.runId,
      error: new LeaseLostError(params.runId, "held", "other"),
    }));
    const result = await controllerFor(runtime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
    expect(brain.requests).toHaveLength(1);
  });

  it("T7: only actual replay-block results are counted (a similar failed result is not)", async () => {
    const run = await setupRun();
    // The runtime returns FAILED with a different code twice: the replay rule must not fire.
    brain
      .queue(propose("p1", "write_file", { path: "s1.txt", content: "x", overwrite: true }))
      .queue(propose("p2", "write_file", { path: "s2.txt", content: "x", overwrite: true }))
      .queue(() => ({ finishReason: "GOAL_REACHED" }));

    const runtime = withExecuteResult((params) => ({
      status: "FAILED",
      actionId: params.actionId ?? "a",
      runId: params.runId,
      error: { code: "TOOL_EXECUTION_FAILED", message: "REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT mentioned in text" },
    }));
    const result = await controllerFor(runtime).runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).not.toBe("POLICY_DENIED");
    for (const req of brain.requests) {
      expect(replayFeedback(req)).toHaveLength(0);
    }
  });
});
