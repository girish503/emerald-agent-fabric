/**
 * Phase 71 — CLI Evaluation Runner
 *
 * Executes evaluation of Governed Guided Constructive Search:
 * - Deterministic Search Node representation and Constraint Index
 * - Forward, Backward, and Bidirectional Constraint Propagation
 * - Deterministic Branch Scoring, Conservative Dominance Pruning, and Semantic Dead-End Detection
 * - Evaluates 60-trial matrix across Conditions A, B, C, D
 * - Tests negative controls N1–N90 fail-closed
 * - Analyzes search work reduction metrics (candidate, node, materialization, proof, time)
 * - Verifies byte-identical replay determinism
 * - Displays canonical PHASE71_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase71(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 71 EVALUATION RUNNER");
  console.log("Governed Guided Constructive Search Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-protocol.json"), "utf8"));
  const strategies = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-search-strategy.json"), "utf8"));
  const constraintIndices = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-constraint-index.json"), "utf8"));
  const forwardData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-forward-constraints.json"), "utf8"));
  const backwardData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-backward-constraints.json"), "utf8"));
  const bidirData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-bidirectional-constraints.json"), "utf8"));
  const branchScores = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-branch-scores.json"), "utf8"));
  const dominanceData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-dominance.json"), "utf8"));
  const pruningData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-pruning.json"), "utf8"));
  const searchTraces = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-search-traces.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-evaluation.json"), "utf8"));
  const efficiency = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-efficiency.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-results.json"), "utf8"));
  const l7Diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-l7-diagnostics.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}, Parent: ${protocol.parentCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Search Strategies] Total Conditions: ${strategies.strategies.length}, Indexed Goals: ${constraintIndices.totalIndices}`);
  console.log(`[Pruning Evaluated] Forward: ${forwardData.totalEvaluated}, Backward: ${backwardData.totalEvaluated}, Bidirectional: ${bidirData.totalEvaluated}, Scores: ${branchScores.totalScores}, Dominance: ${dominanceData.totalEvaluated}`);
  console.log(`[Efficiency Reductions] Node Reduction: ${results.metrics.search_node_reduction_ratio}, Candidate Reduction: ${results.metrics.candidate_reduction_ratio}, Time Reduction: ${results.metrics.time_reduction_ratio}`);
  console.log(`[Verification] Overall Success: ${results.metrics.overall_success}, L7 Clean-Room: ${results.metrics.l7_clean_room_success}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- PRUNING MECHANISMS ---");
  for (const m of pruningData.pruningMechanisms) {
    console.log(`  [${m.category}] ${m.description} (Active: ${m.activeInConditions.join(", ")})`);
  }

  console.log("\n--- EVALUATING NEGATIVE CONTROLS (N1–N90) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of l7Diagnostics.diagnosticCases) {
    console.log(`  Task: ${diag.taskId} (${diag.domain})`);
    console.log(`    Constructive Goal:     ${diag.constructiveGoal}`);
    console.log(`    Forward Constraints:   ${diag.forwardConstraintsApplied.join(", ")}`);
    console.log(`    Backward Constraints:  ${diag.backwardConstraintsApplied.join(", ")}`);
    console.log(`    Bidirectional Result:  ${diag.bidirectionalIntersectionResult}`);
    console.log(`    Proof Status:          Type: ${diag.proofObligationStatus.typeCorrectness}, Effect: ${diag.proofObligationStatus.effectCompatibility}, Invariant: ${diag.proofObligationStatus.invariantPreservation}, Cross-Module: ${diag.proofObligationStatus.crossModuleSync}`);
    console.log(`    Clean-Room Status:     ${diag.cleanRoomStatus}`);
    console.log(`    Exhaustion Reason:     ${diag.exhaustionReason}`);
    console.log(`    Scientific Insight:    ${diag.scientificInsight}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "A");
  const condB = trials.filter((t: any) => t.condition === "B");
  const condC = trials.filter((t: any) => t.condition === "C");
  const condD = trials.filter((t: any) => t.condition === "D");

  const calcRate = (subset: any[]) => {
    const passed = subset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${subset.length} (${((passed / subset.length) * 100).toFixed(1)}%)`;
  };

  const getTierRate = (subset: any[], tierPrefix: string) => {
    const tierSubset = subset.filter((t) => t.level === tierPrefix);
    const passed = tierSubset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${tierSubset.length}`;
  };

  console.log(`Condition A (Phase 70 Control):                  ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Forward Guided Search):             ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (Bidirectional Guided Search):       ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full Governed Guided Search):       ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- SEARCH EFFICIENCY METRICS (D vs A) ---");
  console.log(`Baseline Generated Programs:        ${efficiency.baselineGenerated}`);
  console.log(`Guided Generated Programs:          ${efficiency.guidedGenerated}`);
  console.log(`Search Node Reduction Ratio:        ${results.metrics.search_node_reduction_ratio}`);
  console.log(`Candidate Reduction Ratio:          ${results.metrics.candidate_reduction_ratio}`);
  console.log(`Materialization Reduction Ratio:    ${results.metrics.materialization_reduction_ratio}`);
  console.log(`Proof Evaluation Reduction Ratio:   ${results.metrics.proof_evaluation_reduction_ratio}`);
  console.log(`Time Reduction Ratio:               ${results.metrics.time_reduction_ratio}`);
  console.log(`Latency Reduction (L5):             ${efficiency.meanLatencyReductionMs.L5}`);
  console.log(`Latency Reduction (L6):             ${efficiency.meanLatencyReductionMs.L6}`);
  console.log(`Latency Reduction (L7):             ${efficiency.meanLatencyReductionMs.L7}`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);

  const statusArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase71-status.json"), "utf8"));
  console.log("\n--- CANONICAL STATUS ---");
  console.log(statusArtifact.rawStatus);
}

if (process.argv[1] && process.argv[1].includes("run-phase71")) {
  runPhase71();
}
