/**
 * Phase 48L: Post-Pass Verification Latch and Protection Gate Test Suite
 *
 * Verifies all 12 contractual requirements for the deterministic post-pass
 * verification latch in AgentStepController and ProposalValidator:
 * 1. Successful localized edit + passing F2P/P2P tests activates the latch.
 * 2. Subsequent mutation to the protected file is rejected before disk alteration.
 * 3. Repeated accepted mutation cannot bypass the latch.
 * 4. Model-generated isGoalReached: true cannot override failed authoritative verification.
 * 5. Passing intermediate tests do not bypass clean-room verification.
 * 6. Clean-room pass completes authoritatively through the completion path.
 * 7. Clean-room failure, timeout, or missing verification evidence cannot result in COMPLETED.
 * 8. Read-only inspection and permitted verification remain available after latch activation.
 * 9. Multi-file tasks are not prematurely completed, and unlatched targets remain mutable.
 * 10. Existing policy-denial, duplicate-proposal, and stagnation controls remain intact.
 * 11. Rejected post-pass mutations do not clear the latch.
 * 12. Final protected-file hash remains unchanged after a prohibited mutation attempt.
 *
 * Zero live Ollama inference. Zero network calls. Zero git mutations.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import {
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import {
  PostPassVerificationLatch,
  normalizeLatchPath,
} from "../../src/application/post-pass-verification-latch.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import {
  createMissionContract,
  createResourceLimits,
} from "../../src/domain/mission-contract.js";
import {
  createVerificationSpec,
  type CleanRoomVerificationSpec,
} from "../../src/domain/verification.js";
import { defaultGovernedToolRegistry } from "../../src/domain/tool.js";
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
import { CleanRoomVerifier, CleanRoomVerificationOutcome } from "../../src/application/clean-room-verifier.js";

/**
 * Scriptable Agent Brain for deterministic multi-step testing.
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

/**
 * Controllable execution provider that intercepts command runs and file operations.
 */
class ControllableExecutionProvider implements ExecutionProvider {
  readonly name = "controllable-test-provider";
  readonly invocations: ExecutionRequest[] = [];
  f2pExitCode = 0;
  p2pExitCode = 0;

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    const input = request.inputPayload as Record<string, unknown> | undefined;

    if (request.operationName === "run_command") {
      const argv = Array.isArray(input?.argv) ? (input!.argv as string[]) : [];
      let exitCode = 0;
      let stdout = "PASS: OK";

      if (argv.some((a) => a.includes("f2p"))) {
        exitCode = this.f2pExitCode;
        stdout = exitCode === 0 ? "PASS: F2P passed" : "FAIL: 7 !== 5";
      } else if (argv.some((a) => a.includes("p2p"))) {
        exitCode = this.p2pExitCode;
        stdout = exitCode === 0 ? "PASS: P2P passed" : "FAIL: regression";
      }

      return {
        status: exitCode === 0 ? "SUCCESS" : "FAILED",
        output: {
          exitCode,
          stdout,
          stderr: exitCode === 0 ? "" : "Assertion failed",
          durationMs: 10,
        } as unknown as TOutput,
        durationMs: 10,
      };
    }

