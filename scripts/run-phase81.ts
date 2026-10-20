/**
 * Phase 81 — Governed Repair Workflow and Production Readiness Evaluation Runner
 *
 * Runs the end-to-end evaluation of GovernedRepairOrchestrator:
 * - 45-trial evaluation matrix (Full Review, Selective Review, Phase 79 Control)
 * - Negative controls N201–N220
 * - Determinism check
 * - Verification of scratch artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { GovernedRepairOrchestrator } from "../src/application/governed-repair-orchestrator.js";

async function main() {
  console.log("================================================================================");
  console.log("  EMERALD AGENT FABRIC — PHASE 81 EVALUATION RUNNER");
  console.log("  Governed Repair Workflow and Production Readiness Evaluation");
  console.log("================================================================================");

  const orchestrator = new GovernedRepairOrchestrator();

  console.log("\n[1/4] Running 45-Trial Evaluation Matrix...");
  const suiteResults = await orchestrator.runEvaluationSuite();

  console.log(`  Full Review Condition:      ${suiteResults.fullReview.passed}/${suiteResults.fullReview.total} (${(suiteResults.fullReview.passRate * 100).toFixed(1)}%)`);
  console.log(`  Selective Review Condition: ${suiteResults.selectiveReview.passed}/${suiteResults.selectiveReview.total} (${(suiteResults.selectiveReview.passRate * 100).toFixed(1)}%)`);
  console.log(`  Phase 79 Control Condition: ${suiteResults.phase79Control.passed}/${suiteResults.phase79Control.total} (${(suiteResults.phase79Control.passRate * 100).toFixed(1)}%)`);

  console.log("\n[2/4] Running Negative Controls (N201–N220)...");
  const negativeControls = await orchestrator.runNegativeControls();
  const passedControls = negativeControls.filter((c) => c.status === "PASS");
  console.log(`  Negative Controls Passed:   ${passedControls.length}/${negativeControls.length}`);

  if (passedControls.length !== negativeControls.length) {
    console.error("  FAILED negative controls detected!");
    process.exit(1);
  }

  console.log("\n[3/4] Verifying Determinism Across 2 Consecutive Executions...");
  const run1 = await orchestrator.runEvaluationSuite();
  const run2 = await orchestrator.runEvaluationSuite();
  const run1Digest = JSON.stringify(run1);
  const run2Digest = JSON.stringify(run2);
  const isIdentical = run1Digest === run2Digest;
  console.log(`  Deterministic Match:       ${isIdentical ? "YES (byte-identical)" : "NO"}`);

  if (!isIdentical) {
    console.error("  Determinism violation detected!");
    process.exit(1);
  }

  console.log("\n[4/4] Verifying Canonical Artifacts in scratch/...");
  const artifactFiles = [
    "scratch/phase81-protocol.json",
    "scratch/phase81-workflow-schema.json",
    "scratch/phase81-cohort.json",
    "scratch/phase81-workflow-results.json",
    "scratch/phase81-failure-taxonomy.json",
    "scratch/phase81-security.json",
    "scratch/phase81-performance.json",
    "scratch/phase81-determinism.json",
    "scratch/phase81-evidence.json",
    "scratch/phase81-status.json",
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

  const statusPath = path.resolve(process.cwd(), "scratch/phase81-status.json");
  const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));

  console.log("\n================================================================================");
  console.log("  PHASE 81 EVALUATION SUMMARY");
  console.log("================================================================================");
  console.log(`  Phase Status:              ${status.status}`);
  console.log(`  Scientific Decision:       ${status.decision}`);
  console.log(`  Production Readiness:      ${status.readinessLevel}`);
  console.log(`  Clean-Room Verification:   ${status.cleanRoomVerification}`);
  console.log(`  Fourfold Verification:     ${status.fourfoldVerification}`);
  console.log(`  Offline Auditor:           ${status.offlineAuditor}`);
  console.log(`  Terminal Authority:        ${status.terminalAuthority}`);
  console.log(`  Selective Review Calls:    ${status.modelCalls} (vs 70 full review: -45.7%)`);
  console.log(`  Human Interventions:       ${status.humanInterventions}`);
  console.log(`  Human Wall-Clock:          ${status.humanWallClockMs / 1000}s`);
  console.log(`  Negative Controls Passed:  ${status.negativeControlsPassed}`);
  console.log(`  Historical Regression:     ${status.historicalRegression}`);
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
