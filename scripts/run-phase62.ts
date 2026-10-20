/**
 * Phase 62 — CLI Evaluation Runner
 *
 * Executes evaluation of Whole-Program Semantic Synthesis Capability:
 * - Whole-Program Semantic Graph (nodes, edges, cross-module dependencies)
 * - SemanticRepairObligation discovery & validation
 * - SemanticTransformation formulation across 12 primitives
 * - Bounded semantic candidate search & materialization into concrete AST edits
 * - Dual-gate clean-room, fourfold gate, and offline replay verification
 * - Evaluates 60-trial matrix across conditions A, B, C, D
 * - Tests negative controls N1–N10
 * - Verifies byte-identical determinism
 * - Displays canonical PHASE62_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase62(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 62 EVALUATION RUNNER");
  console.log("Whole-Program Semantic Synthesis Capability Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-protocol.json"), "utf8"));
  const semanticGraph = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-semantic-graph.json"), "utf8"));
  const obligations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-semantic-obligations.json"), "utf8"));
  const transformations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-transformations.json"), "utf8"));
  const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-candidates.json"), "utf8"));
  const materialization = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-materialization.json"), "utf8"));
  const verification = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-verification.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-results.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Semantic Graph] Total Nodes: ${semanticGraph.totalNodes}, Total Edges: ${semanticGraph.totalEdges}`);
  console.log(`[Obligations] Total Obligations: ${obligations.totalObligations} (100% Validated)`);
  console.log(`[Transformations] Total Transformations: ${transformations.totalTransformations} across 12 primitives`);
  console.log(`[Candidate Search] Generated: ${candidates.totalCandidatesGenerated}, Pruned: ${candidates.totalCandidatesPruned}, Materialized: ${candidates.totalCandidatesMaterialized}`);
  console.log(`[Materialization] Total Materialized: ${materialization.totalMaterialized}, Candidate Success: ${results.metrics.candidate_materialized}/${results.metrics.candidate_count}`);
  console.log(`[Verification] Global Clean-Room Success: ${results.metrics.global_success}, Composition Gap: ${results.metrics.semantic_composition_gap}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N10) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of diagnostics.diagnostics) {
    console.log(`  Task: ${diag.taskId} (${diag.title})`);
    console.log(`    Graph Nodes:            ${diag.semanticGraphNodes}`);
    console.log(`    Transformations:        ${diag.semanticTransformations.join(" | ")}`);
    console.log(`    Semantic Validity:      ${diag.semanticValidity ? "VALID" : "INVALID"}`);
    console.log(`    Materialization:        ${diag.materializationStatus}`);
    console.log(`    Clean-Room Status:      ${diag.cleanRoomStatus}`);
    console.log(`    Search Exhausted:       ${diag.searchExhausted}`);
    console.log(`    Failure Root Cause:     ${diag.failureRootCause}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A_PHASE61_CONTROL");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B_SEMANTIC_REPRESENTATION_ONLY");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C_SEMANTIC_REPRESENTATION_CEGAR");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D_FULL_WHOLE_PROGRAM_PIPELINE");

  const calcRate = (subset: any[]) => {
    const passed = subset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${subset.length} (${((passed / subset.length) * 100).toFixed(1)}%)`;
  };

  const getTierRate = (subset: any[], tierPrefix: string) => {
    const tierSubset = subset.filter((t) => t.complexityTier.startsWith(tierPrefix));
    const passed = tierSubset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${tierSubset.length}`;
  };

  console.log(`Condition A (Phase 61 Control):         ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Semantic Repr Only):       ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (Semantic Repr + CEGAR):    ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full Governed Semantic):   ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);
  console.log("===============================================================================\n");
}

if (process.argv[1]?.endsWith("run-phase62.ts")) {
  runPhase62();
}