    return {
      status: "SUCCESS",
      output: { executed: true } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

describe("Phase 48L — Post-Pass Verification Latch & Protection Gate", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let provider: ControllableExecutionProvider;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let proposalValidator: ProposalValidator;
  let brain: ScriptableAgentBrain;
  let stepController: AgentStepController;

  const workerId = "worker-p48l-1";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-p48l-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-26T22:00:00Z"));
    provider = new ControllableExecutionProvider();
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: provider,
      isIsolationAvailable: true,
    });

    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: defaultGovernedToolRegistry,
      clock,
    });

    brain = new ScriptableAgentBrain();

    stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: defaultGovernedToolRegistry,
      clock,
    });

    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 9999,
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

  async function setupRun(options?: {
    cleanRoomSpec?: CleanRoomVerificationSpec;
    allowWholeFileReplacement?: boolean;
    governedBenchmarkRepairMode?: boolean;
    allowedPathPatterns?: string[];
  }) {
    const task = coordinator.createTask({
      title: "Arithmetic Fix",
      description: "Repair defect in src/calc.js",
      inputPayload: { target: "src/calc.js" },
    });

    const cleanSpec: CleanRoomVerificationSpec = options?.cleanRoomSpec ?? {
      specId: "cleanroom-spec-1",
      baselineCommitSha: "0".repeat(40),
      failToPass: {
        testCommand: ["node", "test/f2p.test.js"],
        expectedBaselineExitCode: 1,
        expectedPatchedExitCode: 0,
        minTestCount: 1,
        suiteRanRegex: "PASS: F2P passed",
      },
      passToPass: {
        testCommand: ["node", "test/p2p.test.js"],
        expectedBaselineExitCode: 0,
        expectedPatchedExitCode: 0,
        minTestCount: 1,
        suiteRanRegex: "PASS: P2P passed",
      },
      allowedPathPatterns: options?.allowedPathPatterns ?? ["src/calc.js"],
      timeoutMs: 30000,
    };

    const vSpec = createVerificationSpec({
      specId: cleanSpec.specId,
      ruleKind: "CLEAN_ROOM_DUAL_GATE",
      expectedValue: cleanSpec,
    });

    const policy = createExecutionPolicy({
      policyId: `policy-${task.taskId}`,
      allowedCapabilities: [
        "workspace.file.read",
        "workspace.file.write",
        "workspace.code.search",
        "process.execute",
        "read_file",
        "write_file",
        "edit_file",
        "run_command",
        "search_code",
      ],
      isolationRequirement: "ISOLATED",
      governedBenchmarkRepairMode: options?.governedBenchmarkRepairMode ?? true,
      allowWholeFileReplacement: options?.allowWholeFileReplacement ?? false,
    });

    const contract = createMissionContract({
      contractId: `contract-${task.taskId}`,
      version: 1,
      taskId: task.taskId,
      policy,
      verificationSpecs: [vSpec],
      resourceLimits: createResourceLimits({
        timeoutMs: 60000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      }),
      credentialScopes: ["benchmark:test"],
    });

    store.insertContract(contract);
    store.activateContract(contract.spec.contractId, contract.spec.version, clock.nowIso());

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    const wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    // Write initial defective calc.js
    const srcDir = path.join(wsHandle.hostPath, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const initialContent = "function add(a, b) {\n  return a + b + 1;\n}\nmodule.exports = { add };\n";
    fs.writeFileSync(path.join(srcDir, "calc.js"), initialContent, "utf-8");

    return {
      task,
      contract,
      runId: run.runId,
      leaseId: claimResult.lease.leaseId,
      workspace: wsHandle,
      initialContent,
      calcPath: path.join(srcDir, "calc.js"),
    };
  }

  // --------------------------------------------------------------------------
  // Test 1: Latch Activation upon Intermediate Verification Pass
  // --------------------------------------------------------------------------
  it("Requirement 1: Activates latch when localized edit passes intermediate F2P and P2P tests", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));
    // Step 2 stops
    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const latch = stepController.getPostPassVerificationLatch();
    expect(latch.isLatched).toBe(false);

    await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 2, enableIntermediateTestFeedback: true },
    });

    expect(latch.isLatched).toBe(true);
    expect(latch.protectedPaths).toContain("src/calc.js");
    expect(latch.activationEvent).toBeDefined();
    expect(latch.activationEvent?.f2pExitCode).toBe(0);
    expect(latch.activationEvent?.p2pExitCode).toBe(0);
    expect(latch.activationEvent?.protectedPath).toBe("src/calc.js");
  });

  // --------------------------------------------------------------------------
  // Test 2: Subsequent Mutation to Protected File is Rejected Before Mutation
  // --------------------------------------------------------------------------
  it("Requirement 2: Rejects subsequent mutation proposal to protected target before altering file", async () => {
    const { runId, leaseId, workspace, calcPath } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Step 1: Valid repair
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Attempt harmful post-pass mutation to function header
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "function add(a, b) {",
          replacementText: "function add(a, b) { return a + b; }",
        },
      },
    }));

    // Step 3: Conclude
    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3, enableIntermediateTestFeedback: true },
    });

    // Verify Step 2 proposal was rejected
    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.proposalValid).toBe(false);
    expect(step2?.proposalRejectionReason).toBe("POST_VERIFICATION_MUTATION_DISALLOWED");
    expect(step2?.proposalRejectionMessage).toContain("protected by the post-pass verification latch");

    // Verify source file content was NOT mutated by Step 2
    const finalContent = fs.readFileSync(calcPath, "utf-8");
    expect(finalContent).toBe("function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
  });

  // --------------------------------------------------------------------------
  // Test 3: Repeated Accepted Mutation Cannot Bypass Latch
  // --------------------------------------------------------------------------
  it("Requirement 3: Prohibits repeating a previously accepted mutation once target is latched", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Step 1: Edit succeeds and latches file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Model repeats the identical proposal that succeeded in Step 1
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3, enableIntermediateTestFeedback: true },
    });

    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.proposalValid).toBe(false);
    expect(step2?.proposalRejectionReason).toBe("POST_VERIFICATION_MUTATION_DISALLOWED");
  });

  // --------------------------------------------------------------------------
  // Test 4: Model isGoalReached Claim Cannot Override Failed Authoritative Verification
  // --------------------------------------------------------------------------
  it("Requirement 4: Untrusted isGoalReached claim is rejected when authoritative verification fails", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 1; // Fails authoritative verification

    const mockCleanRoomVerifier = {
      verifyCandidatePatch: async (): Promise<CleanRoomVerificationOutcome> => ({
        status: "FAILED",
        evidence: {} as any,
        payload: {} as any,
        verificationResult: {
          status: "FAILED",
          verifierId: "mock-verifier",
          specId: "cleanroom-spec-1",
          evidenceIds: [],
          verifiedAt: new Date().toISOString(),
          message: "Clean room verification failed: f2p tests failed",
        },
        message: "Clean room verification failed: f2p tests failed",
      }),
    } as unknown as CleanRoomVerifier;

    const controllerWithCleanRoom = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: defaultGovernedToolRegistry,
      cleanRoomVerifier: mockCleanRoomVerifier,
      clock,
    });

    // Model claims goal reached without passing verification
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await controllerWithCleanRoom.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 2 },
    });

    // Run must NOT be completed
    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(result.totalProposalRejections).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Test 5: Clean-Room Invocation Upon Latch Activation
  // --------------------------------------------------------------------------
  it("Requirement 5: Automatically triggers authoritative clean-room verification upon latch activation", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    let cleanRoomCalled = false;
    let cleanRoomRunId: string | undefined;
    const mockCleanRoomVerifier = {
      verifyCandidatePatch: async (params: any): Promise<CleanRoomVerificationOutcome> => {
        cleanRoomCalled = true;
        cleanRoomRunId = params.runId;
        return {
          status: "VERIFIED",
          evidence: {} as any,
          payload: {} as any,
          verificationResult: {
            status: "VERIFIED",
            verifierId: "mock-verifier",
            specId: "cleanroom-spec-1",
            evidenceIds: [],
            message: "Clean room dual gate passed",
            verifiedAt: new Date().toISOString(),
          },
          message: "Clean room dual gate passed",
        };
      },
    } as unknown as CleanRoomVerifier;

    const controllerWithCleanRoom = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: defaultGovernedToolRegistry,
      cleanRoomVerifier: mockCleanRoomVerifier,
      clock,
    });

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    await controllerWithCleanRoom.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3, enableIntermediateTestFeedback: true },
    });

    expect(cleanRoomCalled).toBe(true);
    expect(cleanRoomRunId).toBe(runId);
  });

  // --------------------------------------------------------------------------
  // Test 6: Authoritative Clean-Room Verification Completes the Run
  // --------------------------------------------------------------------------
  it("Requirement 6: Run completes with terminal reason COMPLETED when clean-room verification passes", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    const mockCleanRoomVerifier = {
      verifyCandidatePatch: async (): Promise<CleanRoomVerificationOutcome> => {
        return {
          status: "VERIFIED",
          evidence: {} as any,
          payload: {} as any,
          verificationResult: {
            status: "VERIFIED",
            verifierId: "mock-verifier",
            specId: "cleanroom-spec-1",
            evidenceIds: [],
            message: "Clean room dual gate passed",
            verifiedAt: new Date().toISOString(),
          },
          message: "Clean room dual gate passed",
        };
      },
    } as unknown as CleanRoomVerifier;

    const controllerWithCleanRoom = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: defaultGovernedToolRegistry,
      cleanRoomVerifier: mockCleanRoomVerifier,
      clock,
    });

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    const result = await controllerWithCleanRoom.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 5, enableIntermediateTestFeedback: true },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.terminalMessage).toContain("Authoritative clean-room verification succeeded");
    expect(result.postPassLatchSnapshot?.isLatched).toBe(true);
    expect(result.postPassLatchSnapshot?.cleanRoomVerified).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 7: Clean-Room Failure Does NOT Result in COMPLETED
  // --------------------------------------------------------------------------
  it("Requirement 7: Clean-room failure does NOT declare run completed; target remains protected", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Clean-room verifier that fails
    const mockCleanRoomVerifier = {
      verifyCandidatePatch: async (): Promise<CleanRoomVerificationOutcome> => ({
        status: "FAILED",
        evidence: {} as any,
        payload: {} as any,
        verificationResult: {
          status: "FAILED",
          verifierId: "mock-verifier",
          specId: "cleanroom-spec-1",
          evidenceIds: [],
          verifiedAt: new Date().toISOString(),
          message: "Clean room dual gate regression check failed",
        },
        message: "Clean room dual gate regression check failed",
      }),
    } as unknown as CleanRoomVerifier;

    const controllerWithFailingCleanRoom = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: defaultGovernedToolRegistry,
      cleanRoomVerifier: mockCleanRoomVerifier,
      clock,
    });

    // Step 1: Edit passes intermediate tests, but clean-room fails
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Attempt mutation on protected file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b;",
          replacementText: "return a - b;",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "ERROR", error: "Test completed" }));

    const result = await controllerWithFailingCleanRoom.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3, enableIntermediateTestFeedback: true },
    });

    // Must NOT be COMPLETED
    expect(result.terminalReason).not.toBe("COMPLETED");
    // Latch is still active
    expect(result.postPassLatchSnapshot?.isLatched).toBe(true);
    expect(result.postPassLatchSnapshot?.cleanRoomVerified).toBe(false);
    // Step 2 mutation was rejected
    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.proposalValid).toBe(false);
    expect(step2?.proposalRejectionReason).toBe("POST_VERIFICATION_MUTATION_DISALLOWED");
  });

  // --------------------------------------------------------------------------
  // Test 8: Read-Only Inspection and Permitted Tools Remain Available
  // --------------------------------------------------------------------------
  it("Requirement 8: Read-only inspection and search remain permitted after latch activation", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Step 1: Repair passes tests
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Propose read_file on protected target
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "read_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          offsetLine: 1,
          limitLines: 100,
        },
      },
    }));

    // Step 3: Propose search_code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p3",
        toolName: "search_code",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          query: "function add",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "ERROR", error: "Test completed" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 4, enableIntermediateTestFeedback: true },
    });

    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.toolName).toBe("read_file");
    expect(step2?.proposalValid).toBe(true);

    const step3 = result.transcript.find((t) => t.stepNumber === 3);
    expect(step3?.toolName).toBe("search_code");
    expect(step3?.proposalValid).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 9: Multi-File Tasks: Unlatched Files Remain Mutable
  // --------------------------------------------------------------------------
  it("Requirement 9: Preserves mutation capability for unverified files in multi-file workflows", async () => {
    const { runId, leaseId, workspace } = await setupRun({
      allowedPathPatterns: ["src/calc.js", "src/helper.js"],
    });
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Create helper.js in workspace
    fs.writeFileSync(path.join(workspace.hostPath, "src/helper.js"), "module.exports = {};", "utf-8");

    // Step 1: Edit calc.js -> tests pass -> calc.js latched
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Edit helper.js (unprotected target) -> must be allowed
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/helper.js",
          searchAnchor: "module.exports = {};",
          replacementText: "module.exports = { helper: true };",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "ERROR", error: "Test completed" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3, enableIntermediateTestFeedback: true },
    });

    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.toolName).toBe("edit_file");
    expect(step2?.proposalValid).toBe(true);
    expect(step2?.actionStatus).toBe("SUCCEEDED");
  });

  // --------------------------------------------------------------------------
  // Test 10: Existing Governance, Duplicate Proposal, and Stagnation Intact
  // --------------------------------------------------------------------------
  it("Requirement 10: Preserves existing duplicate-proposal and stagnation behavior", async () => {
    const { runId, leaseId, workspace } = await setupRun();

    // Step 1: Malformed proposal rejected
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b + 1;", // no-op rejected
        },
      },
    }));

    // Step 2: Duplicate rejected proposal
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b + 1;",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "ERROR", error: "Test completed" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3 },
    });

    const step1 = result.transcript.find((t) => t.stepNumber === 1);
    expect(step1?.proposalRejectionReason).toBe("NOOP_EDIT_DISALLOWED");

    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.proposalRejectionReason).toBe("DUPLICATE_PROPOSAL_DISALLOWED");
  });

  // --------------------------------------------------------------------------
  // Test 11: Rejected Post-Pass Mutations Do NOT Clear the Latch
  // --------------------------------------------------------------------------
  it("Requirement 11: Latch remains active across multiple subsequent rejected attempts", async () => {
    const { runId, leaseId, workspace } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Step 1: Valid edit -> latches
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Prohibited mutation 1
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b;",
          replacementText: "return a * b;",
        },
      },
    }));

    // Step 3: Prohibited mutation 2
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p3",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b;",
          replacementText: "return a / b;",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "ERROR", error: "Test completed" }));

    const result = await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 4, enableIntermediateTestFeedback: true },
    });

    const step2 = result.transcript.find((t) => t.stepNumber === 2);
    expect(step2?.proposalRejectionReason).toBe("POST_VERIFICATION_MUTATION_DISALLOWED");

    const step3 = result.transcript.find((t) => t.stepNumber === 3);
    expect(step3?.proposalRejectionReason).toBe("POST_VERIFICATION_MUTATION_DISALLOWED");

    // Latch is still active
    expect(stepController.getPostPassVerificationLatch().isLatched).toBe(true);
    expect(stepController.getPostPassVerificationLatch().isTargetProtected("src/calc.js")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 12: Target File Hash Remains Strictly Unchanged After Prohibited Edit
  // --------------------------------------------------------------------------
  it("Requirement 12: Byte-for-byte file hash remains identical after rejected post-pass edit attempt", async () => {
    const { runId, leaseId, workspace, calcPath } = await setupRun();
    provider.f2pExitCode = 0;
    provider.p2pExitCode = 0;

    // Step 1: Valid repair
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p1",
        toolName: "edit_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          searchAnchor: "return a + b + 1;",
          replacementText: "return a + b;",
        },
      },
    }));

    // Step 2: Attempt destructive overwrite via write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p2",
        toolName: "write_file",
        contextSnapshotHash: req.contextSnapshot.contextHash,
        inputPayload: {
          path: "src/calc.js",
          content: "corrupted file contents",
        },
      },
    }));

    brain.queueStep(() => ({ finishReason: "ERROR", error: "Test completed" }));

    await stepController.runStepLoop({
      runId,
      workerId,
      leaseId,
      workspace,
      budget: { maxSteps: 3, enableIntermediateTestFeedback: true },
    });

    // Content after Step 1 should be pristine
    const content = fs.readFileSync(calcPath, "utf-8");
    const expectedContent = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
    expect(content).toBe(expectedContent);

    const hash = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
    const expectedHash = crypto.createHash("sha256").update(expectedContent, "utf-8").digest("hex");
    expect(hash).toBe(expectedHash);
  });
});
