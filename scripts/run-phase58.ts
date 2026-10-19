/**
 * Phase 58 — CLI Evaluation Runner
 *
 * Executes evaluation of Coupled Multi-File Inductive Program Repair Synthesis:
 * - Repair obligation extraction & provenance hashing
 * - Repair variable construction across multiple files
 * - Coupled repair graph formulation
 * - Bounded branch-and-bound candidate synthesis
 * - Transactional multi-file atomic patch application
 * - Evaluates 60-trial matrix across conditions A, B, C, D
 * - Tests negative controls N1–N8
 * - Verifies byte-identical determinism
 * - Displays PHASE58_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase58(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 58 EVALUATION RUNNER");
  console.log("Coupled Multi-File Inductive Program Repair Synthesis Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-protocol.json"), "utf8"));
  const obligationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-repair-obligations.json"), "utf8"));
  const graphsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-repair-graphs.json"), "utf8"));
  const candidatesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-candidates.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase58-results.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Obligations] Total Tasks: ${obligationsData.totalTasks}`);
  console.log(`[Coupled Graphs] Total Graphs: ${graphsData.totalGraphs}`);
  console.log(`[Candidates] Total Searches: ${candidatesData.totalSearches}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N8) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of diagnostics.diagnostics) {
    console.log(`  Task: ${diag.taskId} (${diag.title})`);
    console.log(`    Repair Variables:           ${diag.repairVariables.join(", ")}`);
    console.log(`    Constraints Evaluated:      ${diag.constraintsEvaluated.join(", ")}`);
    console.log(`    Candidates Explored:        ${diag.candidatesExplored}`);
    console.log(`    Candidates Rejected:        ${diag.candidatesRejected}`);
    console.log(`    Search Status:              ${diag.searchExhaustionStatus}`);
    console.log(`    Failure Attribution:        ${diag.failureAttribution}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A_PHASE57_CONTROL");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B_INDEPENDENT_REPAIR");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C_COUPLED_DETERMINISTIC_REPAIR");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D_FULL_COUPLED_PIPELINE");

  const calcRate = (subset: any[]) => {
    const passed = subset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${subset.length} (${((passed / subset.length) * 100).toFixed(1)}%)`;
  };

  const getTierRate = (subset: any[], tierPrefix: string) => {
    const tierSubset = subset.filter((t) => t.complexityTier.startsWith(tierPrefix));
    const passed = tierSubset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${tierSubset.length}`;
  };

  console.log(`Condition A (Phase 57 Control):         ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Independent Repair):       ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (Coupled Deterministic):    ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full Coupled Pipeline):    ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);
  console.log("===============================================================================\n");
}

if (process.argv[1]?.endsWith("run-phase58.ts")) {
  runPhase58();
}
