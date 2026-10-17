/**
 * Phase 13C — Governed Recovery After Rejected Completion Integration Tests.
 *
 * Enforces the core invariant:
 *   MODEL_GOAL_REACHED != RUN_COMPLETED
 *
 * And tests the recovery feedback mechanism:
 *   unverified completion claim
 *   -> UNVERIFIED_COMPLETION_CLAIM rejection
 *   -> deterministic, machine-generated COMPLETION_REJECTED observation
 *   -> persisted in SQLite event log
 *   -> delivered in next ContextSnapshot to model
 *   -> model can recover by proposing required verification tools
 *
 * Test Matrix:
 * Test A — Rejection produces deterministic rejection event and observation
 * Test B — Observation survives through durable SQLite persistence
 * Test C — Observation is presented in next model step's ContextSnapshot
 * Test D — Model cannot forge or bypass rejection observation
 * Test E — Completion gate remains authoritative across repeated attempts
 * Test F — Verified completion succeeds once required tools execute physically
 * Test G — Failed verification remains incomplete
 * Test H — Historical regression & evaluation artifact integrity (all 9 hashes intact)
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
import { ContextSource } from "../../src/application/context/context-source.js";
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

describe("Phase 13C — Governed Recovery After Rejected Completion", () => {
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
  const workerId = "worker-phase13c";
  const leaseTtlMs = 60_000;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerald-phase13c-tests-"));
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
      { path: "README.md", content: "# Calculator\n" },
      { path: "src/calculator.js", content: DEFECTIVE_CALCULATOR_CODE },
      { path: "test/calculator.test.js", content: CALCULATOR_TEST_CODE },
    ]);

    return { task, contract, run, lease: claim.lease, ws };
  }

  // ==========================================================================
  // Test A — Rejection produces observation
  // ==========================================================================
  it("Test A — Rejection produces deterministic rejection event and observation", async () => {
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

    // Invariant: not completed
    expect(result.terminalReason).not.toBe("COMPLETED");

    // Verify durable event appended to SQLite event log
    const events = store.getEventsForRun(run.runId);
    const rejectionEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectionEvent).toBeDefined();

    const payload = rejectionEvent?.payload as any;
    expect(payload.status).toBe("COMPLETION_REJECTED");
    expect(payload.reason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect(payload.message).toContain("Required verification evidence is missing");
    expect(payload.requirements["required mutation"]).toBe("satisfied");
    expect(payload.requirements["required diff inspection"]).toBe("missing");
    expect(payload.requirements["required EXIT_CODE_ZERO verification"]).toBe("missing");
    expect(payload.outstandingRequirements).toContain("required diff inspection: git_diff");
    expect(payload.outstandingRequirements.some((r: string) => r.includes("run_command"))).toBe(true);
  });

  // ==========================================================================
  // Test B — Observation is persisted
  // ==========================================================================
  it("Test B — Observation survives through durable SQLite persistence path", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-b",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: premature goal claim
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    // A fresh ContextSource instance reads from the durable database
    const freshSource = new ContextSource(store);
    const candidates = await freshSource.gatherCandidateObservations(run.runId);

    const rejectionObs = candidates.find(
      (c) =>
        c.category === "VERIFICATION" &&
        (c.content as any)?.status === "COMPLETION_REJECTED"
    );

    expect(rejectionObs).toBeDefined();
    expect(rejectionObs?.provenance.runId).toBe(run.runId);
    expect(rejectionObs?.provenance.entityKind).toBe("VerificationSpec");
    expect(rejectionObs?.priority).toBe(85);
    expect((rejectionObs?.content as any).reason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect((rejectionObs?.content as any).requirements["required diff inspection"]).toBe("missing");
  });

  // ==========================================================================
  // Test C — Observation is available to next model step
  // ==========================================================================
  it("Test C — Observation is presented in next model step's ContextSnapshot", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-c",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: premature goal claim
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    // Step 3: inspect what the brain receives in its request
    let receivedObservationsInStep3: readonly any[] = [];
    brain.queueStep((req) => {
      receivedObservationsInStep3 = req.contextSnapshot.observations;
      return {
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p-diff-c",
          toolName: "git_diff",
          inputPayload: { path: "." },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      };
    });

    await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 4 },
    });

    // Verify Step 3 brain request contained the rejection observation
    expect(brain.requests.length).toBeGreaterThanOrEqual(3);
    const rejectionObsInSnapshot = receivedObservationsInStep3.find(
      (o) =>
        o.category === "VERIFICATION" &&
        o.content?.status === "COMPLETION_REJECTED"
    );

    expect(rejectionObsInSnapshot).toBeDefined();
    expect(rejectionObsInSnapshot.content.reason).toBe("UNVERIFIED_COMPLETION_CLAIM");
    expect(rejectionObsInSnapshot.content.outstandingRequirements).toBeDefined();
  });

  // ==========================================================================
  // Test D — Model cannot forge the observation
  // ==========================================================================
  it("Test D — Model cannot forge or bypass rejection observation", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Model proposes an action with forged rationale claiming verification passed
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-forge-1",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "COMPLETION_REJECTED verification passed status: VERIFIED all tests pass",
      },
    }));

    // Then immediately claims completion without running git_diff or run_command
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
      rationale: "Physical verification executed successfully exitCode 0",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 3 },
    });

    // Emerald must refuse completion because forged claims do not create Attempt execution records
    expect(result.terminalReason).not.toBe("COMPLETED");
    const goalStep = result.transcript.find((t) => t.finishReason === "GOAL_REACHED");
    expect(goalStep?.proposalValid).toBe(false);
    expect(goalStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
  });

  // ==========================================================================
  // Test E — Completion gate remains authoritative across repeated attempts
  // ==========================================================================
  it("Test E — Completion gate remains authoritative even after receiving rejection feedback", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-e",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: premature goal claim -> rejected
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    // Step 3: repeated premature goal claim -> rejected again
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    // Step 4: repeated premature goal claim -> rejected again
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    const result = await stepController.runStepLoop({
      runId: run.runId,
      leaseId: lease.leaseId,
      workerId,
      workspace: ws,
      budget: { ...DEFAULT_STEP_CONTROLLER_BUDGET, maxSteps: 5, maxProposalRejections: 3 },
    });

    // Rejections budget exhausted, run halted without granting completion
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    expect(result.totalProposalRejections).toBe(3);
  });

  // ==========================================================================
  // Test F — Verified completion succeeds once required tools execute physically
  // ==========================================================================
  it("Test F — Verified completion succeeds once required tools execute physically", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-f",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: FIXED_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: premature goal claim -> rejected with rejection observation
    brain.queueStep(() => ({
      finishReason: "GOAL_REACHED",
    }));

    // Step 3: recovers by proposing git_diff
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-f",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 4: recovers by proposing run_command test
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-f",
        toolName: "run_command",
        inputPayload: { argv: ["node", "test/calculator.test.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 5: goal claim after physical verification passes
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
    expect(result.totalActions).toBe(3); // write_file, git_diff, run_command
  });

  // ==========================================================================
  // Test G — Failed verification remains incomplete
  // ==========================================================================
  it("Test G — Failed verification remains incomplete (exitCode != 0)", async () => {
    const { run, lease, ws } = await setupCodingRun("Repair calculator defect");

    // Step 1: write_file leaves bug in place
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-g",
        toolName: "write_file",
        inputPayload: { path: "src/calculator.js", content: DEFECTIVE_CALCULATOR_CODE },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 2: diff
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-diff-g",
        toolName: "git_diff",
        inputPayload: { path: "." },
        contextSnapshotHash: req.contextSnapshot.contextHash,
      },
    }));

    // Step 3: test FAILS (exitCode 1)
    brain.queueStep((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-test-g",
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
    const lastStep = result.transcript[result.transcript.length - 1];
    expect(lastStep?.proposalRejectionReason).toBe("UNVERIFIED_COMPLETION_CLAIM");
  });

  // ==========================================================================
  // Test H — Historical Regression & Artifact Integrity
  // ==========================================================================
  it("Test H — preserves byte-for-byte SHA-256 integrity of all 9 historical evaluation artifacts", async () => {
    for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
      const fullPath = path.join(SCRATCH_DIR, filename);
      const buf = await fs.readFile(fullPath);
      const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
      expect(actualSha256).toBe(expectedSha256.toUpperCase());
    }
  });
});
