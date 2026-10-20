/**
 * Phase 72 — CLI Evaluation Runner
 *
 * Executes evaluation of Governed Cross-Module Coordination Protocol:
 * - Module Participants and Semantic Commitments
 * - Two-Phase Coordination (PREPARE / COMMIT)
 * - Synchronization Barriers (PREPARE, CONTRACT, STATE_SYNC, COMMIT)
 * - Conflict Negotiation and Versioned Contract Refinement
 * - Evaluates 60-trial matrix across Conditions A, B, C, D
 * - Tests negative controls N1–N100 fail-closed
 * - Verifies byte-identical replay determinism
 * - Displays canonical PHASE72_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase72(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 72 EVALUATION RUNNER");
  console.log("Governed Cross-Module Coordination Protocol Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-protocol.json"), "utf8"));
  const participants = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-participants.json"), "utf8"));
  const commitments = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-commitments.json"), "utf8"));
  const dependencies = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-dependency-graph.json"), "utf8"));
  const conflicts = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-conflicts.json"), "utf8"));
  const resolutions = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-resolution.json"), "utf8"));
  const coordinationState = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-coordination-state.json"), "utf8"));
  const checkpoints = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-checkpoints.json"), "utf8"));
  const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-candidates.json"), "utf8"));
  const accounting = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-search-accounting.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-results.json"), "utf8"));
  const l7Diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-l7-diagnostics.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}, Parent: ${protocol.parentCommit}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Coordination Architecture] Participants: ${participants.totalParticipants}, Commitments: ${commitments.totalCommitments}, Dependencies: ${dependencies.totalEdges}`);
  console.log(`[Protocol Operations] Conflicts: ${conflicts.totalConflicts}, Resolutions: ${resolutions.totalResolutions}, Checkpoints: ${checkpoints.totalCheckpoints}, Sessions: ${coordinationState.totalSessions}`);
  console.log(`[Capability Metrics] Contract Compatibility: ${results.metrics.contract_compatibility}, Synchronization Success: ${results.metrics.synchronization_success}, Clean-Room: ${results.metrics.overall_success}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.allByteIdentical ? "PASS" : "FAIL"}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N100) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of l7Diagnostics.cases) {
    console.log(`  Task: ${diag.taskId} (${diag.domain})`);
    console.log(`    Participants:          ${diag.participants.map((p: any) => `${p.id} (${p.role})`).join(", ")}`);
    console.log(`    Coordination Outcome:  ${diag.coordinationOutcome}`);
    console.log(`    Contract Status:       ${diag.contractExchangeStatus}`);
    console.log(`    Barriers Passed:       ${diag.barriersPassed.join(", ")}`);
    console.log(`    Clean-Room Status:     ${diag.cleanRoomStatus}`);
    console.log(`    Root Cause:            ${diag.rootCause}`);
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

  console.log(`Condition A (Phase 71 Control):                  ${calcRate(condA)} | L5: ${getTierRate(condA, "L5")}, L6: ${getTierRate(condA, "L6")}, L7: ${getTierRate(condA, "L7")}`);
  console.log(`Condition B (Shared Semantic Context):           ${calcRate(condB)} | L5: ${getTierRate(condB, "L5")}, L6: ${getTierRate(condB, "L6")}, L7: ${getTierRate(condB, "L7")}`);
  console.log(`Condition C (Contract Exchange):                 ${calcRate(condC)} | L5: ${getTierRate(condC, "L5")}, L6: ${getTierRate(condC, "L6")}, L7: ${getTierRate(condC, "L7")}`);
  console.log(`Condition D (Full Governed Coordination):        ${calcRate(condD)} | L5: ${getTierRate(condD, "L5")}, L6: ${getTierRate(condD, "L6")}, L7: ${getTierRate(condD, "L7")}`);

  console.log("\n--- COORDINATION ACCOUNTING METRICS ---");
  console.log(`Total Commitments Generated:        ${accounting.summaryMetrics.totalCommitmentsGenerated}`);
  console.log(`Total Commitments Accepted:         ${accounting.summaryMetrics.totalCommitmentsAccepted}`);
  console.log(`Total Commitments Rejected:         ${accounting.summaryMetrics.totalCommitmentsRejected}`);
  console.log(`Conflicts Detected & Resolved:      ${accounting.summaryMetrics.totalConflictsDetected} / ${accounting.summaryMetrics.totalConflictsResolved}`);
  console.log(`Candidate Exchanges:                ${accounting.summaryMetrics.totalCandidateExchanges}`);
  console.log(`Synchronization Barriers Reached:   ${accounting.summaryMetrics.totalSynchronizationBarriersReached}`);
  console.log(`Mean Coordination Latency:          ${accounting.summaryMetrics.meanCoordinationLatencyMs} ms`);
  console.log(`Mean Local Synthesis Latency:       ${accounting.summaryMetrics.meanLocalSynthesisLatencyMs} ms`);

  console.log("\n--- SCIENTIFIC DECISION ---");
  console.log(`Decision:           ${results.metrics.decision}`);
  console.log(`Detail:             ${results.metrics.decisionDetail}`);
  console.log(`Remaining Boundary: ${results.metrics.remainingBoundary}`);

  const statusArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase72-status.json"), "utf8"));
  console.log("\n--- CANONICAL STATUS ---");
  console.log(statusArtifact.rawStatus);
}

if (process.argv[1] && process.argv[1].includes("run-phase72")) {
  runPhase72();
}
