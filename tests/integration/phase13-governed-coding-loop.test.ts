/**
 * Phase 13 — Governed Real Coding Repair Loop Integration Tests.
 *
 * Verifies the 10 core capability and governance invariants:
 * A. Real coding happy path: inspect -> edit -> diff -> test -> success
 * B. Test failure becomes observation: failed verification produces durable observation for next step
 * C. Repair path: agent consumes real test failure and issues subsequent bounded repair
 * D. Repair bound: more than 3 repair attempts cannot occur (bounded termination)
 * E. Governance remains mandatory: write_file and run_command pass through full governance pipeline
 * F. Diff inspection: final diff is observable through git_diff tool
 * G. Physical verification: physical test outcome is authoritative over model claims
 * H. Persistence: coding trajectory maintains Action -> Attempt -> Observation relational integrity
 * I. Security invariants: model cannot inject infrastructure authority fields
 * J. Historical integrity: all 9 historical evaluation artifacts remain byte-for-byte intact
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
// Fast In-Memory Execution Provider for Unit-Level Process Emulation
// ============================================================================

class FastCommandExecutionProvider implements ExecutionProvider {
  readonly name = "fast-command-provider";
  public invocationCount = 0;
  public lastRequest?: ExecutionRequest<any>;

  constructor() {}

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocationCount++;
    this.lastRequest = request;

    const payload = request.inputPayload as { argv: string[]; cwd?: string } | undefined;
    const argv = payload?.argv ?? [];

    // Emulate executing: node test/calculator.test.js
    if (argv[0] === "node" && argv[1] === "test/calculator.test.js") {
      const hostPath = request.workspace?.hostPath;
      if (!hostPath) {
        throw new Error("Missing workspace hostPath");
      }
      const calcPath = path.join(hostPath, "src", "calculator.js");
      let content = "";
      try {
        content = await fs.readFile(calcPath, "utf8");
      } catch {
        // file missing
      }

      if (content.includes("return a + b;")) {
        const out: RunCommandOutput = {
          exitCode: 0,
          stdout: "ALL_TESTS_PASSED\n",
          stderr: "",
          durationMs: 15,
          outputTruncated: false,
          commandHash: "hash-pass",
        };
        return {
          status: "SUCCESS",
          output: out as unknown as TOutput,
          durationMs: 15,
        };
      } else {
        const out: RunCommandOutput = {
          exitCode: 1,
          stdout: "",
          stderr: "TEST_FAILED: add(2, 3) must equal 5\n",
          durationMs: 15,
          outputTruncated: false,
          commandHash: "hash-fail",
        };
        return {
          status: "SUCCESS", // The command execution succeeded, producing exitCode 1
          output: out as unknown as TOutput,
          durationMs: 15,
        };
      }
    }

    // Default mock response
    const defaultOut: RunCommandOutput = {
      exitCode: 0,
      stdout: "command executed successfully\n",
      stderr: "",
      durationMs: 10,
      outputTruncated: false,
      commandHash: "hash-default",
    };
    return {
      status: "SUCCESS",
      output: defaultOut as unknown as TOutput,
      durationMs: 10,
    };
  }
}

// ============================================================================
// Phase 13 Integration Test Suite
// ============================================================================

describe("Phase 13 — Governed Real Coding Repair Loop Integration", () => {
  let tempBaseDir: string;
  let workspaceRootDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let executionProvider: FastCommandExecutionProvider;
  let workerRuntime: WorkerRuntime;
  let proposalValidator: ProposalValidator;
  let brain: ScriptableAgentBrain;
  let stepController: AgentStepController;

  const workerId = "worker-phase13-test";
  const leaseTtlMs = 120_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase13-test-"));
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

    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    brain = new ScriptableAgentBrain();

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

  async function setupCodingRun(taskDirective: string) {
    const task = coordinator.createTask({
      title: "Repair Calculator Defect",
      description: taskDirective,
      inputPayload: { directive: taskDirective },
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
      timeoutMs: 120_000,
      maxOutputBytes: 1048576,
      maxAttempts: 5,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, leaseTtlMs);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    const ws = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    const repoInfo = await createMockGitRepository(ws.hostPath, [
      { path: "README.md", content: "# Calculator Module\nRun tests: node test/calculator.test.js\n" },
      { path: "src/calculator.js", content: DEFECTIVE_CALCULATOR_CODE },
      { path: "test/calculator.test.js", content: CALCULATOR_TEST_CODE },
    ]);

    return { task, contract, run, lease: claimResult.lease, ws, repoInfo };
  }

  // =========================================================================
  // Test A: Real Coding Happy Path (inspect -> edit -> diff -> test -> success)
  // =========================================================================
  it("Test A — Real coding happy path executes inspect -> edit -> diff -> test -> success", async () => {
    const { run, lease, ws } = await setupCodingRun(
      "Inspect calculator defect, repair it, verify diff, run test, and complete."
    );

    // Step 1: read_file src/calculator.js
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-read",
        toolName: "read_file",
        inputPayload: { path: "src/calculator.js" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: write_file src/calculator.js with FIXED code
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: git_diff path: "."
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: run_command argv: ["node", "test/calculator.test.js"]
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 5: Goal reached
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
    expect(result.totalActions).toBe(4);
    expect(result.totalSteps).toBe(5);

    // Verify source modification on disk
    const onDiskContent = await fs.readFile(path.join(ws.hostPath, "src/calculator.js"), "utf8");
    expect(onDiskContent).toBe(FIXED_CALCULATOR_CODE);

    // Verify transcript tool sequence
    expect(result.transcript[0]!.toolName).toBe("read_file");
    expect(result.transcript[1]!.toolName).toBe("write_file");
    expect(result.transcript[2]!.toolName).toBe("git_diff");
    expect(result.transcript[3]!.toolName).toBe("run_command");

    // Verify diff output
    const diffOut = result.transcript[2]!.actionOutput as any;
    expect(diffOut.filesChanged).toBe(1);
    expect(diffOut.diff).toContain("+  return a + b;");

    // Verify test execution output
    const testOut = result.transcript[3]!.actionOutput as any;
    expect(testOut.exitCode).toBe(0);
    expect(testOut.stdout).toContain("ALL_TESTS_PASSED");
  });

  // =========================================================================
  // Test B: Test Failure Becomes Observation
  // =========================================================================
  it("Test B — Test failure produces durable TOOL_RESULT observation available in next step", async () => {
    const { run, lease, ws } = await setupCodingRun("Run tests on defective code.");

    let step2SnapshotObservations: readonly any[] = [];

    // Step 1: run test on broken code (fails)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-fail-test",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: inspect context observations
    brain.queueStep((req) => {
      step2SnapshotObservations = req.contextSnapshot.observations;
      return { finishReason: "GOAL_REACHED" };
    });

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    expect(result.totalActions).toBe(1);

    // Find the tool result observation for the failed test
    const toolResultObs = step2SnapshotObservations.find((o) => o.category === "TOOL_RESULT");
    expect(toolResultObs).toBeDefined();
    expect(toolResultObs!.content.toolName).toBe("run_command");
    expect(toolResultObs!.content.exitCode).toBe(1);
    expect(toolResultObs!.content.output.stderr).toContain("TEST_FAILED: add(2, 3) must equal 5");
  });

  // =========================================================================
  // Test C: Repair Path Driven by Real Test Failure
  // =========================================================================
  it("Test C — Agent consumes real test failure observation and performs subsequent repair", async () => {
    const { run, lease, ws } = await setupCodingRun("Observe failure and repair.");

    // Step 1: Run test (fails)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-1",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: Observe failure in context and write fix
    brain.queueStep((req) => {
      const priorFail = req.contextSnapshot.observations.find(
        (o) => o.category === "TOOL_RESULT" && o.content.toolName === "run_command"
      );
      expect(priorFail).toBeDefined();
      expect(priorFail!.content.exitCode).toBe(1);

      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p-fix",
          toolName: "write_file",
          inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      };
    });

    // Step 3: Re-run test (passes)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-2",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: Finish
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
    expect(result.totalActions).toBe(3);

    // Action 1: failed test (exitCode 1)
    expect((result.transcript[0]!.actionOutput as any).exitCode).toBe(1);
    // Action 2: write_file
    expect(result.transcript[1]!.toolName).toBe("write_file");
    // Action 3: passing test (exitCode 0)
    expect((result.transcript[2]!.actionOutput as any).exitCode).toBe(0);
  });

  // =========================================================================
  // Test D: Repair Bound (Max Failures / Max Steps)
  // =========================================================================
  it("Test D — Controller enforces strict repair bounds and halts on budget exhaustion", async () => {
    const { run, lease, ws } = await setupCodingRun("Endless failing repairs.");

    // Queue 5 consecutive failing test actions
    for (let i = 1; i <= 5; i++) {
      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: `p-fail-${i}`,
          toolName: "run_command",
          inputPayload: { argv: ["node", "test/calculator.test.js"] },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      }));
    }

    // Budget: maximum 3 steps
    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3, maxActions: 3 },
    });

    expect(result.terminalReason).toBe("MAX_STEPS");
    expect(result.totalSteps).toBe(3);
    expect(result.totalActions).toBe(3);
  });

  // =========================================================================
  // Test E: Governance Remains Mandatory (write_file and run_command boundaries)
  // =========================================================================
  it("Test E — Path traversal in write_file and unauthorized capability in run_command are denied", async () => {
    const { run, lease, ws } = await setupCodingRun("Governance boundary check.");

    // Step 1: Attempt write_file escaping workspace
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-escape",
        toolName: "write_file",
        inputPayload: { path: "../../escaped.txt", content: "hacked" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: Goal reached after rejection
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

    expect(result.transcript[0]!.proposalValid).toBe(false);
    expect(result.transcript[0]!.proposalRejectionReason).toBe("INVALID_TOOL_INPUT");
    expect(result.totalActions).toBe(0);

    // Verify escaped file was NEVER written on disk
    const escapedPath = path.resolve(ws.hostPath, "../../escaped.txt");
    let fileExists = true;
    try {
      await fs.access(escapedPath);
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  // =========================================================================
  // Test F: Diff Inspection
  // =========================================================================
  it("Test F — Final diff is observable through git_diff tool and accurately reflects changes", async () => {
    const { run, lease, ws } = await setupCodingRun("Inspect diff after write.");

    // Step 1: Write file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: git_diff
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    const diffOutput = result.transcript[1]!.actionOutput as any;
    expect(diffOutput.filesChanged).toBe(1);
    expect(diffOutput.diff).toContain("-  return a - b;");
    expect(diffOutput.diff).toContain("+  return a + b;");
    expect(diffOutput.isTruncated).toBe(false);
  });

  // =========================================================================
  // Test G: Physical Verification is Authoritative
  // =========================================================================
  it("Test G — Physical verification result in SQLite remains authoritative over model claims", async () => {
    const { run, lease, ws } = await setupCodingRun("Premature goal claim.");

    // Step 1: Run failing test
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-fail",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: Model claims goal reached despite test failure
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "I claim the calculator works perfectly!",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // The recorded physical evidence remains exitCode 1
    const actions = store.getActionsForRun(run.runId);
    expect(actions.length).toBe(1);
    const attempts = store.getAttemptsForAction(actions[0]!.actionId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.outputPayload).toEqual(
      expect.objectContaining({ exitCode: 1 })
    );
  });

  // =========================================================================
  // Test H: Persistence & Trajectory Relational Integrity
  // =========================================================================
  it("Test H — Multi-step coding trajectory maintains Action -> Attempt relational integrity in SQLite", async () => {
    const { run, lease, ws } = await setupCodingRun("Trajectory persistence.");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-read",
        toolName: "read_file",
        inputPayload: { path: "src/calculator.js" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    const actions = store.getActionsForRun(run.runId);
    expect(actions.length).toBe(2);

    expect(actions[0]!.sequenceNumber).toBe(1);
    expect(actions[0]!.toolName).toBe("read_file");
    expect(actions[0]!.status).toBe("SUCCEEDED");

    expect(actions[1]!.sequenceNumber).toBe(2);
    expect(actions[1]!.toolName).toBe("write_file");
    expect(actions[1]!.status).toBe("SUCCEEDED");

    const attempts1 = store.getAttemptsForAction(actions[0]!.actionId);
    expect(attempts1.length).toBe(1);
    expect(attempts1[0]!.runId).toBe(run.runId);
    expect(attempts1[0]!.status).toBe("SUCCEEDED");

    const attempts2 = store.getAttemptsForAction(actions[1]!.actionId);
    expect(attempts2.length).toBe(1);
    expect(attempts2[0]!.runId).toBe(run.runId);
    expect(attempts2[0]!.status).toBe("SUCCEEDED");
  });

  // =========================================================================
  // Test I: Security Invariants (Model Cannot Control Authority Fields)
  // =========================================================================
  it("Test I — Forged infrastructure authority fields in proposal are rejected", async () => {
    const { run, lease, ws } = await setupCodingRun("Forged authority proposal.");

    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-forged",
        toolName: "run_command",
        inputPayload: {
          argv: ["node", "test/calculator.test.js"],
        },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        workerId: "rogue-worker",
        leaseId: "stolen-lease",
        contractId: "counterfeit-contract",
      } as any,
    }));

    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 2 },
    });

    expect(result.transcript[0]!.proposalValid).toBe(false);
    expect(result.transcript[0]!.proposalRejectionReason).toBe("FORBIDDEN_AUTHORITY_FIELD");
    expect(result.totalActions).toBe(0);
  });

  // =========================================================================
  // Test J: Historical Evaluation Artifact Integrity
  // =========================================================================
  it("Test J — All 9 historical evaluation artifacts remain byte-for-byte intact", async () => {
    for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
      const fullPath = path.join(SCRATCH_DIR, filename);
      const exists = await fs.access(fullPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      const buf = await fs.readFile(fullPath);
      const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
      expect(actualSha256).toBe(expectedSha256.toUpperCase());
    }
  });

  // =========================================================================
  // Test K: Completion Verification Contract Metric (Phase 13A)
  // =========================================================================
  it("Test K — Deterministically detects premature goal completion when GOAL_REACHED precedes physical test verification", async () => {
    // Subcase 1: Premature completion (write_file -> GOAL_REACHED)
    const run1 = await setupCodingRun("Premature completion check");
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const resultPremature = await stepController.runStepLoop({
      runId: run1.run.runId,
      leaseId: run1.lease.leaseId,
      workerId,
      workspace: run1.ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    const hasRunCommand = resultPremature.transcript.some((t) => t.toolName === "run_command");
    const premature = resultPremature.transcript.some((t) => t.finishReason === "GOAL_REACHED") && !hasRunCommand;
    expect(premature).toBe(true);
    expect(hasRunCommand).toBe(false);

    // Subcase 2: Verified completion (write_file -> git_diff -> run_command -> GOAL_REACHED)
    const run2 = await setupCodingRun("Verified completion check");
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-2",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-2",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-2",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));
    brain.queueStep(() => ({ finishReason: "GOAL_REACHED" }));

    const resultVerified = await stepController.runStepLoop({
      runId: run2.run.runId,
      leaseId: run2.lease.leaseId,
      workerId,
      workspace: run2.ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5 },
    });

    const hasRunCommandVerified = resultVerified.transcript.some(
      (t) => t.toolName === "run_command" && (t.actionOutput as any)?.exitCode === 0
    );
    const prematureVerified =
      resultVerified.transcript.some((t) => t.finishReason === "GOAL_REACHED") && !hasRunCommandVerified;
    expect(prematureVerified).toBe(false);
    expect(hasRunCommandVerified).toBe(true);
  });
});
