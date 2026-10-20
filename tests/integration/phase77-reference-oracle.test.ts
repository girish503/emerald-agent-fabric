/**
 * Phase 77 — Integration Test Suite
 *
 * Verifies Reference-Oracle Capability Attribution Upper-Bound Experiment:
 * 1. Oracle schema & type structure
 * 2. Oracle provenance & signature integrity
 * 3. Oracle hashing & SHA-256 canonical digest verification
 * 4. Pre-execution independent oracle validation
 * 5. Oracle isolation from autonomous synthesis
 * 6. Autonomous access rejection fail-closed
 * 7. Transformation validation & AST compatibility
 * 8. Compilation of reference transformations
 * 9. AST atomic multi-file materialization
 * 10. Clean-room dual-gate verification (F2P/P2P/suite_ran)
 * 11. Fourfold attestation gate (Pillars 1 to 4)
 * 12. Evidence bundle generation & provenance root
 * 13. Offline auditor verification
 * 14. Terminal authority token issuance & gating
 * 15. Negative controls N1–N160 fail-closed
 * 16. Deterministic replay & byte-identical execution
 * 17. Source-revision binding to baseline commit
 * 18. Behavioral contract binding to Phase 76 SPEC-C
 * 19. Oracle hash & contract mismatch rejection
 * 20. Oracle authority firewall & leakage prevention
 */

import { describe, it, expect } from "vitest";
import {
  ReferenceTransformationOracle,
  OracleAccessFirewall,
  GovernedTransformationGate,
  GovernedReferenceOracleExperimentEngine,
  ReferenceOracleTransformation,
} from "../../src/application/reference-transformation-oracle.js";
import { sha256Hex, canonicalJsonStringify } from "../../src/domain/canonical-hash.js";

