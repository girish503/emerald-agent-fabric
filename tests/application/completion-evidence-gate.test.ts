/**
 * Milestone 2.23 — Fail-Closed Completion Evidence Gate.
 *
 * Invariant under test: MODEL_GOAL_REACHED != RUN_COMPLETED.
 * The model may propose completion; only the runtime authorizes it, and only when every required
 * Mission Contract verification requirement has authoritative evidence. An empty verification set is
 * not proof of success.
 *
 * Section 1 exercises AgentStepController through the real step loop.
 * Section 2 exercises the worker-host mapping (emerald worker -> GovernedAgentExecutionProvider ->
 * WorkerRuntime -> durable lifecycle events) so the result cannot be translated into a successful run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController, DEFAULT_STEP_CONTROLLER_BUDGET } from "../../src/application/agent-step-controller.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import type { CleanRoomVerificationOutcome, CleanRoomVerifier } from "../../src/application/clean-room-verifier.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { createVerificationSpec, VerificationResult } from "../../src/domain/verification.js";
import { MissionContract } from "../../src/domain/mission-contract.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { AgentBrainPort, AgentBrainRequest, AgentBrainResult } from "../../src/ports/agent-brain.port.js";
import { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../../src/ports/execution-provider.port.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { createAndActivateContract } from "./test-helpers.js";

// ----------------------------------------------------------------------------
// Test doubles
// ----------------------------------------------------------------------------

/** Declares tenantModel NONE so WorkerRuntime accepts it; every command exits 0. */
class PassingCommandProvider implements ExecutionProvider {
  readonly name = "passing-command-provider";
  readonly tenantModel = "NONE" as const;
  async execute<TInput = unknown, TOutput = unknown>(_request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>> {
    return {
      status: "SUCCESS",
      output: { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, outputTruncated: false, commandHash: "h" } as unknown as TOutput,
      durationMs: 1,
    };
  }
}

class ScriptedBrain implements AgentBrainPort {
  private steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];
  queue(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }
  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const next = this.steps.shift();
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

const claimGoal = (): AgentBrainResult => ({ finishReason: "GOAL_REACHED" });

const cleanRoomSpecValue = {
  specId: "cr-1",
  baselineCommitSha: "a".repeat(40),
  failToPass: { testCommand: ["node", "f2p.js"], expectedBaselineExitCode: 1, expectedPatchedExitCode: 0, minTestCount: 1, suiteRanRegex: "ran" },
  passToPass: { testCommand: ["node", "p2p.js"], expectedBaselineExitCode: 0, expectedPatchedExitCode: 0, minTestCount: 1, suiteRanRegex: "ran" },
  allowedPathPatterns: ["src/**"],
  timeoutMs: 1000,
};

function verificationResult(status: "VERIFIED" | "FAILED"): VerificationResult {
  return Object.freeze({
    status,
    verifierId: "clean-room-verifier-test",
    specId: "cr-1",
    evidenceIds: [],
    ...(status === "FAILED" ? { reasonCode: "TARGET_TEST_FAILED" as const } : {}),
    message: status === "VERIFIED" ? "clean-room ok" : "clean-room failed",
    verifiedAt: "2026-11-05T00:00:00.000Z",
  });
}

function fakeCleanRoom(behavior: "VERIFIED" | "FAILED" | "THROWS") {
  const calls: unknown[] = [];
  const verifier = {
    async verifyCandidatePatch(params: unknown): Promise<CleanRoomVerificationOutcome> {
      calls.push(params);
      if (behavior === "THROWS") throw new Error("clean-room infrastructure timeout");
      return {
        status: behavior,
        evidence: { evidenceId: "ev-1" } as never,
        payload: {} as never,
        verificationResult: verificationResult(behavior),
        message: behavior === "VERIFIED" ? "clean-room ok" : "clean-room failed",
        ...(behavior === "FAILED" ? { failureReasonCode: "TARGET_TEST_FAILED" as const } : {}),
      };
    },
  } as unknown as CleanRoomVerifier;
  return { verifier, calls };
}

// ----------------------------------------------------------------------------
// Section 1 — AgentStepController completion authorization
// ----------------------------------------------------------------------------

describe("Milestone 2.23 — completion evidence gate (AgentStepController)", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let brain: ScriptedBrain;
  const workerId = "worker-gate-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-gate-"));
    store = new SqliteStateStore({ location: path.join(tempDir, "state.db") });
    clock = new SettableClock("2026-11-05T12:00:00.000Z");
    coordinator = new RunCoordinator(store, clock);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    store.transaction((tx) =>
      tx.insertWorker({ workerId, hostname: "localhost", pid: 4321, status: "ACTIVE", createdAt: clock.nowIso(), lastHeartbeatAt: clock.nowIso() })
    );
    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: new PassingCommandProvider(),
    });
    brain = new ScriptedBrain();
  });

  afterEach(() => {
    try {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  type SpecInput = ReturnType<typeof createVerificationSpec>[];

  function setupRun(taskId: string, verificationSpecs?: SpecInput) {
    coordinator.createTask({ taskId, title: taskId, inputPayload: {} });
    const contract: MissionContract = createAndActivateContract(store, taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write", "workspace.code.search", "process.execute"],
        isolationRequirement: "IN_PROCESS",
      }),
      ...(verificationSpecs !== undefined ? { verificationSpecs } : {}),
    });
    const { run } = coordinator.createRun({ taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 600_000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
    return { run, leaseId: claim.lease.leaseId, contract };
  }

  const controller = (extra: Record<string, unknown> = {}) =>
    new AgentStepController({ coordinator, stateStore: store, workerRuntime, agentBrain: brain, clock, ...extra } as never);

  const eventTypes = (runId: string) => store.getEventsForRun(runId).map((e) => e.eventType);
  const rejectedPayloads = (runId: string) =>
    store.getEventsForRun(runId).filter((e) => e.eventType === "verification.rejected").map((e) => e.payload as Record<string, unknown>);

  const clean = () => createVerificationSpec({ specId: "cr-1", ruleKind: "CLEAN_ROOM_DUAL_GATE", expectedValue: cleanRoomSpecValue });
  const exitZero = () =>
    createVerificationSpec({
      specId: "exit-0",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: { toolName: "run_command", argv: ["node", "verify.js"], requireMutation: true },
    });

  it("1. a completion claim with no verification specifications is rejected as COMPLETION_UNVERIFIABLE", async () => {
    const { run, leaseId } = setupRun("t-nospecs");
    brain.queue(claimGoal);
    const result = await controller().runStepLoop({ runId: run.runId, workerId, leaseId, budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 } });

    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(result.terminalMessage).toContain("NO_VERIFICATION_SPECS");
    // Terminal on the first claim: the model is not asked again to satisfy a requirement it cannot meet.
    expect(result.totalSteps).toBe(1);
    const rejected = rejectedPayloads(run.runId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: "COMPLETION_UNVERIFIABLE", reason: "NO_VERIFICATION_SPECS" });
    expect(eventTypes(run.runId)).not.toContain("run.completed");
    expect(store.getRun(run.runId)?.status).not.toBe("COMPLETED");
  });

  it("2. an explicitly empty verification list is rejected the same way", async () => {
    const { run, leaseId } = setupRun("t-emptyspecs", []);
    brain.queue(claimGoal);
    const result = await controller().runStepLoop({ runId: run.runId, workerId, leaseId });
    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(rejectedPayloads(run.runId)[0]).toMatchObject({ reason: "NO_VERIFICATION_SPECS" });
    expect(eventTypes(run.runId)).not.toContain("run.completed");
  });

  it("3. the explicit operator opt-in authorizes an empty contract and is audited durably", async () => {
    const { run, leaseId } = setupRun("t-optin");
    brain.queue(claimGoal);
    const result = await controller({ allowUnverifiedCompletion: true }).runStepLoop({ runId: run.runId, workerId, leaseId });
    expect(result.terminalReason).toBe("COMPLETED");
    const audit = store.getEventsForRun(run.runId).filter((e) => e.eventType === "verification.unverified_completion_authorized");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ reason: "OPERATOR_OPT_IN_NO_VERIFICATION_SPECS" });
  });

  it("4. a clean-room requirement with no verifier is unverifiable", async () => {
    const { run, leaseId } = setupRun("t-nocleanroom", [clean()]);
    brain.queue(claimGoal);
    const result = await controller().runStepLoop({ runId: run.runId, workerId, leaseId, workspace: {} as never });
    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(rejectedPayloads(run.runId)[0]).toMatchObject({ reason: "CLEAN_ROOM_VERIFIER_UNAVAILABLE" });
    expect(eventTypes(run.runId)).not.toContain("run.completed");
  });

  it("5. a clean-room requirement with no workspace is unverifiable and never invokes the verifier", async () => {
    const { verifier, calls } = fakeCleanRoom("VERIFIED");
    const { run, leaseId } = setupRun("t-nows", [clean()]);
    brain.queue(claimGoal);
    const result = await controller({ cleanRoomVerifier: verifier }).runStepLoop({ runId: run.runId, workerId, leaseId });
    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(rejectedPayloads(run.runId)[0]).toMatchObject({ reason: "CLEAN_ROOM_WORKSPACE_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  });

  it("6. a failing clean-room verification rejects completion (recoverable) and records a structured reason", async () => {
    const { verifier, calls } = fakeCleanRoom("FAILED");
    const { run, leaseId } = setupRun("t-crfail", [clean()]);
    brain.queue(claimGoal).queue(claimGoal);
    const result = await controller({ cleanRoomVerifier: verifier }).runStepLoop({
      runId: run.runId, workerId, leaseId, workspace: {} as never, budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });
    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(rejectedPayloads(run.runId)[0]).toMatchObject({ status: "COMPLETION_REJECTED", rejectionCode: "CLEAN_ROOM_NOT_VERIFIED" });
    expect(eventTypes(run.runId)).not.toContain("run.completed");
  });

  it("7. a clean-room verifier that throws (timeout or infrastructure failure) never authorizes completion", async () => {
    const { verifier } = fakeCleanRoom("THROWS");
    const { run, leaseId } = setupRun("t-crthrow", [clean()]);
    brain.queue(claimGoal).queue(claimGoal);
    const result = await controller({ cleanRoomVerifier: verifier }).runStepLoop({
      runId: run.runId, workerId, leaseId, workspace: {} as never, budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });
    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(rejectedPayloads(run.runId)[0]).toMatchObject({ rejectionCode: "CLEAN_ROOM_NOT_VERIFIED" });
    // The raw error message is not persisted.
    expect(JSON.stringify(rejectedPayloads(run.runId))).not.toContain("infrastructure timeout");
  });

  it("8. a VERIFIED independent clean-room outcome satisfies the requirement", async () => {
    const { verifier, calls } = fakeCleanRoom("VERIFIED");
    const { run, leaseId } = setupRun("t-crok", [clean()]);
    brain.queue(claimGoal);
    const result = await controller({ cleanRoomVerifier: verifier }).runStepLoop({ runId: run.runId, workerId, leaseId, workspace: {} as never });
    expect(result.terminalReason).toBe("COMPLETED");
    expect(calls).toHaveLength(1);
  });

  it("9. one passing and one failing requirement never authorizes completion", async () => {
    // exit-0 evidence is missing, clean-room would pass: the clean-room verifier must not even be consulted.
    const { verifier, calls } = fakeCleanRoom("VERIFIED");
    const { run, leaseId } = setupRun("t-mixed", [exitZero(), clean()]);
    brain.queue(claimGoal).queue(claimGoal);
    const result = await controller({ cleanRoomVerifier: verifier }).runStepLoop({
      runId: run.runId, workerId, leaseId, workspace: {} as never, budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });
    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(calls).toHaveLength(0);
    expect(eventTypes(run.runId)).not.toContain("run.completed");
  });

  it("10. missing required evidence is a recoverable rejection with a MISSING_EVIDENCE code", async () => {
    const { run, leaseId } = setupRun("t-missing", [exitZero()]);
    brain.queue(claimGoal).queue(claimGoal);
    const result = await controller().runStepLoop({
      runId: run.runId, workerId, leaseId, budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });
    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(result.terminalReason).not.toBe("COMPLETION_UNVERIFIABLE"); // still satisfiable by the model
    expect(rejectedPayloads(run.runId)[0]).toMatchObject({ status: "COMPLETION_REJECTED", rejectionCode: "MISSING_EVIDENCE" });
  });

  it("11. an unsupported verification rule is unverifiable (typed evaluation, fail closed)", () => {
    const { run, contract } = setupRun("t-unsupported", [exitZero()]);
    const forged = {
      ...contract,
      spec: { ...contract.spec, verificationSpecs: [{ specId: "x", ruleKind: "TOTALLY_NEW_RULE" }] },
    } as unknown as MissionContract;
    const evaluation = (controller() as unknown as {
      evaluateCompletionVerification: (runId: string, c: MissionContract, ctx: object) => Record<string, unknown>;
    }).evaluateCompletionVerification(run.runId, forged, { cleanRoomVerifierAvailable: true, workspaceAvailable: true });
    expect(evaluation).toMatchObject({ verified: false, unverifiable: true, rejectionCode: "UNSUPPORTED_VERIFICATION_RULE" });
  });

  it("12. the evaluator never treats an empty result set as success", () => {
    const { run, contract } = setupRun("t-emptyresults", [exitZero()]);
    const evaluation = (controller() as unknown as {
      evaluateCompletionVerification: (runId: string, c: MissionContract, ctx: object) => { verified: boolean; specResults: unknown[] };
    }).evaluateCompletionVerification(run.runId, contract, { cleanRoomVerifierAvailable: false, workspaceAvailable: false });
    expect(evaluation.verified).toBe(false);
  });

  it("13. claiming completion before evidence is rejected; performing the verification then allows a later claim", async () => {
    const { run, leaseId } = setupRun("t-flow", [exitZero()]);
    brain
      .queue(claimGoal) // premature: no mutation, no verification command yet
      .queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: { proposalId: "p-write", toolName: "write_file", inputPayload: { path: "out.txt", content: "done" }, contextSnapshotHash: req.contextSnapshot.contextHash },
      }))
      .queue((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: { proposalId: "p-verify", toolName: "run_command", inputPayload: { argv: ["node", "verify.js"] }, contextSnapshotHash: req.contextSnapshot.contextHash },
      }))
      .queue(claimGoal);
    const workspace = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`, runId: run.runId, taskId: "t-flow", maxWorkspaceBytes: 10_000_000, maxFileSizeBytes: 1_000_000,
    });
    const result = await controller().runStepLoop({
      runId: run.runId, workerId, leaseId, workspace, budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 6 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    const rejected = rejectedPayloads(run.runId);
    expect(rejected.length).toBeGreaterThanOrEqual(1); // the premature claim was rejected first
    expect(rejected[0]).toMatchObject({ status: "COMPLETION_REJECTED" });
  });
});

// ----------------------------------------------------------------------------
// Section 2 — worker-host mapping (emerald worker -> durable lifecycle)
// ----------------------------------------------------------------------------

describe("Milestone 2.23 — completion gate through the worker host", () => {
  let tempDir: string;
  let dbPath: string;
  const cli = new EmeraldCli();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-gate-host-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    fs.mkdirSync(path.join(tempDir, "workspace"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const submitTask = async () => {
    const submit = await cli.run(["submit", "--db", dbPath, "--task", "Search workspace for pattern emerald"]);
    expect(submit.exitCode, submit.output).toBe(0);
    return JSON.parse(submit.output) as { runId: string };
  };

  const readRun = (runId: string) => {
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const run = store.getRun(runId)!;
      const events = store.getEventsForRun(runId);
      return { status: run.status, events, errorPayload: run.errorPayload };
    } finally {
      store.close();
    }
  };

  it("a governed run whose contract declares no verification specs ends FAILED, never COMPLETED", async () => {
    const { runId } = await submitTask();
    const worker = await cli.run(["worker", "--db", dbPath, "--once", "--workspace-root", path.join(tempDir, "workspace"), "--model-provider", "fixture"]);
    expect(worker.exitCode, worker.output).toBe(0);

    const { status, events, errorPayload } = readRun(runId);
    expect(status).toBe("FAILED");
    expect(events.map((e) => e.eventType)).not.toContain("run.completed");
    const rejected = events.filter((e) => e.eventType === "verification.rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]!.payload).toMatchObject({ status: "COMPLETION_UNVERIFIABLE", reason: "NO_VERIFICATION_SPECS" });
    expect(JSON.stringify(errorPayload)).toContain("COMPLETION_UNVERIFIABLE");
  });

  it("the explicit --allow-unverified-completion opt-in completes the run and records an audit event", async () => {
    const { runId } = await submitTask();
    const worker = await cli.run([
      "worker", "--db", dbPath, "--once", "--workspace-root", path.join(tempDir, "workspace"), "--model-provider", "fixture", "--allow-unverified-completion",
    ]);
    expect(worker.exitCode, worker.output).toBe(0);
    const { status, events } = readRun(runId);
    expect(status).toBe("COMPLETED");
    expect(events.map((e) => e.eventType)).toContain("verification.unverified_completion_authorized");
  });

  it("does not default the opt-in on: --allow-unverified-completion is rejected when repeated", async () => {
    const r = await cli.run(["worker", "--db", dbPath, "--once", "--allow-unverified-completion", "--allow-unverified-completion"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/more than once/);
  });
});
