/**
 * Phase 59 — CLI Evaluation Runner
 *
 * Executes evaluation of Counterexample-Guided Coupled Repair Search (CEGAR):
 * - Counterexample extraction & normalization
 * - Counterexample generalization into RefinementConstraints
 * - Unsound refinement protection
 * - Search space pruning & reduction ratio tracking
 * - Evaluates 60-trial matrix across conditions A, B, C, D
 * - Tests negative controls N1–N9
 * - Verifies byte-identical determinism
 * - Displays PHASE59_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase59(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 59 EVALUATION RUNNER");
  console.log("Counterexample-Guided Coupled Repair Search (CEGAR) Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-protocol.json"), "utf8"));
  const counterexamplesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-counterexamples.json"), "utf8"));
  const refinementsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-refinement-constraints.json"), "utf8"));
  const tracesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-search-traces.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase59-results.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Counterexamples] Total Tasks with Failure Records: ${counterexamplesData.totalTasks}`);
  console.log(`[Refinements] Total Tasks with Generalized Constraints: ${refinementsData.totalTasks}`);
  console.log(`[Search Traces] Total Traces: ${tracesData.totalTraces}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N9) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of diagnostics.diagnostics) {
    console.log(`  Task: ${diag.taskId} (${diag.title})`);
    console.log(`    Repair Variables:           ${diag.repairVariables.join(", ")}`);
    console.log(`    Counterexamples Extracted:  ${diag.counterexamplesExtracted.length}`);
    console.log(`    Refinements Derived:        ${diag.refinementConstraintsDerived.length}`);
    console.log(`    Initial Space / Pruned:     ${diag.initialSearchSpace} / ${diag.prunedCandidates} (Reduction: ${(diag.searchReductionRatio * 100).toFixed(1)}%)`);
    console.log(`    Search Status:              ${diag.searchExhaustionStatus}`);
    console.log(`    Failure Attribution:        ${diag.failureAttribution}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A_PHASE58_CONTROL");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B_COUNTEREXAMPLE_COLLECTION");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C_CEGAR");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D_FULL_CEGAR_PIPELINE");

  const calcRate = (subset: any[]) => {
    const passed = subset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${subset.length} (${((passed / subset.length) * 100).toFixed(1)}%)`;
  };

  const getTierRate = (subset: any[], tierPrefix: string) => {
    const tierSubset = subset.filter((t) => t.complexityTier.startsWith(tierPrefix));
    const passed = tierSubset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${tierSubset.length}`;
  };

  console.log(`Condition A (Phase 58 Control):         ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Counterexample Collect):   ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (CEGAR Search Pruning):     ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full CEGAR Pipeline):      ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);
  console.log("===============================================================================\n");
}

if (process.argv[1]?.endsWith("run-phase59.ts")) {
  runPhase59();
}
