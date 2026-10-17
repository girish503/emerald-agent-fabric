/**
 * Phase 13B — Authoritative Physical Verification Completion Gate Live Smoke Experiment Runner.
 *
 * Enforces the core invariant:
 *   MODEL_GOAL_REACHED != RUN_COMPLETED
 *
 * Demonstrates:
 * 1. The local model (llama3.2:3b via Ollama) operates under an authoritative Mission Contract
 *    containing a strict EXIT_CODE_ZERO physical verification specification.
 * 2. If the model emits isGoalReached: true prematurely (e.g. immediately after write_file),
 *    the AgentStepController invokes evaluateCompletionVerification(), derives ground-truth
 *    execution state strictly from SQLite Action/Attempt records, rejects the claim as
 *    UNVERIFIED_COMPLETION_CLAIM, and refuses to transition the run to COMPLETED.
 * 3. Model self-attestation is strictly an untrusted proposal.
 * 4. Distinguishes modelClaimedCompletion from emeraldAcceptedCompletion.
 * 5. Persists durable evidence to scratch/phase13b-completion-gate-evidence.json.
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
import { createVerificationSpec } from "../src/domain/verification.js";
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
  console.log("[PREFLIGHT] All 9 historical evaluation artifacts verified byte-for-byte intact.");
}

// ============================================================================
// 2. Fixture Source & Tests
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
// 3. Main Live Runner
// ============================================================================

async function main() {
  console.log("======================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 13B AUTHORITATIVE VERIFICATION GATE");
  console.log("======================================================================");

  // 1. Invariant verification
  verifyHistoricalArtifactsPreserved();

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
  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase13b-live-"));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });
  const coordinator = new RunCoordinator(store, clock);
  const executionProvider = new DockerExecutionProvider();

  const workerId = "worker-phase13b-live";
  const leaseTtlMs = 1_800_000; // 30 minutes lease for CPU coding loop

  // Register worker
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

  const liveBrain = new LiveAgentBrain({
    modelProvider,
    model: modelName,
    timeoutMs: 360_000, // 6 minutes timeout per model call on CPU
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

  const taskDirective =
    "Fix the defect in src/math.js. You must execute these steps in order: First, run the test command with run_command (argv: ['node', 'test/math.test.js']) to observe the failure. Second, read 'src/math.js' with read_file. Third, repair the defect in 'src/math.js' using write_file. Fourth, inspect the patch with git_diff (path: '.'). Fifth, re-run the test command with run_command (argv: ['node', 'test/math.test.js']) to confirm tests pass. Finally, conclude with isGoalReached: true only after receiving a passing test result.";

  const task = coordinator.createTask({
    title: "Repair Defect in Math Module with Verification Gate",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  // Authoritative physical verification specification
  const verificationSpec = createVerificationSpec({
    specId: `verify-${task.taskId}`,
    ruleKind: "EXIT_CODE_ZERO",
    expectedValue: {
      toolName: "run_command",
      argv: ["node", "test/math.test.js"],
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

  // Create clean Git repository with defective code
  const repoInfo = await createMockGitRepository(ws.hostPath, [
    { path: "README.md", content: "# Math Service\nRun tests: node test/math.test.js\n" },
    { path: "src/math.js", content: DEFECTIVE_MATH_JS },
    { path: "test/math.test.js", content: MATH_TEST_JS },
  ]);

  console.log(`[SETUP] Task: ${task.taskId}`);
  console.log(`[SETUP] Contract: ${contract.spec.contractId} (v${contract.spec.version})`);
  console.log(`[SETUP] Verification Spec: ruleKind=${verificationSpec.ruleKind}, argv=${JSON.stringify(verificationSpec.expectedValue.argv)}`);
  console.log(`[SETUP] Run: ${run.runId}`);
  console.log(`[SETUP] Lease: ${claimResult.lease.leaseId}`);
  console.log(`[SETUP] Workspace: ${ws.hostPath}`);
  console.log(`[SETUP] Initial Git Commit: ${repoInfo.commitSha}`);

  // 6. Execute Governed Step Loop (budget: maxSteps=6)
  console.log("\n[EXEC] Initiating Governed Step Loop under Phase 13B Completion Gate (budget: maxSteps=6)...");
  const wallClockStart = performance.now();

  const stepResult = await stepController.runStepLoop({
    runId: run.runId,
    leaseId: claimResult.lease.leaseId,
    workerId,
    workspace: ws,
    budget: {
      ...DEFAULT_STEP_CONTROLLER_BUDGET,
      maxSteps: 6,
      maxActions: 6,
      maxWallClockMs: 1_800_000,
    },
  });

  const wallClockTotalMs = Math.round(performance.now() - wallClockStart);
  console.log(
    `[EXEC] Loop finished with terminalReason: ${stepResult.terminalReason} (totalSteps: ${stepResult.totalSteps}, totalActions: ${stepResult.totalActions}) in ${wallClockTotalMs}ms`
  );

  // 7. Extract Evidence & Observations
  const transcript = stepResult.transcript;
  const actions = store.getActionsForRun(run.runId);
  const contextSource = new ContextSource(store);
  const currentObservations = await contextSource.gatherCandidateObservations(run.runId);

  // Check physical state of src/math.js on disk
  const finalMathJsContent = fs.readFileSync(path.join(ws.hostPath, "src/math.js"), "utf8");
  const sourceModified = finalMathJsContent !== DEFECTIVE_MATH_JS;
  const fixApplied = finalMathJsContent.includes("return a + b;");

  // Check tool execution occurrences in transcript
  const writeAction = transcript.find((t) => t.toolName === "write_file");
  const diffAction = transcript.find((t) => t.toolName === "git_diff");
  const testActions = transcript.filter((t) => t.toolName === "run_command");
  const lastTestAction = testActions.length > 0 ? testActions[testActions.length - 1] : undefined;
  const lastTestOutput = lastTestAction?.actionOutput as any;
  const testPassed = lastTestOutput?.exitCode === 0;

  // Analysis of Model Claim vs Emerald Gate Acceptance
  const modelGoalClaims = transcript.filter((t) => t.finishReason === "GOAL_REACHED");
  const modelClaimedCompletion = modelGoalClaims.length > 0;
  const emeraldAcceptedCompletion = stepResult.terminalReason === "COMPLETED";

  // Rejections specifically due to unverified completion claims
  const unverifiedRejections = transcript.filter(
    (t) => t.proposalRejectionReason === "UNVERIFIED_COMPLETION_CLAIM"
  );

  // Durable SQLite evidence records
  const durableEvidences = store.getEvidenceForRun?.(run.runId) ?? [];
  const durableVerifications = store.getVerificationResultsForRun?.(run.runId) ?? [];

  // Determine gate invariant holding:
  // An unverified goal claim MUST NEVER result in COMPLETED.
  // Emerald accepted completion IFF physical verification actually passed.
  const coreInvariantHolds =
    (!testPassed && !emeraldAcceptedCompletion) ||
    (testPassed && Boolean(writeAction) && Boolean(diffAction) && emeraldAcceptedCompletion);

  const evidence = {
    runId: run.runId,
    taskId: task.taskId,
    model: modelName,
    totalSteps: stepResult.totalSteps,
    totalActions: stepResult.totalActions,
    terminalReason: stepResult.terminalReason,
    terminalMessage: stepResult.terminalMessage,

    // Core Invariant Metrics
    modelClaimedCompletion,
    emeraldAcceptedCompletion,
    unverifiedCompletionRejections: unverifiedRejections.length,
    coreInvariantHolds,

    // Physical State & Execution
    sourceModified,
    fixApplied,
    diffInspected: Boolean(diffAction),
    testExecuted: testActions.length > 0,
    finalTestPassed: testPassed,
    finalDiffSummary: diffAction?.actionOutput ?? null,
    totalActionsPersisted: actions.length,
    totalObservationsPersisted: currentObservations.length,
    totalEvidenceRecords: durableEvidences.length,
    totalVerificationRecords: durableVerifications.length,

    steps: transcript.map((s) => ({
      stepNumber: s.stepNumber,
      toolName: s.toolName ?? null,
      inputPayload: s.inputPayload ?? null,
      rationale: s.rationale ?? null,
      finishReason: s.finishReason ?? null,
      proposalValid: s.proposalValid,
      proposalRejectionReason: s.proposalRejectionReason ?? null,
      reflexDecision: s.reflexDecision ?? null,
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

  // 8. Gate Determination
  const gateChecks = [
    { name: "Step loop concluded within ceiling (<= 6 steps)", passed: evidence.totalSteps <= 6 },
    { name: "Model generated valid proposals", passed: transcript.some((t) => t.proposalValid) },
    { name: "write_file tool invoked on src/math.js", passed: Boolean(writeAction) },
    { name: "Source file modified on disk", passed: sourceModified },
    {
      name: "Model goal self-attestation decoupled from run completion (MODEL_GOAL_REACHED != RUN_COMPLETED)",
      passed: coreInvariantHolds,
    },
    {
      name: "Unverified completion claim rejected when verification missing",
      passed: !modelClaimedCompletion || testPassed || unverifiedRejections.length > 0,
    },
    {
      name: "Run only COMPLETED if physical test execution succeeded (exitCode 0)",
      passed: !emeraldAcceptedCompletion || testPassed,
    },
    { name: "Action/Attempt records persisted in SQLite", passed: actions.length >= 1 },
    { name: "Observations generated and propagated", passed: currentObservations.length > 0 },
    {
      name: "No authority leakage or bypass",
      passed: transcript.every(
        (t) => !t.proposalRejectionReason || t.proposalRejectionReason !== "FORBIDDEN_AUTHORITY_FIELD"
      ),
    },
  ];

  const allPassed = gateChecks.every((c) => c.passed);
  const gateStatus = allPassed ? "PASSED" : "FAILED";

  // 9. Persist Evidence Artifact
  const artifactPath = path.join(SCRATCH_DIR, "phase13b-completion-gate-evidence.json");
  const summaryPayload = {
    phase: "Phase 13B",
    title: "Authoritative Physical Verification Completion Gate",
    model: modelName,
    gateStatus,
    timestamp: new Date().toISOString(),
    coreInvariant: "MODEL_GOAL_REACHED != RUN_COMPLETED",
    gateChecks,
    evidence,
  };
  fs.writeFileSync(artifactPath, JSON.stringify(summaryPayload, null, 2), "utf8");
  console.log(`\n[ARTIFACT] Evidence persisted to: ${artifactPath}`);

  // 10. Print Summary
  console.log("\n======================================================================");
  console.log(`PHASE 13B GATE DETERMINATION: ${gateStatus}`);
  console.log("======================================================================");
  for (const check of gateChecks) {
    console.log(`  [${check.passed ? "PASS" : "FAIL"}] ${check.name}`);
  }
  console.log("\n--- CORE INVARIANT STATUS ---");
  console.log(`  Model Claimed Completion:        ${evidence.modelClaimedCompletion}`);
  console.log(`  Emerald Accepted Completion:     ${evidence.emeraldAcceptedCompletion}`);
  console.log(`  Unverified Claim Rejections:     ${evidence.unverifiedCompletionRejections}`);
  console.log(`  Core Invariant Holds:            ${evidence.coreInvariantHolds}`);
  console.log(`  Terminal Reason:                 ${evidence.terminalReason}`);
  console.log("\n--- PHYSICAL EXECUTION METRICS ---");
  console.log(`  Total Wall Clock:       ${evidence.metrics.totalWallClockMs} ms`);
  console.log(`  Model Calls Count:      ${evidence.metrics.modelCallsCount}`);
  console.log(`  Source Modified:        ${evidence.sourceModified}`);
  console.log(`  Fix Applied:            ${evidence.fixApplied}`);
  console.log(`  Diff Inspected:         ${evidence.diffInspected}`);
  console.log(`  Test Executed:          ${evidence.testExecuted}`);
  console.log(`  Final Test Passed:      ${evidence.finalTestPassed}`);
  for (let i = 0; i < transcript.length; i++) {
    const s = transcript[i];
    console.log(
      `  Step ${s.stepNumber} [${s.toolName ?? s.finishReason}]: status=${s.actionStatus ?? (s.proposalValid ? "VALID" : "REJECTED:" + s.proposalRejectionReason)} duration=${s.durationMs}ms (${s.contextBytes} bytes)`
    );
  }
  console.log("======================================================================\n");

  // Cleanup temp files
  try {
    store.close();
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL] Phase 13B Completion Gate Smoke failed:", err);
  process.exit(1);
});
