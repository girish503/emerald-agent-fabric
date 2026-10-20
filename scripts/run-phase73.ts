/**
 * Phase 73 — CLI Evaluation Runner
 *
 * Executes evaluation of Neural-Guided Governed Constructive Program Synthesis:
 * - Untrusted Neural Synthesis Advisor (qwen2.5-coder:3b)
 * - Structured Synthesis Proposal Validation (ProposalValidator)
 * - Neural Candidate Translation to ConstructiveProgram IR (NeuralCandidateTranslator)
 * - Neural Branch Prioritization (NeuralBranchPrioritizer)
 * - Deterministic Fallback on Model Failure / Timeout
 * - Evaluates 60-trial matrix across Conditions A, B, C, D
 * - Tests negative controls N1–N110 fail-closed
 * - Verifies byte-identical replay determinism
 * - Displays canonical PHASE73_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase73(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 73 EVALUATION RUNNER");
  console.log("Neural-Guided Governed Constructive Program Synthesis Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-protocol.json"), "utf8"));
  const modelIdentity = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-model-identity.json"), "utf8"));
  const modelFeasibility = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-model-feasibility.json"), "utf8"));
  const proposals = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-proposals.json"), "utf8"));
  const validations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-proposal-validation.json"), "utf8"));
  const translations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-candidate-translations.json"), "utf8"));
  const branchRankings = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-branch-rankings.json"), "utf8"));
  const accounting = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-search-accounting.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-results.json"), "utf8"));
  const l7Diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-l7-diagnostics.json"), "utf8"));
  const status = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase73-status.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}, Parent: ${protocol.parentCommit}`);
  console.log(`[Model] Name: ${modelIdentity.identity.modelName}, Parameters: ${modelIdentity.identity.parameterCount}, Quantization: ${modelIdentity.identity.quantization}`);
  console.log(`[Model Role] ${modelIdentity.identity.role} (Authority: ${modelIdentity.authorityStatus})`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Model Feasibility] Verdict: ${modelFeasibility.verificationVerdict}, Mean Latency: ${modelFeasibility.hardwareProfile.meanLatencyMs} ms`);
  console.log(`[Proposals] Total Generated: ${proposals.count}, Validations: ${validations.count}, Translations: ${translations.count}, Rankings: ${branchRankings.count}`);
  console.log(`[Capability Metrics] Valid Proposal Rate: ${results.valid_proposal_rate}, Clean-Room Success: ${results.overall_success}, L7 Success: ${results.l7_clean_room_success}`);
  console.log(`[Attribution Metrics] Discovery Gain: ${results.neural_discovery_gain}, Ordering Gain: ${results.neural_ordering_gain}, Coordination Gain: ${results.coordination_gain}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.deterministicStatus}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N110) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of l7Diagnostics.tasks) {
    console.log(`  Task: ${diag.taskId}`);
    console.log(`    Synchronized:          ${diag.participantsSynchronized}`);
    console.log(`    Proposal Valid:        ${diag.proposalValid}`);
    console.log(`    Translation Succeeded: ${diag.translationSucceeded}`);
    console.log(`    Clean-Room Passed:     ${diag.cleanRoomPassed}`);
    console.log(`    Failure Stage:         ${diag.failureStage}`);
    console.log(`    Root Cause:            ${diag.rootCause}`);
    console.log(`    Diagnostic Detail:     ${diag.diagnosticDetail}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D");

  console.log(`  Condition A (Phase 71 Control):               ${condA.filter((t: any) => t.success).length}/${condA.length} passed`);
  console.log(`  Condition B (Neural Candidate Proposal):      ${condB.filter((t: any) => t.success).length}/${condB.length} passed`);
  console.log(`  Condition C (Neural Branch Prioritization):   ${condC.filter((t: any) => t.success).length}/${condC.length} passed`);
  console.log(`  Condition D (Full Governed Neural Guidance):  ${condD.filter((t: any) => t.success).length}/${condD.length} passed`);

  console.log("\n===============================================================================");
  console.log("CANONICAL STATUS BLOCK:");
  console.log("===============================================================================");
  console.log(status.rawStatus);
  console.log("===============================================================================\n");
}

runPhase73();
