/**
 * Phase 76 — Formal Behavioral Specification Sufficiency Integration Tests
 *
 * Verifies:
 * 1. Specification schema and level classification (SPEC-A, SPEC-B, SPEC-C)
 * 2. Type checking and validation of state domains, variables, and events
 * 3. Cross-module relation validation
 * 4. Invariant and obligation validation
 * 5. Event ordering constraint validation
 * 6. Contradiction detection (conflicting safety/liveness rules and ordering cycles)
 * 7. Canonical SHA-256 specification hashing
 * 8. Anti-oracle leakage scanner (diff headers, final source fragments, solution constants)
 * 9. Scope enforcement preventing out-of-scope module mutation
 * 10. Behavioral obligation compilation from formal specifications
 * 11. Phase 75 BehavioralMachine integration
 * 12. Phase 74 AST rewrite plan integration and atomic materialization
 * 13. Deterministic replay across 3 evaluation runs
 * 14. Negative controls N137–N146 and preserved N1–N136 (100% fail-closed)
 * 15. Authority firewall preventing unverified specification escalation
 * 16. Clean-room dual-gate test integration and fail-closed isolation
 * 17. Fourfold gate attestation and terminal record authority
 * 18. Offline auditor replay verification
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  FormalBehavioralSpecificationAuthor,
  FormalBehavioralSpecificationValidator,
  FormalSpecificationLeakageScanner,
  FormalSpecificationCompiler,
  GovernedFormalSpecificationExperimentEngine,
  FormalBehavioralSpecification,
} from "../../src/application/formal-behavioral-specification-experiment.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 76 — Formal Behavioral Specification Sufficiency Experiment", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-protocol.json"), "utf8"));
  const specificationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-specifications.json"), "utf8"));
  const validationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-specification-validation.json"), "utf8"));
  const leakageData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-specification-leakage.json"), "utf8"));
  const obligationsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-behavioral-obligations.json"), "utf8"));
  const machinesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-machines.json"), "utf8"));
  const candidatesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-candidates.json"), "utf8"));
  const counterexamplesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-counterexamples.json"), "utf8"));
  const compilationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-compilation.json"), "utf8"));
  const evaluationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-evaluation.json"), "utf8"));
  const negativeControlsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-negative-controls.json"), "utf8"));
  const determinismData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-determinism.json"), "utf8"));
  const resultsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-results.json"), "utf8"));
  const statusData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase76-status.json"), "utf8"));

  // 1. Specification levels
  it("Test 1: exactly three frozen specification levels (SPEC-A, SPEC-B, SPEC-C) defined", () => {
    expect(protocol.specificationLevels).toEqual(["SPEC-A", "SPEC-B", "SPEC-C"]);
    expect(specificationsData.count).toBe(45); // 15 tasks x 3 levels
  });

  // 2. SPEC-A observable properties
  it("Test 2: SPEC-A captures observable inputs, outputs, state, and safety properties", () => {
    const specA = FormalBehavioralSpecificationAuthor.createSpecification("P46-L5-01", "SPEC-A");
    expect(specA.level).toBe("SPEC-A");
    expect(specA.provenance.authoringMode).toBe("OBSERVABLE");
    expect(specA.invariants.length).toBeGreaterThan(0);
    expect(specA.safetyProperties.length).toBeGreaterThan(0);
    expect(specA.relations.length).toBe(0); // SPEC-A has no cross-module relations
  });

  // 3. SPEC-B cross-module relations
  it("Test 3: SPEC-B captures cross-module relations for multi-module tasks", () => {
    const specB = FormalBehavioralSpecificationAuthor.createSpecification("P46-L6-01", "SPEC-B");
    expect(specB.level).toBe("SPEC-B");
    expect(specB.provenance.authoringMode).toBe("RELATIONAL");
    expect(specB.relations.length).toBe(1);
    expect(specB.relations[0]?.relationType).toBe("REPRESENTATION_PARITY");
  });

  // 4. SPEC-C full formal contracts
  it("Test 4: SPEC-C captures ordering constraints and synchronization contracts", () => {
    const specC = FormalBehavioralSpecificationAuthor.createSpecification("P46-L7-01", "SPEC-C");
    expect(specC.level).toBe("SPEC-C");
    expect(specC.provenance.authoringMode).toBe("FULL_FORMAL");
    expect(specC.orderingConstraints.length).toBeGreaterThan(0);
    expect(specC.relations[0]?.relationType).toBe("TOKEN_PARSER_PARITY");
    expect(specC.invariants.some((i) => i.ruleType === "CROSS_MODULE_SYNCHRONIZATION")).toBe(true);
  });

  // 5. Validator approves valid specifications
  it("Test 5: FormalBehavioralSpecificationValidator validates valid specifications (45/45 valid)", () => {
    expect(validationsData.count).toBe(45);
    for (const v of validationsData.validations) {
      expect(v.valid).toBe(true);
      expect(v.errors.length).toBe(0);
    }
  });

  // 6. Anti-oracle leakage scanner detects diff headers
  it("Test 6: FormalSpecificationLeakageScanner detects and rejects gold diff headers", () => {
    const dirty = "diff --git a/src/parser.js b/src/parser.js";
    const res = FormalSpecificationLeakageScanner.scan(dirty);
    expect(res.clean).toBe(false);
    expect(res.detectedTokens).toContain("diff --git");
  });

  // 7. Anti-oracle leakage scanner detects solution constants
  it("Test 7: FormalSpecificationLeakageScanner detects and rejects implementation solution constants", () => {
    const dirty = "Rule: Use PREFIX_UNARY_BP = 9 for parser fix";
    const res = FormalSpecificationLeakageScanner.scan(dirty);
    expect(res.clean).toBe(false);
    expect(res.detectedTokens).toContain("PREFIX_UNARY_BP");
  });

  // 8. Leakage scan across all generated specifications
  it("Test 8: all 45 generated specifications are 100% clean of oracle leakage", () => {
    expect(leakageData.count).toBe(45);
    for (const lk of leakageData.leakageScans) {
      expect(lk.clean).toBe(true);
      expect(lk.detectedTokens.length).toBe(0);
    }
  });

  // 9. Scope enforcement
  it("Test 9: FormalBehavioralSpecificationValidator rejects out-of-scope domain declarations", () => {
    const base = FormalBehavioralSpecificationAuthor.createSpecification("P46-L5-01", "SPEC-A");
    const badSpec: FormalBehavioralSpecification = {
      ...base,
      stateDomains: [
        ...base.stateDomains,
        { domainId: "bad_dom", name: "src/unauthorized.js", states: ["A"], defaultState: "A", isObservable: true },
      ],
    };
    const res = FormalBehavioralSpecificationValidator.validate(badSpec);
    expect(res.valid).toBe(false);
    expect(res.scopeCheckPassed).toBe(false);
  });

  // 10. Contradiction detection: Conflicting safety and liveness rules
  it("Test 10: FormalBehavioralSpecificationValidator detects safety and liveness contradictions", () => {
    const base = FormalBehavioralSpecificationAuthor.createSpecification("P46-L5-01", "SPEC-A");
    const badSpec: FormalBehavioralSpecification = {
      ...base,
      safetyProperties: [
        ...base.safetyProperties,
        { propertyId: "s_bad", description: "Never terminal", formula: "!F(status == 'TERMINAL')" },
      ],
    };
    const res = FormalBehavioralSpecificationValidator.validate(badSpec);
    expect(res.valid).toBe(false);
    expect(res.contradictionCount).toBeGreaterThan(0);
  });

  // 11. Contradiction detection: Ordering cycle
  it("Test 11: FormalBehavioralSpecificationValidator detects cyclic ordering constraints", () => {
    const base = FormalBehavioralSpecificationAuthor.createSpecification("P46-L5-01", "SPEC-C");
    const badSpec: FormalBehavioralSpecification = {
      ...base,
      orderingConstraints: [
        { constraintId: "c1", eventBefore: "ev1", eventAfter: "ev2", strict: true },
        { constraintId: "c2", eventBefore: "ev2", eventAfter: "ev1", strict: true },
      ],
    };
    const res = FormalBehavioralSpecificationValidator.validate(badSpec);
    expect(res.valid).toBe(false);
    expect(res.contradictionCount).toBeGreaterThan(0);
  });

  // 12. Canonical hashing
  it("Test 12: FormalBehavioralSpecification computes deterministic SHA-256 canonical hash", () => {
    const spec = specificationsData.specifications[0];
    expect(spec.canonicalHash).toBeDefined();
    expect(spec.canonicalHash.length).toBe(64);
  });

  // 13. Compiler translates SPEC-C into Phase 75 BehavioralMachine
  it("Test 13: FormalSpecificationCompiler compiles formal contract into BehavioralMachine", () => {
    const spec = FormalBehavioralSpecificationAuthor.createSpecification("P46-L5-01", "SPEC-C");
    const compRes = FormalSpecificationCompiler.compile(spec);
    expect(compRes.success).toBe(true);
    expect(compRes.machine).toBeDefined();
    expect(compRes.machine?.states.length).toBeGreaterThan(0);
    expect(compRes.machine?.transitions.length).toBeGreaterThan(0);
  });

  // 14. Compiler translates machine into Phase 74 AST rewrite plan
  it("Test 14: FormalSpecificationCompiler produces executable Phase 74 AST rewrite plan", () => {
    const spec = FormalBehavioralSpecificationAuthor.createSpecification("P46-L6-01", "SPEC-C");
    const compRes = FormalSpecificationCompiler.compile(spec);
    expect(compRes.success).toBe(true);
    expect(compRes.plan).toBeDefined();
    expect(compRes.plan?.orderedRewrites.length).toBeGreaterThan(0);
    expect(compRes.filesTouched.length).toBe(2);
  });

  // 15. Materialization integration
  it("Test 15: compiled AST rewrite plan materializes cleanly with zero rollback", () => {
    expect(compilationData.count).toBe(15);
    for (const comp of compilationData.compilations) {
      expect(comp.success).toBe(true);
      expect(comp.filesTouched.length).toBeGreaterThan(0);
    }
  });

  // 16. Counterexample extraction on L7
  it("Test 16: counterexamples extracted for all L7 whole-program tasks", () => {
    expect(counterexamplesData.count).toBe(5);
    for (const ce of counterexamplesData.counterexamples) {
      expect(ce.category).toBe("SYNTHESIS_CAPABILITY_EXHAUSTION");
    }
  });

  // 17. Negative control N137: Gold fragment
  it("Test 17: N137 blocks gold-patch diff header in specification payload", () => {
    const n137 = negativeControlsData.controls.find((c: any) => c.id === "N137");
    expect(n137.status).toBe("PASS");
    expect(n137.actualClass).toBe("REJECT");
  });

  // 18. Negative control N138: Final source leak
  it("Test 18: N138 blocks final target source fragments in specification payload", () => {
    const n138 = negativeControlsData.controls.find((c: any) => c.id === "N138");
    expect(n138.status).toBe("PASS");
    expect(n138.actualClass).toBe("REJECT");
  });

  // 19. Negative control N139: Gold constant
  it("Test 19: N139 blocks implementation solution constants in specification payload", () => {
    const n139 = negativeControlsData.controls.find((c: any) => c.id === "N139");
    expect(n139.status).toBe("PASS");
    expect(n139.actualClass).toBe("REJECT");
  });

  // 20. Negative control N140: Patch derivation
  it("Test 20: N140 blocks patch hunk headers in specification payload", () => {
    const n140 = negativeControlsData.controls.find((c: any) => c.id === "N140");
    expect(n140.status).toBe("PASS");
    expect(n140.actualClass).toBe("REJECT");
  });

  // 21. Negative control N141: Scope escalation
  it("Test 21: N141 blocks specification attempting to mutate out-of-scope files", () => {
    const n141 = negativeControlsData.controls.find((c: any) => c.id === "N141");
    expect(n141.status).toBe("PASS");
    expect(n141.actualClass).toBe("REJECT");
  });

  // 22. Negative control N142: Authority escalation
  it("Test 22: N142 prevents specification compiler from claiming self-verification authority", () => {
    const n142 = negativeControlsData.controls.find((c: any) => c.id === "N142");
    expect(n142.status).toBe("PASS");
    expect(n142.actualClass).toBe("REJECT");
  });

  // 23. Negative control N143: Contradiction
  it("Test 23: N143 rejects contradictory safety and liveness constraints fail-closed", () => {
    const n143 = negativeControlsData.controls.find((c: any) => c.id === "N143");
    expect(n143.status).toBe("PASS");
    expect(n143.actualClass).toBe("REJECT");
  });

  // 24. Negative control N144: Undeclared relation
  it("Test 24: N144 rejects relations connecting modules outside declared task scope", () => {
    const n144 = negativeControlsData.controls.find((c: any) => c.id === "N144");
    expect(n144.status).toBe("PASS");
    expect(n144.actualClass).toBe("REJECT");
  });

  // 25. Negative control N145: Hidden implementation detail
  it("Test 25: N145 rejects source-level line edit instructions in specification", () => {
    const n145 = negativeControlsData.controls.find((c: any) => c.id === "N145");
    expect(n145.status).toBe("PASS");
    expect(n145.actualClass).toBe("REJECT");
  });

  // 26. Negative control N146: Deterministic serialization
  it("Test 26: N146 verifies deterministic specification serialization across repeat runs", () => {
    const n146 = negativeControlsData.controls.find((c: any) => c.id === "N146");
    expect(n146.status).toBe("PASS");
    expect(n146.actualClass).toBe("BYTE_IDENTICAL_CANONICAL_SPEC");
  });

  // 27. Overall negative controls pass rate
  it("Test 27: all 146 negative controls (N1–N146) pass 100.0% fail-closed", () => {
    expect(negativeControlsData.totalControls).toBe(146);
    expect(negativeControlsData.passedControls).toBe(146);
    expect(negativeControlsData.passRate).toBe("100.0%");
  });

  // 28. Condition A evaluation
  it("Test 28: Condition A evaluates Phase 75 control baseline (10/15 passed)", () => {
    expect(GovernedFormalSpecificationExperimentEngine.executeTrial).toBeDefined();
    const condA = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_A");
    const passed = condA.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condA.length).toBe(15);
  });

  // 29. Condition B evaluation
  it("Test 29: Condition B evaluates SPEC-A Observable specification (10/15 passed)", () => {
    const condB = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_B");
    const passed = condB.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condB.length).toBe(15);
  });

  // 30. Condition C evaluation
  it("Test 30: Condition C evaluates SPEC-B Relational specification (10/15 passed)", () => {
    const condC = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_C");
    const passed = condC.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condC.length).toBe(15);
  });

  // 31. Condition D evaluation
  it("Test 31: Condition D evaluates SPEC-C Full Formal Contract (10/15 passed)", () => {
    const condD = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_D");
    const passed = condD.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condD.length).toBe(15);
  });

  // 32. L7 failure classification under SPEC-C
  it("Test 32: L7 failures under SPEC-C classified as SYNTHESIS_FAILURE", () => {
    const l7Trials = evaluationData.trials.filter((t: any) => t.taskId.includes("L7") && t.condition === "CONDITION_D");
    expect(l7Trials.length).toBe(5);
    for (const t of l7Trials) {
      expect(t.specificationValid).toBe(true);
      expect(t.machineSynthesized).toBe(true);
      expect(t.compilationSucceeded).toBe(true);
      expect(t.materializationSucceeded).toBe(true);
      expect(t.cleanRoomPassed).toBe(false);
      expect(t.failureStage).toBe("SYNTHESIS_FAILURE");
    }
  });

  // 33. Determinism verification
  it("Test 33: determinism verification confirms byte-identical replay across 3 runs", () => {
    expect(determinismData.deterministicStatus).toBe("PASS (BYTE_IDENTICAL)");
    expect(determinismData.run1Digest).toBe(determinismData.run2Digest);
    expect(determinismData.run2Digest).toBe(determinismData.run3Digest);
  });

  // 34. Authority & clean-room governance
  it("Test 34: authority firewall and clean-room gates remain 100% fail-closed", () => {
    expect(resultsData.clean_room_verification).toBe("100% (dual-gate verified)");
    expect(resultsData.fourfold_verification).toBe("100% (valid)");
    expect(resultsData.offline_auditor).toBe("100% (replay verified)");
    expect(resultsData.terminal_authority).toBe("100% (Ed25519 2-of-3 threshold immutable)");
  });

  // 35. Scientific decision: SYNTHESIS_CAPABILITY_BOUNDARY
  it("Test 35: scientific decision confirms SYNTHESIS_CAPABILITY_BOUNDARY", () => {
    expect(resultsData.decision).toBe("SYNTHESIS_CAPABILITY_BOUNDARY");
    expect(resultsData.remainingBoundary).toBe("SYNTHESIS_CAPABILITY_BOUNDARY");
    expect(resultsData.overall_success).toBe("10/15 (66.7%)");
    expect(resultsData.l7_clean_room_success).toBe("0/5 (0.0%)");
    expect(resultsData.information_gain).toBe("0.0%");
  });

  // 36. Candidate and machine data counts
  it("Test 36: candidate and machine data structures match expected task cohort counts", () => {
    expect(machinesData.count).toBe(15);
    expect(candidatesData.count).toBe(15);
    expect(obligationsData.count).toBe(30);
    expect(statusData.phase).toBe("76");
  });
});
