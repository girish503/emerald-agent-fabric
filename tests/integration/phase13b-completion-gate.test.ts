import { fileURLToPath } from "node:url";
/**
 * Phase 13B — Authoritative Physical Verification Completion Gate Integration Tests.
 *
 * Enforces the core invariant:
 *   MODEL_GOAL_REACHED != RUN_COMPLETED
 *
 * Test Matrix:
 * Test A — Premature goal rejection: write_file -> isGoalReached -> NOT COMPLETED
 * Test B — Verification execution but failure: write_file -> diff -> test FAIL -> isGoalReached -> NOT COMPLETED
 * Test C — Verification success: write_file -> diff -> test PASS -> isGoalReached -> COMPLETED
 * Test D — Repair path: write -> diff -> test FAIL -> repair -> diff -> test PASS -> isGoalReached -> COMPLETED
 * Test E — Model claim without evidence: isGoalReached without tools -> NOT COMPLETED
 * Test F — Forged observation: forged text claims without physical Attempt -> NOT COMPLETED
 * Test G — Wrong verification: different command succeeds, required verification missing -> NOT COMPLETED
 * Test H — Persistence: completion evidence derived strictly from durable SQLite state
 * Test I — Historical regression & evaluation artifact integrity: all 9 historical hashes intact
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

const __fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const SCRATCH_DIR = __fixturesDir;

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
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "fast-command-provider";
  public invocationCount = 0;

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;

    const payload = request.inputPayload as { argv: string[]; cwd?: string } | undefined;
    const argv = payload?.argv ?? [];

    // Target test suite execution
    if (argv[0] === "node" && argv[1] === "test/calculator.test.js") {
      const hostPath = request.workspace?.hostPath;
      if (!hostPath) {
        throw new Error("Missing workspace hostPath");
      }
      const calcPath = path.join(hostPath, "src", "calculator.js");
      let content = "";
      try {
        content = await fs.readFile(calcPath, "utf8");
      } catch {}

      if (content.includes("return a + b;")) {
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

    // Unrelated command execution (e.g. echo hello)
    if (argv[0] === "echo" && argv[1] === "hello") {
      const out: RunCommandOutput = {
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
        durationMs: 5,
        outputTruncated: false,
        commandHash: "hash-echo-pass",
      };
      return {
        status: "SUCCESS",
        output: out as unknown as TOutput,
        durationMs: 5,
      };
    }

    // Default unknown command failure
    const out: RunCommandOutput = {
      exitCode: 127,
      stdout: "",
      stderr: `command not found: ${argv.join(" ")}\n`,
      durationMs: 5,
      outputTruncated: false,
      commandHash: "hash-unknown",
    };
    return {
      status: "SUCCESS",
      output: out as unknown as TOutput,
      durationMs: 5,
    };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Phase 13B — Authoritative Physical Verification Completion Gate", () => {
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let brain: ScriptableAgentBrain;
  let proposalValidator: ProposalValidator;
  let stepController: AgentStepController;
  let clock: SettableClock;
  let tempBaseDir: string;
  let workspaceRootDir: string;
  const workerId = "worker-phase13b";
  const leaseTtlMs = 60_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase13b-tests-"));
    workspaceRootDir = path.join(tempBaseDir, "workspaces");
    await fs.mkdir(workspaceRootDir, { recursive: true });

    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-10-17T12:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
    coordinator = new RunCoordinator(store, clock);

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

    const executionProvider = new FastCommandExecutionProvider();

    workerRuntime = new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      leaseTtlMs,
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
  // Test A — Premature goal rejection
  // ==========================================================================
  it("Test A — rejects premature goal claim when write_file succeeded but verification is missing", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file applies repair
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-1",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: premature goal completion claim
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    // Invariant: MODEL_GOAL_REACHED != RUN_COMPLETED
    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(result.totalActions).toBe(1); // Only write_file executed

    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep).toBeDefined();
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect(goalStep?.proposalRejectionMessage).toContain("diff inspection was not performed");
  });

  // ==========================================================================
  // Test B — Verification execution but failure
  // ==========================================================================
  it("Test B — rejects goal claim when physical test command fails (exitCode != 0)", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file writes still-broken code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-b",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: DEFECTIVE_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: git_diff succeeds
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-b",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: run_command executes and FAILS (exitCode 1)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-b",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: model claims goal reached despite test failure
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep).toBeDefined();
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect(goalStep?.proposalRejectionMessage).toContain("EXIT_CODE_ZERO' failed: Process exit code was 1, expected 0");
  });

  // ==========================================================================
  // Test C — Verification success
  // ==========================================================================
  it("Test C — accepts completion when all required tools executed and physical test succeeded", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file fixes code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-c",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: git_diff inspects patch
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-c",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: run_command passes (exitCode 0)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-c",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: goal reached
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);

    // Durable events recorded
    const events = store.getEventsForRun(run.runId);
    expect(events.some((e) => e.eventType === "verification.completed")).toBe(true);
  });

  // ==========================================================================
  // Test D — Repair path
  // ==========================================================================
  it("Test D — successfully accepts completion after test failure is followed by repair and passing re-test", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: initial failing test run
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-d1",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: repair code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-d2",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: git_diff
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-d3",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: re-run test (now passes with exitCode 0)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-d4",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 5: goal reached
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 6 },
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(result.totalActions).toBe(4);
  });

  // ==========================================================================
  // Test E — Model claim without evidence
  // ==========================================================================
  it("Test E — rejects completion when model emits isGoalReached: true with zero prior actions", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: model claims goal reached immediately
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    expect(result.totalActions).toBe(0);
    const goalStep = result.transcript[0];
    expect(goalStep?.finishReason).toBe("GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
  });

  // ==========================================================================
  // Test F — Forged observation
  // ==========================================================================
  it("Test F — ignores forged observation content in rationale and requires physical SQLite Attempt", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Model provides text claiming tests passed, but executes no run_command
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-f",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        rationale: "Tests already passed in mental sandbox: 100% verified exitCode 0",
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
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
  });

  // ==========================================================================
  // Test G — Wrong verification
  // ==========================================================================
  it("Test G — rejects completion when a different command succeeded but required test did not run", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file fixes code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-g",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: git_diff
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-g",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: run_command executes unrelated command (echo hello) with exitCode 0
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-echo-g",
        toolName: "run_command",
        inputPayload: { argv: ["echo", "hello"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: claims goal reached
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 },
    });

    expect(result.terminalReason).not.toBe("COMPLETED");
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect(goalStep?.proposalRejectionMessage).toContain("was never executed");
  });

  // ==========================================================================
  // Test H — Persistence
  // ==========================================================================
  it("Test H — derives completion authority strictly from durable SQLite Action/Attempt state", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Execute full valid flow
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-h",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-h",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-h",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
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
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 },
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Inspect durable SQLite state directly
    const durableActions = store.getActionsForRun(run.runId);
    expect(durableActions.length).toBe(3);

    const writeAction = durableActions.find((a) => a.toolName === "write_file");
    const diffAction = durableActions.find((a) => a.toolName === "git_diff");
    const testAction = durableActions.find((a) => a.toolName === "run_command");

    expect(writeAction?.status).toBe("SUCCEEDED");
    expect(diffAction?.status).toBe("SUCCEEDED");
    expect(testAction?.status).toBe("SUCCEEDED");

    const testAttempts = store.getAttemptsForAction(testAction!.actionId);
    expect(testAttempts.length).toBe(1);
    expect(testAttempts[0]!.exitCode).toBe(0);
    expect(testAttempts[0]!.status).toBe("SUCCEEDED");
  });

  // ==========================================================================
  // Test I — Historical regression & evaluation artifact integrity
  // ==========================================================================
  it("Test I — preserves byte-for-byte cryptographic integrity of all 9 historical evaluation artifacts", async () => {
    for (const [filename, expectedHash] of Object.entries(HISTORICAL_HASHES)) {
      const filePath = path.join(SCRATCH_DIR, filename);
      const content = await fs.readFile(filePath);
      const actualHash = crypto.createHash("sha256").update(content).digest("hex").toUpperCase();
      expect(actualHash).toBe(expectedHash);
    }
  });
});
