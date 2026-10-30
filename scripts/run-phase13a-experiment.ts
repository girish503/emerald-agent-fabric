/**
 * Phase 13A — Completion Verification Contract Experiment Runner.
 *
 * Investigates whether presenting an explicit model-facing Completion Verification Contract
 * prevents premature goal completion by local llama3.2:3b on CPU.
 *
 * Baseline (Phase 13):
 * Step 1: read_file -> SUCCESS
 * Step 2: write_file -> SUCCESS (repair applied)
 * Step 3: isGoalReached: true -> PREMATURE COMPLETION (no diff, no test)
 *
 * Hypothesis:
 * Explicitly requiring physical verification before isGoalReached: true reduces
 * premature completion by the local llama3.2:3b model.
 *
 * Invariants & Experimental Rigor:
 * 1. Zero runtime architecture changes (Reflex, StepController, Gateway, Policies frozen).
 * 2. Exactly identical fixture (src/math.js with subtraction defect, test/math.test.js).
 * 3. Exactly identical infrastructure (Ollama, llama3.2:3b, CPU, Docker node:22-alpine).
 * 4. All historical evaluation artifacts (Phases 9, 10, 11, 12, 13) verified intact.
 * 5. Captures complete multi-step trajectory, latencies, context sizes, and binary metric:
 *    prematureGoalCompletion = isGoalReached === true && !verificationSuccessfullyExecuted.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { DockerExecutionProvider } from "../src/adapters/execution/docker-execution-provider.js";
import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";
import { SqliteStateStore } from "../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  DEFAULT_STEP_CONTROLLER_BUDGET,
} from "../src/application/agent-step-controller.js";
import { ContextSource } from "../src/application/context/context-source.js";
import { LiveAgentBrain } from "../src/application/live-agent-brain.js";
import { ProposalValidator } from "../src/application/proposal-validator.js";
import { RunCoordinator } from "../src/application/run-coordinator.js";
import { WorkerRuntime } from "../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../src/domain/policy.js";
import { staticToolRegistry } from "../src/domain/tool.js";
import { SystemClock } from "../src/ports/clock.port.js";
import { createMockGitRepository } from "../tests/adapters/tools/git-test-helper.js";
import { createAndActivateContract } from "../tests/application/test-helpers.js";

// ============================================================================
// 1. Historical Artifact Protection
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

function verifyHistoricalArtifactsPreserved(): void {
  for (const [filename, expectedSha256] of Object.entries(HISTORICAL_HASHES)) {
    const fullPath = path.join(SCRATCH_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Historical artifact missing: ${filename}`);
    }
    const buf = fs.readFileSync(fullPath);
    const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
    if (actualSha256 !== expectedSha256.toUpperCase()) {
      throw new Error(
        `Historical artifact corrupted! ${filename} expected ${expectedSha256}, got ${actualSha256}`
      );
    }
  }

  // Also confirm Phase 13 baseline evidence exists
  const phase13BaselinePath = path.join(SCRATCH_DIR, "phase13-smoke-evidence.json");
  if (!fs.existsSync(phase13BaselinePath)) {
    throw new Error("Phase 13 baseline evidence missing: phase13-smoke-evidence.json");
  }
  console.log("[PREFLIGHT] All 9 historical evaluation artifacts + Phase 13 baseline verified intact.");
}

// ============================================================================
// 2. Fixture Source & Tests (Identical to Phase 13)
// ============================================================================

const DEFECTIVE_MATH_JS = `/**
 * Math utilities.
 */

// Computes the sum of two numbers
function add(a, b) {
  // Defect: subtracts instead of adds
  return a - b;
}

module.exports = { add };
`;

const MATH_TEST_JS = `const assert = require("assert");
const { add } = require("../src/math.js");

