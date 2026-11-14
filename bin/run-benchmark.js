#!/usr/bin/env node
/**
 * Emerald Agent Fabric — SWE-bench Lite Benchmark CLI
 *
 * Runs the reproducible 10-task SWE-bench Lite benchmark against local Ollama.
 * Usage:
 *   node bin/run-benchmark.js [--limit N] [--model MODEL] [--timeout SEC]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runSweBenchLiteBenchmark } from "../dist/src/application/evaluation/swe-bench-lite-runner.js";

async function main() {
  const args = process.argv.slice(2);
  let limit;
  let model = "qwen2.5-coder:1.5b";
  let timeoutSec = 60;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeoutSec = parseInt(args[++i], 10);
    }
  }

  console.log("==================================================================");
  console.log("Emerald Agent Fabric — SWE-bench Lite Benchmark Suite (Phase 5)");
  console.log("==================================================================");
  console.log(`Model:           ${model}`);
  console.log(`Provider:        Ollama (local ₹0, http://127.0.0.1:11434)`);
  console.log(`Task Timeout:    ${timeoutSec}s`);
  console.log(`Tasks:           ${limit ? limit : 10}`);
  console.log("------------------------------------------------------------------");

  const results = await runSweBenchLiteBenchmark({
    model,
    limit,
    taskTimeoutMs: timeoutSec * 1000,
    modelTimeoutMs: Math.min(120_000, Math.floor((timeoutSec * 1000) * 0.75)),
    onProgress: (res, cur, total) => {
      console.log(
        `[${cur}/${total}] ${res.instanceId} (${res.repo}) -> ${res.status} ` +
          `[${Math.round(res.durationMs / 1000)}s | ${res.turnsTaken} turns | patch: ${res.patchSizeBytes}B]`
      );
      if (res.failureReason) {
        console.log(`       Reason: ${res.failureReason}`);
      }
    },
  });

  const outDir = path.resolve(process.cwd(), "benchmarks", "swe-bench-lite");
  const outFile = path.join(outDir, "benchmark-results.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");
  if (timeoutSec === 180) {
    fs.writeFileSync(path.join(outDir, "benchmark-results-180s.json"), JSON.stringify(results, null, 2), "utf8");
  }

  console.log("==================================================================");
  console.log("BENCHMARK EXECUTION SUMMARY");
  console.log("==================================================================");
  console.log(`Total Tasks:     ${results.totalTasks}`);
  console.log(`Passed:          ${results.passedCount}`);
  console.log(`Failed:          ${results.failedCount}`);
  console.log(`Timed Out:       ${results.timedOutCount}`);
  console.log(`Pass Rate:       ${results.passRate.toFixed(1)}%`);
  console.log(`Total Time:      ${(results.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`Results Saved:   ${outFile}`);
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
