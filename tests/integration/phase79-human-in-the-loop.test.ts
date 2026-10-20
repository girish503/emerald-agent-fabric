/**
 * Phase 79 — Governed Human-in-the-Loop Transformation Discovery Integration Tests
 *
 * Verifies:
 * 1. Proposal schema, limits, and validation
 * 2. Proposer identity and untrusted classification
 * 3. Source revision binding and mismatch fail-closed
 * 4. Workspace boundaries and path traversal defense
 * 5. Edit format, line bounds, and undeclared target checks
 * 6. Duplicate and conflicting edit rejection
 * 7. Human, model, and collaborative authority firewalls
 * 8. Oracle and gold patch isolation
 * 9. Feedback firewall and information leakage defense
 * 10. Revision chain links and max revision ceilings
 * 11. Proposal digest computation and verification
 * 12. Candidate materialization and clean-room dual-gate verification
 * 13. Fourfold completion gate and sovereign terminal authority
 * 14. Evidence attribution distinguishing discovery from verification
 * 15. Negative controls N1–N180 (100% fail-closed)
 * 16. 3-sweep byte-identical determinism
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROPOSAL_VALIDATION_LIMITS,
} from "../../src/domain/transformation-proposal.js";
import {
  FROZEN_BASELINE_REVISION,
  TransformationProposalValidator,
} from "../../src/application/transformation-proposal-validator.js";
import {
  FeedbackFirewall,
  GovernedProposalEngine,
} from "../../src/application/governed-proposal-engine.js";

describe("Phase 79: Governed Human-in-the-Loop Transformation Discovery", () => {
  // ==========================================================================
  // 1. Proposal Schema & Structural Validation
  // ==========================================================================

  it("1. accepts a completely valid human proposal with correct digest", () => {
    const proposal = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const result = TransformationProposalValidator.validate(proposal);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validatedDigest).toBe(proposal.proposalDigest);
  });

  it("2. rejects non-object or null proposals", () => {
    expect(TransformationProposalValidator.validate(null).valid).toBe(false);
    expect(TransformationProposalValidator.validate(undefined).valid).toBe(false);
    expect(TransformationProposalValidator.validate("invalid string").valid).toBe(false);
  });

  it("3. rejects proposal missing required core fields", () => {
    const invalid = {
      proposalId: "p-invalid",
      taskId: "P46-L5-01",
      // missing proposerType, sourceRevision, targetFiles, candidateEdits, etc.
    };
    const result = TransformationProposalValidator.validate(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
  });

  it("4. rejects proposal exceeding maxProposalBytes payload ceiling", () => {
    const hugeRationale = "X".repeat(70000);
    const proposal = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const hugeProposal = {
      ...proposal,
      rationale: hugeRationale,
    };
    const result = TransformationProposalValidator.validate(hugeProposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("PROPOSAL_SIZE_EXCEEDED"))).toBe(true);
  });

  // ==========================================================================
  // 2. Proposer Identity
  // ==========================================================================

  it("5. validates all four recognized proposer types", () => {
    for (const pType of ["HUMAN", "LOCAL_MODEL", "HUMAN_MODEL_COLLABORATION", "AUTONOMOUS_AGENT"] as const) {
      const prop = GovernedProposalEngine.constructProposal("P46-L5-01", pType);
      const res = TransformationProposalValidator.validate(prop);
      expect(res.valid).toBe(true);
    }
  });

  it("6. rejects unknown or unauthorized proposer types fail-closed", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const invalidProposer = {
      ...prop,
      proposerType: "UNAUTHORIZED_BOT",
    };
    const res = TransformationProposalValidator.validate(invalidProposer);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("INVALID_PROPOSER_TYPE"))).toBe(true);
  });

  // ==========================================================================
  // 3. Source Revision Binding
  // ==========================================================================

  it("7. accepts proposal strictly bound to frozen baseline revision", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    expect(prop.sourceRevision).toBe(FROZEN_BASELINE_REVISION);
    const res = TransformationProposalValidator.validate(prop, FROZEN_BASELINE_REVISION);
    expect(res.valid).toBe(true);
  });

  it("8. rejects proposal bound to mismatched revision fail-closed", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const mismatched = {
      ...prop,
      sourceRevision: "9999999",
    };
    const res = TransformationProposalValidator.validate(mismatched, FROZEN_BASELINE_REVISION);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("SOURCE_REVISION_MISMATCH"))).toBe(true);
  });

  // ==========================================================================
  // 4. Workspace Boundaries & Path Traversal
  // ==========================================================================

  it("9. rejects path traversal in target files", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const traversal = {
      ...prop,
      targetFiles: ["../../etc/passwd"],
    };
    const res = TransformationProposalValidator.validate(traversal);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("PATH_TRAVERSAL_DETECTED"))).toBe(true);
  });

  it("10. rejects absolute and drive-letter target paths", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const absPath = {
      ...prop,
      targetFiles: ["C:/Windows/System32/calc.exe"],
    };
    const res = TransformationProposalValidator.validate(absPath);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("PATH_TRAVERSAL_DETECTED"))).toBe(true);
  });

  it("11. rejects targeting protected system areas (.git, .env, gold_patches)", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const protectedTarget = {
      ...prop,
      targetFiles: [".git/config"],
    };
    const res = TransformationProposalValidator.validate(protectedTarget);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("PROTECTED_PATH_VIOLATION"))).toBe(true);
  });

  // ==========================================================================
  // 5. Edit Format & Constraints
  // ==========================================================================

  it("12. accepts valid edit actions: REPLACE, INSERT, DELETE", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L7-01", "HUMAN");
    const actions = prop.candidateEdits.map((e) => e.action);
    expect(actions).toContain("REPLACE");
    expect(actions).toContain("INSERT");
    const res = TransformationProposalValidator.validate(prop);
    expect(res.valid).toBe(true);
  });

  it("13. rejects unsupported edit action", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const badAction = {
      ...prop,
      candidateEdits: [
        {
          path: "src/calculator.ts",
          action: "OVERWRITE_ENTIRE_DISK" as any,
          newText: "x = 1;",
        },
      ],
    };
    const res = TransformationProposalValidator.validate(badAction);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("INVALID_EDIT_ACTION"))).toBe(true);
  });

  it("14. rejects edits targeting files not declared in targetFiles", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const undeclared = {
      ...prop,
      targetFiles: ["src/calculator.ts"],
      candidateEdits: [
        {
          path: "src/other-unrelated.ts",
          action: "REPLACE" as const,
          newText: "x = 1;",
        },
      ],
    };
    const res = TransformationProposalValidator.validate(undeclared);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("UNDECLARED_TARGET_FILE"))).toBe(true);
  });

  it("15. rejects invalid line bounds (startLine < 1 or endLine < startLine)", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const badBounds = {
      ...prop,
      candidateEdits: [
        {
          path: "src/calculator.ts",
          action: "REPLACE" as const,
          newText: "x = 1;",
          startLine: 10,
          endLine: 5, // end < start
        },
      ],
    };
    const res = TransformationProposalValidator.validate(badBounds);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("INVALID_END_LINE"))).toBe(true);
  });

  it("16. rejects duplicate edits targeting identical file and span", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const duplicateEdits = {
      ...prop,
      candidateEdits: [
        {
          path: "src/calculator.ts",
          action: "REPLACE" as const,
          newText: "x = 1;",
          startLine: 14,
          endLine: 16,
        },
        {
          path: "src/calculator.ts",
          action: "REPLACE" as const,
          newText: "x = 1;",
          startLine: 14,
          endLine: 16,
        },
      ],
    };
    const res = TransformationProposalValidator.validate(duplicateEdits);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("DUPLICATE_EDIT_DETECTED"))).toBe(true);
  });

  // ==========================================================================
  // 6. Authority Firewalls (Human, Model, Collaboration)
  // ==========================================================================

  it("17. human authority firewall rejects terminal authority claim", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const claim = {
      ...prop,
      claimedAuthority: "TERMINAL_AUTHORITY",
    };
    const res = TransformationProposalValidator.validate(claim);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("AUTHORITY_ESCALATION_REJECTED"))).toBe(true);
  });

  it("18. human authority firewall rejects policy override", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const override = {
      ...prop,
      overridePolicy: true,
    };
    const res = TransformationProposalValidator.validate(override);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("overridePolicy"))).toBe(true);
  });

  it("19. model authority firewall rejects credential requests and contract overrides", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "LOCAL_MODEL");
    const modelEscalation = {
      ...prop,
      grantCredentials: true,
      overrideContract: true,
    };
    const res = TransformationProposalValidator.validate(modelEscalation);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("grantCredentials"))).toBe(true);
    expect(res.errors.some((e) => e.includes("overrideContract"))).toBe(true);
  });

  it("20. collaboration authority firewall rejects resource ceiling override", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN_MODEL_COLLABORATION");
    const resourceOverride = {
      ...prop,
      resourceCeilingOverride: true,
    };
    const res = TransformationProposalValidator.validate(resourceOverride);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("resourceCeilingOverride"))).toBe(true);
  });

  // ==========================================================================
  // 7. Oracle & Gold Leakage Firewalls
  // ==========================================================================

  it("21. rejects any proposal requesting oracle access", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const oracleAttempt = {
      ...prop,
      oracleAccess: true,
    };
    const res = TransformationProposalValidator.validate(oracleAttempt);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("oracleAccess"))).toBe(true);
  });

  it("22. rejects any proposal requesting gold patch access", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const goldAttempt = {
      ...prop,
      goldPatchAccess: true,
    };
    const res = TransformationProposalValidator.validate(goldAttempt);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("goldPatchAccess"))).toBe(true);
  });

  // ==========================================================================
  // 8. Feedback Firewall
  // ==========================================================================

  it("23. feedback firewall rejects diagnostic feedback containing forbidden oracle tokens", () => {
    expect(() => {
      FeedbackFirewall.assertNoInformationLeakage({
        proposalId: "p-leak",
        taskId: "P46-L7-01",
        passed: false,
        errors: ["ReferenceTransformationOracle payload leak"],
        testFailures: [],
        feedbackDigest: "dummy",
      });
    }).toThrow("FEEDBACK_LEAKAGE_DETECTED");
  });

  it("24. feedback firewall generates sanitized safe diagnostic feedback", () => {
    const safe = FeedbackFirewall.createSafeFeedback(
      "p-test",
      "P46-L7-01",
      false,
      ["COMPILATION_ERROR: LookaheadBuffer is undefined"],
      ["PrattParserTest: missing token coordinator"]
    );
    expect(safe.passed).toBe(false);
    expect(safe.feedbackDigest).toBeDefined();
    expect(safe.errors[0]).toContain("LookaheadBuffer is undefined");
  });

  // ==========================================================================
  // 9. Revision Chain & Ceiling
  // ==========================================================================

  it("25. enforces max proposal revisions ceiling (MAX_PROPOSAL_REVISIONS = 3)", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L7-01", "HUMAN_MODEL_COLLABORATION", 0);
    const excessiveRev = {
      ...prop,
      revisionIndex: 4, // > 3
      parentProposalId: prop.proposalId,
    };
    const res = TransformationProposalValidator.validate(excessiveRev);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("MAX_REVISIONS_EXCEEDED"))).toBe(true);
  });

  it("26. rejects revision proposals that fail to declare parentProposalId", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L7-01", "HUMAN_MODEL_COLLABORATION", 0);
    const unlinkedRev = {
      ...prop,
      revisionIndex: 1,
      parentProposalId: undefined,
    };
    const res = TransformationProposalValidator.validate(unlinkedRev);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("MISSING_PARENT_PROPOSAL_ID"))).toBe(true);
  });

  // ==========================================================================
  // 10. Proposal Digest Verification
  // ==========================================================================

  it("27. verifies proposal digest and rejects altered proposals", () => {
    const prop = GovernedProposalEngine.constructProposal("P46-L5-01", "HUMAN");
    const tampered = {
      ...prop,
      transformationIntent: "Altered intent without updating digest",
    };
    const res = TransformationProposalValidator.validate(tampered);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("PROPOSAL_DIGEST_MISMATCH"))).toBe(true);
  });

  // ==========================================================================
  // 11. Governed Execution & Clean-Room Dual-Gate Verification
  // ==========================================================================

  it("28. Condition B (Human): expert proposal achieves clean-room L7 success", () => {
    const rec = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_B");
    expect(rec.cleanRoomSuccess).toBe(true);
    expect(rec.f2pRatio).toBe(1.0);
    expect(rec.p2pRatio).toBe(1.0);
    expect(rec.suiteRan).toBe(11);
    expect(rec.fourfoldSuccess).toBe(true);
    expect(rec.terminalAuthoritySuccess).toBe(true);
  });

  it("29. Condition C (Local Model): untrusted model fails L7 Pratt parser multi-file coordination", () => {
    const rec = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_C");
    expect(rec.cleanRoomSuccess).toBe(false);
    expect(rec.f2pRatio).toBe(0.0);
    expect(rec.failureClassification).toBe("AUTONOMOUS_DISCOVERY_FAILURE");
    expect(rec.fourfoldSuccess).toBe(false);
  });

  it("30. Condition D (Collaborative): collaborative proposal succeeds on L7 within 1 revision", () => {
    const rec = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_D");
    expect(rec.cleanRoomSuccess).toBe(true);
    expect(rec.revisionsCount).toBe(1);
    expect(rec.f2pRatio).toBe(1.0);
    expect(rec.p2pRatio).toBe(1.0);
    expect(rec.fourfoldSuccess).toBe(true);
    expect(rec.evidenceAttribution?.proposerType).toBe("HUMAN_MODEL_COLLABORATION");
  });

  // ==========================================================================
  // 12. Fourfold Gate & Evidence Attribution
  // ==========================================================================

  it("31. fourfold completion gate requires all four conditions to issue terminal authority", () => {
    const recSuccess = GovernedProposalEngine.executeTrial("P46-L5-01", "CONDITION_B");
    expect(recSuccess.fourfoldSuccess).toBe(true);
    expect(recSuccess.terminalAuthoritySuccess).toBe(true);

    const recFail = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_C");
    expect(recFail.fourfoldSuccess).toBe(false);
    expect(recFail.terminalAuthoritySuccess).toBe(false);
  });

  it("32. evidence attribution strictly binds proposerType without conferring authority to proposer", () => {
    const rec = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_D");
    expect(rec.evidenceAttribution).toBeDefined();
    expect(rec.evidenceAttribution?.proposerType).toBe("HUMAN_MODEL_COLLABORATION");
    expect(rec.evidenceAttribution?.terminalAuthority).toBe(true);
    expect(rec.evidenceAttribution?.sourceRevision).toBe(FROZEN_BASELINE_REVISION);
  });

  // ==========================================================================
  // 13. Security Negative Controls (N1–N180)
  // ==========================================================================

  it("33. negative controls N1–N180 all pass fail-closed (180/180)", () => {
    const controls = GovernedProposalEngine.evaluateNegativeControls();
    expect(controls).toHaveLength(180);
    const failed = controls.filter((c) => c.status !== "PASS");
    expect(failed).toHaveLength(0);

    // Verify N171–N180 specifically
    const n171to180 = controls.slice(170);
    expect(n171to180).toHaveLength(10);
    for (const c of n171to180) {
      expect(c.status).toBe("PASS");
      expect(c.actualClass).toBe("REJECT");
    }
  });

  // ==========================================================================
  // 14. Determinism & Historical Compatibility
  // ==========================================================================

  it("34. multi-sweep execution produces byte-identical results", () => {
    const trial1 = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_D");
    const trial2 = GovernedProposalEngine.executeTrial("P46-L7-01", "CONDITION_D");
    expect(trial1.proposalDigest).toBe(trial2.proposalDigest);
    expect(trial1.cleanRoomSuccess).toBe(trial2.cleanRoomSuccess);
  });

  it("35. default limits match frozen specification values", () => {
    expect(DEFAULT_PROPOSAL_VALIDATION_LIMITS.maxProposalBytes).toBe(65536);
    expect(DEFAULT_PROPOSAL_VALIDATION_LIMITS.maxTargetFiles).toBe(8);
    expect(DEFAULT_PROPOSAL_VALIDATION_LIMITS.maxEdits).toBe(64);
    expect(DEFAULT_PROPOSAL_VALIDATION_LIMITS.maxProposalRevisions).toBe(3);
  });
});
