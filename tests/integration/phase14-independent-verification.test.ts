/**
 * Phase 14 — Independent Verification and Clean-Room Proof Integration Tests.
 *
 * Verifies the hypothesis:
 *   Given an agent-produced patch and an immutable task baseline, Emerald can independently
 *   reproduce the task in a clean-room environment and establish F2P/P2P evidence without
 *   trusting the agent's mutable workspace or in-workspace verification result.
 *
 * Fourfold Completion Invariant:
 *   TaskSatisfied ∧ VerificationPassed ∧ PolicySatisfied ∧ EvidenceComplete
 *
 * Test Matrix:
 * Test 14.1  — Happy Path Clean Verification: Agent produces correct patch; clean baseline materializes, F2P=1.0, P2P=1.0, COMPLETED
 * Test 14.2  — Zero Code Mutation: Agent emits isGoalReached: true without calling write_file; verifier detects empty patch (EMPTY_PATCH)
 * Test 14.3  — Unsuccessful Bug Fix: Agent modifies code but target test still fails in clean-room (TARGET_TEST_FAILED)
 * Test 14.4  — Regression Introduced: Agent fixes bug but breaks regression test (REGRESSION_DETECTED)
 * Test 14.5  — Test File Tampering: Agent modifies test in its workspace; clean-room executes un-tampered baseline test (TARGET_TEST_FAILED)
 * Test 14.6  — Zero-Test Execution Gating: Command exits 0 without running assertions; fails closed (TEST_SUITE_NEVER_RAN)
 * Test 14.7  — Patch Conflict / Rejection: Diff cannot be applied cleanly to baseline (APPLY_PATCH_FAIL)
 * Test 14.8  — Policy Path Scope Violation: Agent touches files outside allowedPathPatterns (POLICY_PATH_VIOLATION)
 * Test 14.9  — Clean-Room Timeout: Test execution exceeds timeout budget (EXECUTION_TIMEOUT)
 * Test 14.10 — Double Clean-Room Isolation: Agent workspace files and hashes remain 100% untouched before and after verification
 * Test 14.11 — Historical Artifact Integrity: All 9 historical benchmark artifacts remain byte-for-byte identical
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
} from "../../src/application/agent-step-controller.js";
import { CleanRoomVerifier, applyUnifiedDiff } from "../../src/application/clean-room-verifier.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { RunCommandOutput } from "../../src/domain/tool-schemas.js";
import {
  CleanRoomVerificationSpec,
  createVerificationSpec,
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
import { createMockGitRepository } from "../adapters/tools/git-test-helper.js";
import { createAndActivateContract } from "../application/test-helpers.js";

// ============================================================================
// Historical Artifact Protection Hashes
// ============================================================================

const SCRATCH_DIR = path.resolve(
  "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch"
);

const HISTORICAL_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
  "phase10e-summary.json": "6D0DEB0E1685FDBF06882A90AF4A0AD27CA68DEEFE03F37CC36FEC6632A37136",
  "phase10f-tool-input-diagnostic.json": "46F0B3EE24FFFCCA06CDA3133A9199FE3096E23A063F2293FF5813D6F2424DE0",
  "phase10h-tool-contract-diagnostic.json": "6DF83F1792D1AD10649393DC86DF4451AC27BA495844B292B947FCB131BC8961",
  "phase11-smoke-evidence.json": "8F2B71B6604794952F2DFDA6777206D68A274E50CD489FA32BE61BE4294A0021",
  "phase12-smoke-evidence.json": "19A58904795D2F908565C1BF38A70F15DCDA27884AA072695FE7128986C4ED32",
});

// ============================================================================
// Fixture Constants
// ============================================================================

const DEFECTIVE_MATH_CODE = `/**
 * Math unit under test.
 */

