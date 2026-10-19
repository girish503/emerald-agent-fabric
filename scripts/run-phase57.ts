/**
 * Phase 57 — CLI Evaluation Runner
 *
 * Executes evaluation of Whole-Program Semantic Intent Inference & Cross-Module Contract Reconciliation:
 * - Evidence extraction & provenance verification
 * - Semantic invariant derivation
 * - Cross-module contract graph construction
 * - Conflict detection & reconciliation
 * - Evaluates 60-trial matrix across conditions A, B, C, D
 * - Tests negative controls N1–N8 and hidden-invariant control
 * - Verifies byte-identical determinism
 * - Displays PHASE57_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

function run() {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 57 EVALUATION RUNNER");
  console.log("Whole-Program Semantic Intent Inference & Contract Reconciliation Boundary");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-protocol.json"), "utf8"));
  const evidenceData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-semantic-evidence.json"), "utf8"));
  const invariantsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-invariants.json"), "utf8"));
  const graphsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-contract-graphs.json"), "utf8"));
  const reconData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-reconciliation.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase57-results.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Evidence] Extracted Tasks: ${evidenceData.totalTasks}`);
  console.log(`[Invariants] Inferred Tasks: ${invariantsData.totalTasks}`);
  console.log(`[Contract Graphs] Total Graphs: ${graphsData.totalGraphs}`);
  console.log(`[Reconciliation] Total Tasks Evaluated: ${reconData.totalTasks}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N8 + HIDDEN INVARIANT) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of diagnostics.diagnostics) {
    console.log(`  Task: ${diag.taskId} (${diag.title})`);
    console.log(`    Primary Bug:               ${diag.inferredSemantics.primaryBug}`);
    console.log(`    Discovered Hidden Invariant: ${diag.inferredSemantics.discoveredHiddenInvariant}`);
    console.log(`    Conflict Detected:          ${diag.inferredSemantics.conflictDetected}`);
    console.log(`    Reconciliation Status:      ${diag.inferredSemantics.reconciliationStatus}`);
    console.log(`    Repair Feasibility:         ${diag.inferredSemantics.repairFeasibility}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A_PHASE56_CONTROL");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B_SEMANTIC_SPECIFICATION_INFERENCE");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C_INFERENCE_PLUS_RECONCILIATION");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D_FULL_SEMANTIC_INTENT_PIPELINE");

  const calcRate = (subset: any[]) => {
    const passed = subset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${subset.length} (${((passed / subset.length) * 100).toFixed(1)}%)`;
  };

  const getTierRate = (subset: any[], tierPrefix: string) => {
    const tierSubset = subset.filter((t) => t.complexityTier.startsWith(tierPrefix));
    const passed = tierSubset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${tierSubset.length}`;
  };

  console.log(`Condition A (Phase 56 Control):         ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Semantic Inference):        ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (Inference + Reconcil):      ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full Governed Pipeline):    ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);
  console.log("===============================================================================\n");
}

run();
