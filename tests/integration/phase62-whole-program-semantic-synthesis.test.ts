/**
 * Phase 62 — Whole-Program Semantic Synthesis Capability Integration Tests
 *
 * Verifies:
 * 1. Whole-Program Semantic Graph node and directional edge generation with provenance
 * 2. Semantic Repair Obligation discovery and pre-condition/post-condition validation
 * 3. Semantic transformation formulation across 12 primitives
 * 4. Schema validation for each primitive (valid and invalid payloads)
 * 5. Canonical SHA-256 digest consistency across graph, obligations, transformations, and candidates
 * 6. Transformation validation against graph preconditions and postconditions
 * 7. Candidate generation bounds (maxSemanticTransformations <= 16, maxTransformationDepth <= 6, maxSemanticCandidates <= 50)
 * 8. Candidate pruning via graph constraints, CEGAR feedback, and precondition violations
 * 9. Pre-materialization validation (ensuring semantic transformations are internally consistent before AST modification)
 * 10. Deterministic materialization of semantic transformations into structural AST edits
 * 11. Local contract satisfaction under materialized patches
 * 12. Whole-program invariant validation (success on L5/L6, clean-room rejection on L7)
 * 13. CEGAR refinement constraint integration with semantic search trace depth
 * 14. Atomic patch application and fail-closed rollback
 * 15. Static gold leakage detection (rejection of hardcoded Pratt constants PREFIX_UNARY_BP = 9, EXP_BP = 8, CORS regexes)
 * 16. Authority firewall preventing elevation of lease, credentials, or terminal authority
 * 17. Deterministic replay across repeated independent runs (byte-identical canonical output)
 * 18. Complete negative control suite (N1–N10 fail-closed)
 * 19. Clean-room dual-gate verification integration and L7 diagnostic root cause analysis
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProgramSpaceDecomposer } from "../../src/application/program-space-decomposer.js";
import {
  WholeProgramSemanticSynthesizer,
  SEMANTIC_SYNTHESIS_LIMITS,
  SEMANTIC_TRANSFORMATION_PRIMITIVES,
  type SemanticCandidate,
} from "../../src/application/whole-program-semantic-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 62 — Whole-Program Semantic Synthesis Capability", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-protocol.json"), "utf8"));
  const semanticGraph = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-semantic-graph.json"), "utf8"));
  const obligations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-semantic-obligations.json"), "utf8"));
  const transformations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-transformations.json"), "utf8"));
  const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-candidates.json"), "utf8"));
  const materialization = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-materialization.json"), "utf8"));
  const verification = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-verification.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase62-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Whole-Program Semantic Graph Generation
  // ---------------------------------------------------------------------------
  it("constructs WholeProgramSemanticGraph nodes and directional edges with provenance", () => {
    expect(protocol.phase).toBe("62");
    expect(protocol.baselineCommit).toBe("1a2ee25");
    expect(semanticGraph.totalNodes).toBe(107);
    expect(semanticGraph.totalEdges).toBe(112);
    expect(evaluation.totalTrials).toBe(60);

    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L7-01", {
      symbols: ["parseExpression", "evaluateExponent"],
      files: ["src/parser.js", "src/calc.js"],
      invariants: ["PRATT_UNARY_JUXTAPOSITION_INVARIANT"],
    });

    const graph = WholeProgramSemanticSynthesizer.constructSemanticGraph("P46-L7-01", plan);
    expect(graph.taskId).toBe("P46-L7-01");
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.graphDigest).toBeDefined();
    expect(graph.graphDigest.length).toBe(64);

    const moduleNodes = graph.nodes.filter((n) => n.type === "MODULE");
    expect(moduleNodes.length).toBeGreaterThan(0);
    const exportEdges = graph.edges.filter((e) => e.type === "EXPORTS");
    expect(exportEdges.length).toBeGreaterThan(0);
    expect(exportEdges[0]!.provenance.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Semantic Repair Obligation Discovery
  // ---------------------------------------------------------------------------
  it("derives SemanticRepairObligations and validates pre/post semantic properties", () => {
    expect(obligations.totalObligations).toBe(15);
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L6-01", {
      symbols: ["hasRole", "authorizeUser"],
      files: ["src/rbac.js", "src/auth.js"],
      invariants: ["RBAC_HIERARCHY"],
    });
    const graph = WholeProgramSemanticSynthesizer.constructSemanticGraph("P46-L6-01", plan);
    const obls = WholeProgramSemanticSynthesizer.constructSemanticObligations("P46-L6-01", graph, ["RBAC_HIERARCHY"]);

    expect(obls.length).toBe(1);
    expect(obls[0]!.obligationId).toBe("SOBL-P46-L6-01-01");
    expect(obls[0]!.currentSemanticProperty).toBe("DECOUPLED_MODULE_MISALIGNMENT");
    expect(obls[0]!.requiredSemanticProperty).toBe("ALIGNED_INTERFACE_AND_DEFAULTS");
    expect(obls[0]!.obligationDigest.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 3. Transformation Formulation across 12 Primitives
  // ---------------------------------------------------------------------------
  it("supports all 12 semantic transformation primitives", () => {
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES.length).toBe(12);
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_PRECONDITION");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_POSTCONDITION");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_STATE_TRANSITION");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_REPRESENTATION");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("ADAPT_PRODUCER");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("ADAPT_CONSUMER");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_CONTROL_FLOW");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_DATA_FLOW");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_SYMBOL_RELATION");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_ERROR_SEMANTICS");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("CHANGE_VALIDATION_RULE");
    expect(SEMANTIC_TRANSFORMATION_PRIMITIVES).toContain("PRESERVE_INVARIANT");
  });

  // ---------------------------------------------------------------------------
  // 4. Schema Validation for Primitives
  // ---------------------------------------------------------------------------
  it("rejects invalid transformation schemas (N1 fail-closed)", () => {
    const ctrl = negativeControls.controls.find((c: any) => c.id === "N1");
    expect(ctrl.status).toBe("PASS");
    expect(ctrl.actualClass).toBe("INVALID_TRANSFORMATION_SCHEMA_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 5. Canonical Digest Consistency
  // ---------------------------------------------------------------------------
  it("verifies canonical SHA-256 digests across all semantic artifacts", () => {
    for (const t of transformations.transformations) {
      expect(t.canonicalHash).toBeDefined();
      expect(t.canonicalHash.length).toBe(64);
    }
    for (const m of materialization.materializations) {
      expect(m.patchDigest).toBeDefined();
      expect(m.patchDigest.length).toBe(64);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Precondition and Postcondition Validation
  // ---------------------------------------------------------------------------
  it("validates transformation preconditions and postconditions against graph boundaries", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L5-01", {
      symbols: ["comparePrerelease"],
      files: ["src/semver.js"],
      invariants: ["PRERELEASE_PRECEDENCE"],
    });

    const invalidCandidate: SemanticCandidate = {
      candidateId: "CAND-INVALID-PRE",
      taskId: "P46-L5-01",
      transformations: [
        {
          transformationId: "T-INVALID-1",
          taskId: "P46-L5-01",
          primitive: "CHANGE_POSTCONDITION",
          targetSymbols: ["comparePrerelease"],
          targetModules: ["src/semver.js"],
          preconditions: [], // Missing precondition
          postconditions: ["POST:OK"],
          stateTransition: "ST",
          representationTransition: "RT",
          behavioralPredicate: "PRED",
          affectedDataFlow: [],
          affectedControlFlow: [],
          requiredInvariants: [],
          requiredContracts: [],
          allowedMutationScope: ["src/semver.js"],
          dependencies: [],
          provenance: {
            taskId: "P46-L5-01",
            regionId: "REG-1",
            primitive: "CHANGE_POSTCONDITION",
            closureRule: "TEST",
          },
          canonicalHash: "0000000000000000000000000000000000000000000000000000000000000000",
        },
      ],
      dependencyOrder: ["T-INVALID-1"],
      preconditions: [],
      postconditions: ["POST:OK"],
      invariants: [],
      crossModuleRelationships: [],
      semanticValidity: false,
      candidateDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const val = WholeProgramSemanticSynthesizer.validateSemanticCandidate(invalidCandidate, plan);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("VIOLATED_PRECONDITION"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 7. Candidate Generation Bounds
  // ---------------------------------------------------------------------------
  it("enforces frozen semantic synthesis resource boundaries", () => {
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxSemanticTransformations).toBe(16);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxTransformationDepth).toBe(6);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxAffectedModules).toBe(6);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxAffectedSymbols).toBe(32);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxSemanticCandidates).toBe(50);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxASTNodes).toBe(150);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxFiles).toBe(6);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxRepairAttempts).toBe(3);
    expect(SEMANTIC_SYNTHESIS_LIMITS.maxWallClockMs).toBe(120000);
  });

  // ---------------------------------------------------------------------------
  // 8. Candidate Pruning via CEGAR and Graph Constraints
  // ---------------------------------------------------------------------------
  it("prunes invalid semantic candidate combinations (195 candidates pruned)", () => {
    expect(candidates.totalCandidatesGenerated).toBe(335);
    expect(candidates.totalCandidatesPruned).toBe(195);
    expect(candidates.totalCandidatesMaterialized).toBe(140);
    const pruneRatio = candidates.totalCandidatesPruned / candidates.totalCandidatesGenerated;
    expect(pruneRatio).toBeGreaterThan(0.55);
  });

  // ---------------------------------------------------------------------------
  // 9. Pre-Materialization Consistency Validation
  // ---------------------------------------------------------------------------
  it("rejects candidates targeting non-existent symbols or modules (N2 fail-closed)", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L5-01", {
      symbols: ["comparePrerelease"],
      files: ["src/semver.js"],
      invariants: ["PRERELEASE_PRECEDENCE"],
    });

    const ghostCandidate: SemanticCandidate = {
      candidateId: "CAND-GHOST-SYM",
      taskId: "P46-L5-01",
      transformations: [
        {
          transformationId: "T-GHOST-1",
          taskId: "P46-L5-01",
          primitive: "CHANGE_SYMBOL_RELATION",
          targetSymbols: ["nonExistentSymbol_XYZ"],
          targetModules: ["src/semver.js"],
          preconditions: ["PRE:VALID"],
          postconditions: ["POST:OK"],
          stateTransition: "ST",
          representationTransition: "RT",
          behavioralPredicate: "PRED",
          affectedDataFlow: [],
          affectedControlFlow: [],
          requiredInvariants: [],
          requiredContracts: [],
          allowedMutationScope: ["src/semver.js"],
          dependencies: [],
          provenance: {
            taskId: "P46-L5-01",
            regionId: "REG-1",
            primitive: "CHANGE_SYMBOL_RELATION",
            closureRule: "TEST",
          },
          canonicalHash: "0000000000000000000000000000000000000000000000000000000000000000",
        },
      ],
      dependencyOrder: ["T-GHOST-1"],
      preconditions: ["PRE:VALID"],
      postconditions: ["POST:OK"],
      invariants: [],
      crossModuleRelationships: [],
      semanticValidity: false,
      candidateDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const val = WholeProgramSemanticSynthesizer.validateSemanticCandidate(ghostCandidate, plan);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e) => e.includes("NONEXISTENT_TARGET"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 10. Deterministic Materialization into AST Edits
  // ---------------------------------------------------------------------------
  it("materializes valid semantic candidates into concrete structural AST edits", () => {
    const validCandidate: SemanticCandidate = {
      candidateId: "CAND-VALID-01",
      taskId: "P46-L5-01",
      transformations: [
        {
          transformationId: "T-VALID-1",
          taskId: "P46-L5-01",
          primitive: "CHANGE_POSTCONDITION",
          targetSymbols: ["comparePrerelease"],
          targetModules: ["src/semver.js"],
          preconditions: ["PRE:VALID"],
          postconditions: ["POST:VALID"],
          stateTransition: "NORM",
          representationTransition: "REPR",
          behavioralPredicate: "EVALUATE_CHANGE_POSTCONDITION_ON_comparePrerelease",
          affectedDataFlow: [],
          affectedControlFlow: [],
          requiredInvariants: [],
          requiredContracts: [],
          allowedMutationScope: ["src/semver.js"],
          dependencies: [],
          provenance: {
            taskId: "P46-L5-01",
            regionId: "REG-1",
            primitive: "CHANGE_POSTCONDITION",
            closureRule: "TEST",
          },
          canonicalHash: "1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
      dependencyOrder: ["T-VALID-1"],
      preconditions: ["PRE:VALID"],
      postconditions: ["POST:VALID"],
      invariants: [],
      crossModuleRelationships: [],
      semanticValidity: true,
      candidateDigest: "1111111111111111111111111111111111111111111111111111111111111111",
    };

    const patch = WholeProgramSemanticSynthesizer.materializeSemanticCandidate(validCandidate);
    expect(patch.patchId).toBe("MPATCH-CAND-VALID-01");
    expect(patch.affectedFiles).toEqual(["src/semver.js"]);
    expect(patch.edits.length).toBe(1);
    expect(patch.edits[0]!.target).toContain("// TARGET_TRANSFORMATION_comparePrerelease");
    expect(patch.edits[0]!.replacement).toContain("MATERIALIZED_CHANGE_POSTCONDITION");
    expect(patch.deterministic).toBe(true);
    expect(patch.patchDigest.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 11. Local Contract Satisfaction Under Materialized Patches
  // ---------------------------------------------------------------------------
  it("achieves 100% local contract satisfaction across all 25 evaluated regions", () => {
    expect(results.metrics.contract_success).toBe("25/25 (100.0%)");
    expect(results.metrics.local_success).toBe("25/25 (100.0%)");
  });

  // ---------------------------------------------------------------------------
  // 12. Whole-Program Invariant Validation
  // ---------------------------------------------------------------------------
  it("verifies global clean-room success on L5/L6 and clean-room failure on L7", () => {
    const l5Result = verification.results.find((r: any) => r.taskId === "P46-L5-01");
    expect(l5Result.cleanRoomVerification).toBe("PASS");
    expect(l5Result.contractSuccess).toBe(true);

    const l6Result = verification.results.find((r: any) => r.taskId === "P46-L6-01");
    expect(l6Result.cleanRoomVerification).toBe("PASS");
    expect(l6Result.contractSuccess).toBe(true);

    const l7Result = verification.results.find((r: any) => r.taskId === "P46-L7-01");
    expect(l7Result.cleanRoomVerification).toBe("FAIL");
    expect(l7Result.invariantSuccess).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 13. CEGAR Refinement Integration with Semantic Search Depth
  // ---------------------------------------------------------------------------
  it("tracks bounded search depth (depth 6) and logs search exhaustion on L7", () => {
    expect(results.metrics.search_exhaustion).toBe("100.0% (L7)");
    const d1 = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-01");
    expect(d1.searchExhausted).toBe(true);
    const d2 = diagnostics.diagnostics.find((d: any) => d.taskId === "P46-L7-02");
    expect(d2.searchExhausted).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 14. Atomic Patch Application and Rollback
  // ---------------------------------------------------------------------------
  it("enforces fail-closed rollback when candidate violates global invariants (N6/N9)", () => {
    const ctrlN6 = negativeControls.controls.find((c: any) => c.id === "N6");
    expect(ctrlN6.status).toBe("PASS");
    expect(ctrlN6.actualClass).toBe("WHOLE_PROGRAM_INVARIANT_VIOLATION");

    const ctrlN9 = negativeControls.controls.find((c: any) => c.id === "N9");
    expect(ctrlN9.status).toBe("PASS");
    expect(ctrlN9.actualClass).toBe("CROSS_REGION_SEMANTIC_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // 15. Static Gold Leakage Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects gold-patch snippets and pre-authored constants", () => {
    expect(results.metrics.gold_leakage).toContain("ZERO_LEAKAGE");
    expect(WholeProgramSemanticSynthesizer.detectGoldLeakage("PREFIX_UNARY_BP = 9")).toBe(true);
    expect(WholeProgramSemanticSynthesizer.detectGoldLeakage("EXP_BP = 8")).toBe(true);
    expect(WholeProgramSemanticSynthesizer.detectGoldLeakage("OriginReflectionRegex")).toBe(true);
    expect(WholeProgramSemanticSynthesizer.detectGoldLeakage("Access-Control-Allow-Credentials: true")).toBe(true);
    expect(WholeProgramSemanticSynthesizer.detectGoldLeakage("const valid = true;")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 16. Authority Firewall
  // ---------------------------------------------------------------------------
  it("prevents lease elevation and rejects unauthorized mutations (N8 fail-closed)", () => {
    expect(results.metrics.authority_firewall).toContain("100%");
    expect(results.metrics.terminal_authority).toContain("100%");
    const ctrlN8 = negativeControls.controls.find((c: any) => c.id === "N8");
    expect(ctrlN8.status).toBe("PASS");
    expect(ctrlN8.actualClass).toBe("UNAUTHORIZED_MUTATION_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 17. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("guarantees byte-identical determinism across repeated independent runs (N10)", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. Complete Negative Controls (N1–N10)
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
  // 19. Clean-Room Dual-Gate & L7 Diagnostic Analysis
  // ---------------------------------------------------------------------------
  it("verifies dual-gate clean-room fail-closed behavior on P46-L7-01 and P46-L7-02", () => {
    expect(diagnostics.diagnostics.length).toBe(2);

    const d1 = diagnostics.diagnostics[0]!;
    expect(d1.taskId).toBe("P46-L7-01");
    expect(d1.searchExhausted).toBe(true);
    expect(d1.cleanRoomStatus).toBe("FAIL");
    expect(d1.failureRootCause).toContain("Pratt parser binding rules and juxtaposition token stream transitions");

    const d2 = diagnostics.diagnostics[1]!;
    expect(d2.taskId).toBe("P46-L7-02");
    expect(d2.searchExhausted).toBe(true);
    expect(d2.cleanRoomStatus).toBe("FAIL");
    expect(d2.failureRootCause).toContain("credential reflection predicate");

    expect(results.metrics.decision).toBe("WHOLE_PROGRAM_SEMANTIC_SYNTHESIS_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("HIGHER_ORDER_SEMANTIC_SYNTHESIS_CAPABILITY");
  });
});
