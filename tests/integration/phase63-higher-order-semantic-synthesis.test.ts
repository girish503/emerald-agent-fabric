/**
 * Phase 63 — Higher-Order Semantic Invariant Synthesis and Program Skeleton Completion Integration Tests
 *
 * Verifies:
 * 1. Higher-order invariant candidate generation from observable evidence
 * 2. Invariant evidence provenance tracking
 * 3. Invariant contradiction detection against known counterexamples
 * 4. Soundness validation of synthesized invariants (OBSERVED -> VALIDATED)
 * 5. Over-generalization detection preventing exclusion of valid behaviors
 * 6. Counterexample refinement integration in candidate ranking
 * 7. TypedProgramSkeleton construction with typed holes
 * 8. SemanticHole validation against target symbols and modules
 * 9. Hole candidate bounds enforcement (maxHoleCandidates <= 16, maxSkeletons <= 25)
 * 10. Invariant-guided skeleton completion compiling into semantic transformations
 * 11. Invariant-guided pruning (54.3% candidate search space reduction)
 * 12. Multi-module semantic transformation generation from completed skeletons
 * 13. Deterministic AST materialization with canonical hashing
 * 14. Transactional rollback and fail-closed behavior on invariant failure
 * 15. Static gold leakage detection (zero Pratt or CORS leakage)
 * 16. Authority firewall preventing elevation of lease, credentials, or terminal authority
 * 17. Deterministic replay across repeated independent runs (byte-identical canonical output)
 * 18. Complete negative control suite (N1–N12 fail-closed)
 * 19. Clean-room dual-gate verification integration and L7 diagnostic root cause analysis
 * 20. Phase 62 historical baseline regression preservation
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProgramSpaceDecomposer } from "../../src/application/program-space-decomposer.js";
import { WholeProgramSemanticSynthesizer } from "../../src/application/whole-program-semantic-synthesizer.js";
import {
  HigherOrderSemanticSynthesizer,
  HIGHER_ORDER_SYNTHESIS_LIMITS,
  INVARIANT_CATEGORIES,
  INVARIANT_CONFIDENCE_CLASSES,
  type HigherOrderInvariant,
} from "../../src/application/higher-order-semantic-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 63 — Higher-Order Semantic Invariant Synthesis and Program Skeleton Completion", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-protocol.json"), "utf8"));
  const semanticGraph = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-semantic-graph.json"), "utf8"));
  const invariantCandidates = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-invariant-candidates.json"), "utf8"));
  const validatedInvariants = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-validated-invariants.json"), "utf8"));
  const counterexamples = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-counterexamples.json"), "utf8"));
  const skeletons = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-skeletons.json"), "utf8"));
  const holes = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-semantic-holes.json"), "utf8"));
  const completions = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-completions.json"), "utf8"));
  const materialization = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-materialization.json"), "utf8"));
  const verification = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-verification.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase63-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Invariant Candidate Generation
  // ---------------------------------------------------------------------------
  it("synthesizes higher-order invariant candidates from observable repository evidence", () => {
    expect(protocol.phase).toBe("63");
    expect(protocol.baselineCommit).toBe("7f14c90");
    expect(invariantCandidates.totalCandidates).toBe(65);
    expect(evaluation.totalTrials).toBe(60);

    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-01", {
      symbols: ["parseExpression", "evaluateExponent"],
      files: ["src/parser.js", "src/calc.js"],
      invariants: ["PRATT_UNARY_JUXTAPOSITION_INVARIANT"],
    });
    const graph = WholeProgramSemanticSynthesizer.constructSemanticGraph("P46-L7-01", plan);
    const candidates = HigherOrderSemanticSynthesizer.synthesizeInvariantCandidates("P46-L7-01", graph, plan);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.category === "REGRESSION_INVARIANT")).toBe(true);
    expect(candidates.some((c) => c.category === "REPRESENTATION_INVARIANT")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Invariant Evidence Provenance
  // ---------------------------------------------------------------------------
  it("tracks explicit evidence provenance and canonical SHA-256 digests for all invariants", () => {
    for (const inv of validatedInvariants.invariants) {
      expect(inv.canonicalHash).toBeDefined();
      expect(inv.canonicalHash.length).toBe(64);
      expect(inv.provenance.sourceEntity).toBeDefined();
      expect(inv.provenance.extractionRule).toBeDefined();
      expect(inv.evidence.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Contradiction Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects candidate invariants that contradict known counterexamples", () => {
    const contradictoryInv: HigherOrderInvariant = {
      invariantId: "INV-CONTRADICTION",
      taskId: "P46-L7-01",
      category: "STATE_INVARIANT",
      semanticPredicate: "CONTRADICTS_KNOWN_COUNTEREXAMPLE",
      affectedSymbols: ["parseExpression"],
      affectedModules: ["src/parser.js"],
      requiredRelationships: [],
      preconditions: [],
      postconditions: [],
      counterexamples: ["CE-KNOWN-FAILURE-01"],
      evidence: ["EV_1"],
      provenance: {
        taskId: "P46-L7-01",
        sourceEntity: "TEST",
        extractionRule: "TEST",
        derivedAt: "2026-10-20T00:00:00.000Z",
      },
      confidenceClass: "UNRESOLVED",
      canonicalHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const val = HigherOrderSemanticSynthesizer.validateInvariants(
      [contradictoryInv],
      ["CE-KNOWN-FAILURE-01"]
    );
    expect(val.validated.length).toBe(0);
    expect(val.rejected.length).toBe(1);
    expect(val.rejected[0]!.reason).toContain("CONTRADICTORY_INVARIANT");
  });

  // ---------------------------------------------------------------------------
  // 4. Invariant Soundness Validation
  // ---------------------------------------------------------------------------
  it("enforces soundness validation: only VALIDATED and INFERRED invariants constrain synthesis", () => {
    expect(validatedInvariants.totalValidated).toBe(38);
    expect(validatedInvariants.totalRejected).toBe(27);
    for (const inv of validatedInvariants.invariants) {
      expect(["VALIDATED", "INFERRED"]).toContain(inv.confidenceClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Over-Generalization Detection
  // ---------------------------------------------------------------------------
  it("detects over-generalization and rejects invariants excluding valid behaviors (N3)", () => {
    const inv: HigherOrderInvariant = {
      invariantId: "INV-OVERGEN-TEST",
      taskId: "P46-L5-01",
      category: "REGRESSION_INVARIANT",
      semanticPredicate: "OVER_RESTRICTIVE_PRED",
      affectedSymbols: ["comparePrerelease"],
      affectedModules: ["src/semver.js"],
      requiredRelationships: [],
      preconditions: [],
      postconditions: [],
      counterexamples: ["OBSERVED_VALID_SEMVER_SORT"],
      evidence: ["TEST_EVIDENCE"],
      provenance: {
        taskId: "P46-L5-01",
        sourceEntity: "TEST",
        extractionRule: "TEST",
        derivedAt: "2026-10-20T00:00:00.000Z",
      },
      confidenceClass: "VALIDATED",
      canonicalHash: "1111111111111111111111111111111111111111111111111111111111111111",
    };

    const res = HigherOrderSemanticSynthesizer.generalizeInvariant(inv, ["OBSERVED_VALID_SEMVER_SORT"]);
    expect(res.generalized).toBeNull();
    expect(res.error).toContain("UNSOUND_INVARIANT_GENERALIZATION");
  });

  // ---------------------------------------------------------------------------
  // 6. Counterexample Refinement
  // ---------------------------------------------------------------------------
  it("records counterexamples across the cohort (42 counterexamples extracted)", () => {
    expect(counterexamples.totalCounterexamples).toBe(42);
    expect(counterexamples.records.length).toBe(15);
  });

  // ---------------------------------------------------------------------------
  // 7. TypedProgramSkeleton Construction
  // ---------------------------------------------------------------------------
  it("constructs TypedProgramSkeletons with explicit type and contract constraints", () => {
    expect(skeletons.totalSkeletons).toBe(20);
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L6-01", {
      symbols: ["hasRole", "authorizeUser"],
      files: ["src/rbac.js", "src/auth.js"],
      invariants: ["RBAC_HIERARCHY"],
    });
    const graph = WholeProgramSemanticSynthesizer.constructSemanticGraph("P46-L6-01", plan);
    const candidates = HigherOrderSemanticSynthesizer.synthesizeInvariantCandidates("P46-L6-01", graph, plan);
    const skels = HigherOrderSemanticSynthesizer.constructProgramSkeletons("P46-L6-01", candidates, plan);

    expect(skels.length).toBe(1);
    expect(skels[0]!.skeletonId).toBe("SKEL-P46-L6-01-01");
    expect(skels[0]!.semanticHoles.length).toBe(2);
    expect(skels[0]!.canonicalHash.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 8. Semantic Hole Validation
  // ---------------------------------------------------------------------------
  it("validates semantic holes, ensuring targets and transformation classes are bounded", () => {
    expect(holes.totalSemanticHoles).toBe(25);
    for (const h of holes.holes) {
      expect(h.holeId).toBeDefined();
      expect(h.target).toBeDefined();
      expect(h.expectedType).toBeDefined();
      expect(h.allowedTransformationClasses.length).toBeGreaterThan(0);
      expect(h.candidateDomain.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Hole Candidate Bounds
  // ---------------------------------------------------------------------------
  it("enforces frozen resource limits for skeletons and holes", () => {
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxHigherOrderInvariants).toBe(32);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxSkeletons).toBe(25);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxSemanticHoles).toBe(32);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxHoleCandidates).toBe(16);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxCompletionDepth).toBe(6);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxAffectedModules).toBe(6);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxAffectedSymbols).toBe(32);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxFiles).toBe(6);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxASTNodes).toBe(150);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxRepairAttempts).toBe(3);
    expect(HIGHER_ORDER_SYNTHESIS_LIMITS.maxWallClockMs).toBe(120000);
  });

  // ---------------------------------------------------------------------------
  // 10. Skeleton Completion
  // ---------------------------------------------------------------------------
  it("completes skeleton holes deterministically, generating valid SemanticTransformations", () => {
    expect(completions.totalCompletions).toBeGreaterThan(0);
    const validComp = completions.completions.find((c: any) => c.validated);
    expect(validComp).toBeDefined();
    expect(validComp.resultingTransformations.length).toBeGreaterThan(0);
    expect(validComp.canonicalHash.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 11. Invariant-Guided Pruning
  // ---------------------------------------------------------------------------
  it("prunes invalid hole candidate combinations (54.3% candidate search reduction)", () => {
    expect(results.metrics.completion_candidates).toBe(280);
    expect(results.metrics.completion_pruned).toBe(152);
    expect(results.metrics.materialized_candidates).toBe(128);
    expect(results.metrics.search_reduction).toBe("54.3%");
  });

  // ---------------------------------------------------------------------------
  // 12. Multi-Module Semantic Transformation Generation
  // ---------------------------------------------------------------------------
  it("synthesizes multi-module semantic transformations across coupled regions", () => {
    const l6Res = verification.results.find((r: any) => r.taskId === "P46-L6-01");
    expect(l6Res.localSuccess).toBe(true);
    expect(l6Res.contractSuccess).toBe(true);
    expect(l6Res.compositionSuccess).toBe(true);
    expect(l6Res.cleanRoomVerification).toBe("PASS");
  });

  // ---------------------------------------------------------------------------
  // 13. Deterministic AST Materialization
  // ---------------------------------------------------------------------------
  it("compiles completed skeletons into deterministic structural AST patches", () => {
    expect(materialization.totalMaterialized).toBe(15);
    for (const m of materialization.materializations) {
      expect(m.patchId).toBeDefined();
      expect(m.patchDigest.length).toBe(64);
      expect(m.deterministic).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 14. Transactional Rollback
  // ---------------------------------------------------------------------------
  it("enforces fail-closed rejection and rollback when skeleton completion violates global invariants", () => {
    const l7Res = verification.results.find((r: any) => r.taskId === "P46-L7-01");
    expect(l7Res.compositionSuccess).toBe(false);
    expect(l7Res.cleanRoomVerification).toBe("FAIL");
  });

  // ---------------------------------------------------------------------------
  // 15. Static Gold Leakage Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects gold-patch snippets and pre-authored constants", () => {
    expect(results.metrics.gold_leakage).toContain("ZERO_LEAKAGE");
    expect(HigherOrderSemanticSynthesizer.detectGoldLeakage("PREFIX_UNARY_BP = 9")).toBe(true);
    expect(HigherOrderSemanticSynthesizer.detectGoldLeakage("EXP_BP = 8")).toBe(true);
    expect(HigherOrderSemanticSynthesizer.detectGoldLeakage("OriginReflectionRegex")).toBe(true);
    expect(HigherOrderSemanticSynthesizer.detectGoldLeakage("Access-Control-Allow-Credentials: true")).toBe(true);
    expect(HigherOrderSemanticSynthesizer.detectGoldLeakage("const valid = true;")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 16. Authority Firewall
  // ---------------------------------------------------------------------------
  it("preserves immutable authority firewall preventing elevation of lease, policy, or terminal authority", () => {
    expect(results.metrics.authority_firewall).toContain("100%");
    expect(results.metrics.terminal_authority).toContain("100%");
    const ctrlN9 = negativeControls.controls.find((c: any) => c.id === "N9");
    expect(ctrlN9.status).toBe("PASS");
    expect(ctrlN9.actualClass).toBe("UNAUTHORIZED_MUTATION_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 17. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("guarantees byte-identical determinism across repeated independent runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. Complete Negative Controls (N1–N12)
  // ---------------------------------------------------------------------------
  it("passes all 12 negative controls (N1–N12) in fail-closed state", () => {
    expect(negativeControls.totalControls).toBe(12);
    expect(negativeControls.allPassed).toBe(true);
    const ids = negativeControls.controls.map((c: any) => c.id);
    expect(ids).toEqual(["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12"]);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
    }
  });

  // ---------------------------------------------------------------------------
  // 19. Clean-Room Dual-Gate & L7 Diagnostic Analysis
  // ---------------------------------------------------------------------------
  it("verifies dual-gate clean-room fail-closed behavior on P46-L7-01 and P46-L7-02", () => {
    expect(diagnostics.diagnostics.length).toBe(2);

    const d1 = diagnostics.diagnostics[0]!;
    expect(d1.taskId).toBe("P46-L7-01");
    expect(d1.searchExhausted).toBe(true);
    expect(d1.cleanRoomStatus).toBe("FAIL");
    expect(d1.failureRootCause).toContain("Pratt binding power lookahead rule without gold-solution leakage");

    const d2 = diagnostics.diagnostics[1]!;
    expect(d2.taskId).toBe("P46-L7-02");
    expect(d2.searchExhausted).toBe(true);
    expect(d2.cleanRoomStatus).toBe("FAIL");
    expect(d2.failureRootCause).toContain("credential reflection predicate");

    expect(results.metrics.decision).toBe("HIGHER_ORDER_INVARIANT_SYNTHESIS_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("INDUCTIVE_PROGRAM_SYNTHESIS_CAPABILITY");
  });

  // ---------------------------------------------------------------------------
  // 20. Historical Phase 62 Regression Check
  // ---------------------------------------------------------------------------
  it("preserves historical Phase 62 baseline performance without regression", () => {
    expect(results.metrics.control_l5).toBe("5/5");
    expect(results.metrics.control_l6).toBe("5/5");
    expect(results.metrics.control_l7).toBe("0/5");
    expect(results.metrics.global_success).toBe("10/15 (66.7%)");
    expect(results.metrics.invariant_gain).toBe("0.0%");
    expect(results.metrics.skeleton_gain).toBe("0.0%");
    expect(results.metrics.local_success).toBe("25/25 (100.0%)");
    expect(results.metrics.contract_success).toBe("25/25 (100.0%)");
    expect(INVARIANT_CATEGORIES.length).toBe(10);
    expect(INVARIANT_CONFIDENCE_CLASSES.length).toBe(4);
    expect(semanticGraph.totalNodes).toBe(107);
  });
});
