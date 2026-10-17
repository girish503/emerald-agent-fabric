/**
 * Phase 13D — Governed Verification Stage Integration Tests.
 *
 * Verifies the hypothesis:
 *   A bounded, contract-declared verification stage can guarantee physical verification
 *   without trusting the model to remember to request verification.
 *
 * Test Matrix:
 * Test A — Contract requires verification: A mission with verificationSpecs cannot complete immediately after mutation
 * Test B — Completion triggers required verification stage: A model isGoalReached=true proposal triggers contract verification stage
 * Test C — Physical diff execution: Required diff inspection occurs through the existing governed tool path
 * Test D — Physical test execution: Required test command executes through ToolGateway -> ExecutionProvider
 * Test E — Verification success: Successful required verification allows completion
 * Test F — Verification failure: Failed required verification prevents completion
 * Test G — Repair after failure: Physical test failure becomes observation, agent repairs and passes subsequent verification
 * Test H — No hidden execution: All verification actions appear in Action/Attempt/evidence history
 * Test I — No authority leakage: Model cannot manipulate verification commands, outcomes, or contract authority
 * Test J — Existing completion gate: A forged isGoalReached=true still cannot directly mark the run completed
 * Test K — Persistence: Verification Actions, Attempts, and observations survive through SQLite
 * Test L — Historical integrity: All 9 historical benchmark artifacts remain byte-for-byte identical
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
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { createVerificationSpec } from "../../src/domain/verification.js";
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
import { RunCommandOutput } from "../../src/domain/tool-schemas.js";
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

const DEFECTIVE_CALCULATOR_CODE = `/**
 * Simple calculator module.
 */

