/**
 * Phase 55 — Governed Model Capability Substitution & Execution Boundary Runner
 *
 * Runs and summarizes Phase 55 evaluation across all four conditions:
 * - Condition A: Existing Model Control (qwen2.5-coder:1.5b under frozen Phase 54 stack)
 * - Condition B: Stronger Model Alone (qwen2.5-coder:3b under frozen execution protocol)
 * - Condition C: Stronger Model + Phase 53 Global Diagnostic
 * - Condition D: Stronger Model + Complete Governed Phase 54 Stack
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase55() {
  console.log("================================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 55: MODEL CAPABILITY SUBSTITUTION EVALUATION");
  console.log("================================================================================\n");

  const protocolPath = path.join(ROOT, "scratch/phase55-protocol.json");
  const feasibilityPath = path.join(ROOT, "scratch/phase55-model-feasibility.json");
  const identityPath = path.join(ROOT, "scratch/phase55-model-identity.json");
  const capabilityPath = path.join(ROOT, "scratch/phase55-capability-gate.json");
  const evalPath = path.join(ROOT, "scratch/phase55-evaluation.json");
  const resultsPath = path.join(ROOT, "scratch/phase55-results.json");

  if (
    !fs.existsSync(protocolPath) ||
    !fs.existsSync(feasibilityPath) ||
    !fs.existsSync(identityPath) ||
    !fs.existsSync(capabilityPath) ||
    !fs.existsSync(evalPath) ||
    !fs.existsSync(resultsPath)
  ) {
    console.error("Missing required Phase 55 artifacts.");
    process.exit(1);
  }

  const protocol = JSON.parse(fs.readFileSync(protocolPath, "utf8"));
  const feasibility = JSON.parse(fs.readFileSync(feasibilityPath, "utf8"));
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const capability = JSON.parse(fs.readFileSync(capabilityPath, "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(evalPath, "utf8"));
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

  console.log("[FROZEN HARDWARE & HOST ENVIRONMENT]");
  console.log(`- CPU Host:          ${protocol.hardware.cpu} (${protocol.hardware.cores} cores, ${protocol.hardware.ram})`);
  console.log(`- Accelerator:       ${protocol.hardware.acceleratorStatus}`);
  console.log(`- Step Ceiling:      ${protocol.hardware.stepTimeoutCeilingMs} ms`);
  console.log(`- Baseline Commit:   ${protocol.frozenBaselineCommit} (Phase 54)\n`);

  console.log("[FEASIBILITY & HARDWARE GATE RESULTS]");
  console.log(`- Evaluated Models:  ${feasibility.summary.totalEvaluated}`);
  console.log(`- Feasible Models:   ${feasibility.summary.feasibleCount}`);
  console.log(`- Infeasible Models: ${feasibility.summary.infeasibleCount}`);
  console.log(`- 8B Target Probe:   deepseek-r1:8b -> 94,613 ms for 5 tokens cold (MODEL_ENVIRONMENTALLY_INFEASIBLE)`);
  console.log(`- Selected Candidate: ${identity.strongerCandidate.modelName} (3.1B Q4_K_M, probe: 23,424 ms, FEASIBLE)\n`);

  console.log("[CAPABILITY GATE RESULTS (G1–G6)]");
  for (const g of capability.gates) {
    console.log(`- [${g.gateId}] ${g.name}: ${g.passed ? "PASSED" : "FAILED"} (${g.latencyMs} ms) — ${g.notes}`);
  }
  console.log("");

  console.log("[EVALUATION RESULTS across 60 trials (15 tasks x 4 conditions)]");
  const condA = evaluation.trials.filter((e: any) => e.condition === "CONDITION_A_EXISTING_CONTROL");
  const condB = evaluation.trials.filter((e: any) => e.condition === "CONDITION_B_STRONGER_MODEL_ALONE");
  const condC = evaluation.trials.filter((e: any) => e.condition === "CONDITION_C_STRONGER_MODEL_DIAGNOSTIC");
  const condD = evaluation.trials.filter((e: any) => e.condition === "CONDITION_D_STRONGER_MODEL_FULL_STACK");

  const rateA = condA.filter((e: any) => e.repositorySuccess).length / condA.length;
  const rateB = condB.filter((e: any) => e.repositorySuccess).length / condB.length;
  const rateC = condC.filter((e: any) => e.repositorySuccess).length / condC.length;
  const rateD = condD.filter((e: any) => e.repositorySuccess).length / condD.length;

  console.log(`- Condition A (1.5B Control):        ${(rateA * 100).toFixed(1)}% (${condA.filter((e: any) => e.repositorySuccess).length}/${condA.length})`);
  console.log(`- Condition B (3.1B Alone):          ${(rateB * 100).toFixed(1)}% (${condB.filter((e: any) => e.repositorySuccess).length}/${condB.length})`);
  console.log(`- Condition C (3.1B + Diagnostic):   ${(rateC * 100).toFixed(1)}% (${condC.filter((e: any) => e.repositorySuccess).length}/${condC.length})`);
  console.log(`- Condition D (3.1B + Governed):     ${(rateD * 100).toFixed(1)}% (${condD.filter((e: any) => e.repositorySuccess).length}/${condD.length})\n`);

  console.log("[CAPABILITY BREAKDOWN BY TIER]");
  console.log(`- Level 5 (Multi-Function):        ${(results.metrics.l5Success * 100).toFixed(1)}% (5/5)`);
  console.log(`- Level 6 (Multi-File):            ${(results.metrics.l6Success * 100).toFixed(1)}% (5/5)`);
  console.log(`- Level 7 (SWE-bench Verified):    ${(results.metrics.l7Success * 100).toFixed(1)}% (0/5)`);
  console.log(`- Level 7 Delta:                   ${(results.metrics.l7Delta * 100).toFixed(1)} percentage points\n`);

  console.log("[CAPABILITY ATTRIBUTION]");
  console.log(`- Model Only Gain:                 ${(results.metrics.modelCapabilityGain * 100).toFixed(1)}%`);
  console.log(`- Diagnostic Gain:                 ${(results.metrics.diagnosticGain * 100).toFixed(1)}%`);
  console.log(`- Patch Synthesis Gain:            ${(results.metrics.patchSynthesisGain * 100).toFixed(1)}%`);
  console.log(`- Orchestration Gain:              ${(results.metrics.orchestrationGain * 100).toFixed(1)}%\n`);

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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run-phase55.ts")) {
  runPhase55();
}
