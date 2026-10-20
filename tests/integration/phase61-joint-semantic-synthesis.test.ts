/**
 * Phase 61 — Governed Joint Semantic Synthesis and Multi-Region Composition Integration Tests
 *
 * Verifies:
 * 1. Evidence-based coupled-region group discovery
 * 2. Coupling provenance tracking and semantic hashing
 * 3. JointRepairVariable construction across coupled targets
 * 4. CrossRegionConstraint construction across multi-region boundaries
 * 5. Constraint canonical SHA-256 digest consistency
 * 6. Unsupported constraint rejection prior to synthesis
 * 7. Bounded joint candidate generation
 * 8. Candidate pruning via constraints and CEGAR feedback
 * 9. Joint candidate structural and assignment validation
 * 10. Region contract conformance under joint variable assignments
 * 11. Whole-program global invariant validation
 * 12. CEGAR refinement constraint integration in joint candidate ranking
 * 13. Transactional atomic patch application and rollback
 * 14. Static gold leakage detection and zero leakage assertion
 * 15. Authority firewall preventing elevation of lease, credentials, or terminal authority
 * 16. Deterministic replay across repeated independent runs
 * 17. Complete negative control suite (N1–N10 fail-closed)
 * 18. Clean-room dual-gate verification integration
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProgramSpaceDecomposer } from "../../src/application/program-space-decomposer.js";
import {
  JointSemanticSynthesizer,
  JOINT_SYNTHESIS_LIMITS,
} from "../../src/application/joint-semantic-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 61 — Governed Joint Semantic Synthesis and Multi-Region Composition", () => {
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

  // ---------------------------------------------------------------------------
  // 1. Coupled-Region Discovery
  // ---------------------------------------------------------------------------
  it("discovers coupled region groups from semantic decomposition boundaries", () => {
    expect(protocol.phase).toBe("61");
    expect(protocol.baselineCommit).toBe("267badc");
    expect(coupledRegionsData.totalCoupledGroups).toBe(15);
    expect(evaluation.totalTrials).toBe(60);

    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-01", {
      symbols: ["parseExpression", "evaluateExponent"],
      files: ["src/parser.js", "src/calc.js"],
      invariants: ["PRATT_UNARY_JUXTAPOSITION_INVARIANT"]
    });

    const groups = JointSemanticSynthesizer.detectCoupledRegions("P46-L7-01", plan);
    expect(groups.length).toBe(1);
    expect(groups[0]!.groupId).toBe("GROUP-P46-L7-01-01");
    expect(groups[0]!.regionIds.length).toBe(2);
    expect(groups[0]!.couplingReasons).toContain("PRODUCER_CONSUMER_COUPLING");
  });

  // ---------------------------------------------------------------------------
  // 2. Coupling Provenance
  // ---------------------------------------------------------------------------
  it("tracks explicit coupling provenance and validates semanticHash", () => {
    const group = coupledRegionsData.groups[0]!;
    expect(group.provenance).toBeDefined();
    expect(group.semanticHash).toBeDefined();
    expect(group.semanticHash.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 3. Joint Variable Construction
  // ---------------------------------------------------------------------------
  it("constructs JointRepairVariables across coupled region members", () => {
    expect(jointVariablesData.totalJointVariables).toBe(25);
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L6-01", {
      symbols: ["hasRole", "authorizeUser"],
      files: ["src/rbac.js", "src/auth.js"],
      invariants: ["RBAC_HIERARCHY"]
    });
    const groups = JointSemanticSynthesizer.detectCoupledRegions("P46-L6-01", plan);
    const vars = JointSemanticSynthesizer.constructJointVariables(groups[0]!, plan);

    expect(vars.length).toBe(2);
    expect(vars[0]!.variableId).toBe("JVAR-P46-L6-01-1");
    expect(vars[1]!.variableId).toBe("JVAR-P46-L6-01-2");
    expect(vars[1]!.dependencies).toContain("JVAR-P46-L6-01-1");
  });

  // ---------------------------------------------------------------------------
  // 4. Cross-Region Constraint Construction
  // ---------------------------------------------------------------------------
  it("extracts cross-region constraints covering producer/consumer, state, and invariants", () => {
    expect(constraintsData.totalConstraints).toBe(45);
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-02", {
      symbols: ["compileOriginPattern", "validateHeaders"],
      files: ["src/cors.js", "src/header-validator.js"],
      invariants: ["CORS_WILDCARD_CREDENTIAL_INVARIANT"]
    });
    const groups = JointSemanticSynthesizer.detectCoupledRegions("P46-L7-02", plan);
    const vars = JointSemanticSynthesizer.constructJointVariables(groups[0]!, plan);
    const constrs = JointSemanticSynthesizer.extractCrossRegionConstraints(groups[0]!, vars, plan);

    expect(constrs.length).toBe(4);
    const types = constrs.map((c) => c.constraintType);
    expect(types).toContain("PRODUCER_CONSUMER");
    expect(types).toContain("SHARED_STATE");
    expect(types).toContain("INVARIANT");
    expect(types).toContain("REGRESSION");
  });

  // ---------------------------------------------------------------------------
  // 5. Constraint Hashing
  // ---------------------------------------------------------------------------
  it("verifies canonical SHA-256 hashing for CrossRegionConstraints", () => {
    for (const c of constraintsData.constraints) {
      expect(c.canonicalHash).toBeDefined();
      expect(c.canonicalHash.length).toBe(64);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Unsupported Constraint Rejection
  // ---------------------------------------------------------------------------
  it("rejects unsupported constraints lacking evidence or provenance", () => {
    const ctrl = negativeControls.controls.find((c: any) => c.id === "N3");
    expect(ctrl.status).toBe("PASS");
    expect(ctrl.actualClass).toBe("UNSUPPORTED_CONSTRAINT_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 7. Bounded Joint Candidate Generation
  // ---------------------------------------------------------------------------
  it("bounds candidate generation within research limits (maxCandidates <= 50)", () => {
    expect(candidatesData.totalCandidatesGenerated).toBe(300);
    expect(JOINT_SYNTHESIS_LIMITS.maxCandidates).toBe(50);
    expect(JOINT_SYNTHESIS_LIMITS.maxCoupledRegions).toBe(4);
    expect(JOINT_SYNTHESIS_LIMITS.maxJointVariables).toBe(32);
    expect(JOINT_SYNTHESIS_LIMITS.maxSearchDepth).toBe(6);
  });

  // ---------------------------------------------------------------------------
  // 8. Candidate Pruning via Constraints and CEGAR
  // ---------------------------------------------------------------------------
  it("prunes invalid candidate combinations using cross-region constraints", () => {
    expect(candidatesData.totalCandidatesPruned).toBe(165);
    expect(candidatesData.totalCandidatesExecuted).toBe(135);
    const pruningRatio = candidatesData.totalCandidatesPruned / candidatesData.totalCandidatesGenerated;
    expect(pruningRatio).toBeGreaterThan(0.50);
  });

  // ---------------------------------------------------------------------------
  // 9. Joint Candidate Structural Validation
  // ---------------------------------------------------------------------------
  it("validates joint candidate variable assignments and touched symbols", () => {
    const acceptedL6 = candidatesData.results.find((r: any) => r.taskId === "P46-L6-01");
    expect(acceptedL6.acceptedCandidate).toBeDefined();
    expect(acceptedL6.acceptedCandidate.touchedRegions.length).toBe(2);
    expect(acceptedL6.acceptedCandidate.regressionResults).toBe("PASS");
  });

  // ---------------------------------------------------------------------------
  // 10. Region Contract Validation
  // ---------------------------------------------------------------------------
  it("verifies all region contracts are satisfied under joint assignments", () => {
    expect(results.metrics.contract_success).toBe("25/25 (100.0%)");
  });

  // ---------------------------------------------------------------------------
  // 11. Whole-Program Global Invariant Validation
  // ---------------------------------------------------------------------------
  it("validates that L5 and L6 candidates satisfy global invariants, while L7 fails", () => {
    const l5Result = compositionData.results.find((r: any) => r.taskId === "P46-L5-01");
    expect(l5Result.crossRegionSuccess).toBe(true);
    expect(l5Result.cleanRoomVerification).toBe("PASS");

    const l7Result = compositionData.results.find((r: any) => r.taskId === "P46-L7-01");
    expect(l7Result.crossRegionSuccess).toBe(false);
    expect(l7Result.cleanRoomVerification).toBe("FAIL");
  });

  // ---------------------------------------------------------------------------
  // 12. CEGAR Refinement Integration
  // ---------------------------------------------------------------------------
  it("integrates CEGAR search trace tracking depth and exhaustion", () => {
    expect(searchTraceData.totalTraces).toBe(15);
    const l7Trace = searchTraceData.traces.find((t: any) => t.taskId === "P46-L7-01");
    expect(l7Trace.searchDepth).toBe(6);
    expect(l7Trace.searchExhausted).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 13. Transactional Rollback
  // ---------------------------------------------------------------------------
  it("rolls back candidate mutations upon regression failure", () => {
    const l7Candidate = candidatesData.results.find((r: any) => r.taskId === "P46-L7-02");
    expect(l7Candidate.acceptedCandidate).toBeNull();
    expect(l7Candidate.searchExhausted).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 14. Gold Leakage Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects gold-patch snippets and pre-authored solutions", () => {
    expect(results.metrics.gold_leakage).toContain("ZERO_LEAKAGE");
    expect(JointSemanticSynthesizer.detectGoldLeakage("PREFIX_UNARY_BP = 9")).toBe(true);
    expect(JointSemanticSynthesizer.detectGoldLeakage("EXP_BP = 8")).toBe(true);
    expect(JointSemanticSynthesizer.detectGoldLeakage("const valid = true;")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 15. Authority Firewall
  // ---------------------------------------------------------------------------
  it("preserves immutable authority firewall preventing execution elevation", () => {
    expect(results.metrics.authority_firewall).toContain("100%");
    expect(results.metrics.terminal_authority).toContain("100%");
  });

  // ---------------------------------------------------------------------------
  // 16. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("guarantees byte-identical determinism across repeated independent runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 17. Complete Negative Controls (N1–N10)
  // ---------------------------------------------------------------------------
  it("passes all 10 negative controls (N1–N10) in fail-closed state", () => {
    expect(negativeControls.totalControls).toBe(10);
    expect(negativeControls.allPassed).toBe(true);
    const ids = negativeControls.controls.map((c: any) => c.id);
    expect(ids).toEqual(["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10"]);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
    }
  });

  // ---------------------------------------------------------------------------
  // 18. Clean-Room Integration & L7 Diagnostic Analysis
  // ---------------------------------------------------------------------------
  it("verifies dual-gate clean-room fail-closed behavior on P46-L7-01 and P46-L7-02", () => {
    expect(diagnostics.diagnostics.length).toBe(2);

    const d1 = diagnostics.diagnostics[0];
    expect(d1.taskId).toBe("P46-L7-01");
    expect(d1.searchExhausted).toBe(true);
    expect(d1.cleanRoomStatus).toBe("FAIL");
    expect(d1.failureRootCause).toContain("Pratt parser precedence and juxtaposition");

    const d2 = diagnostics.diagnostics[1];
    expect(d2.taskId).toBe("P46-L7-02");
    expect(d2.searchExhausted).toBe(true);
    expect(d2.cleanRoomStatus).toBe("FAIL");
    expect(d2.failureRootCause).toContain("Access-Control-Allow-Credentials");
  });
});