function add(a, b) {
  // Defect: subtracts instead of adds
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const FIXED_MATH_CODE = `/**
 * Math unit under test.
 */

function add(a, b) {
  // Fixed: correct addition
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const STILL_BROKEN_MATH_CODE = `/**
 * Math unit under test.
 */

function add(a, b) {
  // Still broken: multiplies instead of adds
  return a * b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const REGRESSION_MATH_CODE = `/**
 * Math unit under test.
 */

function add(a, b) {
  // Fixed addition
  return a + b;
}

function multiply(a, b) {
  // REGRESSION: multiply broken
  return a + b;
}

module.exports = { add, multiply };
`;

const TARGET_TEST_CODE = `const assert = require("node:assert");
const { add } = require("../src/math.js");

try {
  assert.strictEqual(add(2, 3), 5, "add(2, 3) must equal 5");
  assert.strictEqual(add(-1, 1), 0, "add(-1, 1) must equal 0");
  console.log("PASS: 2 of 2 target tests passing");
  process.exit(0);
} catch (err) {
  console.error("FAIL target:", err.message);
  process.exit(1);
}
`;

const REGRESSION_TEST_CODE = `const assert = require("node:assert");
const { multiply } = require("../src/math.js");

try {
  assert.strictEqual(multiply(2, 3), 6, "multiply(2, 3) must equal 6");
  assert.strictEqual(multiply(0, 5), 0, "multiply(0, 5) must equal 0");
  assert.strictEqual(multiply(-2, 4), -8, "multiply(-2, 4) must equal -8");
  console.log("PASS: 3 of 3 regression tests passing");
  process.exit(0);
} catch (err) {
  console.error("FAIL regression:", err.message);
  process.exit(1);
}
`;

const TAMPERED_TARGET_TEST_CODE = `// Agent cheated and stripped assertions!
console.log("PASS: 2 of 2 target tests passing");
process.exit(0);
`;

// ============================================================================
// Scriptable Brain Helper
// ============================================================================

class ScriptableAgentBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private steps: ((req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>)[] = [];

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    return {
      finishReason: "GOAL_REACHED",
    };
  }
}

// ============================================================================
// Deterministic Clean-Room Execution Provider
// ============================================================================

class FastCleanRoomExecutionProvider implements ExecutionProvider {
  readonly name = "fast-clean-room-provider";
  public invocationCount = 0;
  public simulateZeroTestOutput = false;
  public simulateTimeout = false;

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;

    if (this.simulateTimeout) {
      return {
        status: "TIMED_OUT",
        error: { code: "EXECUTION_TIMEOUT", message: "Simulated execution timeout in container" },
        durationMs: 30000,
      };
    }

    const payload = request.inputPayload as { argv: string[]; cwd?: string } | undefined;
    const argv = payload?.argv ?? [];
    const hostPath = request.workspace?.hostPath;

    if (!hostPath) {
      throw new Error("Missing workspace hostPath in execution request");
    }

    // Target bug test suite execution
    if (argv[0] === "node" && (argv[1] === "test/math.target.test.js" || argv[1]?.includes("math.target"))) {
      const mathPath = path.join(hostPath, "src", "math.js");
      let mathCode = "";
      try {
        mathCode = await fs.readFile(mathPath, "utf8");
      } catch {
        mathCode = "";
      }

      const isFixed = mathCode.includes("return a + b;");

      if (isFixed) {
        if (this.simulateZeroTestOutput) {
          const out: RunCommandOutput = {
            exitCode: 0,
            stdout: "No tests were executed. 0 tests run.\n",
            stderr: "",
            durationMs: 5,
            outputTruncated: false,
            commandHash: "hash-zero-tests",
          };
          return {
            status: "SUCCESS",
            output: out as unknown as TOutput,
            durationMs: 5,
          };
        }

        const out: RunCommandOutput = {
          exitCode: 0,
          stdout: "PASS: 2 of 2 target tests passing\n",
          stderr: "",
          durationMs: 10,
          outputTruncated: false,
          commandHash: "hash-target-pass",
        };
        return {
          status: "SUCCESS",
          output: out as unknown as TOutput,
          durationMs: 10,
        };
      } else {
        const out: RunCommandOutput = {
          exitCode: 1,
          stdout: "",
          stderr: "FAIL target: add(2, 3) must equal 5\n",
          durationMs: 10,
          outputTruncated: false,
          commandHash: "hash-target-fail",
        };
        return {
          status: "SUCCESS",
          output: out as unknown as TOutput,
          durationMs: 10,
        };
      }
    }

    // Regression test suite execution
    if (argv[0] === "node" && (argv[1] === "test/math.regress.test.js" || argv[1]?.includes("math.regress"))) {
      const mathPath = path.join(hostPath, "src", "math.js");
      let mathCode = "";
      try {
        mathCode = await fs.readFile(mathPath, "utf8");
      } catch {
        mathCode = "";
      }

      // Check if multiply is intact
      const isMultiplyBroken = mathCode.includes("REGRESSION: multiply broken");

      if (isMultiplyBroken) {
        const out: RunCommandOutput = {
          exitCode: 1,
          stdout: "",
          stderr: "FAIL regression: multiply(2, 3) must equal 6\n",
          durationMs: 10,
          outputTruncated: false,
          commandHash: "hash-regress-fail",
        };
        return {
          status: "SUCCESS",
          output: out as unknown as TOutput,
          durationMs: 10,
        };
      } else {
        const out: RunCommandOutput = {
          exitCode: 0,
          stdout: "PASS: 3 of 3 regression tests passing\n",
          stderr: "",
          durationMs: 10,
          outputTruncated: false,
          commandHash: "hash-regress-pass",
        };
        return {
          status: "SUCCESS",
          output: out as unknown as TOutput,
          durationMs: 10,
        };
      }
    }

    // Generic command fallback
    const defaultOut: RunCommandOutput = {
      exitCode: 0,
      stdout: "command executed successfully\n",
      stderr: "",
      durationMs: 5,
      outputTruncated: false,
      commandHash: "hash-default",
    };
    return {
      status: "SUCCESS",
      output: defaultOut as unknown as TOutput,
      durationMs: 5,
    };
  }
}

