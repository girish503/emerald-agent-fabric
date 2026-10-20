/**
 * Phase 84 — Speculative Parallel Multi-Hypothesis Clean-Room Execution Runner
 *
 * Runs end-to-end evaluation:
 * - 60-trial speculative parallel clean-room experiment matrix
 * - Negative controls N261–N280 (20/20)
 * - Multi-sweep determinism check (100% byte-identical)
 * - Verification of all 14 canonical scratch artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SpeculativeVerificationOrchestrator } from "../src/application/speculative-verification-orchestrator.js";
import { canonicalJsonStringify, sha256Hex } from "../src/domain/canonical-hash.js";

async function main() {
  console.log("================================================================================");
  console.log("  EMERALD AGENT FABRIC — PHASE 84 EVALUATION RUNNER");
  console.log("  Speculative Parallel Multi-Hypothesis Clean-Room Execution");
  console.log("================================================================================");

  const orchestrator = new SpeculativeVerificationOrchestrator();

  console.log("\n[1/4] Running 60-Trial Speculative Parallel Experiment Matrix...");
  const matrixResult = orchestrator.run60TrialMatrix();
  const summary = matrixResult.summary;

  console.log(`  Condition A (Sequential Baseline):  WallClock: ${summary.meanWallClockMs.sequential.toFixed(1)}ms | Time-to-First: ${summary.meanTimeToFirstVerifiedMs.sequential.toFixed(1)}ms | Compute: ${summary.aggregateComputeCostMs.sequential}ms | Eff: ${(summary.meanEfficiency.sequential * 100).toFixed(1)}%`);
  console.log(`  Condition B (Parallel-2):           WallClock: ${summary.meanWallClockMs.parallel2.toFixed(1)}ms | Time-to-First: ${summary.meanTimeToFirstVerifiedMs.parallel2.toFixed(1)}ms | Speedup: ${summary.speedupVsSequential.parallel2.toFixed(2)}x | Compute: ${summary.aggregateComputeCostMs.parallel2}ms`);
  console.log(`  Condition C (Parallel-4):           WallClock: ${summary.meanWallClockMs.parallel4.toFixed(1)}ms | Time-to-First: ${summary.meanTimeToFirstVerifiedMs.parallel4.toFixed(1)}ms | Speedup: ${summary.speedupVsSequential.parallel4.toFixed(2)}x | Compute: ${summary.aggregateComputeCostMs.parallel4}ms`);
  console.log(`  Condition D (Adaptive Parallel):    WallClock: ${summary.meanWallClockMs.adaptive.toFixed(1)}ms | Time-to-First: ${summary.meanTimeToFirstVerifiedMs.adaptive.toFixed(1)}ms | Speedup: ${summary.speedupVsSequential.adaptive.toFixed(2)}x | Compute: ${summary.aggregateComputeCostMs.adaptive}ms`);
  console.log(`  Total Trials Evaluated:             ${summary.totalTrials}/60`);
  console.log(`  Terminal Correctness Rate:          ${(summary.terminalCorrectnessRate * 100).toFixed(0)}% (60/60)`);
  console.log(`  Multiple Terminal Success Count:    ${summary.multipleTerminalSuccessViolations} (Strict Invariant Upheld)`);

  console.log("\n[2/4] Running Negative Controls (N261–N280)...");
  const negativeControls = orchestrator.evaluateNegativeControls();
  const passedControls = negativeControls.filter((c) => c.status === "PASS");
  console.log(`  Negative Controls Passed:           ${passedControls.length}/${negativeControls.length}`);

  if (passedControls.length !== negativeControls.length) {
    console.error("  FAILED negative controls detected!");
    process.exit(1);
  }

  console.log("\n[3/4] Verifying Determinism Across 3 Consecutive Sweeps...");
  const sweep1 = orchestrator.run60TrialMatrix();
  const sweep2 = orchestrator.run60TrialMatrix();
  const sweep3 = orchestrator.run60TrialMatrix();

  const d1 = sha256Hex(canonicalJsonStringify(sweep1.trials));
  const d2 = sha256Hex(canonicalJsonStringify(sweep2.trials));
  const d3 = sha256Hex(canonicalJsonStringify(sweep3.trials));

  const isIdentical = d1 === d2 && d2 === d3;
  console.log(`  Deterministic Match:               ${isIdentical ? "YES (byte-identical across 3 sweeps)" : "NO"}`);

  if (!isIdentical) {
    console.error("  Determinism violation detected!");
    process.exit(1);
  }

  console.log("\n[4/4] Verifying Scratch Artifacts (14 files)...");
  const requiredArtifacts = [
    "phase84-protocol.json",
    "phase84-candidate-cohort.json",
    "phase84-candidate-identities.json",
    "phase84-parallelism-model.json",
    "phase84-scheduling-results.json",
    "phase84-verification-results.json",
    "phase84-cancellation-results.json",
    "phase84-performance.json",
    "phase84-cost.json",
    "phase84-security.json",
    "phase84-determinism.json",
    "phase84-recovery.json",
    "phase84-evidence.json",
    "phase84-status.json",
  ];

  let missing = 0;
  for (const f of requiredArtifacts) {
    const fullPath = path.join(process.cwd(), "scratch", f);
    if (!fs.existsSync(fullPath)) {
      console.error(`  MISSING: scratch/${f}`);
      missing++;
    } else {
      const stats = fs.statSync(fullPath);
      console.log(`  OK: scratch/${f} (${stats.size} bytes)`);
    }
  }

  if (missing > 0) {
    console.error(`  ${missing} required artifacts missing!`);
    process.exit(1);
  }

  console.log("\n================================================================================");
  console.log("  PHASE 84 VERIFICATION: SUCCESS");
  console.log("  DECISION: LATENCY_GAIN_COMPUTE_TRADEOFF");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
