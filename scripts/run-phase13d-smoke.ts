/**
 * Phase 13D — Governed Verification Stage Experiment Live Smoke Runner.
 *
 * Runs the live experiment against real local Ollama (llama3.2:3b on CPU)
 * with the real math defect fixture, Docker sandboxed execution (node:22-alpine),
 * and contract-declared verification stage enabled in AgentStepController.
 *
 * Invariants & Boundaries:
 * 1. Model: llama3.2:3b via Ollama (http://127.0.0.1:11434).
 * 2. Real containerized tool execution (node:22-alpine via DockerExecutionProvider).
 * 3. Contract-declared verification stage executed exclusively via WorkerRuntime.
 * 4. Zero direct child_process/exec execution from controller.
 * 5. All 9 historical benchmark artifacts preserved byte-for-byte.
 * 6. Evidence persisted to scratch/phase13d-verification-stage-evidence.json.
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
  path.resolve(__dirname, "../tests/fixtures")
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
  console.log("EMERALD AGENT FABRIC — PHASE 13D GOVERNED VERIFICATION STAGE SMOKE");
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
  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase13d-live-"));
  const workspaceRootDir = path.join(tempBaseDir, "workspaces");
  fs.mkdirSync(workspaceRootDir, { recursive: true });

  const store = new SqliteStateStore();
  const clock = new SystemClock();
  const coordinator = new RunCoordinator(store, clock);
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: workspaceRootDir });

  const dockerProvider = new DockerExecutionProvider({
    image: "node:22-alpine",
    containerWorkdir: "/workspace",
  });

  const workerId = "worker-phase13d-live";
  const leaseTtlMs = 1_800_000;

  store.transaction((tx) => {
    tx.insertWorker({
      workerId,
      hostname: os.hostname(),
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
    executionProvider: dockerProvider,
    workspacePort: workspaceAdapter,
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
    timeoutMs: 600_000, // 10 minutes timeout per model call on CPU
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
    enableGovernedVerificationStage: true,
  });

  const taskDirective =
    "Fix the defect in src/math.js so that add(a, b) returns a + b. Step 1: Read 'src/math.js' using read_file. Step 2: Repair the defect in 'src/math.js' using write_file with the corrected complete function implementation. Step 3: Conclude with isGoalReached: true.";

  const task = coordinator.createTask({
    title: "Repair Defect in Math Module",
    description: taskDirective,
    inputPayload: { directive: taskDirective },
  });

  const verificationSpec = createVerificationSpec({
    specId: "verify-math-tests",
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
  console.log(`[SETUP] Run: ${run.runId}`);
  console.log(`[SETUP] Lease: ${claimResult.lease.leaseId}`);
  console.log(`[SETUP] Workspace: ${ws.hostPath}`);
  console.log(`[SETUP] Initial Git Commit: ${repoInfo.commitSha}`);

  // 5. Execute Governed Step Loop (budget: maxSteps=6)
  console.log("\n[EXEC] Initiating Governed Verification Stage Experiment Loop (budget: maxSteps=6)...");
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
  console.log(`[EXEC] Terminal message: ${stepResult.terminalMessage}`);
  for (const s of stepResult.transcript) {
    console.log(
      `  [STEP ${s.stepNumber}] tool=${s.toolName ?? "none"} finish=${s.finishReason} valid=${s.proposalValid} rationale=${s.rationale ?? "none"} duration=${s.durationMs}ms`
    );
  }

  // 6. Extract Evidence & Observations
  const transcript = stepResult.transcript;
  const actions = store.getActionsForRun(run.runId);
  const attempts = actions.flatMap((a) => store.getAttemptsForAction(a.actionId));
  const contextSource = new ContextSource(store);
  const currentObservations = await contextSource.gatherCandidateObservations(run.runId);

  // Check physical state of src/math.js on disk
  const finalMathJsContent = fs.readFileSync(path.join(ws.hostPath, "src/math.js"), "utf8");
  const sourceModified = finalMathJsContent !== DEFECTIVE_MATH_JS;
  const fixApplied = finalMathJsContent.includes("return a + b;");

  // Check verification tool executions
  const writeAction = transcript.find((t) => t.toolName === "write_file");
  const diffAction = transcript.find((t) => t.toolName === "git_diff");
  const testActions = transcript.filter((t) => t.toolName === "run_command");
  const lastTestAction = testActions.length > 0 ? testActions[testActions.length - 1] : undefined;
  const lastTestOutput = lastTestAction?.actionOutput as any;
  const testPassed = lastTestOutput?.exitCode === 0;

  const modelClaimedCompletion = transcript.some((s) => s.finishReason === "GOAL_REACHED");
  const verificationRequired = contract.spec.verificationSpecs !== undefined && contract.spec.verificationSpecs.length > 0;
  const verificationExecuted = diffAction !== undefined && testActions.length > 0;
  const verificationPassed = testPassed;
  const emeraldAcceptedCompletion = stepResult.terminalReason === "COMPLETED";

  const durableEvents = store.getEventsForRun(run.runId);
  const verificationResults = durableEvents
    .filter((e) => e.eventType === "evidence.recorded" || e.eventType === "verification.completed")
    .map((e) => e.payload);

  const completionClaims = transcript.filter((s) => s.finishReason === "GOAL_REACHED").length;
  const goalReachedIdx = transcript.findIndex((s) => s.finishReason === "GOAL_REACHED");
  const completionDecisions =
    goalReachedIdx >= 0
      ? [
          {
            step: goalReachedIdx + 1,
            accepted: emeraldAcceptedCompletion,
            reason: emeraldAcceptedCompletion ? "VERIFIED_COMPLETION" : "REJECTED",
          },
        ]
      : [];

  // Tool vs verification latencies
  const modelSteps = transcript.filter((s) => s.rationale !== "Contract-declared verification stage execution");
  const modelDurationMs = modelSteps.reduce((acc, s) => acc + s.durationMs, 0);
  const verificationSteps = transcript.filter((s) => s.rationale === "Contract-declared verification stage execution");
  const verificationDurationMs = verificationSteps.reduce((acc, s) => acc + s.durationMs, 0);

  const evidence = {
    taskId: task.taskId,
    contractId: contract.spec.contractId,
    contractVersion: contract.spec.version,
    verificationSpecs: contract.spec.verificationSpecs,
    modelCalls: modelSteps.length,
    orderedActions: actions.map((a) => ({
      actionId: a.actionId,
      sequenceNumber: a.sequenceNumber,
      toolName: a.toolName,
      status: a.status,
      inputPayload: a.inputPayload,
    })),
    orderedAttempts: attempts.map((att) => ({
      attemptId: att.attemptId,
      actionId: att.actionId,
      status: att.status,
      exitCode: att.exitCode,
      outputPayload: att.outputPayload,
    })),
    verificationActions: verificationSteps.map((v) => ({
      toolName: v.toolName,
      actionId: v.actionId,
      status: v.actionStatus,
      output: v.actionOutput,
    })),
    verificationResults,
    observations: currentObservations.map((o) => ({
      observationId: o.observationId,
      category: o.category,
      freshness: o.freshness,
      contentHash: o.contentHash,
    })),
    completionClaims,
    completionDecisions,
    finalRunState: {
      runId: run.runId,
      status: stepResult.terminalReason,
      totalSteps: stepResult.totalSteps,
      totalActions: stepResult.totalActions,
    },
    latencies: {
      totalWallClockMs: wallClockTotalMs,
      modelCallsMs: modelDurationMs,
      verificationMs: verificationDurationMs,
      perStepMs: transcript.map((s) => ({
        step: s.stepNumber,
        tool: s.toolName ?? "none",
        durationMs: s.durationMs,
      })),
    },
    contextSizes: transcript.map((s) => ({
      step: s.stepNumber,
      bytes: s.contextBytes,
      tokens: s.contextEstimatedTokens,
      observationsCount: s.contextObservationsCount,
    })),
    repairCount: 0,
    evidenceIntegrity: {
      historicalArtifactsPreserved: true,
      allArtifactsSha256Matches: true,
    },
    modelClaimedCompletion,
    verificationRequired,
    verificationExecuted,
    verificationPassed,
    emeraldAcceptedCompletion,
    sourceModified,
    fixApplied,
  };

  // Write evidence to scratch/phase13d-verification-stage-evidence.json in both locations
  fs.mkdirSync("scratch", { recursive: true });
  fs.writeFileSync("scratch/phase13d-verification-stage-evidence.json", JSON.stringify(evidence, null, 2), "utf8");
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH_DIR, "phase13d-verification-stage-evidence.json"), JSON.stringify(evidence, null, 2), "utf8");

  console.log("\n[EVIDENCE] Saved evidence to scratch/phase13d-verification-stage-evidence.json");
  console.log(`[EVIDENCE] modelClaimedCompletion: ${modelClaimedCompletion}`);
  console.log(`[EVIDENCE] verificationRequired: ${verificationRequired}`);
  console.log(`[EVIDENCE] verificationExecuted: ${verificationExecuted}`);
  console.log(`[EVIDENCE] verificationPassed: ${verificationPassed}`);
  console.log(`[EVIDENCE] emeraldAcceptedCompletion: ${emeraldAcceptedCompletion}`);

  // Cleanup
  store.close();
  try {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  } catch {}

  console.log("\n======================================================================");
  console.log(`PHASE 13D LIVE EXPERIMENT COMPLETE: ${emeraldAcceptedCompletion ? "PASSED" : "FAILED"}`);
  console.log("======================================================================");
}

main().catch((err) => {
  console.error("[FATAL] Phase 13D experiment runner crashed:", err);
  process.exit(1);
});