// ============================================================================
// Phase 14 Test Suite
// ============================================================================

describe("Phase 14 — Independent Verification and Clean-Room Proof", () => {
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let executionProvider: FastCleanRoomExecutionProvider;
  let workerRuntime: WorkerRuntime;
  let cleanRoomVerifier: CleanRoomVerifier;
  let brain: ScriptableAgentBrain;
  let proposalValidator: ProposalValidator;
  let stepController: AgentStepController;
  let clock: SettableClock;
  let tempBaseDir: string;
  let workspaceRootDir: string;
  const workerId = "worker-phase14";
  const leaseTtlMs = 60_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase14-tests-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-17T14:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    coordinator = new RunCoordinator(store, clock);
    executionProvider = new FastCleanRoomExecutionProvider();

    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
      isIsolationAvailable: true,
    });

    cleanRoomVerifier = new CleanRoomVerifier({
      workspacePort: workspaceAdapter,
      workerRuntime,
      coordinator,
      stateStore: store,
      clock,
    });

    brain = new ScriptableAgentBrain();

    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    stepController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
      enableGovernedVerificationStage: true,
      cleanRoomVerifier,
    });
  });

  afterEach(async () => {
    try {
      store.close();
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    } catch {
      // ignore cleanup error
    }
  });

  async function setupCleanRoomRun(options?: {
    customAllowedPatterns?: readonly string[];
  }) {
    const task = coordinator.createTask({
      title: "Repair math defect and prove independently",
      description: "Repair defective addition in math.js without breaking regressions.",
      inputPayload: { directive: "Fix add() in src/math.js" },
    });

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${task.taskId.slice(0, 8)}`,
      runId: `run-${task.taskId.slice(0, 8)}`,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    // Create authentic Git baseline repository
    const { commitSha } = await createMockGitRepository(ws.hostPath, [
      { path: "package.json", content: '{\n  "name": "math-unit",\n  "version": "1.0.0"\n}\n' },
      { path: "src/math.js", content: DEFECTIVE_MATH_CODE },
      { path: "test/math.target.test.js", content: TARGET_TEST_CODE },
      { path: "test/math.regress.test.js", content: REGRESSION_TEST_CODE },
    ]);

    const cleanRoomSpec: CleanRoomVerificationSpec = {
      specId: "clean-room-math-spec",
      baselineCommitSha: commitSha,
      failToPass: {
        testCommand: ["node", "test/math.target.test.js"],
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
      allowedPathPatterns: options?.customAllowedPatterns ?? ["src/**/*.js"],
      timeoutMs: 30000,
    };

    const verificationSpec = createVerificationSpec({
      specId: cleanRoomSpec.specId,
      ruleKind: "CLEAN_ROOM_DUAL_GATE",
      expectedValue: cleanRoomSpec,
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
      verificationSpecs: [verificationSpec],
      timeoutMs: 60_000,
      maxOutputBytes: 1048576,
      maxAttempts: 5,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);

    return { task, contract, run, lease: claim.lease, ws, cleanRoomSpec, commitSha };
  }

  // ==========================================================================
  // Test 14.1 — Happy Path Clean Verification
  // ==========================================================================
  it("Test 14.1 — Happy Path Clean Verification: pristine baseline materializes, F2P=1.0, P2P=1.0, COMPLETED", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Step 1: Agent writes fix to src/math.js
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-fix",
        toolName: "write_file",
        inputPayload: { path: "src/math.js", content: FIXED_MATH_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Fix defective addition in math.js",
      },
    }));

    // Step 2: Agent claims goal reached
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Defect repaired and verified",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Authoritative state store assertion
    coordinator.completeRun(run.runId, workerId, lease.leaseId, { outcome: "VERIFIED" });
    const finalRun = store.getRun(run.runId);
    expect(finalRun?.status).toBe("COMPLETED");

    // Verify independent observer evidence was persisted
    const events = store.getEventsForRun(run.runId);
    const evidenceRecordedEvents = events.filter((e) => e.eventType === "evidence.recorded");
    expect(evidenceRecordedEvents.length).toBeGreaterThan(0);

    const independentEvidenceEvent = evidenceRecordedEvents.find(
      (e) => (e.payload as any)?.source === "INDEPENDENT_OBSERVER"
    );
    expect(independentEvidenceEvent).toBeDefined();

    const payload = (independentEvidenceEvent!.payload as any).summary;
    expect(payload.overallStatus).toBe("VERIFIED");
    expect(payload.baselineDiagnostic.baselineValid).toBe(true);
    expect(payload.baselineDiagnostic.f2pExitCode).toBe(1); // Baseline target failed
    expect(payload.baselineDiagnostic.p2pExitCode).toBe(0); // Baseline regression passed
    expect(payload.cleanRoomEvaluation.f2pRatio).toBe(1.0);
    expect(payload.cleanRoomEvaluation.p2pRatio).toBe(1.0);
    expect(payload.cleanRoomEvaluation.f2pSuiteRanMatched).toBe(true);
    expect(payload.cleanRoomEvaluation.p2pSuiteRanMatched).toBe(true);
  });

  // ==========================================================================
  // Test 14.2 — Zero Code Mutation (No-op Goal Claim)
  // ==========================================================================
  it("Test 14.2 — Zero Code Mutation: agent claims goal without calling write_file; verifier detects empty patch", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Agent immediately proposes GOAL_REACHED without touching code
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "I believe it is already working",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const finalRun = store.getRun(run.runId);
    expect(finalRun?.status).not.toBe("COMPLETED");

    // Check rejection event
    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("EMPTY_PATCH")])
    );
  });

  // ==========================================================================
  // Test 14.3 — Unsuccessful Bug Fix
  // ==========================================================================
  it("Test 14.3 — Unsuccessful Bug Fix: agent modifies code but target test still fails in clean-room", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Step 1: Agent writes still-broken code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-broken",
        toolName: "write_file",
        inputPayload: { path: "src/math.js", content: STILL_BROKEN_MATH_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Attempted fix but still broken",
      },
    }));

    // Step 2: Agent claims goal reached
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Fixed math",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("TARGET_TEST_FAILED")])
    );
  });

  // ==========================================================================
  // Test 14.4 — Regression Introduced
  // ==========================================================================
  it("Test 14.4 — Regression Introduced: agent fixes bug but breaks regression test (REGRESSION_DETECTED)", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Step 1: Agent writes code that fixes addition but breaks multiply()
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-regress",
        toolName: "write_file",
        inputPayload: { path: "src/math.js", content: REGRESSION_MATH_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Fix addition but broke multiplication",
      },
    }));

    // Step 2: Agent claims goal reached
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Addition is fixed now",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("REGRESSION_DETECTED")])
    );
  });

  // ==========================================================================
  // Test 14.5 — Test File Tampering in Agent Workspace
  // ==========================================================================
  it("Test 14.5 — Test File Tampering: agent tampers test in its own workspace; clean-room uses pristine test", async () => {
    // Contract allowedPathPatterns allows test tampering to test whether clean-room catches it
    const { run, lease, ws } = await setupCleanRoomRun({
      customAllowedPatterns: ["src/**/*.js", "test/**/*.js"],
    });

    // Step 1: Cheating agent tampers with test file instead of fixing src/math.js
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-cheat-test",
        toolName: "write_file",
        inputPayload: { path: "test/math.target.test.js", content: TAMPERED_TARGET_TEST_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Tampering test file to always pass",
      },
    }));

    // Step 2: Agent claims completion
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Tests pass now!",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    // Clean-room ran the untampered test from baseline commit; math.js was not fixed -> TARGET_TEST_FAILED
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("TARGET_TEST_FAILED")])
    );
  });

  // ==========================================================================
  // Test 14.6 — Zero-Test Execution Gating
  // ==========================================================================
  it("Test 14.6 — Zero-Test Execution Gating: test command exits 0 without running assertions; fails closed", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Step 1: Agent writes fix
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-fix",
        toolName: "write_file",
        inputPayload: { path: "src/math.js", content: FIXED_MATH_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Fix addition",
      },
    }));

    // Step 2: Agent claims completion
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Fixed addition",
    }));

    // Simulate test runner reporting 0 tests run
    executionProvider.simulateZeroTestOutput = true;

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("TEST_SUITE_NEVER_RAN")])
    );
  });

  // ==========================================================================
  // Test 14.7 — Patch Conflict / Rejection
  // ==========================================================================
  it("Test 14.7 — Patch Conflict: candidate patch cannot apply cleanly to baseline (APPLY_PATCH_FAIL)", async () => {
    const { run, lease, ws, cleanRoomSpec, contract } = await setupCleanRoomRun();

    // Artificially construct a conflicted patch directly against CleanRoomVerifier
    const malformedDiff = `--- a/src/math.js
+++ b/src/math.js
@@ -1,5 +1,5 @@
 function nonExistentFunction() {
-  return 999;
+  return 1000;
 }
`;

    // Overwrite math.js in agent workspace to produce malformed diff
    await fs.writeFile(path.join(ws.hostPath, "src", "math.js"), FIXED_MATH_CODE, "utf8");

    // Test in-process patch applier directly detects conflict
    const patchApp = await applyUnifiedDiff(ws.hostPath, malformedDiff);
    expect(patchApp.status).toBe("CONFLICT");
    expect(patchApp.exitCode).toBe(1);

    // Call verifyCandidatePatch with an empty/invalid baseline commit where file won't match diff
    const outcome = await cleanRoomVerifier.verifyCandidatePatch({
      runId: run.runId,
      taskId: run.taskId,
      workerId,
      leaseId: lease.leaseId,
      contract,
      spec: {
        ...cleanRoomSpec,
        baselineCommitSha: "0000000000000000000000000000000000000000",
      },
      agentWorkspace: ws,
    });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureReasonCode).toBeDefined();
  });

  // ==========================================================================
  // Test 14.8 — Policy Path Scope Violation
  // ==========================================================================
  it("Test 14.8 — Policy Path Scope Violation: agent touches files outside allowedPathPatterns", async () => {
    const { run, lease, ws } = await setupCleanRoomRun({
      customAllowedPatterns: ["src/**/*.js"], // Only src/**/*.js allowed
    });

    // Step 1: Agent writes to package.json (out of scope!)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-pkg",
        toolName: "write_file",
        inputPayload: { path: "package.json", content: '{\n  "name": "hacked"\n}\n' },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Modify package.json outside allowed paths",
      },
    }));

    // Step 2: Agent claims completion
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Done",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("POLICY_PATH_VIOLATION")])
    );
  });

  // ==========================================================================
  // Test 14.9 — Clean-Room Timeout
  // ==========================================================================
  it("Test 14.9 — Clean-Room Timeout: test execution exceeds timeout budget (EXECUTION_TIMEOUT)", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Step 1: Agent writes fix
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-fix",
        toolName: "write_file",
        inputPayload: { path: "src/math.js", content: FIXED_MATH_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Fix addition",
      },
    }));

    // Step 2: Agent claims completion
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Fixed addition",
    }));

    // Simulate container timeout
    executionProvider.simulateTimeout = true;

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();
    expect((rejectionEvent?.payload as any).outstandingRequirements).toEqual(
      expect.arrayContaining([expect.stringContaining("EXECUTION_TIMEOUT")])
    );
  });

  // ==========================================================================
  // Test 14.10 — Double Clean-Room Isolation
  // ==========================================================================
  it("Test 14.10 — Double Clean-Room Isolation: agent workspace files and hashes remain untouched before and after verification", async () => {
    const { run, lease, ws } = await setupCleanRoomRun();

    // Agent has written fix to its workspace
    await fs.writeFile(path.join(ws.hostPath, "src", "math.js"), FIXED_MATH_CODE, "utf8");

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Goal reached",
    }));

    // Snapshot agent workspace files right before clean-room verification runs
    const mathBefore = await fs.readFile(path.join(ws.hostPath, "src", "math.js"), "utf8");
    const targetTestBefore = await fs.readFile(path.join(ws.hostPath, "test", "math.target.test.js"), "utf8");
    const regressTestBefore = await fs.readFile(path.join(ws.hostPath, "test", "math.regress.test.js"), "utf8");

    const result = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: lease.leaseId,
      workspace: ws,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Snapshot agent workspace files after clean-room verification
    const mathAfter = await fs.readFile(path.join(ws.hostPath, "src", "math.js"), "utf8");
    const targetTestAfter = await fs.readFile(path.join(ws.hostPath, "test", "math.target.test.js"), "utf8");
    const regressTestAfter = await fs.readFile(path.join(ws.hostPath, "test", "math.regress.test.js"), "utf8");

    // File contents must be 100% byte-for-byte identical
    expect(mathAfter).toBe(mathBefore);
    expect(targetTestAfter).toBe(targetTestBefore);
    expect(regressTestAfter).toBe(regressTestBefore);

    // Verify clean-room workspace was disposed (no leftover ws-verify directories)
    const activeWorkspaces = await fs.readdir(workspaceRootDir);
    const leftoverVerifyDirs = activeWorkspaces.filter((dir) => dir.startsWith("ws-verify-"));
    expect(leftoverVerifyDirs).toEqual([]);
  });

  // ==========================================================================
  // Test 14.11 — Historical Artifact Protection
  // ==========================================================================
  it("Test 14.11 — Historical Artifact Protection: all 9 historical benchmark artifacts remain byte-for-byte identical", async () => {
    for (const [filename, expectedHash] of Object.entries(HISTORICAL_HASHES)) {
      const filePath = path.join(SCRATCH_DIR, filename);
      const fileBytes = await fs.readFile(filePath);
      const actualHash = crypto
        .createHash("sha256")
        .update(fileBytes)
        .digest("hex")
        .toUpperCase();

      expect(
        actualHash,
        `Historical artifact '${filename}' SHA-256 hash has been modified! Expected ${expectedHash}, received ${actualHash}`
      ).toBe(expectedHash);
    }
  });
});
