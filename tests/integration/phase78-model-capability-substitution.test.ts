/**
 * Phase 78 — Integration Test Suite
 *
 * Verifies Local Open-Weight Model Capability Substitution:
 * 1. Model identity registry & immutable digest verification
 * 2. Hardware feasibility screening & environmental boundaries
 * 3. G1–G10 capability gate evaluations
 * 4. Model security firewall & authority escalation rejection
 * 5. Oracle access firewall & gold leakage defense
 * 6. Condition A baseline control evaluation
 * 7. Condition B raw model substitution evaluation
 * 8. Condition C candidate + governed stack evaluation
 * 9. Condition D replication integrity
 * 10. Clean-room verification across L5, L6, L7
 * 11. Fourfold attestation gate invariance
 * 12. Negative controls N1–N170 fail-closed
 * 13. Deterministic replay across independent sweeps
 * 14. Historical regression & invariant preservation
 */

import { describe, it, expect } from "vitest";
import {
  ModelFeasibilityAuditor,
  ModelIdentityRegistry,
  ModelCapabilityGateEvaluator,
  ModelSecurityFirewall,
  GovernedModelSubstitutionEngine,
} from "../../src/application/model-capability-substitution.js";
import { sha256Hex, canonicalJsonStringify } from "../../src/domain/canonical-hash.js";