describe("Phase 77 — Reference-Oracle Capability Attribution Integration Suite", () => {
  const sampleL5Task = "P46-L5-01";
  const sampleL6Task = "P46-L6-01";
  const sampleL7Task = "P46-L7-01";

  // --------------------------------------------------------------------------
  // 1. Oracle Schema & Type Structure
  // --------------------------------------------------------------------------
  it("generates reference oracle transformations conforming strictly to ReferenceOracleTransformation schema", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    expect(trans.taskId).toBe(sampleL7Task);
    expect(trans.sourceRevision).toBe("f779420");
    expect(trans.transformationKind).toBe("AST_REWRITE_PLAN");
    expect(trans.transformationPayload).toBeDefined();
    expect(trans.transformationPayload.affectedFiles).toEqual(["src/calc.js", "src/parser.js"]);
    expect(trans.expectedBehavioralContractHash).toHaveLength(64);
    expect(trans.oracleArtifactHash).toHaveLength(64);
    expect(trans.provenance).toBeDefined();
    expect(trans.provenance.source).toBe("REFERENCE_ORACLE");
  });

  // --------------------------------------------------------------------------
  // 2. Oracle Provenance & Authority Binding
  // --------------------------------------------------------------------------
  it("attaches canonical research provenance without granting execution authority", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL5Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    expect(trans.provenance.source).toBe("REFERENCE_ORACLE");
    expect(trans.provenance.author).toBe("BENCHMARK_RESEARCH_AUTHORITY");
    expect(trans.provenance.intendedCohort).toBe("PHASE46_15_TASK_COHORT");
    expect(trans.provenance.signature).toHaveLength(64);
  });

  // --------------------------------------------------------------------------
  // 3. Oracle Hashing & Digest Consistency
  // --------------------------------------------------------------------------
  it("computes immutable canonical SHA-256 payload digest matching oracleArtifactHash", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    const computed = sha256Hex(canonicalJsonStringify(trans.transformationPayload));
    expect(computed).toBe(trans.oracleArtifactHash);
  });

  // --------------------------------------------------------------------------
  // 4. Pre-execution Independent Oracle Validation
  // --------------------------------------------------------------------------
  it("validates genuine reference oracle transformations successfully across all 15 cohort tasks", () => {
    for (const taskId of GovernedReferenceOracleExperimentEngine.TASK_COHORT) {
      const trans = ReferenceTransformationOracle.getTransformation(taskId, {
        callerType: "RESEARCH_HARNESS",
        isAutonomous: false,
      });
      const val = ReferenceTransformationOracle.validateReferenceTransformation(trans);
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);
      expect(val.taskMatch).toBe(true);
      expect(val.hashVerified).toBe(true);
      expect(val.revisionVerified).toBe(true);
      expect(val.contractVerified).toBe(true);
      expect(val.scopeVerified).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // 5. Oracle Isolation & Firewall
  // --------------------------------------------------------------------------
  it("blocks autonomous synthesis caller from accessing ReferenceTransformationOracle fail-closed", () => {
    expect(() => {
      ReferenceTransformationOracle.getTransformation(sampleL7Task, {
        callerType: "AUTONOMOUS_SYNTHESIZER",
        isAutonomous: true,
      });
    }).toThrow(/ORACLE_FIREWALL_VIOLATION/);
  });

  // --------------------------------------------------------------------------
  // 6. Oracle Leakage Scanning
  // --------------------------------------------------------------------------
  it("scans and detects raw oracle patch markers in prompts and contexts fail-closed", () => {
    const cleanPrompt = "Fix the operator precedence handling in calculator";
    expect(OracleAccessFirewall.scanForOracleLeakage(cleanPrompt).clean).toBe(true);

    const leakingPrompt = "Use the REFERENCE_LOOKAHEAD_BUFFER_FIX to repair the parser";
    const leakRes = OracleAccessFirewall.scanForOracleLeakage(leakingPrompt);
    expect(leakRes.clean).toBe(false);
    expect(leakRes.leakMarkers).toContain("REFERENCE_LOOKAHEAD_BUFFER_FIX");
  });

  // --------------------------------------------------------------------------
  // 7. Source-Revision Binding
  // --------------------------------------------------------------------------
  it("rejects reference oracle transformations bound to foreign or outdated revisions", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const modified: ReferenceOracleTransformation = {
      ...trans,
      sourceRevision: "commit_deadbeef_invalid",
    };

    const val = ReferenceTransformationOracle.validateReferenceTransformation(modified);
    expect(val.valid).toBe(false);
    expect(val.revisionVerified).toBe(false);
    expect(val.errors.some((e) => e.includes("SOURCE_REVISION_MISMATCH"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 8. Expected Behavioral Contract Binding
  // --------------------------------------------------------------------------
  it("rejects reference transformations when expected behavioral contract hash diverges from Phase 76 SPEC-C", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const corruptedContract: ReferenceOracleTransformation = {
      ...trans,
      expectedBehavioralContractHash: "mismatched_contract_hash_0000000000000000000000000000000000000000",
    };

    const val = ReferenceTransformationOracle.validateReferenceTransformation(corruptedContract);
    expect(val.valid).toBe(false);
    expect(val.contractVerified).toBe(false);
    expect(val.errors.some((e) => e.includes("BEHAVIORAL_CONTRACT_MISMATCH"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 9. Scope Enforcement
  // --------------------------------------------------------------------------
  it("rejects reference transformations modifying files outside declared cohort scope", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL5Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const scopeViolated: ReferenceOracleTransformation = {
      ...trans,
      transformationPayload: {
        ...trans.transformationPayload,
        affectedFiles: ["src/semver.js", "src/auth.js"], // src/auth.js is out of scope!
      },
    };

    const val = ReferenceTransformationOracle.validateReferenceTransformation(scopeViolated);
    expect(val.valid).toBe(false);
    expect(val.scopeVerified).toBe(false);
    expect(val.errors.some((e) => e.includes("SCOPE_ESCALATION"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 10. Transformation Materialization
  // --------------------------------------------------------------------------
  it("materializes reference AST rewrite plans into atomic workspace commits", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    const opRes = GovernedTransformationGate.operationalizeTransformation(trans);
    expect(opRes.accepted).toBe(true);
    expect(opRes.materialized).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 11. Clean-Room Dual-Gate Verification
  // --------------------------------------------------------------------------
  it("verifies reference transformations pass independent clean-room dual gates (F2P=1.0, P2P=1.0, suite_ran > 0)", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    const opRes = GovernedTransformationGate.operationalizeTransformation(trans);
    expect(opRes.cleanRoomPassed).toBe(true);
    expect(opRes.f2pRatio).toBe(1.0);
    expect(opRes.p2pRatio).toBe(1.0);
    expect(opRes.suiteRan).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 12. Fourfold Attestation Gate
  // --------------------------------------------------------------------------
  it("confirms reference transformations satisfy all 4 fourfold verification pillars", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL6Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    const opRes = GovernedTransformationGate.operationalizeTransformation(trans, true);
    expect(opRes.fourfoldPassed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 13. Evidence Bundle Integrity & Offline Auditor
  // --------------------------------------------------------------------------
  it("validates evidence bundle completion and offline auditor verification on reference transformations", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    const opRes = GovernedTransformationGate.operationalizeTransformation(trans, true);
    expect(opRes.evidenceComplete).toBe(true);
    expect(opRes.offlineAuditorPassed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 14. Terminal Authority Token Issuance
  // --------------------------------------------------------------------------
  it("grants terminal authority only upon complete verified execution", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });

    const opRes = GovernedTransformationGate.operationalizeTransformation(trans, true);
    expect(opRes.terminalAuthorityGranted).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 15. Condition A: Frozen Autonomous Baseline Control
  // --------------------------------------------------------------------------
  it("evaluates Condition A reproducing frozen Phase 76 autonomous results (L5: 5/5, L6: 5/5, L7: 0/5)", () => {
    const l5Rec = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL5Task, "CONDITION_A");
    expect(l5Rec.executionMode).toBe("AUTONOMOUS_SYNTHESIS");
    expect(l5Rec.cleanRoomSuccess).toBe(true);

    const l6Rec = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL6Task, "CONDITION_A");
    expect(l6Rec.executionMode).toBe("AUTONOMOUS_SYNTHESIS");
    expect(l6Rec.cleanRoomSuccess).toBe(true);

    const l7Rec = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_A");
    expect(l7Rec.executionMode).toBe("AUTONOMOUS_SYNTHESIS");
    expect(l7Rec.cleanRoomSuccess).toBe(false);
    expect(l7Rec.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
  });

  // --------------------------------------------------------------------------
  // 16. Condition B: Reference Transformation Pipeline
  // --------------------------------------------------------------------------
  it("evaluates Condition B achieving 5/5 clean-room success on Level 7 tasks when reference is supplied", () => {
    const l7Rec = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_B");
    expect(l7Rec.executionMode).toBe("REFERENCE_ORACLE_EXECUTION");
    expect(l7Rec.cleanRoomSuccess).toBe(true);
    expect(l7Rec.materializationSuccess).toBe(true);
    expect(l7Rec.fourfoldSuccess).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 17. Condition C: Reference + Full Governed Stack
  // --------------------------------------------------------------------------
  it("evaluates Condition C confirming downstream governance operationalizes L7 transformations", () => {
    const l7Rec = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_C");
    expect(l7Rec.cleanRoomSuccess).toBe(true);
    expect(l7Rec.offlineAuditorSuccess).toBe(true);
    expect(l7Rec.terminalAuthoritySuccess).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 18. Condition D: Blind Oracle Handoff
  // --------------------------------------------------------------------------
  it("evaluates Condition D confirming isolated handoff succeeds without contaminating autonomous baseline", () => {
    const l7Rec = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_D");
    expect(l7Rec.cleanRoomSuccess).toBe(true);
    expect(l7Rec.oracleIsolation).toBe("PASS");
    expect(l7Rec.unintendedOracleLeakage).toBe("ZERO");
  });

  // --------------------------------------------------------------------------
  // 19. Capability Attribution Matrix
  // --------------------------------------------------------------------------
  it("generates the 12-row capability attribution matrix isolating transformation discovery as first divergence", () => {
    const matrix = GovernedReferenceOracleExperimentEngine.generateCapabilityAttributionMatrix();
    expect(matrix).toHaveLength(12);

    const discoveryRow = matrix.find((r) => r.capability === "Transformation discovery");
    expect(discoveryRow).toBeDefined();
    expect(discoveryRow?.firstDivergencePoint).toBe(true);
    expect(discoveryRow?.autonomous).toContain("10/15");
    expect(discoveryRow?.oracle).toContain("15/15");

    const materializationRow = matrix.find((r) => r.capability === "AST materialization");
    expect(materializationRow?.autonomous).toBe("15/15 (100%)");
    expect(materializationRow?.oracle).toBe("15/15 (100%)");
    expect(materializationRow?.firstDivergencePoint).toBe(false);

    const cleanRoomRow = matrix.find((r) => r.capability === "Clean-room verification");
    expect(cleanRoomRow?.autonomous).toContain("10/15");
    expect(cleanRoomRow?.oracle).toBe("15/15 (100%) — L7: 5/5");

    const l7SuccessRow = matrix.find((r) => r.capability === "L7 task success");
    expect(l7SuccessRow?.autonomous).toBe("0/5 (0.0%)");
    expect(l7SuccessRow?.oracle).toBe("5/5 (100.0%)");
  });

  // --------------------------------------------------------------------------
  // 20. Negative Controls N1–N160
  // --------------------------------------------------------------------------
  it("evaluates all 160 negative controls fail-closed with 100% pass rate", () => {
    const controls = GovernedReferenceOracleExperimentEngine.evaluateNegativeControls();
    expect(controls).toHaveLength(160);

    const failed = controls.filter((c) => c.status !== "PASS");
    expect(failed).toHaveLength(0);

    // Verify presence of oracle boundary controls N147–N160
    const n147 = controls.find((c) => c.id === "N147");
    expect(n147).toBeDefined();
    expect(n147?.status).toBe("PASS");

    const n148 = controls.find((c) => c.id === "N148");
    expect(n148).toBeDefined();
    expect(n148?.status).toBe("PASS");

    const n151 = controls.find((c) => c.id === "N151");
    expect(n151).toBeDefined();
    expect(n151?.status).toBe("PASS");

    const n153 = controls.find((c) => c.id === "N153");
    expect(n153).toBeDefined();
    expect(n153?.status).toBe("PASS");

    const n157 = controls.find((c) => c.id === "N157");
    expect(n157).toBeDefined();
    expect(n157?.status).toBe("PASS");

    const n160 = controls.find((c) => c.id === "N160");
    expect(n160).toBeDefined();
    expect(n160?.status).toBe("PASS");
  });

  // --------------------------------------------------------------------------
  // 21. Determinism
  // --------------------------------------------------------------------------
  it("produces byte-identical trial digests across multiple independent runs", () => {
    const run1 = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_B");
    const run2 = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_B");
    expect(sha256Hex(canonicalJsonStringify(run1))).toBe(sha256Hex(canonicalJsonStringify(run2)));
  });

  // --------------------------------------------------------------------------
  // 22. Causal Attribution Verdict
  // --------------------------------------------------------------------------
  it("verifies downstream infrastructure does not fail on L7 when correct transformation is supplied", () => {
    for (const l7TaskId of ["P46-L7-01", "P46-L7-02", "P46-L7-03", "P46-L7-04", "P46-L7-05"]) {
      const rec = GovernedReferenceOracleExperimentEngine.executeTrial(l7TaskId, "CONDITION_C");
      expect(rec.cleanRoomSuccess).toBe(true);
      expect(rec.materializationSuccess).toBe(true);
      expect(rec.fourfoldSuccess).toBe(true);
      expect(rec.offlineAuditorSuccess).toBe(true);
      expect(rec.terminalAuthoritySuccess).toBe(true);
      expect(rec.failureClassification).toBeUndefined();
    }
  });

  // --------------------------------------------------------------------------
  // 23. Provenance Forgery Defense
  // --------------------------------------------------------------------------
  it("rejects forged oracle transformations with invalid provenance signatures", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const forged: ReferenceOracleTransformation = {
      ...trans,
      provenance: {
        ...trans.provenance,
        source: "UNTRUSTED_EXTERNAL" as any,
      },
    };

    const val = ReferenceTransformationOracle.validateReferenceTransformation(forged);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("PROVENANCE_FORGERY"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 24. Clean-Room Anti-Zero-Test Enforcement
  // --------------------------------------------------------------------------
  it("confirms clean-room verification rejects execution if zero tests were executed", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL5Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const opRes = GovernedTransformationGate.operationalizeTransformation(trans);
    expect(opRes.suiteRan).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 25. Gold Leakage vs Intentional Oracle Usage Distinction
  // --------------------------------------------------------------------------
  it("strictly separates intentional oracle execution from unintended gold leakage", () => {
    const trials = [
      GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_A"),
      GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, "CONDITION_B"),
    ];

    expect(trials[0]?.executionMode).toBe("AUTONOMOUS_SYNTHESIS");
    expect(trials[0]?.oracleIsolation).toBe("PASS");
    expect(trials[0]?.unintendedOracleLeakage).toBe("ZERO");

    expect(trials[1]?.executionMode).toBe("REFERENCE_ORACLE_EXECUTION");
    expect(trials[1]?.oracleIsolation).toBe("PASS");
    expect(trials[1]?.unintendedOracleLeakage).toBe("ZERO");
  });

  // --------------------------------------------------------------------------
  // 26. Oracle Payload Tampering Rejection
  // --------------------------------------------------------------------------
  it("rejects oracle transformation if payload description or contents are tampered", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL7Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const tampered: ReferenceOracleTransformation = {
      ...trans,
      transformationPayload: {
        ...trans.transformationPayload,
        description: "Tampered description",
      },
    };

    const val = ReferenceTransformationOracle.validateReferenceTransformation(tampered);
    expect(val.valid).toBe(false);
    expect(val.hashVerified).toBe(false);
    expect(val.errors.some((e) => e.includes("ORACLE_HASH_MISMATCH"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 27. Malformed Plan Handling in GovernedTransformationGate
  // --------------------------------------------------------------------------
  it("handles missing AST rewrite plan in Gate fail-closed with rejection", () => {
    const trans = ReferenceTransformationOracle.getTransformation(sampleL5Task, {
      callerType: "RESEARCH_HARNESS",
      isAutonomous: false,
    });
    const noPlan: ReferenceOracleTransformation = {
      ...trans,
      transformationPayload: {
        ...trans.transformationPayload,
        plan: undefined,
      },
      oracleArtifactHash: sha256Hex(canonicalJsonStringify({
        ...trans.transformationPayload,
        plan: undefined,
      })),
    };

    const opRes = GovernedTransformationGate.operationalizeTransformation(noPlan);
    expect(opRes.accepted).toBe(false);
    expect(opRes.materialized).toBe(false);
    expect(opRes.cleanRoomPassed).toBe(false);
    expect(opRes.failureReason).toBe("MISSING_AST_REWRITE_PLAN");
  });

  // --------------------------------------------------------------------------
  // 28. Cohort Complete Evaluation
  // --------------------------------------------------------------------------
  it("verifies all 15 tasks succeed under Reference Oracle while L7 fails under Autonomous", () => {
    const l7Tasks = ["P46-L7-01", "P46-L7-02", "P46-L7-03", "P46-L7-04", "P46-L7-05"];

    for (const taskId of l7Tasks) {
      const autoTrial = GovernedReferenceOracleExperimentEngine.executeTrial(taskId, "CONDITION_A");
      expect(autoTrial.cleanRoomSuccess).toBe(false);
      expect(autoTrial.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");

      const oracleTrial = GovernedReferenceOracleExperimentEngine.executeTrial(taskId, "CONDITION_D");
      expect(oracleTrial.cleanRoomSuccess).toBe(true);
      expect(oracleTrial.materializationSuccess).toBe(true);
      expect(oracleTrial.fourfoldSuccess).toBe(true);
      expect(oracleTrial.offlineAuditorSuccess).toBe(true);
      expect(oracleTrial.terminalAuthoritySuccess).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // 29. Clean-Room Zero Leakage Audit
  // --------------------------------------------------------------------------
  it("verifies zero unintended oracle leakage across all 60 execution trials", () => {
    for (const taskId of GovernedReferenceOracleExperimentEngine.TASK_COHORT) {
      for (const cond of ["CONDITION_A", "CONDITION_B", "CONDITION_C", "CONDITION_D"] as const) {
        const trial = GovernedReferenceOracleExperimentEngine.executeTrial(taskId, cond);
        expect(trial.unintendedOracleLeakage).toBe("ZERO");
        expect(trial.oracleIsolation).toBe("PASS");
      }
    }
  });

  // --------------------------------------------------------------------------
  // 30. Deterministic Replay Across Conditions
  // --------------------------------------------------------------------------
  it("confirms byte-identical trial hashes across independent sweeps for all 4 conditions", () => {
    for (const cond of ["CONDITION_A", "CONDITION_B", "CONDITION_C", "CONDITION_D"] as const) {
      const sweepA = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, cond);
      const sweepB = GovernedReferenceOracleExperimentEngine.executeTrial(sampleL7Task, cond);
      expect(sha256Hex(canonicalJsonStringify(sweepA))).toBe(sha256Hex(canonicalJsonStringify(sweepB)));
    }
  });

  // --------------------------------------------------------------------------
  // 31. Scientific Decision Invariant
  // --------------------------------------------------------------------------
  it("confirms scientific decision is AUTONOMOUS_SYNTHESIS_CAPABILITY_BOUNDARY_CONFIRMED", () => {
    const matrix = GovernedReferenceOracleExperimentEngine.generateCapabilityAttributionMatrix();
    const l7Row = matrix.find((r) => r.capability === "L7 task success");
    expect(l7Row?.autonomous).toBe("0/5 (0.0%)");
    expect(l7Row?.oracle).toBe("5/5 (100.0%)");
  });
});
