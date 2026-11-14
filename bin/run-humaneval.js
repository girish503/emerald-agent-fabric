#!/usr/bin/env node
/**
 * Emerald Agent Fabric — HumanEval Benchmark CLI
 *
 * Runs the reproducible HumanEval benchmark suite through the fully governed
 * execution loop (GovernedModelRouterService, AgentStepController, BoundedRepairLoopController).
 *
 * Usage:
 *   node bin/run-humaneval.js [--limit N] [--model MODEL] [--provider PROVIDER] [--timeout SEC]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runHumanEvalBenchmark } from "../dist/src/application/evaluation/humaneval-runner.js";

async function main() {
  const args = process.argv.slice(2);
  let limit;
  let offset = 0;
  let provider = process.env.EMERALD_MODEL_PROVIDER || "groq";
  let model = process.env.EMERALD_MODEL_NAME || (provider === "groq" ? "openai/gpt-oss-120b" : "qwen2.5-coder:1.5b");
  let timeoutSec = 600;
  const spendCapUsd = parseFloat(process.env.EMERALD_SPEND_CAP_USD || "2.0");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === "--offset" && args[i + 1]) {
      offset = parseInt(args[++i], 10);
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--provider" && args[i + 1]) {
      provider = args[++i];
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeoutSec = parseInt(args[++i], 10);
    }
  }

  console.log("==================================================================");
  console.log("Emerald Agent Fabric — Governed HumanEval Benchmark Suite");
  console.log("==================================================================");
  console.log(`Provider:        ${provider}`);
  console.log(`Model:           ${model}`);
  console.log(`Task Timeout:    ${timeoutSec}s`);
  console.log(`Tasks:           ${limit ? limit : "All 10"}${offset > 0 ? ` (starting at offset ${offset})` : ""}`);
  console.log(`Spend Cap:       $${spendCapUsd.toFixed(2)}`);
  console.log("------------------------------------------------------------------");

  const results = await runHumanEvalBenchmark({
    provider,
    model,
    limit,
    offset,
    taskTimeoutMs: timeoutSec * 1000,
    modelTimeoutMs: Math.min(120_000, Math.floor((timeoutSec * 1000) * 0.75)),
    spendCapUsd,
    onProgress: (res, cur, total) => {
      const costStr = res.costUsd !== undefined ? ` | $${res.costUsd.toFixed(4)}` : "";
      const verifiedStr = res.verifiedPatch ? "VERIFIED_PATCH" : "NO_PATCH";
      console.log(
        `[${cur}/${total}] ${res.taskId} (${res.entryPoint}) -> ${res.status} ` +
          `[${Math.round(res.durationMs / 1000)}s | ${res.turnsTaken} turns | patch: ${res.patchSizeBytes}B | ${verifiedStr} | test: ${res.testPassed ? "PASS" : "FAIL"}${costStr}]`
      );
      if (res.failureReason) {
        console.log(`       Reason: ${res.failureReason}`);
      }
      if (res.toolsCalled && res.toolsCalled.length > 0) {
        console.log(`       Tools: ${res.toolsCalled.join(", ")}`);
      }
    },
  });

  const outDir = path.resolve(process.cwd(), "benchmarks", "humaneval");
  const outFile = path.join(outDir, "benchmark-results.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");

  console.log("==================================================================");
  console.log("HUMANEVAL BENCHMARK EXECUTION SUMMARY");
  console.log("==================================================================");
  console.log(`Total Tasks:     ${results.totalTasks}`);
  console.log(`Passed:          ${results.passedCount}`);
  console.log(`Failed:          ${results.failedCount}`);
  console.log(`Timed Out:       ${results.timedOutCount}`);
  console.log(`Pass Rate:       ${results.passRate.toFixed(1)}%`);
  console.log(`Total Duration:  ${(results.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`Total Cost:      $${results.totalCostUsd.toFixed(4)}`);
  console.log(`Results Saved:   ${outFile}`);
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