function add(a, b) {
  // BUG: subtracts instead of adds
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const FIXED_CALCULATOR_CODE = `/**
 * Simple calculator module.
 */

function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const STILL_BROKEN_CALCULATOR_CODE = `/**
 * Simple calculator module.
 */

function add(a, b) {
  // Still broken
  return a * b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const CALCULATOR_TEST_CODE = `const assert = require("assert");
const { add, multiply } = require("../src/calculator.js");

try {
  assert.strictEqual(add(2, 3), 5, "add(2, 3) must equal 5");
  assert.strictEqual(add(-1, 1), 0, "add(-1, 1) must equal 0");
  assert.strictEqual(multiply(3, 4), 12, "multiply(3, 4) must equal 12");
  console.log("ALL_TESTS_PASSED");
  process.exit(0);
} catch (err) {
  console.error("TEST_FAILED:", err.message);
  process.exit(1);
}
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
// Fast In-Memory Command Execution Provider
// ============================================================================

class FastCommandExecutionProvider implements ExecutionProvider {
  readonly name = "fast-command-provider";
  public invocationCount = 0;
  public executedCommands: { argv: string[]; cwd?: string }[] = [];

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;

    const payload = request.inputPayload as { argv: string[]; cwd?: string } | undefined;
    const argv = payload?.argv ?? [];
    this.executedCommands.push({ argv, cwd: payload?.cwd });

    if (argv[0] === "node" && argv[1] === "test/calculator.test.js") {
      const hostPath = request.workspace?.hostPath;
      if (!hostPath) {
        throw new Error("Missing workspace hostPath");
      }
      const calcPath = path.join(hostPath, "src", "calculator.js");
      let calcCode = "";
      try {
        calcCode = await fs.readFile(calcPath, "utf8");
      } catch {
        calcCode = "";
      }

      const isFixed = calcCode.includes("return a + b;");

      if (isFixed) {
        const out: RunCommandOutput = {
          exitCode: 0,
          stdout: "ALL_TESTS_PASSED\n",
          stderr: "",
          durationMs: 10,
          outputTruncated: false,
          commandHash: "hash-calc-pass",
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
          stderr: "TEST_FAILED: add(2, 3) must equal 5\n",
          durationMs: 10,
          outputTruncated: false,
          commandHash: "hash-calc-fail",
        };
        return {
          status: "SUCCESS",
          output: out as unknown as TOutput,
          durationMs: 10,
        };
      }
    }

    const defaultOut: RunCommandOutput = {
      exitCode: 0,
      stdout: "command executed\n",
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
// Phase 13D Integration Test Suite
// ============================================================================

describe("Phase 13D — Governed Verification Stage Integration", () => {
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let executionProvider: FastCommandExecutionProvider;
  let workerRuntime: WorkerRuntime;
  let brain: ScriptableAgentBrain;
  let proposalValidator: ProposalValidator;
  let stepController: AgentStepController;
  let clock: SettableClock;
  let tempBaseDir: string;
  let workspaceRootDir: string;
  const workerId = "worker-phase13d";
  const leaseTtlMs = 60_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase13d-tests-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-17T12:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    coordinator = new RunCoordinator(store, clock);
    executionProvider = new FastCommandExecutionProvider();

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
    });
  });

  afterEach(async () => {
    try {
      store.close();
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    } catch {
      // ignore
    }
  });

  async function setupCodingRun(taskDescription: string, options?: {
    customVerificationSpec?: ReturnType<typeof createVerificationSpec>;
  }) {
    const task = coordinator.createTask({
      title: "Fix defective calculator module",
      description: taskDescription,
      inputPayload: { directive: taskDescription },
    });

    const verificationSpec = options?.customVerificationSpec ?? createVerificationSpec({
      specId: "verify-calculator-tests",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: {
        toolName: "run_command",
        argv: ["node", "test/calculator.test.js"],
        requireMutation: true,
        requireDiff: true,
      },
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

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    await createMockGitRepository(ws.hostPath, [
      { path: "README.md", content: "# Calculator Module\nRun tests: node test/calculator.test.js\n" },
      { path: "src/calculator.js", content: DEFECTIVE_CALCULATOR_CODE },
      { path: "test/calculator.test.js", content: CALCULATOR_TEST_CODE },
    ]);

    return { task, contract, run, lease: claim.lease, ws };
  }

  // ==========================================================================
  // Test A — Contract requires verification
  // ==========================================================================
  it("Test A — Contract requires verification: mission cannot complete without physical verification passing", async () => {
    // Controller with verification stage disabled to demonstrate baseline contract enforcement
    const manualController = new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime,
      agentBrain: brain,
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
      enableGovernedVerificationStage: false,
    });

    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-a",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: premature goal completion claim
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await manualController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(result.totalActions).toBe(1); // Only write_file executed
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
  });

  // ==========================================================================
  // Test B — Completion triggers required verification stage
  // ==========================================================================
  it("Test B — Completion triggers required verification stage: isGoalReached=true enters contract verification stage", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: read_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-read-b",
        toolName: "read_file",
        inputPayload: { path: "src/calculator.js" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: write_file with fix
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-b",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: isGoalReached=true (triggers contract verification stage)
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 6, maxActions: 6 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalSteps).toBe(3);
    // Actions executed: read_file, write_file, git_diff, run_command
    expect(result.totalActions).toBe(4);

    const toolsExecuted = result.transcript
      .filter((t) => t.toolName)
      .map((t) => t.toolName);
    expect(toolsExecuted).toEqual(["read_file", "write_file", "git_diff", "run_command"]);
  });

  // ==========================================================================
  // Test C — Physical diff execution
  // ==========================================================================
  it("Test C — Physical diff execution occurs through existing governed tool path", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-c",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5, maxActions: 5 },
    });

    const diffEntry = result.transcript.find((t) => t.toolName === "git_diff");
    expect(diffEntry).toBeDefined();
    expect(diffEntry?.actionStatus).toBe("SUCCEEDED");
    const diffOut = diffEntry?.actionOutput as any;
    expect(diffOut.filesChanged).toBe(1);
    expect(diffOut.diff).toContain("+  return a + b;");
  });

  // ==========================================================================
  // Test D — Physical test execution
  // ==========================================================================
  it("Test D — Physical test execution executes through ToolGateway -> ExecutionProvider", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-d",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    expect(executionProvider.invocationCount).toBe(0);

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5, maxActions: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(executionProvider.invocationCount).toBe(1);
    expect(executionProvider.executedCommands[0]!.argv).toEqual(["node", "test/calculator.test.js"]);
  });

  // ==========================================================================
  // Test E — Verification success allows completion
  // ==========================================================================
  it("Test E — Verification success: Passing tests allow completion transition", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-e",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    const testEntry = result.transcript.find((t) => t.toolName === "run_command");
    expect(testEntry?.actionStatus).toBe("SUCCEEDED");
    expect((testEntry?.actionOutput as any).exitCode).toBe(0);
  });

  // ==========================================================================
  // Test F — Verification failure prevents completion
  // ==========================================================================
  it("Test F — Verification failure: Failed test command prevents completion", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Write code that is still broken
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-f",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: STILL_BROKEN_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Claim completion
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    // Bounded budget with maxProposalRejections=1 to verify termination
    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3, maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.terminalReason).not.toBe("COMPLETED");

    // Verification executed both git_diff and run_command
    const testEntry = result.transcript.find((t) => t.toolName === "run_command");
    expect(testEntry).toBeDefined();
    expect((testEntry?.actionOutput as any).exitCode).toBe(1);

    // Goal was rejected
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED" && !t.proposalValid);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
  });

  // ==========================================================================
  // Test G — Repair after failure
  // ==========================================================================
  it("Test G — Repair after failure: Failed verification produces observation, agent repairs and completes", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: Agent writes still-broken code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-bad",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: STILL_BROKEN_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: Agent attempts goal completion -> triggers verification stage -> test FAILS
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    // Step 3: Agent receives observation of test failure and proposes fix via write_file
    brain.queueStep((req) => {
      // Check that test failure is present in context observations
      const hasFailureObs = req.contextSnapshot.observations.some(
        (obs) =>
          obs.category === "ACTION_HISTORY" &&
          (obs.content as any).toolName === "run_command"
      );
      expect(hasFailureObs).toBe(true);

      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p-write-repair",
          toolName: "write_file",
          inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      };
    });

    // Step 4: Agent concludes with goal reached -> verification re-runs on repaired code -> PASSES
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 8, maxActions: 8 },
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Total actions: write(bad) + diff(1) + test(fail) + write(good) + diff(2) + test(pass) = 6 actions
    expect(result.totalActions).toBe(6);

    const testActions = result.transcript.filter((t) => t.toolName === "run_command");
    expect(testActions.length).toBe(2);
    expect((testActions[0]?.actionOutput as any).exitCode).toBe(1);
    expect((testActions[1]?.actionOutput as any).exitCode).toBe(0);
  });

  // ==========================================================================
  // Test H — No hidden execution
  // ==========================================================================
  it("Test H — No hidden execution: All verification actions appear in SQLite Actions, Attempts, and evidence", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-h",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Inspect SQLite state directly
    const storedActions = store.getActionsForRun(run.runId);
    expect(storedActions.length).toBe(3); // write_file, git_diff, run_command
    expect(storedActions.map((a) => a.toolName)).toEqual(["write_file", "git_diff", "run_command"]);

    for (const action of storedActions) {
      const attempts = store.getAttemptsForAction(action.actionId);
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts[0]!.status).toBe("SUCCEEDED");
    }

    const durableEvents = store.getEventsForRun(run.runId);
    const hasVerificationEvent = durableEvents.some((e) => e.eventType === "verification.completed" || e.eventType === "evidence.recorded");
    expect(hasVerificationEvent).toBe(true);
  });

  // ==========================================================================
  // Test I — No authority leakage
  // ==========================================================================
  it("Test I — No authority leakage: Model cannot modify contract verification command or bypass policy", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: Model repairs code with write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-i",
        toolName: "write_file",
        inputPayload: {
          path: "src/calculator.js",
          content: FIXED_CALCULATOR_CODE,
        },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: Model attempts to run an unauthorized fake test command trying to bypass real tests
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-fake-test",
        toolName: "run_command",
        inputPayload: {
          argv: ["echo", "fake tests passed"],
        },
        rationale: "Claiming tests pass via echo bypass",
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: Model emits GOAL_REACHED claiming verification is done
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 6, maxActions: 6 },
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Verify the contract-declared test was authoritatively executed, NOT substituted by echo
    const contractTestExecution = executionProvider.executedCommands.find(
      (cmd) => cmd.argv[0] === "node" && cmd.argv[1] === "test/calculator.test.js"
    );
    expect(contractTestExecution).toBeDefined();

    // Verify contract in store was untouched
    const storedContract = store.getContract(run.contractBinding!.contractId, run.contractBinding!.version);
    expect(storedContract?.spec.verificationSpecs?.[0]!.ruleKind).toBe("EXIT_CODE_ZERO");
    expect((storedContract?.spec.verificationSpecs?.[0]!.expectedValue as any).argv).toEqual([
      "node",
      "test/calculator.test.js",
    ]);

    // The verification command strictly followed the contract, ignoring model spoofing
    expect(contractTestExecution!.argv).toEqual(["node", "test/calculator.test.js"]);
  });

  // ==========================================================================
  // Test J — Existing completion gate
  // ==========================================================================
  it("Test J — Existing completion gate: Forged isGoalReached=true without mutation cannot complete", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Model emits GOAL_REACHED immediately on step 1 without performing mutation
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2, maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalActions).toBe(0);

    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect(goalStep?.proposalRejectionMessage).toContain("Prerequisite source mutation was not performed");
  });

  // ==========================================================================
  // Test K — Persistence
  // ==========================================================================
  it("Test K — Persistence: Verification Actions, Attempts, and observations survive in SQLite", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-k",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Close and verify state can be read directly
    const runState = store.getRun(run.runId);
    expect(runState).toBeDefined();

    const actions = store.getActionsForRun(run.runId);
    expect(actions.length).toBe(3);

    for (const act of actions) {
      const attempts = store.getAttemptsForAction(act.actionId);
      expect(attempts.length).toBe(1);
      expect(attempts[0]!.runId).toBe(run.runId);
    }
  });

  // ==========================================================================
  // Test L — Historical integrity
  // ==========================================================================
  it("Test L — Historical integrity: All 9 historical benchmark artifacts remain byte-for-byte identical", async () => {
    for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
      const fullPath = path.join(SCRATCH_DIR, filename);
      const exists = await fs
        .access(fullPath)
        .then(() => true)
        .catch(() => false);
      expect(exists, `Historical artifact missing: ${filename}`).toBe(true);

      const buf = await fs.readFile(fullPath);
      const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
      expect(
        actualSha256,
        `Historical artifact corrupted! ${filename} expected ${expectedSha256}, got ${actualSha256}`
      ).toBe(expectedSha256.toUpperCase());
    }
  });
});
