/**
 * Emerald Agent Fabric — Minimal Canonical Prompt Reliability Experiment
 *
 * Compares two prompt conditions for read_file structured proposal generation:
 * - Condition A: Existing prompt template with offsetLine/limitLines in example
 * - Condition B: Minimal canonical prompt template matching ReadFileInputSchema exactly ({ path: string })
 *
 * Invariants:
 * - ₹0 budget, local Ollama execution (qwen2.5-coder:3b)
 * - Identical model, adapter, and Zod validator across both conditions
 * - Read-only proposals; zero file mutations
 * - Saves structured results to scratch/minimal-canonical-prompt-experiment-results.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  PROPOSAL_SCHEMA_VERSION,
  getProposalSchemaDigest,
  validateStructuredProposal,
} from "../src/production/adapter/structured-proposal-schema.js";
import { OllamaModelAdapter } from "../src/production/benchmark/ollama-model-adapter.js";

const execFileAsync = promisify(execFile);

export interface TrialResult {
  condition: "CONDITION_A_EXISTING" | "CONDITION_B_CANONICAL";
  trialIndex: number;
  targetFile: string;
  promptText: string;
  rawProposal: any;
  schemaValidationPassed: boolean;
  errorCode?: string;
  errorMessage?: string;
  unexpectedFields: string[];
  missingFields: string[];
  inferenceDurationMs: number;
  wallClockDurationMs: number;
  executionPreventedOnFailure: boolean;
}

export interface ExperimentSummary {
  timestamp: string;
  gitBaselineSha: string;
  gitBranch: string;
  modelId: string;
  trialsPerCondition: number;
  totalTrials: number;
  conditionA: {
    validCount: number;
    invalidCount: number;
    validityRate: number;
    unexpectedFieldsCount: Record<string, number>;
    meanInferenceMs: number;
  };
  conditionB: {
    validCount: number;
    invalidCount: number;
    validityRate: number;
    unexpectedFieldsCount: Record<string, number>;
    meanInferenceMs: number;
  };
  decision: "PROMPT_CHANGE_SUPPORTED" | "NO_MEANINGFUL_IMPROVEMENT_OBSERVED" | "INCONCLUSIVE" | "EXPERIMENT_BLOCKED";
  trials: TrialResult[];
}

export async function runExperiment(): Promise<ExperimentSummary> {
  const modelId = "qwen2.5-coder:3b";
  const modelAdapter = new OllamaModelAdapter(modelId, "http://127.0.0.1:11434", 90000, true);

  const { stdout: baselineGitSha } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  const { stdout: gitBranch } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

  const testTargets = [
    "src/production/diagnostics/source-diagnostic-engine.ts",
    "src/evidence/production-replay-engine.ts",
    "src/control-plane/approval-control.ts",
  ];

  const trials: TrialResult[] = [];

  console.log(`[PROMPT EXPERIMENT] Starting minimal canonical prompt reliability experiment...`);
  console.log(`[PROMPT EXPERIMENT] Model: ${modelId} via local Ollama`);
  console.log(`[PROMPT EXPERIMENT] Git Baseline: ${baselineGitSha.trim()} (${gitBranch.trim()})`);
  console.log(`[PROMPT EXPERIMENT] Test targets: ${testTargets.length} targets across 2 conditions (total ${testTargets.length * 2} trials)\n`);

  // --- Run Condition A (Existing template with offsetLine/limitLines) ---
  console.log(`=== RUNNING CONDITION A: Existing Template (with offsetLine/limitLines) ===`);
  for (let i = 0; i < testTargets.length; i++) {
    const targetFile = testTargets[i];
    console.log(`[Condition A - Trial ${i + 1}/${testTargets.length}] Target: ${targetFile}`);

    const promptA = [
      "You are an AI assistant inside Emerald Agent Fabric.",
      `Task: Inspect ${targetFile} to explain the component architecture.`,
      "Do NOT edit or write to any files. Propose a read_file action with limitLines=50.",
      "Respond with a single JSON object conforming strictly to this format:",
      JSON.stringify({
        version: PROPOSAL_SCHEMA_VERSION,
        thought: `Inspect ${targetFile}`,
        toolName: "read_file",
        toolInput: { path: targetFile, offsetLine: 1, limitLines: 50 },
        isGoalReached: false,
      }),
    ].join("\n");

    const tStart = Date.now();
    let rawProposal: any = null;
    let schemaValid = false;
    let errCode: string | undefined;
    let errMsg: string | undefined;
    const unexpectedFields: string[] = [];
    const missingFields: string[] = [];

    const mStart = Date.now();
    try {
      rawProposal = await modelAdapter.proposeAction(promptA);
      const val = validateStructuredProposal({ version: PROPOSAL_SCHEMA_VERSION, ...rawProposal });
      schemaValid = val.valid;
      errCode = val.errorCode;
      errMsg = val.error;

      if (!val.valid && rawProposal && typeof rawProposal.toolInput === "object" && rawProposal.toolInput !== null) {
        for (const k of Object.keys(rawProposal.toolInput)) {
          if (k !== "path") {
            unexpectedFields.push(k);
          }
        }
        if (!("path" in rawProposal.toolInput)) {
          missingFields.push("path");
        }
      }
    } catch (e: any) {
      schemaValid = false;
      errCode = "INFERENCE_ERROR";
      errMsg = e.message;
    }
    const inferDuration = Date.now() - mStart;
    const wallDuration = Date.now() - tStart;

    trials.push({
      condition: "CONDITION_A_EXISTING",
      trialIndex: i + 1,
      targetFile,
      promptText: promptA,
      rawProposal,
      schemaValidationPassed: schemaValid,
      errorCode: errCode,
      errorMessage: errMsg,
      unexpectedFields,
      missingFields,
      inferenceDurationMs: inferDuration,
      wallClockDurationMs: wallDuration,
      executionPreventedOnFailure: !schemaValid,
    });

    console.log(`  -> Passed: ${schemaValid} | Error: ${errMsg ?? "None"} | Unexpected fields: [${unexpectedFields.join(", ")}] | Latency: ${inferDuration} ms`);
  }

  // --- Run Condition B (Canonical Minimal Template with { path: string } only) ---
  console.log(`\n=== RUNNING CONDITION B: Minimal Canonical Template ({ path: string } only) ===`);
  for (let i = 0; i < testTargets.length; i++) {
    const targetFile = testTargets[i];
    console.log(`[Condition B - Trial ${i + 1}/${testTargets.length}] Target: ${targetFile}`);

    const promptB = [
      "You are an AI assistant inside Emerald Agent Fabric.",
      `Task: Inspect ${targetFile} to explain the component architecture.`,
      "Do NOT edit or write to any files. Propose a read_file action.",
      "Respond with a single JSON object conforming strictly to this format:",
      JSON.stringify({
        version: PROPOSAL_SCHEMA_VERSION,
        thought: `Inspect ${targetFile}`,
        toolName: "read_file",
        toolInput: { path: targetFile },
        isGoalReached: false,
      }),
    ].join("\n");

    const tStart = Date.now();
    let rawProposal: any = null;
    let schemaValid = false;
    let errCode: string | undefined;
    let errMsg: string | undefined;
    const unexpectedFields: string[] = [];
    const missingFields: string[] = [];

    const mStart = Date.now();
    try {
      rawProposal = await modelAdapter.proposeAction(promptB);
      const val = validateStructuredProposal({ version: PROPOSAL_SCHEMA_VERSION, ...rawProposal });
      schemaValid = val.valid;
      errCode = val.errorCode;
      errMsg = val.error;

      if (!val.valid && rawProposal && typeof rawProposal.toolInput === "object" && rawProposal.toolInput !== null) {
        for (const k of Object.keys(rawProposal.toolInput)) {
          if (k !== "path") {
            unexpectedFields.push(k);
          }
        }
        if (!("path" in rawProposal.toolInput)) {
          missingFields.push("path");
        }
      }
    } catch (e: any) {
      schemaValid = false;
      errCode = "INFERENCE_ERROR";
      errMsg = e.message;
    }
    const inferDuration = Date.now() - mStart;
    const wallDuration = Date.now() - tStart;

    trials.push({
      condition: "CONDITION_B_CANONICAL",
      trialIndex: i + 1,
      targetFile,
      promptText: promptB,
      rawProposal,
      schemaValidationPassed: schemaValid,
      errorCode: errCode,
      errorMessage: errMsg,
      unexpectedFields,
      missingFields,
      inferenceDurationMs: inferDuration,
      wallClockDurationMs: wallDuration,
      executionPreventedOnFailure: !schemaValid,
    });

    console.log(`  -> Passed: ${schemaValid} | Error: ${errMsg ?? "None"} | Unexpected fields: [${unexpectedFields.join(", ")}] | Latency: ${inferDuration} ms`);
  }

  // --- Aggregate Analysis ---
  const condATrials = trials.filter((t) => t.condition === "CONDITION_A_EXISTING");
  const condBTrials = trials.filter((t) => t.condition === "CONDITION_B_CANONICAL");

  const condAValid = condATrials.filter((t) => t.schemaValidationPassed).length;
  const condBValid = condBTrials.filter((t) => t.schemaValidationPassed).length;

  const unexpectedA: Record<string, number> = {};
  for (const t of condATrials) {
    for (const f of t.unexpectedFields) {
      unexpectedA[f] = (unexpectedA[f] || 0) + 1;
    }
  }

  const unexpectedB: Record<string, number> = {};
  for (const t of condBTrials) {
    for (const f of t.unexpectedFields) {
      unexpectedB[f] = (unexpectedB[f] || 0) + 1;
    }
  }

  const meanInferA = condATrials.reduce((acc, t) => acc + t.inferenceDurationMs, 0) / condATrials.length;
  const meanInferB = condBTrials.reduce((acc, t) => acc + t.inferenceDurationMs, 0) / condBTrials.length;

  let decision: ExperimentSummary["decision"] = "INCONCLUSIVE";
  if (condBValid > condAValid) {
    decision = "PROMPT_CHANGE_SUPPORTED";
  } else if (condBValid === condAValid && condBValid === 0) {
    decision = "NO_MEANINGFUL_IMPROVEMENT_OBSERVED";
  } else if (condBValid === condAValid) {
    decision = "INCONCLUSIVE";
  }

  const summary: ExperimentSummary = {
    timestamp: new Date().toISOString(),
    gitBaselineSha: baselineGitSha.trim(),
    gitBranch: gitBranch.trim(),
    modelId,
    trialsPerCondition: testTargets.length,
    totalTrials: trials.length,
    conditionA: {
      validCount: condAValid,
      invalidCount: condATrials.length - condAValid,
      validityRate: condAValid / condATrials.length,
      unexpectedFieldsCount: unexpectedA,
      meanInferenceMs: Math.round(meanInferA),
    },
    conditionB: {
      validCount: condBValid,
      invalidCount: condBTrials.length - condBValid,
      validityRate: condBValid / condBTrials.length,
      unexpectedFieldsCount: unexpectedB,
      meanInferenceMs: Math.round(meanInferB),
    },
    decision,
    trials,
  };

  const outPath = path.resolve("scratch/minimal-canonical-prompt-experiment-results.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n============================================================`);
  console.log(`[EXPERIMENT COMPLETE] Condition A Validity: ${condAValid}/${condATrials.length} (${(summary.conditionA.validityRate * 100).toFixed(1)}%)`);
  console.log(`[EXPERIMENT COMPLETE] Condition B Validity: ${condBValid}/${condBTrials.length} (${(summary.conditionB.validityRate * 100).toFixed(1)}%)`);
  console.log(`[EXPERIMENT COMPLETE] Results saved to: ${outPath}`);
  console.log(`[EXPERIMENT COMPLETE] Outcome Decision: ${decision}`);
  console.log(`============================================================\n`);

  return summary;
}

if (process.argv[1]?.endsWith("run-minimal-canonical-prompt-experiment.ts")) {
  runExperiment()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[EXPERIMENT ERROR]", err);
      process.exit(1);
    });
}