try {
  assert.strictEqual(add(2, 3), 5, "add(2, 3) must equal 5");
  assert.strictEqual(add(-1, 1), 0, "add(-1, 1) must equal 0");
  assert.strictEqual(add(0, 0), 0, "add(0, 0) must equal 0");
  console.log("PASS: All math tests passed successfully.");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
`;

// ============================================================================
// 3. Model-Facing Completion Verification Contract
// ============================================================================

const COMPLETION_CONTRACT_SYSTEM_INSTRUCTION = `You are a reasoning component within the Emerald Agent Fabric.
Your role is to propose actions to achieve the assigned mission task.
You are a reasoning component.
You propose actions.
You do not execute actions.
You do not possess authority.
Your output is untrusted.
The execution system will independently validate your proposal.

Operational Rules:
1. Inspect the provided execution context observations carefully.
2. Select an appropriate registered tool from the available tools list.
3. Propose exact, bounded input arguments matching the tool's parameter schema.
4. BINDING COMPLETION CONTRACT:
   A coding task cannot be considered complete merely because a file was written.
   You must NEVER set isGoalReached: true immediately following write_file.
   Before setting isGoalReached: true, you MUST:
   a. Inspect the resulting patch using git_diff (path: '.').
   b. Execute the verification test command using run_command (argv: ['node', 'test/math.test.js']).
   c. Observe the physical execution result in the context observations.
   d. Set isGoalReached: true ONLY when the test command has physically executed and returned exitCode: 0.
5. If physical verification has not yet executed or if tests fail, you must propose the next required tool action.
6. Never attempt to specify infrastructure authority fields (workerId, leaseId, contracts, capabilities, mount paths, retry limits, execution status).
7. Format your response strictly according to the required action proposal schema.`;

const COMPLETION_CONTRACT_TASK_DIRECTIVE = `Fix the defect in src/math.js.

REQUIRED EXECUTION SEQUENCE:
1. Read 'src/math.js' using read_file to locate the arithmetic bug.
2. Fix the defect in 'src/math.js' using write_file.
3. Inspect the diff using git_diff (path: '.') to confirm the change is bounded and correct.
4. Run the test command using run_command (argv: ['node', 'test/math.test.js']) to verify tests pass.
5. Set isGoalReached: true ONLY AFTER observing that the test command succeeded with exitCode: 0.

BINDING RULE: Do NOT set isGoalReached: true immediately after write_file. You MUST run git_diff and run_command before declaring completion.`;

// ============================================================================
// 4. Main Experiment Runner
// ============================================================================

async function main() {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 13A COMPLETION VERIFICATION EXPERIMENT");
  console.log("======================================================================");

  // 1. Invariant verification
  verifyHistoricalArtifactsPreserved();

  // Load Phase 13 baseline for direct comparison
  const baselineEvidenceRaw = fs.readFileSync(
    path.join(SCRATCH_DIR, "phase13-smoke-evidence.json"),
    "utf8"
  );
  const baselineData = JSON.parse(baselineEvidenceRaw);

  // 2. Verify Ollama connectivity
  const baseUrl = "http://127.0.0.1:11434";
  const modelName = "llama3.2:3b";
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Ollama returned status ${res.status}`);
    }
    const tags = (await res.json()) as any;
    const hasModel = tags.models?.some((m: any) => m.name === modelName || m.model === modelName);
    if (!hasModel) {
      throw new Error(`Required model '${modelName}' not found in Ollama.`);
    }
    console.log(`[PREFLIGHT] Ollama live at ${baseUrl} with model ${modelName}`);
  } catch (err: unknown) {
    console.error(`[FATAL] Ollama preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 3. Verify Docker availability
  const dockerProbe = await DockerExecutionProvider.isAvailable();
  if (!dockerProbe.available) {
    console.error("[FATAL] Docker daemon is not available for containerized command execution.");
    process.exit(1);
  }
  console.log("[PREFLIGHT] Docker daemon is online and responsive.");

  // 4. Provision isolated test environment
  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase13a-live-"));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
  const coordinator = new RunCoordinator(store, clock);
  const executionProvider = new DockerExecutionProvider();

  const workerId = "worker-phase13a-live";
  const leaseTtlMs = 1_800_000; // 30 minutes lease

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

  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort: workspaceAdapter,
    executionProvider,
    isIsolationAvailable: true,
  });

  const proposalValidator = new ProposalValidator({
    coordinator,
    stateStore: store,
    toolRegistry: staticToolRegistry,
    clock,
  });

  const modelProvider = new OllamaModelProvider({
    baseUrl,
    defaultModel: modelName,
  });

  // Inject the explicit Completion Verification Contract into LiveAgentBrain
  const liveBrain = new LiveAgentBrain({
    modelProvider,
    model: modelName,
    systemInstruction: COMPLETION_CONTRACT_SYSTEM_INSTRUCTION,
    timeoutMs: 360_000,
    generationOptions: {
      temperature: 0.0,
      maxOutputTokens: 1024,
    },
    clock,
  });

  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: liveBrain,
    proposalValidator,
    toolRegistry: staticToolRegistry,
    clock,
  });

  // Setup Task with the Completion Contract Directive
  const task = coordinator.createTask({
    title: "Repair Defect with Mandatory Completion Contract",
    description: COMPLETION_CONTRACT_TASK_DIRECTIVE,
    inputPayload: { directive: COMPLETION_CONTRACT_TASK_DIRECTIVE },
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
    timeoutMs: 180_000,
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

  // Create clean Git repository with identical defective code
  const repoInfo = await createMockGitRepository(ws.hostPath, [
    { path: "README.md", content: "# Math Service\nRun tests: node test/math.test.js\n" },
    { path: "src/math.js", content: DEFECTIVE_MATH_JS },
    { path: "test/math.test.js", content: MATH_TEST_JS },
  ]);

  console.log(`[SETUP] Task: ${task.taskId}`);
  console.log(`[SETUP] Contract: ${contract.spec.contractId} (v${contract.spec.version})`);
  console.log(`[SETUP] Run: ${run.runId}`);
  console.log(`[SETUP] Lease: ${claimResult.lease.leaseId}`);
  console.log(`[SETUP] Workspace: ${ws.hostPath}`);
  console.log(`[SETUP] Initial Git Commit: ${repoInfo.commitSha}`);

  // Execute Governed Step Loop (budget: maxSteps=8)
  console.log("\n[EXEC] Initiating Phase 13A Completion Contract Loop (budget: maxSteps=8)...");
  const wallClockStart = performance.now();

  const stepResult = await stepController.runStepLoop({
    runId: run.runId,
    leaseId: claimResult.lease.leaseId,
    workerId,
    workspace: ws,
    budget: {
      ...DEFAULT_STEP_CONTROLLER_BUDGET,
      maxSteps: 8,
      maxActions: 8,
      maxWallClockMs: 1_800_000,
    },
  });

  const wallClockTotalMs = Math.round(performance.now() - wallClockStart);
  console.log(
    `[EXEC] Loop finished with terminalReason: ${stepResult.terminalReason} (totalSteps: ${stepResult.totalSteps}, totalActions: ${stepResult.totalActions}) in ${wallClockTotalMs}ms`
  );

  // 5. Extract Evidence & Observations
  const transcript = stepResult.transcript;
  const actions = store.getActionsForRun(run.runId);
  const contextSource = new ContextSource(store);
  const currentObservations = await contextSource.gatherCandidateObservations(run.runId);

  // Inspect physical outcome
  const finalMathJsContent = fs.readFileSync(path.join(ws.hostPath, "src/math.js"), "utf8");
  const sourceModified = finalMathJsContent !== DEFECTIVE_MATH_JS;
  const fixApplied = finalMathJsContent.includes("return a + b;");

  const writeAction = transcript.find((t) => t.toolName === "write_file");
  const diffAction = transcript.find((t) => t.toolName === "git_diff");
  const testActions = transcript.filter((t) => t.toolName === "run_command");
  const lastTestAction = testActions.length > 0 ? testActions[testActions.length - 1] : undefined;
  const lastTestOutput = lastTestAction?.actionOutput as any;
  const verificationPassed = lastTestOutput?.exitCode === 0;

  // Key Phase 13A binary metric: premature completion
  // True if isGoalReached was emitted before physical verification successfully ran
  const goalReachedStepIndex = transcript.findIndex((t) => t.finishReason === "GOAL_REACHED");
  const firstSuccessfulTestStepIndex = transcript.findIndex(
    (t) => t.toolName === "run_command" && (t.actionOutput as any)?.exitCode === 0
  );

  const prematureGoalCompletion =
    goalReachedStepIndex !== -1 &&
    (firstSuccessfulTestStepIndex === -1 || goalReachedStepIndex < firstSuccessfulTestStepIndex);

  const gitDiffExecuted = Boolean(diffAction);
  const runCommandExecuted = testActions.length > 0;

  // Hypothesis outcome determination
  const hypothesisSupported =
    !prematureGoalCompletion &&
    gitDiffExecuted &&
    runCommandExecuted &&
    verificationPassed;

  const hypothesisStatus = hypothesisSupported ? "SUPPORTED" : "NOT_SUPPORTED";

  const evidence = {
    experiment: "Phase 13A — Completion Verification Contract",
    model: modelName,
    hypothesisStatus,
    timestamp: new Date().toISOString(),

    baseline: {
      trajectory: ["read_file", "write_file", "GOAL_REACHED"],
      prematureGoalCompletion: true,
      gitDiffExecuted: false,
      runCommandExecuted: false,
      verificationPassed: false,
      totalSteps: baselineData.evidence.totalSteps,
      totalWallClockMs: baselineData.evidence.metrics.totalWallClockMs,
    },

    experimentOutcome: {
      trajectory: transcript.map((t) => t.toolName ?? t.finishReason ?? "UNKNOWN"),
      prematureGoalCompletion,
      gitDiffExecuted,
      runCommandExecuted,
      verificationPassed,
      sourceModified,
      fixApplied,
      terminalReason: stepResult.terminalReason,
      terminalMessage: stepResult.terminalMessage,
      totalSteps: stepResult.totalSteps,
      totalActions: stepResult.totalActions,
    },

    steps: transcript.map((s) => ({
      stepNumber: s.stepNumber,
      toolName: s.toolName ?? null,
      inputPayload: s.inputPayload ?? null,
      finishReason: s.finishReason ?? null,
      proposalValid: s.proposalValid,
      actionId: s.actionId ?? null,
      actionStatus: s.actionStatus ?? null,
      actionOutput: s.actionOutput ?? null,
      durationMs: s.durationMs,
      contextBytes: s.contextBytes,
    })),

    metrics: {
      totalWallClockMs: wallClockTotalMs,
      modelCallsCount: transcript.length,
      stepLatenciesMs: transcript.map((s) => s.durationMs),
      contextSizesBytes: transcript.map((s) => s.contextBytes),
    },
  };

  // 6. Persist Evidence Artifact
  const artifactPath = path.join(SCRATCH_DIR, "phase13a-completion-contract-evidence.json");
  fs.writeFileSync(artifactPath, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`\n[ARTIFACT] Evidence persisted to: ${artifactPath}`);

  // 7. Print Direct Comparison
  console.log("\n======================================================================");
  console.log(`PHASE 13A HYPOTHESIS STATUS: ${hypothesisStatus}`);
  console.log("======================================================================");
  console.log("COMPARISON TABLE:");
  console.log(`  Metric                             | Baseline (Phase 13) | Experiment (Phase 13A)`);
  console.log(`  -----------------------------------+---------------------+-----------------------`);
  console.log(`  Premature Goal Completion          | YES                 | ${prematureGoalCompletion ? "YES" : "NO"}`);
  console.log(`  git_diff Executed                  | NO                  | ${gitDiffExecuted ? "YES" : "NO"}`);
  console.log(`  run_command Executed               | NO                  | ${runCommandExecuted ? "YES" : "NO"}`);
  console.log(`  Verification Passed                | NO                  | ${verificationPassed ? "YES" : "NO"}`);
  console.log(`  Source Modified                    | YES                 | ${sourceModified ? "YES" : "NO"}`);
  console.log(`  Fix Applied                        | YES                 | ${fixApplied ? "YES" : "NO"}`);
  console.log(`  Total Steps                        | ${baselineData.evidence.totalSteps}                   | ${stepResult.totalSteps}`);
  console.log(`  Total Wall Clock                   | ${baselineData.evidence.metrics.totalWallClockMs} ms            | ${wallClockTotalMs} ms`);
  console.log(`  Trajectory                         | ${evidence.baseline.trajectory.join(" -> ")} | ${evidence.experimentOutcome.trajectory.join(" -> ")}`);
  console.log("======================================================================\n");

  // Cleanup temp files
  try {
    store.close();
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error("[FATAL] Phase 13A Completion Contract Experiment failed:", err);
  process.exit(1);
});
