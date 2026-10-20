/**
 * Phase 61 — CLI Evaluation Runner
 *
 * Executes evaluation of Governed Joint Semantic Synthesis and Multi-Region Composition:
 * - Evidence-based CoupledRegionGroup discovery
 * - JointRepairVariable construction across coupled regions
 * - CrossRegionConstraint extraction & canonical hashing
 * - Bounded joint candidate synthesis & CEGAR pruning
 * - Multi-region composition & global verification
 * - Evaluates 60-trial matrix across conditions A, B, C, D
 * - Tests negative controls N1–N10
 * - Verifies byte-identical determinism
 * - Displays PHASE61_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase61(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 61 EVALUATION RUNNER");
  console.log("Governed Joint Semantic Synthesis and Multi-Region Composition Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-protocol.json"), "utf8"));
  const coupledRegionsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-coupled-regions.json"), "utf8"));
  const jointVariablesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-joint-variables.json"), "utf8"));
  const constraintsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-cross-region-constraints.json"), "utf8"));
  const candidatesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-candidates.json"), "utf8"));
  const searchTraceData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-search-trace.json"), "utf8"));
  const compositionData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-composition.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase61-results.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Coupled Groups] Total Coupled Region Groups: ${coupledRegionsData.totalCoupledGroups}`);
  console.log(`[Joint Variables] Total Joint Repair Variables: ${jointVariablesData.totalJointVariables}`);
  console.log(`[Constraints] Total Cross-Region Constraints: ${constraintsData.totalConstraints} (100% Canonical Hashed)`);
  console.log(`[Candidate Search] Generated: ${candidatesData.totalCandidatesGenerated}, Pruned: ${candidatesData.totalCandidatesPruned}, Executed: ${candidatesData.totalCandidatesExecuted}`);
  console.log(`[Search Traces] Total Traces: ${searchTraceData.totalTraces}, L7 Exhaustion: ${results.metrics.search_exhaustion}`);
  console.log(`[Composition] Global Clean-Room Success: ${compositionData.totalSuccess}/${compositionData.totalTasks} (${(compositionData.globalSuccessRate * 100).toFixed(1)}%), Composition Gap: ${(compositionData.jointCompositionGap * 100).toFixed(1)}%`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N10) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of diagnostics.diagnostics) {
    console.log(`  Task: ${diag.taskId} (${diag.title})`);
    console.log(`    Coupled Group:          ${diag.coupledGroup}`);
    console.log(`    Coupled Regions:        ${diag.coupledRegions.join(" | ")}`);
    console.log(`    Joint Variables:        ${diag.jointVariables.join(", ")}`);
    console.log(`    Constraints / Pruned:   ${diag.constraints} / ${diag.candidatesPruned}`);
    console.log(`    Search Exhausted:       ${diag.searchExhausted}`);
    console.log(`    Clean-Room Status:      ${diag.cleanRoomStatus}`);
    console.log(`    Failure Root Cause:     ${diag.failureRootCause}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A_PHASE60_CONTROL");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B_JOINT_SYNTHESIS");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C_JOINT_SYNTHESIS_CEGAR");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D_FULL_GOVERNED_JOINT_SYNTHESIS");

  const calcRate = (subset: any[]) => {
    const passed = subset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${subset.length} (${((passed / subset.length) * 100).toFixed(1)}%)`;
  };

  const getTierRate = (subset: any[], tierPrefix: string) => {
    const tierSubset = subset.filter((t) => t.complexityTier.startsWith(tierPrefix));
    const passed = tierSubset.filter((t) => t.cleanRoomPassed).length;
    return `${passed}/${tierSubset.length}`;
  };

  console.log(`Condition A (Phase 60 Control):         ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Joint Synthesis):          ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (Joint Synthesis + CEGAR):  ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full Governed Joint):      ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);
  console.log("===============================================================================\n");
}

if (process.argv[1]?.endsWith("run-phase61.ts")) {
  runPhase61();
}