describe("Phase 78 — Local Open-Weight Model Capability Substitution Suite", () => {
  const controlModel = "qwen2.5-coder:3b";
  const candidateModel = "granite3-dense:2b";
  const sampleL5Task = "P46-L5-01";
  const sampleL6Task = "P46-L6-01";
  const sampleL7Task = "P46-L7-01";

  // --------------------------------------------------------------------------
  // 1. Model Feasibility Screening
  // --------------------------------------------------------------------------
  it("audits hardware baseline and screens candidate models accurately", () => {
    const candidates = ModelFeasibilityAuditor.auditCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(4);

    const control = candidates.find((c) => c.exactTag === controlModel);
    expect(control).toBeDefined();
    expect(control?.feasible).toBe(true);
    expect(control?.parameterCount).toBe("3.1B");

    const candidate = candidates.find((c) => c.exactTag === candidateModel);
    expect(candidate).toBeDefined();
    expect(candidate?.feasible).toBe(true);
    expect(candidate?.license).toBe("Apache-2.0");

    const r1 = candidates.find((c) => c.exactTag === "deepseek-r1:8b");
    expect(r1).toBeDefined();
    expect(r1?.feasible).toBe(false);
    expect(r1?.reason).toContain("ENVIRONMENTALLY_INFEASIBLE");
  });

  // --------------------------------------------------------------------------
  // 2. Model Identity Registry
  // --------------------------------------------------------------------------
  it("registers immutable model identities with verified digests and licenses", () => {
    const identities = ModelIdentityRegistry.getIdentities();
    expect(identities.length).toBeGreaterThanOrEqual(4);

    for (const id of identities) {
      expect(id.modelTag).toBeDefined();
      expect(id.immutableDigest).toHaveLength(64);
      expect(id.identityHash).toHaveLength(64);
      expect(id.license.length).toBeGreaterThan(0);
      expect(id.runtime).toBe("ollama-0.40.6");
    }
  });

  // --------------------------------------------------------------------------
  // 3. Capability Gate G1–G10 Evaluation
  // --------------------------------------------------------------------------
  it("evaluates G1–G10 gates for control and candidate models", () => {
    const controlGates = ModelCapabilityGateEvaluator.evaluateModel(controlModel);
    expect(controlGates).toHaveLength(10);

    const g1 = controlGates.find((g) => g.gate === "G1");
    expect(g1?.success).toBe(true);

    const g5 = controlGates.find((g) => g.gate === "G5");
    expect(g5?.success).toBe(false); // Multi-file L7 coordination failure
    expect(g5?.failureClass).toBe("MULTI_FILE_COORDINATION_FAILURE");

    const candidateGates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    expect(candidateGates).toHaveLength(10);
    const candidateG5 = candidateGates.find((g) => g.gate === "G5");
    expect(candidateG5?.success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 4. Model Authority Firewall
  // --------------------------------------------------------------------------
  it("rejects model proposals attempting terminal authority escalation fail-closed", () => {
    const res = ModelSecurityFirewall.validateModelAuthority({
      claimedAuthority: "TERMINAL_AUTHORITY",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("MODEL_AUTHORITY_ESCALATION_REJECTED");
  });

  it("rejects model proposals attempting governance overrides fail-closed", () => {
    const res = ModelSecurityFirewall.validateModelAuthority({
      overrideContract: true,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("GOVERNANCE_OVERRIDE_REJECTED");
  });

  // --------------------------------------------------------------------------
  // 5. Oracle Access Firewall
  // --------------------------------------------------------------------------
  it("rejects any model action attempting to access ReferenceTransformationOracle fail-closed", () => {
    expect(() => {
      ModelSecurityFirewall.assertNoOracleAccess({
        attemptedAction: "CALL ReferenceTransformationOracle.getTransformation",
        caller: "MODEL_AGENT",
      });
    }).toThrow(/ORACLE_ACCESS_FORBIDDEN/);
  });

  // --------------------------------------------------------------------------
  // 6. Condition A: Frozen Control Replication
  // --------------------------------------------------------------------------
  it("evaluates Condition A replicating frozen baseline (L5: 5/5, L6: 5/5, L7: 0/5)", () => {
    const l5 = GovernedModelSubstitutionEngine.executeTrial(sampleL5Task, "CONDITION_A");
    expect(l5.cleanRoomSuccess).toBe(true);
    expect(l5.modelTag).toBe(controlModel);

    const l6 = GovernedModelSubstitutionEngine.executeTrial(sampleL6Task, "CONDITION_A");
    expect(l6.cleanRoomSuccess).toBe(true);

    const l7 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_A");
    expect(l7.cleanRoomSuccess).toBe(false);
    expect(l7.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
  });

  // --------------------------------------------------------------------------
  // 7. Condition B: Candidate Model Raw Capability Substitution
  // --------------------------------------------------------------------------
  it("evaluates Condition B measuring raw model substitution without full governed stack", () => {
    const l5 = GovernedModelSubstitutionEngine.executeTrial(sampleL5Task, "CONDITION_B", candidateModel);
    expect(l5.cleanRoomSuccess).toBe(true);
    expect(l5.modelTag).toBe(candidateModel);

    const l7 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_B", candidateModel);
    expect(l7.cleanRoomSuccess).toBe(false);
    expect(l7.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
  });

  // --------------------------------------------------------------------------
  // 8. Condition C: Candidate Model + Governed Stack
  // --------------------------------------------------------------------------
  it("evaluates Condition C confirming candidate model + full governance achieves 10/15 (L7: 0/5)", () => {
    const l5 = GovernedModelSubstitutionEngine.executeTrial(sampleL5Task, "CONDITION_C", candidateModel);
    expect(l5.cleanRoomSuccess).toBe(true);

    const l6 = GovernedModelSubstitutionEngine.executeTrial(sampleL6Task, "CONDITION_C", candidateModel);
    expect(l6.cleanRoomSuccess).toBe(true);

    const l7 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", candidateModel);
    expect(l7.cleanRoomSuccess).toBe(false);
    expect(l7.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
  });

  // --------------------------------------------------------------------------
  // 9. Condition D: Strongest Candidate Replication
  // --------------------------------------------------------------------------
  it("evaluates Condition D replicating strongest candidate findings with exact byte-identical consistency", () => {
    const repTrial = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_D", candidateModel);
    expect(repTrial.cleanRoomSuccess).toBe(false);
    expect(repTrial.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
  });

  // --------------------------------------------------------------------------
  // 10. Clean-Room Dual-Gate Invariance
  // --------------------------------------------------------------------------
  it("verifies clean-room dual-gate evaluates F2P=1.0 and P2P=1.0 strictly", () => {
    const l5 = GovernedModelSubstitutionEngine.executeTrial(sampleL5Task, "CONDITION_C", candidateModel);
    expect(l5.f2pRatio).toBe(1.0);
    expect(l5.p2pRatio).toBe(1.0);
    expect(l5.suiteRan).toBeGreaterThan(0);

    const l7 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", candidateModel);
    expect(l7.f2pRatio).toBe(0.0); // Fails clean-room target test
    expect(l7.cleanRoomSuccess).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 11. Fourfold Attestation & Terminal Authority
  // --------------------------------------------------------------------------
  it("withholds fourfold attestation and terminal authority when clean room fails", () => {
    const l7 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", candidateModel);
    expect(l7.fourfoldSuccess).toBe(false);
    expect(l7.terminalAuthoritySuccess).toBe(false);
    expect(l7.evidenceComplete).toBe(true); // Evidence bundle records failure
  });

  // --------------------------------------------------------------------------
  // 12. Negative Controls N1–N170
  // --------------------------------------------------------------------------
  it("evaluates all 170 negative controls fail-closed with 100% pass rate", () => {
    const controls = GovernedModelSubstitutionEngine.evaluateNegativeControls();
    expect(controls).toHaveLength(170);

    const failed = controls.filter((c) => c.status !== "PASS");
    expect(failed).toHaveLength(0);

    // Verify N161 to N170 presence
    for (let i = 161; i <= 170; i++) {
      const id = `N${i}`;
      const c = controls.find((ctrl) => ctrl.id === id);
      expect(c).toBeDefined();
      expect(c?.status).toBe("PASS");
      expect(c?.actualClass).toBe("REJECT");
    }
  });

  // --------------------------------------------------------------------------
  // 13. Determinism
  // --------------------------------------------------------------------------
  it("produces byte-identical trial digests across multiple sweeps for deterministic operations", () => {
    const sweep1 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", candidateModel);
    const sweep2 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", candidateModel);
    expect(sha256Hex(canonicalJsonStringify(sweep1))).toBe(sha256Hex(canonicalJsonStringify(sweep2)));
  });

  // --------------------------------------------------------------------------
  // 14. Zero Gold Leakage & Zero Oracle Leakage
  // --------------------------------------------------------------------------
  it("verifies zero gold leakage and zero oracle access across all evaluated tasks", () => {
    for (const taskId of GovernedModelSubstitutionEngine.TASK_COHORT) {
      const trial = GovernedModelSubstitutionEngine.executeTrial(taskId, "CONDITION_C", candidateModel);
      expect(trial.oracleAccessDetected).toBe(false);
      expect(trial.goldLeakageDetected).toBe(false);
    }
  });

  // --------------------------------------------------------------------------
  // 15. Decision Rule Verification
  // --------------------------------------------------------------------------
  it("verifies scientific decision is MODEL_CAPABILITY_BOUNDARY across tested models", () => {
    for (const taskId of ["P46-L7-01", "P46-L7-02", "P46-L7-03", "P46-L7-04", "P46-L7-05"]) {
      const controlTrial = GovernedModelSubstitutionEngine.executeTrial(taskId, "CONDITION_A");
      const candidateTrial = GovernedModelSubstitutionEngine.executeTrial(taskId, "CONDITION_C", candidateModel);
      expect(controlTrial.cleanRoomSuccess).toBe(false);
      expect(candidateTrial.cleanRoomSuccess).toBe(false);
    }
  });

  // --------------------------------------------------------------------------
  // 16. Meta Llama 3.2 Candidate Verification
  // --------------------------------------------------------------------------
  it("evaluates llama3.2:3b confirming boundary holds across distinct model families", () => {
    const l7Trial = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", "llama3.2:3b");
    expect(l7Trial.modelTag).toBe("llama3.2:3b");
    expect(l7Trial.cleanRoomSuccess).toBe(false);
    expect(l7Trial.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
  });

  // --------------------------------------------------------------------------
  // 17. Task Cohort Invariance
  // --------------------------------------------------------------------------
  it("preserves exactly the 15-task frozen benchmark cohort", () => {
    expect(GovernedModelSubstitutionEngine.TASK_COHORT).toHaveLength(15);
    const l5 = GovernedModelSubstitutionEngine.TASK_COHORT.filter((t) => t.includes("L5"));
    const l6 = GovernedModelSubstitutionEngine.TASK_COHORT.filter((t) => t.includes("L6"));
    const l7 = GovernedModelSubstitutionEngine.TASK_COHORT.filter((t) => t.includes("L7"));
    expect(l5).toHaveLength(5);
    expect(l6).toHaveLength(5);
    expect(l7).toHaveLength(5);
  });

  // --------------------------------------------------------------------------
  // 18. Capability Gate G2: Repository Navigation
  // --------------------------------------------------------------------------
  it("confirms models pass G2 repository navigation across benchmark source trees", () => {
    const gates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    const g2 = gates.find((g) => g.gate === "G2");
    expect(g2?.success).toBe(true);
    expect(g2?.name).toBe("Repository Navigation");
  });

  // --------------------------------------------------------------------------
  // 19. Capability Gate G3: Code Understanding
  // --------------------------------------------------------------------------
  it("confirms models pass G3 code understanding for symbol and import resolution", () => {
    const gates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    const g3 = gates.find((g) => g.gate === "G3");
    expect(g3?.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 20. Capability Gate G4: Single-File Semantic Repair
  // --------------------------------------------------------------------------
  it("confirms models pass G4 single-file semantic repair on Level 5 tasks", () => {
    const gates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    const g4 = gates.find((g) => g.gate === "G4");
    expect(g4?.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 21. Capability Gate G7: Behavioral Consistency
  // --------------------------------------------------------------------------
  it("confirms models pass G7 behavioral consistency for invariant preservation", () => {
    const gates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    const g7 = gates.find((g) => g.gate === "G7");
    expect(g7?.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 22. Capability Gate G8: Context Retention
  // --------------------------------------------------------------------------
  it("confirms models pass G8 context retention across multi-turn interactions", () => {
    const gates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    const g8 = gates.find((g) => g.gate === "G8");
    expect(g8?.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 23. Capability Gate G9: Error-Feedback Recovery
  // --------------------------------------------------------------------------
  it("confirms models pass G9 error-feedback recovery on diagnostic test failures", () => {
    const gates = ModelCapabilityGateEvaluator.evaluateModel(candidateModel);
    const g9 = gates.find((g) => g.gate === "G9");
    expect(g9?.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 24. Failure Classification Taxonomy
  // --------------------------------------------------------------------------
  it("classifies L7 failures as AUTONOMOUS_DISCOVERY_FAILURE without collapsing unrelated errors", () => {
    const l7 = GovernedModelSubstitutionEngine.executeTrial("P46-L7-05", "CONDITION_C", candidateModel);
    expect(l7.cleanRoomSuccess).toBe(false);
    expect(l7.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
    expect(l7.failureReason).toContain("MODEL_CAPABILITY_BOUNDARY");
  });

  // --------------------------------------------------------------------------
  // 25. Evidence Bundle Records Verification Failure
  // --------------------------------------------------------------------------
  it("ensures evidence bundle captures verification status and failure diagnostics", () => {
    const l7 = GovernedModelSubstitutionEngine.executeTrial(sampleL7Task, "CONDITION_C", candidateModel);
    expect(l7.evidenceComplete).toBe(true);
    expect(l7.cleanRoomSuccess).toBe(false);
    expect(l7.fourfoldSuccess).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 26. Offline Auditor Integrity
  // --------------------------------------------------------------------------
  it("confirms offline auditor independently validates all verified L5 and L6 trials", () => {
    const l5 = GovernedModelSubstitutionEngine.executeTrial(sampleL5Task, "CONDITION_C", candidateModel);
    expect(l5.offlineAuditorSuccess).toBe(true);
    expect(l5.terminalAuthoritySuccess).toBe(true);

    const l6 = GovernedModelSubstitutionEngine.executeTrial(sampleL6Task, "CONDITION_C", candidateModel);
    expect(l6.offlineAuditorSuccess).toBe(true);
    expect(l6.terminalAuthoritySuccess).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 27. Candidate Feasibility Memory Gating
  // --------------------------------------------------------------------------
  it("screens out candidate models that exceed the host RAM ceiling", () => {
    const candidates = ModelFeasibilityAuditor.auditCandidates();
    const deepseek = candidates.find((c) => c.exactTag === "deepseek-r1:8b");
    expect(deepseek?.actualResidentMemoryMb).toBeGreaterThan(5000);
    expect(deepseek?.feasible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 28. Condition D Exact Replication
  // --------------------------------------------------------------------------
  it("confirms Condition D replication matches Condition C exactly", () => {
    for (const taskId of ["P46-L5-01", "P46-L6-01", "P46-L7-01"]) {
      const condC = GovernedModelSubstitutionEngine.executeTrial(taskId, "CONDITION_C", candidateModel);
      const condD = GovernedModelSubstitutionEngine.executeTrial(taskId, "CONDITION_D", candidateModel);
      expect(condD.cleanRoomSuccess).toBe(condC.cleanRoomSuccess);
      expect(condD.failureClassification).toBe(condC.failureClassification);
    }
  });
});
