#!/usr/bin/env node
/**
 * Emerald Agent Fabric — Live Multi-Agent Mission Demo CLI
 *
 * Runs the end-to-end multi-agent mission pipeline (Researcher -> Coder -> Tester -> Reviewer -> Synthesis)
 * through existing Emerald components (TaskRouterService, RunCoordinator, WorkerRuntime,
 * GovernedModelRouterService, BoundedRepairLoopController, DeterministicVerifier).
 *
 * Usage:
 *   node bin/run-mission-demo.js [--model MODEL] [--provider PROVIDER] [--timeout SEC]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runLiveMissionDemo, validateEnvironment } from "../dist/src/application/evaluation/mission-demo-runner.js";

async function main() {
  const args = process.argv.slice(2);
  let provider = process.env.EMERALD_MODEL_PROVIDER || "groq";
  let model = process.env.EMERALD_MODEL_NAME || "openai/gpt-oss-120b";
  let timeoutSec = 300;
  let missionText = "Build a small note-taking REST API (create, list, delete notes), with tests, and a review.";
  let outputDir = path.join(process.cwd(), "scratch", "mission-demo-2");
  const spendCapUsd = parseFloat(process.env.EMERALD_SPEND_CAP_USD || "2.0");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--provider" && args[i + 1]) {
      provider = args[++i];
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeoutSec = parseInt(args[++i], 10);
    } else if (args[i] === "--mission" && args[i + 1]) {
      missionText = args[++i];
    } else if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = path.resolve(args[++i]);
    }
  }

  console.log("==================================================================");
  console.log("Emerald Agent Fabric — Live Multi-Agent Mission Demo");
  console.log("==================================================================");
  console.log(`Provider:        ${provider}`);
  console.log(`Model:           ${model}`);
  console.log(`Task Timeout:    ${timeoutSec}s`);
  console.log(`Spend Cap:       $${spendCapUsd.toFixed(2)}`);
  console.log("------------------------------------------------------------------");

  const envCheck = validateEnvironment();
  if (!envCheck.valid) {
    console.error(`\n[FAIL-CLOSED] Missing required environment variable(s): ${envCheck.missing.join(", ")}`);
    console.error("Please configure the following environment variables before running:\n");
    for (const v of envCheck.missing) {
      console.error(`  - ${v}`);
    }
    console.error("\nExample PowerShell setup:");
    console.error("  [System.Environment]::SetEnvironmentVariable('EMERALD_MODEL_PROVIDER', 'groq', 'User')");
    console.error("  [System.Environment]::SetEnvironmentVariable('EMERALD_MODEL_NAME', 'openai/gpt-oss-120b', 'User')");
    console.error("  [System.Environment]::SetEnvironmentVariable('EMERALD_API_KEY', '<your-groq-api-key>', 'User')");
    console.error("  [System.Environment]::SetEnvironmentVariable('EMERALD_SPEND_CAP_USD', '2', 'User')\n");
    process.exit(1);
  }

  try {
    const result = await runLiveMissionDemo({
      modelProviderName: provider,
      modelName: model,
      spendCapUsd,
      timeoutMs: timeoutSec * 1000,
      missionText,
      outputDir,
    });

    console.log("\n==================================================================");
    console.log("Mission Summary");
    console.log("==================================================================");
    console.log(`Mission Task ID:     ${result.missionTaskId}`);
    console.log(`Final Verdict:       ${result.verdict}`);
    console.log(`Total Duration:      ${(result.totalDurationMs / 1000).toFixed(2)}s`);
    console.log(`Total Spend:         $${result.totalSpendUsd.toFixed(4)}`);
    console.log(`Approval Recorded:   ${result.approvalRecorded}`);
    console.log(`Repair Triggered:    ${result.repairTriggered} (${result.repairIterations} iteration(s))`);
    console.log(`Evidence Directory:  ${result.evidenceDir}`);
    console.log("------------------------------------------------------------------");
    for (const s of result.subtasks) {
      console.log(`  [${s.role}] ${s.subtaskId}: ${s.status} (${s.verificationStatus}) in ${s.durationMs}ms`);
    }
    console.log("==================================================================\n");

    if (result.verdict !== "SUCCESS") {
      process.exit(1);
    }
  } catch (err) {
    console.error("\n[ERROR] Mission execution failed:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
