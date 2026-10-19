/**
 * Phase 54 — Governed Multi-Hop Patch Synthesis Runner
 *
 * Runs and summarizes Phase 54 evaluation across all four conditions:
 * - Condition A: Phase 53 Control (monolithic global repair under global invariant reconciliation)
 * - Condition B: Atomic Edit Decomposition (AtomicPatchPlan with independently validated edits)
 * - Condition C: Search -> Transform -> Validate (structural search + exact target resolution)
 * - Condition D: Governed Incremental Patch Synthesis (dependency ordering + checkpoints + invariant preservation)
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase54() {
  console.log("================================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 54: MULTI-HOP PATCH SYNTHESIS EVALUATION");
  console.log("================================================================================\n");

  const protocolPath = path.join(ROOT, "scratch/phase54-protocol.json");
  const plansPath = path.join(ROOT, "scratch/phase54-patch-plans.json");
  const editsPath = path.join(ROOT, "scratch/phase54-atomic-edits.json");
  const checkpointsPath = path.join(ROOT, "scratch/phase54-checkpoints.json");
  const evalPath = path.join(ROOT, "scratch/phase54-evaluation.json");
  const resultsPath = path.join(ROOT, "scratch/phase54-results.json");

  if (
    !fs.existsSync(protocolPath) ||
    !fs.existsSync(plansPath) ||
    !fs.existsSync(editsPath) ||
    !fs.existsSync(checkpointsPath) ||
    !fs.existsSync(evalPath) ||
    !fs.existsSync(resultsPath)
  ) {
    console.error("Missing required Phase 54 artifacts.");
    process.exit(1);
  }

  const protocol = JSON.parse(fs.readFileSync(protocolPath, "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(evalPath, "utf8"));
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

  console.log("[FROZEN HARDWARE & MODEL BASELINE]");
  console.log(`- CPU Host:          ${protocol.hardware.cpu} (${protocol.hardware.cores} cores, ${protocol.hardware.ram})`);
  console.log(`- Accelerator:       ${protocol.hardware.acceleratorStatus}`);
  console.log(`- Step Ceiling:      ${protocol.hardware.stepTimeoutCeilingMs} ms`);
  console.log(`- Baseline Commit:   ${protocol.frozenBaselineCommit} (Phase 53)`);
  console.log(`- Models in Cascade:`);
  console.log(`  * Executor:        ${protocol.models.executor.model} (1.5B Q4_K_M)`);
  console.log(`  * Reasoner:        ${protocol.models.semanticReasoner.model} (3.1B Q4_K_M)`);
  console.log(`  * Critic:          ${protocol.models.critic.model} (2.6B Q4_K_M)\n`);

  console.log("[EVALUATION RESULTS across 60 trials (15 tasks x 4 conditions)]");
  const condA = evaluation.trials.filter((e: any) => e.condition === "CONDITION_A_PHASE53_CONTROL");
  const condB = evaluation.trials.filter((e: any) => e.condition === "CONDITION_B_ATOMIC_EDIT_DECOMPOSITION");
  const condC = evaluation.trials.filter((e: any) => e.condition === "CONDITION_C_SEARCH_TRANSFORM_VALIDATE");
  const condD = evaluation.trials.filter((e: any) => e.condition === "CONDITION_D_GOVERNED_INCREMENTAL_PATCH_SYNTHESIS");

  const rateA = condA.filter((e: any) => e.repositorySuccess).length / condA.length;
  const rateB = condB.filter((e: any) => e.repositorySuccess).length / condB.length;
  const rateC = condC.filter((e: any) => e.repositorySuccess).length / condC.length;
  const rateD = condD.filter((e: any) => e.repositorySuccess).length / condD.length;

  console.log(`- Condition A (P53 Control):       ${(rateA * 100).toFixed(1)}% (${condA.filter((e: any) => e.repositorySuccess).length}/${condA.length})`);
  console.log(`- Condition B (Atomic Edits):      ${(rateB * 100).toFixed(1)}% (${condB.filter((e: any) => e.repositorySuccess).length}/${condB.length})`);
  console.log(`- Condition C (Search->Transform): ${(rateC * 100).toFixed(1)}% (${condC.filter((e: any) => e.repositorySuccess).length}/${condC.length})`);
  console.log(`- Condition D (Governed Increm.):  ${(rateD * 100).toFixed(1)}% (${condD.filter((e: any) => e.repositorySuccess).length}/${condD.length})\n`);

  console.log("[CAPABILITY BREAKDOWN BY TIER]");
  console.log(`- Level 5 (Multi-Function):        ${(results.metrics.l5Success * 100).toFixed(1)}% (5/5)`);
  console.log(`- Level 6 (Multi-File):            ${(results.metrics.l6Success * 100).toFixed(1)}% (5/5)`);
  console.log(`- Level 7 (SWE-bench Verified):    ${(results.metrics.l7Success * 100).toFixed(1)}% (0/5)`);
  console.log(`- Level 7 Delta:                   ${(results.metrics.l7Delta * 100).toFixed(1)} percentage points\n`);

  console.log("[PATCH SYNTHESIS & EXECUTION METRICS]");
  console.log(`- Atomic Edit Success Rate:        ${(results.metrics.atomicEditSuccessRate * 100).toFixed(1)}%`);
  console.log(`- Patch Plan Completion Rate:      ${(results.metrics.patchCompletionRate * 100).toFixed(1)}%`);
  console.log(`- Edit-to-Repository Gap:          ${(results.metrics.editToRepositoryGap * 100).toFixed(1)}%`);
  console.log(`- Regression Preservation Rate:    ${(results.metrics.regressionPreservation * 100).toFixed(1)}%`);
  console.log(`- Target Resolution Accuracy:      ${(results.metrics.targetResolutionAccuracy * 100).toFixed(1)}%`);
  console.log(`- AST Structural Validity:         ${(results.metrics.astValidity * 100).toFixed(1)}%`);
  console.log(`- Structural Postcondition Rate:   ${(results.metrics.postconditionSuccess * 100).toFixed(1)}%\n`);

  console.log("[DIAGNOSTIC TASK HIGHLIGHTS]");
  console.log(`- P46-L7-01 (Calc Pratt Precedence): Target resolved (bp: 9 vs 8), atomic edits generated, failed at clean room (juxtaposition regression on 5 - -2)`);
  console.log(`- P46-L7-02 (CORS Multi-Origin Regex): Target resolved (wildcard port), atomic edits generated, failed at clean room (origin echo / credentials violation)\n`);

  console.log("[GOVERNANCE & INTEGRITY]");
  console.log(`- Clean-Room Integrity:            ${(results.metrics.cleanRoomIntegrity * 100).toFixed(1)}%`);
  console.log(`- Fourfold Completion Integrity:   ${(results.metrics.fourfoldIntegrity * 100).toFixed(1)}%`);
  console.log(`- Ed25519 Threshold Signing:       ${(results.metrics.ed25519ThresholdIntegrity * 100).toFixed(1)}%`);
  console.log(`- Offline Auditor Agreement:       ${(results.metrics.offlineAuditorAgreement * 100).toFixed(1)}%`);
  console.log(`- Governance Invariants:           ${(results.metrics.governanceIntegrity * 100).toFixed(1)}%\n`);

  console.log("[DECISION & SCIENTIFIC OUTCOME]");
  console.log(`- Primary Failure Class:           ${results.metrics.primaryFailureClass}`);
  console.log(`- Scientific Outcome:              ${results.metrics.scientificOutcome}`);
  console.log(`- Decision:                        ${results.metrics.decision}`);
  console.log(`- Decision Detail:                 ${results.metrics.decisionDetail}`);
  console.log(`- Next Research Boundary:          ${results.metrics.nextResearchBoundary}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run-phase54.ts")) {
  runPhase54();
}
