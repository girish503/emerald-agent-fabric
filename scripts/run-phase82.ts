/**
 * Phase 82 — Adaptive Queue Scheduling and Cost-Aware Repair Orchestration Runner
 *
 * Runs end-to-end evaluation:
 * - 60-trial scheduling experiment suite across 4 strategies
 * - Negative controls N221–N240
 * - Multi-sweep determinism check
 * - Verification of scratch artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AdaptiveRepairScheduler } from "../src/application/adaptive-repair-scheduler.js";

async function main() {
  console.log("================================================================================");
  console.log("  EMERALD AGENT FABRIC — PHASE 82 EVALUATION RUNNER");
  console.log("  Adaptive Dynamic Queue Scheduling & Cost-Aware Repair Orchestration");
  console.log("================================================================================");

  console.log("\n[1/4] Running 60-Trial Scheduling Experiment Matrix...");
  const suiteResults = AdaptiveRepairScheduler.runSchedulingExperimentSuite();

  console.log(`  Condition A (FIFO):                 Mean Wait: ${suiteResults.fifo.meanQueueWaitingMs}ms | p50: ${suiteResults.fifo.p50QueueWaitingMs}ms | p95: ${suiteResults.fifo.p95QueueWaitingMs}ms | Cost: ${suiteResults.fifo.totalActualCostMs}ms`);
  console.log(`  Condition B (Complexity First):     Mean Wait: ${suiteResults.complexityFirst.meanQueueWaitingMs}ms | p50: ${suiteResults.complexityFirst.p50QueueWaitingMs}ms | p95: ${suiteResults.complexityFirst.p95QueueWaitingMs}ms | Cost: ${suiteResults.complexityFirst.totalActualCostMs}ms`);
  console.log(`  Condition C (Cost First):           Mean Wait: ${suiteResults.costFirst.meanQueueWaitingMs}ms | p50: ${suiteResults.costFirst.p50QueueWaitingMs}ms | p95: ${suiteResults.costFirst.p95QueueWaitingMs}ms | Cost: ${suiteResults.costFirst.totalActualCostMs}ms`);
  console.log(`  Condition D (Adaptive Cost-Aware):   Mean Wait: ${suiteResults.adaptiveCostAware.meanQueueWaitingMs}ms | p50: ${suiteResults.adaptiveCostAware.p50QueueWaitingMs}ms | p95: ${suiteResults.adaptiveCostAware.p95QueueWaitingMs}ms | Cost: ${suiteResults.adaptiveCostAware.totalActualCostMs}ms`);

  const reductionVsFIFO = (
    ((suiteResults.fifo.meanQueueWaitingMs - suiteResults.adaptiveCostAware.meanQueueWaitingMs) /
      suiteResults.fifo.meanQueueWaitingMs) *
    100
  ).toFixed(1);
  console.log(`  Queue Waiting Reduction (D vs A):   ${reductionVsFIFO}%`);

  console.log("\n[2/4] Running Negative Controls (N221–N240)...");
  const negativeControls = AdaptiveRepairScheduler.evaluateNegativeControls();
  const passedControls = negativeControls.filter((c) => c.status === "PASS");
  console.log(`  Negative Controls Passed:           ${passedControls.length}/${negativeControls.length}`);

  if (passedControls.length !== negativeControls.length) {
    console.error("  FAILED negative controls detected!");
    process.exit(1);
  }

  console.log("\n[3/4] Verifying Determinism Across 3 Consecutive Sweeps...");
  const sweep1 = AdaptiveRepairScheduler.runSchedulingExperimentSuite();
  const sweep2 = AdaptiveRepairScheduler.runSchedulingExperimentSuite();
  const sweep3 = AdaptiveRepairScheduler.runSchedulingExperimentSuite();

  const isIdentical =
    JSON.stringify(sweep1) === JSON.stringify(sweep2) &&
    JSON.stringify(sweep2) === JSON.stringify(sweep3);
  console.log(`  Deterministic Match:               ${isIdentical ? "YES (byte-identical across 3 sweeps)" : "NO"}`);

  if (!isIdentical) {
    console.error("  Determinism violation detected!");
    process.exit(1);
  }

  console.log("\n[4/4] Verifying Canonical Artifacts in scratch/...");
  const artifactFiles = [
    "scratch/phase82-protocol.json",
    "scratch/phase82-complexity-model.json",
    "scratch/phase82-cost-model.json",
    "scratch/phase82-queue-cohort.json",
    "scratch/phase82-scheduling-results.json",
    "scratch/phase82-performance.json",
    "scratch/phase82-fairness.json",
    "scratch/phase82-security.json",
    "scratch/phase82-determinism.json",
    "scratch/phase82-recovery.json",
    "scratch/phase82-evidence.json",
    "scratch/phase82-status.json",
  ];

  let missingCount = 0;
  for (const relPath of artifactFiles) {
    const fullPath = path.resolve(process.cwd(), relPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`  MISSING: ${relPath}`);
      missingCount++;
    } else {
      const stat = fs.statSync(fullPath);
      console.log(`  FOUND: ${relPath} (${stat.size} bytes)`);
    }
  }

  if (missingCount > 0) {
    console.error(`  ${missingCount} required artifacts are missing!`);
    process.exit(1);
  }

  const statusPath = path.resolve(process.cwd(), "scratch/phase82-status.json");
  const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));

  console.log("\n================================================================================");
  console.log("  PHASE 82 EVALUATION SUMMARY");
  console.log("================================================================================");
  console.log(`  Phase Status:                      ${status.status}`);
  console.log(`  Scientific Decision:               ${status.decision}`);
  console.log(`  Production Readiness:              ${status.readinessLevel}`);
  console.log(`  Trials Executed:                   ${status.trialsExecuted}`);
  console.log(`  Waiting Reduction vs FIFO:         ${status.waitingReductionVsFIFO}`);
  console.log(`  Clean-Room Verification:           ${status.cleanRoomVerification}`);
  console.log(`  Fourfold Verification:             ${status.fourfoldVerification}`);
  console.log(`  Offline Auditor:                   ${status.offlineAuditor}`);
  console.log(`  Terminal Authority:                ${status.terminalAuthority}`);
  console.log(`  Negative Controls Passed:          ${status.negativeControlsPassed}`);
  console.log(`  Determinism:                       ${status.determinism}`);
  console.log(`  Historical Regression:             ${status.historicalRegression}`);
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
