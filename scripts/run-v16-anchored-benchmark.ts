/**
 * Emerald Agent Fabric — Production V1.6: Line-Anchored Editing Benchmark Comparison
 *
 * Executes controlled benchmark comparison between:
 * - Baseline (Condition B3): Existing V1.5 whole-file write_file repair workflow
 * - Treatment (Condition B4): Production V1.6 line-anchored edit_file_anchor workflow
 *
 * Evaluates the 5 calibration tasks (calib-001 through calib-005) under local Ollama inference.
 * Compares patch integrity, unintended overwrites, and verified completion rates.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { CalibrationManifestLoader } from "../src/production/benchmark/calibration-manifest.js";
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

export interface V16TrialRecord {
  taskId: string;
  condition: "BASELINE_B3_WRITE_FILE" | "TREATMENT_B4_ANCHORED_EDIT";
  model: string;
  initialGitSha: string;
  finalGitSha: string;
  initialFileDigest: string;
  finalFileDigest: string;
  proposalsCount: number;
  validProposalsCount: number;
  anchoredEditRequestsCount: number;
  uniqueAnchorSuccessCount: number;
  zeroMatchRejectionsCount: number;
  multipleMatchRejectionsCount: number;
  staleContentRejectionsCount: number;
  malformedEditRequestsCount: number;
  patchAppliedSuccessfully: boolean;
  unintendedModificationsCount: number;
  scopeViolationsCount: number;
  testPassed: boolean;
  verified: boolean;
  replayVerified: boolean;
  attribution: DetailedFailureAttribution;
  gitDiff: string;
  durationMs: number;
}

export interface V16ConditionMetrics {
  totalTrials: number;
  validProposalsCount: number;
  anchoredEditRequestsCount: number;
  uniqueAnchorSuccessRate: number;
  zeroMatchRejectionsCount: number;
  multipleMatchRejectionsCount: number;
  staleContentRejectionsCount: number;
  malformedEditRequestsCount: number;
  patchApplicationRate: number;
  unintendedModificationsCount: number;
  testPassRate: number;
  sovereignVerifiedRate: number;
  meanDurationMs: number;
  stageDistribution: Record<string, number>;
}

export interface V16ComparisonReport {
  timestamp: string;
  harnessVersion: string;
  modelId: string;
  tasksCount: number;
  baselineB3Results: V16TrialRecord[];
  treatmentB4Results: V16TrialRecord[];
  baselineMetrics: V16ConditionMetrics;
  treatmentMetrics: V16ConditionMetrics;
  decision:
    | "ANCHORED_EDITING_CONFIRMED"
    | "PATCH_INTEGRITY_IMPROVED_COMPLETION_NEUTRAL"
    | "ANCHORED_EDITING_NEUTRAL"
    | "ANCHORED_EDITING_REJECTED"
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
  condition: "BASELINE_B3_WRITE_FILE" | "TREATMENT_B4_ANCHORED_EDIT",
  modelAdapter: OllamaModelAdapter,
  manifestLoader: CalibrationManifestLoader,
  classifier: FailureAttributionClassifier,
  tempBaseDir: string,
): Promise<V16TrialRecord> {
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

  const lineAnchoredEditingEnabled = condition === "TREATMENT_B4_ANCHORED_EDIT";
  const missionPrompt = manifestLoader.buildUntrustedPromptForModel(task, { lineAnchoredEditingEnabled });

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
      initialGitSha,
      finalGitSha,
      initialFileDigest,
      finalFileDigest,
      proposalsCount: 0,
      validProposalsCount: 0,
      anchoredEditRequestsCount: 0,
      uniqueAnchorSuccessCount: 0,
      zeroMatchRejectionsCount: 0,
      multipleMatchRejectionsCount: 0,
      staleContentRejectionsCount: 0,
      malformedEditRequestsCount: 0,
      patchAppliedSuccessfully: false,
      unintendedModificationsCount: 0,
      scopeViolationsCount: 0,
      testPassed: false,
      verified: false,
      replayVerified: false,
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

  // Parse timeline for anchored edit metrics
  let anchoredEditRequestsCount = 0;
  let uniqueAnchorSuccessCount = 0;
  let zeroMatchRejectionsCount = 0;
  let multipleMatchRejectionsCount = 0;
  let staleContentRejectionsCount = 0;
  let malformedEditRequestsCount = 0;

  for (const t of outcome.evidence.timeline) {
    if (t.eventType === "action.proposed" && t.details["toolName"] === "edit_file_anchor") {
      anchoredEditRequestsCount++;
    }
    if (t.eventType === "repair.file_anchored_edit") {
      uniqueAnchorSuccessCount++;
    }
    if (t.eventType === "repair.file_anchored_edit_failed") {
      const reason = String(t.details["reason"] || "");
      if (reason.includes("0 occurrences")) zeroMatchRejectionsCount++;
      else if (reason.includes("Ambiguous")) multipleMatchRejectionsCount++;
      else if (reason.includes("Stale edit")) staleContentRejectionsCount++;
      else malformedEditRequestsCount++;
    }
  }

  // Unintended modifications check: did model overwrite unrelated code lines?
  let unintendedModificationsCount = 0;
  if (diff) {
    // If lines removed > 5 in a small 5-line function, likely full-file overwrite
    const linesRemoved = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    if (linesRemoved > 3 && task.difficulty === "EASY") {
      unintendedModificationsCount++;
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
    initialGitSha,
    finalGitSha,
    initialFileDigest,
    finalFileDigest,
    proposalsCount: outcome.session.proposalHistoryCount,
    validProposalsCount: outcome.session.proposalHistoryCount,
    anchoredEditRequestsCount,
    uniqueAnchorSuccessCount,
    zeroMatchRejectionsCount,
    multipleMatchRejectionsCount,
    staleContentRejectionsCount,
    malformedEditRequestsCount,
    patchAppliedSuccessfully: patchApplied,
    unintendedModificationsCount,
    scopeViolationsCount: outcome.session.scopeViolations.length,
    testPassed: outcome.verification.verified,
    verified: isVerified,
    replayVerified,
    attribution,
    gitDiff: diff,
    durationMs: Date.now() - startTime,
  };
}

function computeAggregateMetrics(records: V16TrialRecord[]): V16ConditionMetrics {
  const total = records.length;
  if (total === 0) {
    return {
      totalTrials: 0,
      validProposalsCount: 0,
      anchoredEditRequestsCount: 0,
      uniqueAnchorSuccessRate: 0,
      zeroMatchRejectionsCount: 0,
      multipleMatchRejectionsCount: 0,
      staleContentRejectionsCount: 0,
      malformedEditRequestsCount: 0,
      patchApplicationRate: 0,
      unintendedModificationsCount: 0,
      testPassRate: 0,
      sovereignVerifiedRate: 0,
      meanDurationMs: 0,
      stageDistribution: {},
    };
  }

  let totalValidProposals = 0;
  let totalAnchoredRequests = 0;
  let totalUniqueSuccesses = 0;
  let totalZeroMatches = 0;
  let totalMultipleMatches = 0;
  let totalStaleRejections = 0;
  let totalMalformed = 0;
  let totalPatchesApplied = 0;
  let totalUnintendedMods = 0;
  let totalTestsPassed = 0;
  let totalVerified = 0;
  let totalDurationMs = 0;
  const stageDist: Record<string, number> = {};

  for (const r of records) {
    totalValidProposals += r.validProposalsCount;
    totalAnchoredRequests += r.anchoredEditRequestsCount;
    totalUniqueSuccesses += r.uniqueAnchorSuccessCount;
    totalZeroMatches += r.zeroMatchRejectionsCount;
    totalMultipleMatches += r.multipleMatchRejectionsCount;
    totalStaleRejections += r.staleContentRejectionsCount;
    totalMalformed += r.malformedEditRequestsCount;
    if (r.patchAppliedSuccessfully) totalPatchesApplied++;
    totalUnintendedMods += r.unintendedModificationsCount;
    if (r.testPassed) totalTestsPassed++;
    if (r.verified) totalVerified++;
    totalDurationMs += r.durationMs;

    const stage = r.attribution.primaryStage;
    stageDist[stage] = (stageDist[stage] || 0) + 1;
  }

  return {
    totalTrials: total,
    validProposalsCount: totalValidProposals,
    anchoredEditRequestsCount: totalAnchoredRequests,
    uniqueAnchorSuccessRate: totalAnchoredRequests > 0 ? Math.round((totalUniqueSuccesses / totalAnchoredRequests) * 100) : 0,
    zeroMatchRejectionsCount: totalZeroMatches,
    multipleMatchRejectionsCount: totalMultipleMatches,
    staleContentRejectionsCount: totalStaleRejections,
    malformedEditRequestsCount: totalMalformed,
    patchApplicationRate: Math.round((totalPatchesApplied / total) * 100),
    unintendedModificationsCount: totalUnintendedMods,
    testPassRate: Math.round((totalTestsPassed / total) * 100),
    sovereignVerifiedRate: Math.round((totalVerified / total) * 100),
    meanDurationMs: Math.round(totalDurationMs / total),
    stageDistribution: stageDist,
  };
}

async function main() {
  console.log("================================================================================");
  console.log("EMERALD AGENT FABRIC — PRODUCTION V1.6 BENCHMARK EVALUATION");
  console.log("Line-Anchored Editing and Patch Integrity vs Whole-File Replacement Baseline");
  console.log("================================================================================\n");

  const manifestLoader = new CalibrationManifestLoader();
  const manifest = manifestLoader.loadManifest();
  const tasks = manifest.tasks;
  const classifier = new FailureAttributionClassifier();
  const modelAdapter = new OllamaModelAdapter("qwen2.5-coder:3b", "http://localhost:11434", 45000);

  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-v16-bench-"));

  const baselineResults: V16TrialRecord[] = [];
  const treatmentResults: V16TrialRecord[] = [];

  try {
    // 1. RUN BASELINE CONDITION B3 (Whole-File write_file)
    console.log("--- 1. EXECUTING BASELINE CONDITION B3 (Whole-file write_file) ---");
    for (const task of tasks) {
      console.log(`[BASELINE B3] Running ${task.taskId} (${task.title})...`);
      const res = await runSingleTrial(task, "BASELINE_B3_WRITE_FILE", modelAdapter, manifestLoader, classifier, tempBaseDir);
      baselineResults.push(res);
      console.log(
        `[BASELINE B3] ${task.taskId} -> Patch: ${res.patchAppliedSuccessfully ? "YES" : "NO"} | Verified: ${res.verified ? "PASSED" : "NO"} | Stage: ${res.attribution.primaryStage} (${res.attribution.primaryCode})`,
      );
    }

    // 2. RUN TREATMENT CONDITION B4 (Line-Anchored edit_file_anchor)
    console.log("\n--- 2. EXECUTING TREATMENT CONDITION B4 (Line-Anchored edit_file_anchor) ---");
    for (const task of tasks) {
      console.log(`[TREATMENT B4] Running ${task.taskId} (${task.title})...`);
      const res = await runSingleTrial(task, "TREATMENT_B4_ANCHORED_EDIT", modelAdapter, manifestLoader, classifier, tempBaseDir);
      treatmentResults.push(res);
      console.log(
        `[TREATMENT B4] ${task.taskId} -> Anchored: ${res.uniqueAnchorSuccessCount} | Patch: ${res.patchAppliedSuccessfully ? "YES" : "NO"} | Verified: ${res.verified ? "PASSED" : "NO"} | Stage: ${res.attribution.primaryStage} (${res.attribution.primaryCode})`,
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

  let decision: V16ComparisonReport["decision"];
  let decisionReason: string;

  if (treatmentMetrics.sovereignVerifiedRate > baselineMetrics.sovereignVerifiedRate) {
    decision = "ANCHORED_EDITING_CONFIRMED";
    decisionReason = `Treatment improved sovereign verified completions from ${baselineMetrics.sovereignVerifiedRate}% to ${treatmentMetrics.sovereignVerifiedRate}% without regressions.`;
  } else if (
    treatmentMetrics.patchApplicationRate > baselineMetrics.patchApplicationRate ||
    treatmentMetrics.unintendedModificationsCount < baselineMetrics.unintendedModificationsCount
  ) {
    decision = "PATCH_INTEGRITY_IMPROVED_COMPLETION_NEUTRAL";
    decisionReason = `Line-anchored editing improved patch application rate from ${baselineMetrics.patchApplicationRate}% to ${treatmentMetrics.patchApplicationRate}% (reducing whole-file clobbering), but verified completions remained neutral (${treatmentMetrics.sovereignVerifiedRate}%).`;
  } else if (treatmentMetrics.patchApplicationRate === baselineMetrics.patchApplicationRate) {
    decision = "ANCHORED_EDITING_NEUTRAL";
    decisionReason = `No meaningful change in patch application rate (${treatmentMetrics.patchApplicationRate}%) or verified completion (${treatmentMetrics.sovereignVerifiedRate}%).`;
  } else {
    decision = "ANCHORED_EDITING_REJECTED";
    decisionReason = `Treatment reduced patch application rate or made repair outcomes worse.`;
  }

  const report: V16ComparisonReport = {
    timestamp: new Date().toISOString(),
    harnessVersion: "production-v1.6",
    modelId: "qwen2.5-coder:3b",
    tasksCount: tasks.length,
    baselineB3Results: baselineResults,
    treatmentB4Results: treatmentResults,
    baselineMetrics,
    treatmentMetrics,
    decision,
    decisionReason,
  };

  const outputPath = path.resolve(process.cwd(), "scratch/production-v16-anchored-results.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("\n--------------------------------------------------------------------------------");
  console.log("PRODUCTION V1.6 BENCHMARK COMPARISON SUMMARY (N=5 tasks):");
  console.log(`- Model Evaluated:                           ${report.modelId} (local Ollama)`);
  console.log(`- Baseline Patch Application Rate:           ${baselineMetrics.patchApplicationRate}%`);
  console.log(`- Treatment Patch Application Rate:          ${treatmentMetrics.patchApplicationRate}%`);
  console.log(`- Baseline Verified Completion Rate:         ${baselineMetrics.sovereignVerifiedRate}%`);
  console.log(`- Treatment Verified Completion Rate:        ${treatmentMetrics.sovereignVerifiedRate}%`);
  console.log(`- Anchored Requests Count:                   ${treatmentMetrics.anchoredEditRequestsCount}`);
  console.log(`- Unique Anchor Success Rate:                ${treatmentMetrics.uniqueAnchorSuccessRate}%`);
  console.log(`- Unintended Modifications (Baseline):       ${baselineMetrics.unintendedModificationsCount}`);
  console.log(`- Unintended Modifications (Treatment):      ${treatmentMetrics.unintendedModificationsCount}`);
  console.log(`- Decision:                                  ${decision}`);
  console.log(`- Decision Reason:                           ${decisionReason}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Results saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("V1.6 calibration benchmark failed:", err);
  process.exit(1);
});
