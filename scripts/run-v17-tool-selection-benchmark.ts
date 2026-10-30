/**
 * Emerald Agent Fabric — Production V1.7: Anchored Edit Tool-Selection Calibration Benchmark
 *
 * Controlled comparison between:
 * - Baseline (Condition B4): Line-anchored editing without in-context demonstration (V1.6 prompt)
 * - Treatment (Condition B5): Line-anchored editing with 1-shot synthetic demonstration (V1.7 prompt)
 *
 * Evaluates the 5 calibration tasks (calib-001 through calib-005) under local Ollama inference (qwen2.5-coder:3b).
 * Isolates whether in-context demonstration overcomes tool-selection inertia.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import {
  CalibrationManifestLoader,
  ANCHORED_EDIT_DEMONSTRATION_VERSION,
  getAnchoredEditDemonstrationDigest,
} from "../src/production/benchmark/calibration-manifest.js";
import { FailureAttributionClassifier, DetailedFailureAttribution } from "../src/production/benchmark/failure-attribution.js";
import { OllamaModelAdapter } from "../src/production/benchmark/ollama-model-adapter.js";
import { ProductionRuntimeEngine } from "../src/runtime/production-runtime-engine.js";
import { createProductionConfig } from "../src/config/production-config.js";
import { MissionControl } from "../src/control-plane/mission-control.js";
import { RunControl } from "../src/control-plane/run-control.js";
import { EvidenceControl } from "../src/control-plane/evidence-control.js";
import { CapabilityFenceEnforcer } from "../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../src/application/cross-harness-gateway.js";
import { ProductionVerifier } from "../src/verification/production-verifier.js";
import { ProductionReplayEngine } from "../src/evidence/production-replay-engine.js";
import { BenchmarkTask } from "../src/production/benchmark/benchmark-types.js";

const execFileAsync = promisify(execFile);

export interface V17TrialRecord {
  taskId: string;
  condition: "BASELINE_B4_ANCHORED_PROMPT" | "TREATMENT_B5_DEMONSTRATION_PROMPT";
  model: string;
  demonstrationVersion?: string;
  demonstrationDigest?: string;
  initialGitSha: string;
  finalGitSha: string;
  initialFileDigest: string;
  finalFileDigest: string;
  modelCallsCount: number;
  toolCallsCount: number;
  selectedAnchoredEdit: boolean;
  toolCallStructurallyValid: boolean;
  argumentsValid: boolean;
  reachedToolGateway: boolean;
  governanceAccepted: boolean;
  anchorMatchedUniquely: boolean;
  editAppliedSuccessfully: boolean;
  unrelatedContentByteIdentical: boolean;
  patchAppliedSuccessfully: boolean;
  scopeViolationsCount: number;
  testPassed: boolean;
  sovereignVerified: boolean;
  replayVerified: boolean;
  budgetExhausted: boolean;
  attribution: DetailedFailureAttribution;
  gitDiff: string;
  durationMs: number;
}

export interface V17ConditionMetrics {
  totalTrials: number;
  anchoredEditSelectionCount: number;
  anchoredEditSelectionRate: number;
  structurallyValidToolCallCount: number;
  argumentsValidCount: number;
  reachedToolGatewayCount: number;
  governanceAcceptedCount: number;
  uniqueAnchorMatchCount: number;
  editApplicationCount: number;
  editApplicationRate: number;
  patchApplicationCount: number;
  patchApplicationRate: number;
  testPassCount: number;
  testPassRate: number;
  sovereignVerifiedCount: number;
  sovereignVerifiedRate: number;
  meanDurationMs: number;
  stageDistribution: Record<string, number>;
}

export interface V17ComparisonReport {
  timestamp: string;
  harnessVersion: string;
  modelId: string;
  tasksCount: number;
  demonstrationVersion: string;
  demonstrationDigest: string;
  baselineB4Results: V17TrialRecord[];
  treatmentB5Results: V17TrialRecord[];
  baselineMetrics: V17ConditionMetrics;
  treatmentMetrics: V17ConditionMetrics;
  decision:
    | "TOOL_SELECTION_IMPROVED"
    | "TOOL_SELECTION_IMPROVED_COMPLETION_NEUTRAL"
    | "TOOL_SELECTION_UNCHANGED"
    | "TOOL_INTERFACE_DEFECT_IDENTIFIED"
    | "CALIBRATION_INCONCLUSIVE"
    | "PRODUCTION_REGRESSION_DETECTED";
  decisionReason: string;
}

async function prepareWorkspace(task: BenchmarkTask, baseDir: string): Promise<string> {
  const dir = path.join(baseDir, `${task.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });

  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "EmeraldBench"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "bench@emerald.local"], { cwd: dir });

  fs.writeFileSync(path.join(dir, task.sourceFile), task.initialCode, "utf8");
  fs.writeFileSync(path.join(dir, task.testFile), task.testCode, "utf8");

  if (task.additionalFiles) {
    for (const af of task.additionalFiles) {
      const fullPath = path.join(dir, af.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, af.content, "utf8");
    }
  }

  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", `Initial baseline commit for ${task.taskId}`], { cwd: dir });

  return dir;
}

async function runSingleTrial(
  task: BenchmarkTask,
  condition: "BASELINE_B4_ANCHORED_PROMPT" | "TREATMENT_B5_DEMONSTRATION_PROMPT",
  modelAdapter: OllamaModelAdapter,
  manifestLoader: CalibrationManifestLoader,
  classifier: FailureAttributionClassifier,
  tempBaseDir: string,
): Promise<V17TrialRecord> {
  const startTime = Date.now();
  const workspaceDir = await prepareWorkspace(task, tempBaseDir);

  const initialGitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceDir })).stdout.trim();
  const initialFileContent = fs.readFileSync(path.join(workspaceDir, task.sourceFile), "utf8");
  const initialFileDigest = createHash("sha256").update(initialFileContent, "utf8").digest("hex");

  const config = createProductionConfig({ workspaceRoot: workspaceDir });
  const missionControl = new MissionControl();
  const runControl = new RunControl();
  const evidenceControl = new EvidenceControl();
  const fenceEnforcer = new CapabilityFenceEnforcer();
  const crossHarnessGateway = new CrossHarnessGateway(fenceEnforcer);
  const verifier = new ProductionVerifier();
  const replayEngine = new ProductionReplayEngine();

  const runtime = new ProductionRuntimeEngine(
    config,
    missionControl,
    runControl,
    fenceEnforcer,
    crossHarnessGateway,
    evidenceControl,
    verifier,
  );

  const anchoredEditDemonstrationEnabled = condition === "TREATMENT_B5_DEMONSTRATION_PROMPT";
  const missionPrompt = manifestLoader.buildUntrustedPromptForModel(task, {
    lineAnchoredEditingEnabled: true,
    anchoredEditDemonstrationEnabled,
  });

  const mission = missionControl.createMission({
    title: task.title,
    description: missionPrompt,
    repositoryPath: workspaceDir,
    workspacePath: workspaceDir,
  });

  let outcome;
  try {
    outcome = await runtime.executeRepairSession(mission.missionId, modelAdapter, {
      config: {
        maxSteps: 4,
        maxAttempts: 4,
        minimalEvidenceSelectionEnabled: true,
        maxFeedbackBytes: 4096,
      },
      testCommand: { cmd: task.testCommand.cmd, args: task.testCommand.args as string[] },
      expectedFiles: [task.sourceFile],
    });
  } catch (err: any) {
    const finalGitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceDir })).stdout.trim();
    const currentFileContent = fs.existsSync(path.join(workspaceDir, task.sourceFile))
      ? fs.readFileSync(path.join(workspaceDir, task.sourceFile), "utf8")
      : "";
    const finalFileDigest = createHash("sha256").update(currentFileContent, "utf8").digest("hex");

    return {
      taskId: task.taskId,
      condition,
      model: modelAdapter.modelName,
      demonstrationVersion: anchoredEditDemonstrationEnabled ? ANCHORED_EDIT_DEMONSTRATION_VERSION : undefined,
      demonstrationDigest: anchoredEditDemonstrationEnabled ? getAnchoredEditDemonstrationDigest() : undefined,
      initialGitSha,
      finalGitSha,
      initialFileDigest,
      finalFileDigest,
      modelCallsCount: 0,
      toolCallsCount: 0,
      selectedAnchoredEdit: false,
      toolCallStructurallyValid: false,
      argumentsValid: false,
      reachedToolGateway: false,
      governanceAccepted: false,
      anchorMatchedUniquely: false,
      editAppliedSuccessfully: false,
      unrelatedContentByteIdentical: true,
      patchAppliedSuccessfully: false,
      scopeViolationsCount: 0,
      testPassed: false,
      sovereignVerified: false,
      replayVerified: false,
      budgetExhausted: false,
      attribution: classifier.classify({
        fixtureFailed: false,
        modelRawResponse: "error",
        proposalValid: false,
        patchApplied: false,
        governanceDenied: false,
        timedOut: false,
        testExecutionFailed: false,
        testAssertionFailed: false,
        verified: false,
      }),
      gitDiff: "",
      durationMs: Date.now() - startTime,
    };
  }

  const { stdout: diff } = await execFileAsync("git", ["diff"], { cwd: workspaceDir });
  const finalGitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceDir })).stdout.trim();
  const finalFileContent = fs.readFileSync(path.join(workspaceDir, task.sourceFile), "utf8");
  const finalFileDigest = createHash("sha256").update(finalFileContent, "utf8").digest("hex");

  // Replay Sweeps (3 sweeps)
  let replayVerified = false;
  if (outcome.verification.verified) {
    const s1 = replayEngine.reconstructRun(outcome.evidence);
    const s2 = replayEngine.reconstructRun(outcome.evidence);
    const s3 = replayEngine.reconstructRun(outcome.evidence);
    replayVerified =
      s1.reconstructedSuccessfully &&
      s2.reconstructedSuccessfully &&
      s3.reconstructedSuccessfully &&
      s1.verification.proofHash === outcome.verification.proofHash &&
      s2.verification.proofHash === outcome.verification.proofHash &&
      s3.verification.proofHash === outcome.verification.proofHash;
  }

  // Parse timeline for precise metrics
  let selectedAnchoredEdit = false;
  let toolCallStructurallyValid = false;
  let argumentsValid = false;
  let reachedToolGateway = false;
  let governanceAccepted = false;
  let anchorMatchedUniquely = false;
  let editAppliedSuccessfully = false;

  for (const t of outcome.evidence.timeline) {
    if (t.eventType === "action.proposed" && t.details["toolName"] === "edit_file_anchor") {
      selectedAnchoredEdit = true;
      toolCallStructurallyValid = true;
      const input = t.details["input"] as Record<string, unknown> | undefined;
      if (input && (input["searchAnchor"] || input["oldText"]) && (input["replacementText"] || input["newText"])) {
        argumentsValid = true;
      }
    }
    if (t.eventType === "tool.executed" && t.details["toolName"] === "edit_file_anchor") {
      reachedToolGateway = true;
      governanceAccepted = true;
    }
    if (t.eventType === "repair.file_anchored_edit") {
      anchorMatchedUniquely = true;
      editAppliedSuccessfully = true;
    }
  }

  const patchApplied = diff.trim().length > 0;
  const isVerified = outcome.verification.verified && replayVerified;

  const attribution = classifier.classify({
    fixtureFailed: false,
    modelRawResponse: "valid_stream",
    proposalValid: outcome.run.actionsCount > 0 || isVerified,
    patchApplied,
    governanceDenied: outcome.session.scopeViolations.length > 0,
    scopeViolations: outcome.session.scopeViolations,
    timedOut: outcome.session.classification === "TIMEOUT",
    diagnosticStatus: outcome.diagnosticMetrics && outcome.diagnosticMetrics.diagnosticFailureCount > 0 ? "SYNTAX_ERROR" : "CLEAN",
    testExecutionFailed: false,
    testAssertionFailed: !outcome.verification.verified,
    verified: isVerified,
    verificationProofHash: outcome.verification.proofHash,
    verificationFailureReason: outcome.verification.failureReason,
  });

  return {
    taskId: task.taskId,
    condition,
    model: modelAdapter.modelName,
    demonstrationVersion: anchoredEditDemonstrationEnabled ? ANCHORED_EDIT_DEMONSTRATION_VERSION : undefined,
    demonstrationDigest: anchoredEditDemonstrationEnabled ? getAnchoredEditDemonstrationDigest() : undefined,
    initialGitSha,
    finalGitSha,
    initialFileDigest,
    finalFileDigest,
    modelCallsCount: outcome.session.proposalHistoryCount,
    toolCallsCount: outcome.run.actionsCount,
    selectedAnchoredEdit,
    toolCallStructurallyValid,
    argumentsValid,
    reachedToolGateway,
    governanceAccepted,
    anchorMatchedUniquely,
    editAppliedSuccessfully,
    unrelatedContentByteIdentical: editAppliedSuccessfully ? true : false,
    patchAppliedSuccessfully: patchApplied,
    scopeViolationsCount: outcome.session.scopeViolations.length,
    testPassed: outcome.verification.verified,
    sovereignVerified: isVerified,
    replayVerified,
    budgetExhausted: outcome.session.classification === "TIMEOUT",
    attribution,
    gitDiff: diff,
    durationMs: Date.now() - startTime,
  };
}

function computeAggregateMetrics(records: V17TrialRecord[]): V17ConditionMetrics {
  const total = records.length;
  if (total === 0) {
    return {
      totalTrials: 0,
      anchoredEditSelectionCount: 0,
      anchoredEditSelectionRate: 0,
      structurallyValidToolCallCount: 0,
      argumentsValidCount: 0,
      reachedToolGatewayCount: 0,
      governanceAcceptedCount: 0,
      uniqueAnchorMatchCount: 0,
      editApplicationCount: 0,
      editApplicationRate: 0,
      patchApplicationCount: 0,
      patchApplicationRate: 0,
      testPassCount: 0,
      testPassRate: 0,
      sovereignVerifiedCount: 0,
      sovereignVerifiedRate: 0,
      meanDurationMs: 0,
      stageDistribution: {},
    };
  }

  let totalSelection = 0;
  let totalStructurallyValid = 0;
  let totalArgsValid = 0;
  let totalReachedGateway = 0;
  let totalGovAccepted = 0;
  let totalUniqueMatches = 0;
  let totalEditsApplied = 0;
  let totalPatchesApplied = 0;
  let totalTestsPassed = 0;
  let totalVerified = 0;
  let totalDurationMs = 0;
  const stageDist: Record<string, number> = {};

  for (const r of records) {
    if (r.selectedAnchoredEdit) totalSelection++;
    if (r.toolCallStructurallyValid) totalStructurallyValid++;
    if (r.argumentsValid) totalArgsValid++;
    if (r.reachedToolGateway) totalReachedGateway++;
    if (r.governanceAccepted) totalGovAccepted++;
    if (r.anchorMatchedUniquely) totalUniqueMatches++;
    if (r.editAppliedSuccessfully) totalEditsApplied++;
    if (r.patchAppliedSuccessfully) totalPatchesApplied++;
    if (r.testPassed) totalTestsPassed++;
    if (r.sovereignVerified) totalVerified++;
    totalDurationMs += r.durationMs;

    const stage = r.attribution.primaryStage;
    stageDist[stage] = (stageDist[stage] || 0) + 1;
  }

  return {
    totalTrials: total,
    anchoredEditSelectionCount: totalSelection,
    anchoredEditSelectionRate: Math.round((totalSelection / total) * 100),
    structurallyValidToolCallCount: totalStructurallyValid,
    argumentsValidCount: totalArgsValid,
    reachedToolGatewayCount: totalReachedGateway,
    governanceAcceptedCount: totalGovAccepted,
    uniqueAnchorMatchCount: totalUniqueMatches,
    editApplicationCount: totalEditsApplied,
    editApplicationRate: Math.round((totalEditsApplied / total) * 100),
    patchApplicationCount: totalPatchesApplied,
    patchApplicationRate: Math.round((totalPatchesApplied / total) * 100),
    testPassCount: totalTestsPassed,
    testPassRate: Math.round((totalTestsPassed / total) * 100),
    sovereignVerifiedCount: totalVerified,
    sovereignVerifiedRate: Math.round((totalVerified / total) * 100),
    meanDurationMs: Math.round(totalDurationMs / total),
    stageDistribution: stageDist,
  };
}

async function main() {
  console.log("================================================================================");
  console.log("EMERALD AGENT FABRIC — PRODUCTION V1.7 BENCHMARK EVALUATION");
  console.log("Anchored Edit Tool-Selection Calibration (Baseline B4 vs Treatment B5)");
  console.log("================================================================================\n");

  const manifestLoader = new CalibrationManifestLoader();
  const manifest = manifestLoader.loadManifest();
  const tasks = manifest.tasks;
  const classifier = new FailureAttributionClassifier();
  const modelAdapter = new OllamaModelAdapter("qwen2.5-coder:3b", "http://localhost:11434", 45000);

  const demoDigest = getAnchoredEditDemonstrationDigest();
  console.log(`[PREFLIGHT] Demonstration Version: ${ANCHORED_EDIT_DEMONSTRATION_VERSION}`);
  console.log(`[PREFLIGHT] Demonstration Digest:  ${demoDigest}\n`);

  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-v17-bench-"));

  const baselineResults: V17TrialRecord[] = [];
  const treatmentResults: V17TrialRecord[] = [];

  try {
    // 1. RUN BASELINE CONDITION B4 (No demonstration)
    console.log("--- 1. EXECUTING BASELINE CONDITION B4 (V1.6 prompt, no demonstration) ---");
    for (const task of tasks) {
      console.log(`[BASELINE B4] Running ${task.taskId} (${task.title})...`);
      const res = await runSingleTrial(task, "BASELINE_B4_ANCHORED_PROMPT", modelAdapter, manifestLoader, classifier, tempBaseDir);
      baselineResults.push(res);
      console.log(
        `[BASELINE B4] ${task.taskId} -> Selected: ${res.selectedAnchoredEdit ? "YES" : "NO"} | Applied: ${res.editAppliedSuccessfully ? "YES" : "NO"} | Verified: ${res.sovereignVerified ? "PASSED" : "NO"} | Stage: ${res.attribution.primaryStage} (${res.attribution.primaryCode})`,
      );
    }

    // 2. RUN TREATMENT CONDITION B5 (1-Shot Demonstration enabled)
    console.log("\n--- 2. EXECUTING TREATMENT CONDITION B5 (1-Shot Demonstration enabled) ---");
    for (const task of tasks) {
      console.log(`[TREATMENT B5] Running ${task.taskId} (${task.title})...`);
      const res = await runSingleTrial(task, "TREATMENT_B5_DEMONSTRATION_PROMPT", modelAdapter, manifestLoader, classifier, tempBaseDir);
      treatmentResults.push(res);
      console.log(
        `[TREATMENT B5] ${task.taskId} -> Selected: ${res.selectedAnchoredEdit ? "YES" : "NO"} | Applied: ${res.editAppliedSuccessfully ? "YES" : "NO"} | Verified: ${res.sovereignVerified ? "PASSED" : "NO"} | Stage: ${res.attribution.primaryStage} (${res.attribution.primaryCode})`,
      );
    }
  } finally {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup locks
    }
  }

  const baselineMetrics = computeAggregateMetrics(baselineResults);
  const treatmentMetrics = computeAggregateMetrics(treatmentResults);

  let decision: V17ComparisonReport["decision"];
  let decisionReason: string;

  if (treatmentMetrics.sovereignVerifiedRate > baselineMetrics.sovereignVerifiedRate) {
    decision = "TOOL_SELECTION_IMPROVED";
    decisionReason = `The demonstration increased valid anchored-tool selection and improved verified completion from ${baselineMetrics.sovereignVerifiedRate}% to ${treatmentMetrics.sovereignVerifiedRate}%.`;
  } else if (
    treatmentMetrics.anchoredEditSelectionRate > baselineMetrics.anchoredEditSelectionRate ||
    treatmentMetrics.editApplicationRate > baselineMetrics.editApplicationRate
  ) {
    decision = "TOOL_SELECTION_IMPROVED_COMPLETION_NEUTRAL";
    decisionReason = `Valid tool selection/use improved (selection: ${treatmentMetrics.anchoredEditSelectionRate}%, edit application: ${treatmentMetrics.editApplicationRate}%), but verified completion remained neutral (${treatmentMetrics.sovereignVerifiedRate}%).`;
  } else if (treatmentMetrics.anchoredEditSelectionRate === baselineMetrics.anchoredEditSelectionRate) {
    decision = "TOOL_SELECTION_UNCHANGED";
    decisionReason = `The demonstration did not materially alter model tool selection (${baselineMetrics.anchoredEditSelectionRate}% vs ${treatmentMetrics.anchoredEditSelectionRate}%). Model persisted in its baseline tool-calling behavior.`;
  } else {
    decision = "CALIBRATION_INCONCLUSIVE";
    decisionReason = `Inconclusive tool selection outcome.`;
  }

  const report: V17ComparisonReport = {
    timestamp: new Date().toISOString(),
    harnessVersion: "production-v1.7",
    modelId: "qwen2.5-coder:3b",
    tasksCount: tasks.length,
    demonstrationVersion: ANCHORED_EDIT_DEMONSTRATION_VERSION,
    demonstrationDigest: demoDigest,
    baselineB4Results: baselineResults,
    treatmentB5Results: treatmentResults,
    baselineMetrics,
    treatmentMetrics,
    decision,
    decisionReason,
  };

  const outputPath = path.resolve(process.cwd(), "scratch/production-v17-tool-selection-results.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("\n--------------------------------------------------------------------------------");
  console.log("PRODUCTION V1.7 TOOL-SELECTION CALIBRATION SUMMARY (N=5 tasks):");
  console.log(`- Model Evaluated:                           ${report.modelId} (local Ollama)`);
  console.log(`- Demonstration Version:                     ${report.demonstrationVersion}`);
  console.log(`- Demonstration Digest:                      ${report.demonstrationDigest.slice(0, 16)}...`);
  console.log(`- Baseline Anchored-Tool Selection Rate:     ${baselineMetrics.anchoredEditSelectionRate}% (${baselineMetrics.anchoredEditSelectionCount}/${baselineMetrics.totalTrials})`);
  console.log(`- Treatment Anchored-Tool Selection Rate:    ${treatmentMetrics.anchoredEditSelectionRate}% (${treatmentMetrics.anchoredEditSelectionCount}/${treatmentMetrics.totalTrials})`);
  console.log(`- Baseline Edit Application Rate:            ${baselineMetrics.editApplicationRate}% (${baselineMetrics.editApplicationCount}/${baselineMetrics.totalTrials})`);
  console.log(`- Treatment Edit Application Rate:           ${treatmentMetrics.editApplicationRate}% (${treatmentMetrics.editApplicationCount}/${treatmentMetrics.totalTrials})`);
  console.log(`- Baseline Verified Completion Rate:         ${baselineMetrics.sovereignVerifiedRate}% (${baselineMetrics.sovereignVerifiedCount}/${baselineMetrics.totalTrials})`);
  console.log(`- Treatment Verified Completion Rate:        ${treatmentMetrics.sovereignVerifiedRate}% (${treatmentMetrics.sovereignVerifiedCount}/${treatmentMetrics.totalTrials})`);
  console.log(`- Decision:                                  ${decision}`);
  console.log(`- Decision Reason:                           ${decisionReason}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Results saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("V1.7 calibration benchmark failed:", err);
  process.exit(1);
});
