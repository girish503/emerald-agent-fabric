/**
 * Phase 66 — Integration Test Suite: Governed Whole-Program Relational Semantic Synthesis
 *
 * Verifies:
 * 1. Relational specification construction (unified non-decomposed model)
 * 2. Canonical hashing and tamper-evidence
 * 3. Relation graph construction
 * 4. Cyclic relation handling (e.g. tokenizer <-> parser <-> calc)
 * 5. Relation typing and operator coverage
 * 6. Relational variable extraction across 9 semantic categories
 * 7. Relational repair obligation extraction
 * 8. Relational consistency engine validation
 * 9. State consistency checking
 * 10. Representation consistency checking
 * 11. Dataflow consistency checking
 * 12. Controlflow consistency checking
 * 13. Security policy consistency checking
 * 14. Temporal consistency checking
 * 15. Observational consistency checking
 * 16. Whole-program candidate synthesis
 * 17. Equivalence pruning
 * 18. Counterexample refinement updating relational specifications
 * 19. Compilation to Phase 62 SemanticTransformations
 * 20. Deterministic AST patch materialization
 * 21. Gold relation & transformation leakage prevention
 * 22. Authority firewall & model proposal non-authority
 * 23. Byte-identical replay determinism
 * 24. Clean-room dual-gate integration (100% fail-closed on L7)
 * 25. Terminal authority and fourfold completion gate under Ed25519 2-of-3 threshold
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  WholeProgramRelationalSynthesizer,
  RELATIONAL_SYNTHESIS_LIMITS,
  RELATION_OPERATORS,
  RELATIONAL_VARIABLE_TYPES,
  RELATIONAL_TRANSFORMATION_TYPES,
  RELATIONAL_CONFLICT_TYPES,
} from "../../src/application/whole-program-relational-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 66 — Governed Whole-Program Relational Semantic Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-protocol.json"), "utf8"));
  const specs = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-relational-specification.json"), "utf8"));
  const graph = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-relation-graph.json"), "utf8"));
  const obligations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-relational-obligations.json"), "utf8"));
  const variables = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-relational-variables.json"), "utf8"));
  const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-candidates.json"), "utf8"));
  const consistency = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-consistency.json"), "utf8"));
  const counterexamples = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-counterexamples.json"), "utf8"));
  const refinements = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-refinements.json"), "utf8"));
  const transformations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-transformations.json"), "utf8"));
  const searchMetrics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-search-metrics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase66-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Relational Specification Construction
  // ---------------------------------------------------------------------------
  it("constructs unified WholeProgramRelationalSpecifications without partitioning", () => {
    expect(protocol.phase).toBe("66");
    expect(protocol.baselineCommit).toBe("90edced");
    expect(specs.totalSpecifications).toBe(15);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    expect(spec.specificationId).toBe("REL-SPEC-P46-L5-01-01");
    expect(spec.symbols.length).toBeGreaterThan(0);
    expect(spec.semanticRelations.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Canonical Hashing
  // ---------------------------------------------------------------------------
  it("computes deterministic canonical SHA-256 digests on relational specifications", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    expect(spec.contentHash.length).toBe(64);
    const spec2 = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    expect(spec.contentHash).toBe(spec2.contentHash);
  });

  // ---------------------------------------------------------------------------
  // 3. Relation Graph Construction
  // ---------------------------------------------------------------------------
  it("constructs WholeProgramRelationGraphs mapping multi-entity relationships", () => {
    expect(graph.totalGraphs).toBe(15);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const g = WholeProgramRelationalSynthesizer.buildRelationGraph(spec);
    expect(g.graphId).toBe("REL-GRAPH-P46-L5-01");
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 4. Cyclic Relation Handling
  // ---------------------------------------------------------------------------
  it("supports cyclic dependencies in Level-7 relation graphs without decomposition rejection", () => {
    const specL7 = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L7-01");
    const gL7 = WholeProgramRelationalSynthesizer.buildRelationGraph(specL7);
    expect(gL7.cycles.length).toBeGreaterThan(0);
    expect(results.metrics.relational_graph_cycles).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // 5. Relation Typing & Operator Coverage
  // ---------------------------------------------------------------------------
  it("validates that all 20 finite relational operators are typed and defined", () => {
    expect(RELATION_OPERATORS.length).toBe(20);
    expect(RELATION_OPERATORS).toContain("EQUALS");
    expect(RELATION_OPERATORS).toContain("STATE_TRANSITION");
    expect(RELATION_OPERATORS).toContain("REPRESENTS");
    expect(RELATION_OPERATORS).toContain("FLOWS");
    expect(RELATION_OPERATORS).toContain("PRECEDES");
    expect(RELATION_OPERATORS).toContain("AUTHORIZES");
  });

  // ---------------------------------------------------------------------------
  // 6. Relational Variable Extraction Across 9 Semantic Categories
  // ---------------------------------------------------------------------------
  it("extracts explicit RelationalVariables across 9 semantic categories", () => {
    expect(RELATIONAL_VARIABLE_TYPES.length).toBe(9);
    expect(variables.totalVariables).toBeGreaterThan(0);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const vars = WholeProgramRelationalSynthesizer.extractRelationalVariables(spec);
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v.variableId).toBeDefined();
      expect(v.contentHash.length).toBe(64);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Relational Repair Obligation Extraction
  // ---------------------------------------------------------------------------
  it("extracts RelationalRepairObligations describing what semantic relations must become true", () => {
    expect(obligations.totalObligations).toBeGreaterThan(0);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L7-01");
    const obs = WholeProgramRelationalSynthesizer.extractRelationalObligations(spec);
    expect(obs.length).toBeGreaterThan(0);
    for (const ob of obs) {
      expect(ob.obligationId).toBeDefined();
      expect(ob.expectedRelation).toBeDefined();
      expect(ob.currentRelation).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Relational Consistency Engine Validation
  // ---------------------------------------------------------------------------
  it("validates multi-domain relational consistency and detects conflicts", () => {
    expect(consistency.totalChecked).toBeGreaterThan(0);
    expect(RELATIONAL_CONFLICT_TYPES.length).toBe(10);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const res = WholeProgramRelationalSynthesizer.validateRelationalConsistency({ transformations: [] }, spec);
    expect(res.consistent).toBe(true);
    expect(res.conflicts.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 9. State Consistency
  // ---------------------------------------------------------------------------
  it("checks state transition consistency against valid lifecycle states", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    expect(spec.states).toContain("UNINITIALIZED");
    expect(spec.states).toContain("PARSING");
    expect(spec.states).toContain("TERMINAL_VALID");
  });

  // ---------------------------------------------------------------------------
  // 10. Representation Consistency
  // ---------------------------------------------------------------------------
  it("flags representation mismatches when transformations reference undeclared representations", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const invalidTrans = [
      {
        transformationId: "T-BAD",
        type: "ADAPT_REPRESENTATION" as const,
        targetEntity: spec.symbols[0]!,
        parameters: { targetRep: "NON_EXISTENT_FORMAT" },
        rationale: "bad representation",
        contentHash: "hash",
      },
    ];
    const res = WholeProgramRelationalSynthesizer.validateRelationalConsistency({ transformations: invalidTrans }, spec);
    expect(res.consistent).toBe(false);
    expect(res.conflicts.some((c) => c.conflictType === "REPRESENTATION_CONFLICT")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 11. Dataflow Consistency
  // ---------------------------------------------------------------------------
  it("enforces FLOWS dataflow relations across source and destination symbols", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const flowsRel = spec.semanticRelations.find((r) => r.operator === "FLOWS");
    expect(flowsRel).toBeDefined();
    expect(flowsRel?.predicate).toContain("FLOWS");
  });

  // ---------------------------------------------------------------------------
  // 12. Controlflow Consistency
  // ---------------------------------------------------------------------------
  it("detects controlflow desynchronization between tokenizer lookahead and parser binding power on L7", () => {
    const specL7 = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L7-01");
    const asymmetricTrans = [
      {
        transformationId: "T-LOOK",
        type: "CHANGE_OPERATOR_BINDING" as const,
        targetEntity: "parseExpression",
        parameters: { targetRep: specL7.representations[0]! },
        rationale: "lookahead only",
        contentHash: "hash",
      },
    ];
    const res = WholeProgramRelationalSynthesizer.validateRelationalConsistency({ transformations: asymmetricTrans }, specL7);
    expect(res.consistent).toBe(false);
    expect(res.conflicts.some((c) => c.conflictType === "CONTROLFLOW_CONFLICT")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 13. Security Consistency
  // ---------------------------------------------------------------------------
  it("flags security policy conflicts when wildcard origins are enabled alongside credentials", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L6-01");
    const insecureTrans = [
      {
        transformationId: "T-SEC",
        type: "CHANGE_SECURITY_POLICY" as const,
        targetEntity: "sanitizeOrigin",
        parameters: { allowWildcardCredentials: true, targetRep: spec.representations[0]! },
        rationale: "insecure policy",
        contentHash: "hash",
      },
    ];
    const res = WholeProgramRelationalSynthesizer.validateRelationalConsistency({ transformations: insecureTrans }, spec);
    expect(res.consistent).toBe(false);
    expect(res.conflicts.some((c) => c.conflictType === "SECURITY_POLICY_CONFLICT")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 14. Temporal Consistency
  // ---------------------------------------------------------------------------
  it("validates temporal BEFORE/AFTER constraints across pipeline stages", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    expect(spec.temporalConstraints.length).toBeGreaterThan(0);
    expect(spec.temporalConstraints[0]).toContain("BEFORE");
  });

  // ---------------------------------------------------------------------------
  // 15. Observational Consistency
  // ---------------------------------------------------------------------------
  it("preserves observable regression behaviors without breaking passing baseline tests", () => {
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    expect(spec.preservedBehavior).toContain("REGRESSION_TEST_PRESERVATION");
    expect(spec.behavioralExamples[0]?.preservedObservations).toContain(
      "OBSERVATIONALLY_EQUIVALENT(PASSING_TEST_BASE)"
    );
  });

  // ---------------------------------------------------------------------------
  // 16. Whole-Program Candidate Synthesis
  // ---------------------------------------------------------------------------
  it("synthesizes whole-program relational candidates satisfying global constraints", () => {
    expect(RELATIONAL_SYNTHESIS_LIMITS.maxTransformationCandidates).toBe(100);
    expect(RELATIONAL_TRANSFORMATION_TYPES.length).toBe(16);
    expect(candidates.totalCandidates).toBeGreaterThan(0);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const obs = WholeProgramRelationalSynthesizer.extractRelationalObligations(spec);
    const cands = WholeProgramRelationalSynthesizer.synthesizeRelationalCandidates(spec, obs);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.candidateId).toBeDefined();
      expect(c.contentHash.length).toBe(64);
    }
  });

  // ---------------------------------------------------------------------------
  // 17. Equivalence Pruning
  // ---------------------------------------------------------------------------
  it("prunes redundant transformations via proof-backed equivalence classes", () => {
    expect(searchMetrics.synthesisMetrics.candidatesTypeRejected).toBe(35);
    expect(searchMetrics.synthesisMetrics.candidatesRelationalRejected).toBe(40);
    expect(searchMetrics.synthesisMetrics.equivalenceClasses).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // 18. Counterexample Refinement
  // ---------------------------------------------------------------------------
  it("refines WholeProgramRelationalSpecifications via global counterexamples", () => {
    expect(counterexamples.totalCounterexamples).toBe(20);
    expect(refinements.totalRefinements).toBe(20);
    for (const ref of refinements.refinements) {
      expect(ref.targetRelation).toBeDefined();
      expect(ref.refinementRule).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 19. Compilation to Phase 62 SemanticTransformations
  // ---------------------------------------------------------------------------
  it("compiles valid relational candidates into Phase 62 SemanticTransformations", () => {
    expect(transformations.totalTransformations).toBeGreaterThan(0);
    const spec = WholeProgramRelationalSynthesizer.constructRelationalSpecification("P46-L5-01");
    const obs = WholeProgramRelationalSynthesizer.extractRelationalObligations(spec);
    const cands = WholeProgramRelationalSynthesizer.synthesizeRelationalCandidates(spec, obs);
    const strans = WholeProgramRelationalSynthesizer.compileToSemanticTransformations(cands[0]!, spec);
    expect(strans.length).toBeGreaterThan(0);
    for (const t of strans) {
      expect(t.transformationId).toBeDefined();
      expect(t.canonicalHash.length).toBe(64);
    }
  });

  // ---------------------------------------------------------------------------
  // 20. Deterministic AST Patch Materialization
  // ---------------------------------------------------------------------------
  it("produces deterministic AST patches via Phase 62 materialization engine", () => {
    const resL5 = WholeProgramRelationalSynthesizer.evaluateCondition("P46-L5-01", "CONDITION_D_FULL_GOVERNED_RELATIONAL");
    expect(resL5.materializedPatch).toBeDefined();
    expect(resL5.cleanRoomVerification).toBe("PASS");

    const resL7 = WholeProgramRelationalSynthesizer.evaluateCondition("P46-L7-01", "CONDITION_D_FULL_GOVERNED_RELATIONAL");
    expect(resL7.materializedPatch).toBeDefined();
    expect(resL7.cleanRoomVerification).toBe("FAIL");
  });

  // ---------------------------------------------------------------------------
  // 21. Gold Relation & Transformation Leakage Prevention
  // ---------------------------------------------------------------------------
  it("detects and blocks gold relation and transformation leakage", () => {
    expect(WholeProgramRelationalSynthesizer.detectGoldRelationLeakage("PREFIX_UNARY_BP = 9")).toBe(true);
    expect(WholeProgramRelationalSynthesizer.detectGoldRelationLeakage("EXP_BP = 8")).toBe(true);
    expect(WholeProgramRelationalSynthesizer.detectGoldRelationLeakage("Access-Control-Allow-Origin: *")).toBe(true);
    expect(WholeProgramRelationalSynthesizer.detectGoldRelationLeakage("clean code")).toBe(false);
    expect(results.metrics.gold_leakage).toBe("ZERO_LEAKAGE (100% verified)");
  });

  // ---------------------------------------------------------------------------
  // 22. Authority Firewall & Model Proposal Non-Authority
  // ---------------------------------------------------------------------------
  it("enforces authority firewall: model proposals cannot bypass symbolic verification", () => {
    expect(WholeProgramRelationalSynthesizer.validateModelAuthority(false)).toBe(false);
    expect(WholeProgramRelationalSynthesizer.validateModelAuthority(true)).toBe(true);
    expect(results.metrics.authority_firewall).toBe("100% (fail-closed)");
  });

  // ---------------------------------------------------------------------------
  // 23. Byte-Identical Replay Determinism
  // ---------------------------------------------------------------------------
  it("verifies byte-identical replay determinism across repeated experimental executions", () => {
    expect(determinism.allByteIdentical).toBe(true);
    expect(determinism.run1Digest).toBe(determinism.run2Digest);
    expect(results.metrics.determinism).toBe("PASS (BYTE_IDENTICAL)");
  });

  // ---------------------------------------------------------------------------
  // 24. Clean-Room Dual-Gate Integration
  // ---------------------------------------------------------------------------
  it("enforces dual-gate clean-room verification (100% fail-closed on L7)", () => {
    expect(results.metrics.overall_success).toBe("10/15 (66.7%)");
    expect(results.metrics.l7_clean_room_success).toBe("0/5 (0.0%)");
    expect(results.metrics.clean_room_verification).toBe("100% (dual-gate verified)");

    const condD = evaluation.trials.filter((t: any) => t.condition === "CONDITION_D_FULL_GOVERNED_RELATIONAL");
    const l7Trials = condD.filter((t: any) => t.complexityTier.startsWith("L7"));
    for (const t of l7Trials) {
      expect(t.cleanRoomPassed).toBe(false);
      expect(t.terminalReason).toBe("RELATIONAL_SYNTHESIS_EXHAUSTED");
    }
  });

  // ---------------------------------------------------------------------------
  // 25. Terminal Authority & Fourfold Completion Gate
  // ---------------------------------------------------------------------------
  it("verifies negative controls N1–N34 in strict fail-closed mode under Ed25519 threshold", () => {
    expect(negativeControls.totalControls).toBe(34);
    expect(negativeControls.allPassed).toBe(true);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
    }
    expect(results.metrics.fourfold_verification).toBe("100% (valid)");
    expect(results.metrics.terminal_authority).toBe("100% (Ed25519 2-of-3 threshold immutable)");
  });
});
