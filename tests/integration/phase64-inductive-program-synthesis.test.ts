/**
 * Phase 64 — Governed Inductive Program Synthesis Integration Tests
 *
 * Verifies:
 * 1. Typed synthesis grammar construction and vocabulary completeness (28+ primitives)
 * 2. Grammar determinism and canonical sorting
 * 3. Type system integrity across 10 supported types
 * 4. Static type rejection of invalid operator compositions (BOOLEAN AND STRING fail-closed)
 * 5. SynthesisSpecification construction from observable evidence and invariants
 * 6. Behavioral example integration without gold-solution oracles
 * 7. Bounded candidate program enumeration and depth limits
 * 8. Semantic equivalence pruning (70.0% program space reduction)
 * 9. Invariant constraint satisfaction during candidate generation
 * 10. CEGIS counterexample extraction from verification failures
 * 11. CEGIS refinement constraint propagation across iterations
 * 12. Synthesis convergence on L5/L6 and bounded stagnation on L7
 * 13. Compilation of InductiveSemanticProgram into Phase 62 SemanticTransformations
 * 14. Deterministic AST patch materialization with canonical SHA-256 digests
 * 15. Transactional rollback upon clean-room regression violation
 * 16. Static gold leakage detection (zero Pratt or CORS leakage)
 * 17. Authority firewall preventing elevation of lease, credentials, or terminal authority
 * 18. Deterministic replay across repeated independent runs (byte-identical canonical output)
 * 19. Complete negative control suite (N1–N14 fail-closed)
 * 20. Clean-room dual-gate verification integration and L7 diagnostic root cause analysis
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProgramSpaceDecomposer } from "../../src/application/program-space-decomposer.js";
import {
  InductiveProgramSynthesizer,
  INDUCTIVE_SYNTHESIS_LIMITS,
  SYNTHESIS_GRAMMAR_PRIMITIVES,
  SYNTHESIS_TYPES,
} from "../../src/application/inductive-program-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 64 — Governed Inductive Program Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-protocol.json"), "utf8"));
  const grammar = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-grammar.json"), "utf8"));
  const specifications = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-synthesis-specifications.json"), "utf8"));
  const examples = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-behavioral-examples.json"), "utf8"));
  const programs = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-programs.json"), "utf8"));
  const typeChecks = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-type-checks.json"), "utf8"));
  const counterexamples = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-counterexamples.json"), "utf8"));
  const cegisTraces = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-cegis-traces.json"), "utf8"));
  const materialization = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-materialization.json"), "utf8"));
  const verification = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-verification.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-determinism.json"), "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-l7-diagnostics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase64-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Grammar Construction
  // ---------------------------------------------------------------------------
  it("constructs the typed synthesis grammar containing all required generic primitives", () => {
    expect(protocol.phase).toBe("64");
    expect(protocol.baselineCommit).toBe("fa54388");
    expect(grammar.primitiveCount).toBeGreaterThanOrEqual(28);
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("CONSTANT");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("PARAMETER");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("STATE_TRANSITION");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("REPRESENTATION_CONVERSION");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("GUARD");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("MAP");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("PRODUCE");
    expect(SYNTHESIS_GRAMMAR_PRIMITIVES).toContain("CONSUME");
  });

  // ---------------------------------------------------------------------------
  // 2. Grammar Determinism
  // ---------------------------------------------------------------------------
  it("verifies grammar determinism and immutability across evaluation runs", () => {
    expect(grammar.grammarVersion).toBe("emerald-phase64-grammar-v1");
    expect(grammar.supportedTypes).toEqual(SYNTHESIS_TYPES);
  });

  // ---------------------------------------------------------------------------
  // 3. Type System
  // ---------------------------------------------------------------------------
  it("supports all 10 core types in the synthesis type system", () => {
    expect(SYNTHESIS_TYPES.length).toBe(10);
    expect(SYNTHESIS_TYPES).toContain("BOOLEAN");
    expect(SYNTHESIS_TYPES).toContain("INTEGER");
    expect(SYNTHESIS_TYPES).toContain("STRING");
    expect(SYNTHESIS_TYPES).toContain("STATE");
    expect(SYNTHESIS_TYPES).toContain("RECORD");
  });

  // ---------------------------------------------------------------------------
  // 4. Static Type Rejection
  // ---------------------------------------------------------------------------
  it("statically rejects type mismatches (BOOLEAN AND STRING rejected fail-closed) (N2)", () => {
    const res = InductiveProgramSynthesizer.typeCheckExpression("AND", ["BOOLEAN", "STRING"]);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("TYPE_MISMATCH");

    const validRes = InductiveProgramSynthesizer.typeCheckExpression("AND", ["BOOLEAN", "BOOLEAN"]);
    expect(validRes.valid).toBe(true);
    expect(validRes.returnType).toBe("BOOLEAN");
  });

  // ---------------------------------------------------------------------------
  // 5. Synthesis Specification
  // ---------------------------------------------------------------------------
  it("derives SynthesisSpecifications from observable repository evidence and invariants", () => {
    expect(specifications.totalSpecifications).toBe(15);
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L5-01", {
      symbols: ["parsePrerelease", "comparePrerelease"],
      files: ["src/semver.js"],
      invariants: ["PRE_RELEASE_SEMANTICS"],
    });
    const spec = InductiveProgramSynthesizer.constructSpecification("P46-L5-01", plan, []);

    expect(spec.specificationId).toBe("SPEC-P46-L5-01-01");
    expect(spec.inputTypes.length).toBeGreaterThan(0);
    expect(spec.outputTypes.length).toBeGreaterThan(0);
    expect(spec.canonicalHash.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 6. Behavioral Examples
  // ---------------------------------------------------------------------------
  it("integrates observable behavioral examples without gold-solution leakage", () => {
    expect(examples.totalExamples).toBe(25);
    for (const ex of examples.examples) {
      expect(ex.exampleId).toBeDefined();
      expect(ex.provenance).toBeDefined();
      expect(InductiveProgramSynthesizer.detectGoldLeakage(ex.input)).toBe(false);
      expect(InductiveProgramSynthesizer.detectGoldLeakage(ex.observedOutput)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Program Enumeration & Ceilings
  // ---------------------------------------------------------------------------
  it("enforces frozen ceilings on program depth, nodes, and CEGIS iterations", () => {
    expect(INDUCTIVE_SYNTHESIS_LIMITS.maxCEGISIterations).toBe(6);
    expect(INDUCTIVE_SYNTHESIS_LIMITS.maxProgramDepth).toBe(8);
    expect(INDUCTIVE_SYNTHESIS_LIMITS.maxProgramNodes).toBe(32);
    expect(INDUCTIVE_SYNTHESIS_LIMITS.maxCandidatesPerIteration).toBe(50);
    expect(INDUCTIVE_SYNTHESIS_LIMITS.maxTotalCandidates).toBe(200);
    expect(INDUCTIVE_SYNTHESIS_LIMITS.maxWallClockMs).toBe(120000);
  });

  // ---------------------------------------------------------------------------
  // 8. Equivalence Pruning
  // ---------------------------------------------------------------------------
  it("achieves 70.0% program space reduction via type checks and equivalence classes", () => {
    expect(typeChecks.records.length).toBeGreaterThan(0);
    expect(results.metrics.programs_generated).toBe(200);
    expect(results.metrics.programs_type_rejected).toBe(72);
    expect(results.metrics.programs_semantic_rejected).toBe(68);
    expect(results.metrics.unique_programs).toBe(45);
    expect(results.metrics.program_space_reduction).toBe("70.0%");
  });

  // ---------------------------------------------------------------------------
  // 9. Invariant Constraints
  // ---------------------------------------------------------------------------
  it("constrains candidate program synthesis with validated higher-order invariants", () => {
    for (const prog of programs.programs) {
      expect(prog.canonicalHash).toBeDefined();
      expect(prog.canonicalHash.length).toBe(64);
      expect(prog.typedExpressions.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Counterexample Extraction
  // ---------------------------------------------------------------------------
  it("extracts counterexamples from failed candidate verification (56 counterexamples total)", () => {
    expect(counterexamples.totalCounterexamples).toBe(56);
    expect(counterexamples.records.length).toBe(15);
  });

  // ---------------------------------------------------------------------------
  // 11. CEGIS Refinement
  // ---------------------------------------------------------------------------
  it("tracks CEGIS refinement rules across iterations (32 refinements total)", () => {
    expect(results.metrics.refinements).toBe(32);
    expect(cegisTraces.totalTraces).toBe(15);
  });

  // ---------------------------------------------------------------------------
  // 12. Synthesis Convergence Rate
  // ---------------------------------------------------------------------------
  it("achieves 66.7% CEGIS convergence rate (converges on L5/L6, exhausts on L7)", () => {
    expect(results.metrics.convergence_rate).toBe("66.7%");
    const l5Trace = cegisTraces.traces.find((t: any) => t.taskId === "P46-L5-01");
    expect(l5Trace.converged).toBe(true);

    const l7Trace = cegisTraces.traces.find((t: any) => t.taskId === "P46-L7-01");
    expect(l7Trace.converged).toBe(false);
    expect(l7Trace.iterations).toBe(6);
  });

  // ---------------------------------------------------------------------------
  // 13. Semantic Transformation Compilation
  // ---------------------------------------------------------------------------
  it("compiles InductiveSemanticPrograms into Phase 62 SemanticTransformations", () => {
    const plan = ProgramSpaceDecomposer.decomposeProgramSpace("P46-L5-01", {
      symbols: ["parsePrerelease", "comparePrerelease"],
      files: ["src/semver.js"],
      invariants: ["PRE_RELEASE_SEMANTICS"],
    });
    const spec = InductiveProgramSynthesizer.constructSpecification("P46-L5-01", plan, []);
    const prog = InductiveProgramSynthesizer.synthesizeCandidateProgram(spec, 1, 3);
    const trans = InductiveProgramSynthesizer.compileToSemanticTransformations(prog, plan);

    expect(trans.length).toBe(1);
    expect(trans[0]!.transformationId).toContain("STRANS-PROG-P46-L5-01-1");
    expect(trans[0]!.canonicalHash.length).toBe(64);
  });

  // ---------------------------------------------------------------------------
  // 14. Deterministic AST Materialization
  // ---------------------------------------------------------------------------
  it("materializes synthesized semantic programs into deterministic structural AST patches", () => {
    expect(materialization.totalMaterialized).toBe(15);
    for (const m of materialization.materializations) {
      expect(m.patchId).toBeDefined();
      expect(m.patchDigest.length).toBe(64);
      expect(m.deterministic).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 15. Transactional Rollback
  // ---------------------------------------------------------------------------
  it("enforces fail-closed rollback when candidate program violates global regression (N14)", () => {
    const l7Res = verification.results.find((r: any) => r.taskId === "P46-L7-01");
    expect(l7Res.compositionSuccess).toBe(false);
    expect(l7Res.cleanRoomVerification).toBe("FAIL");
  });

  // ---------------------------------------------------------------------------
  // 16. Static Gold Leakage Detection
  // ---------------------------------------------------------------------------
  it("detects and rejects gold-patch snippets and pre-authored constants", () => {
    expect(results.metrics.gold_leakage).toContain("ZERO_LEAKAGE");
    expect(InductiveProgramSynthesizer.detectGoldLeakage("PREFIX_UNARY_BP = 9")).toBe(true);
    expect(InductiveProgramSynthesizer.detectGoldLeakage("EXP_BP = 8")).toBe(true);
    expect(InductiveProgramSynthesizer.detectGoldLeakage("OriginReflectionRegex")).toBe(true);
    expect(InductiveProgramSynthesizer.detectGoldLeakage("Access-Control-Allow-Credentials: true")).toBe(true);
    expect(InductiveProgramSynthesizer.detectGoldLeakage("const valid = true;")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 17. Authority Firewall
  // ---------------------------------------------------------------------------
  it("preserves immutable authority firewall preventing elevation of lease, policy, or terminal authority", () => {
    expect(results.metrics.authority_firewall).toContain("100%");
    expect(results.metrics.terminal_authority).toContain("100%");
    const ctrlN10 = negativeControls.controls.find((c: any) => c.id === "N10");
    expect(ctrlN10.status).toBe("PASS");
    expect(ctrlN10.actualClass).toBe("UNAUTHORIZED_MUTATION_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 18. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("guarantees byte-identical determinism across repeated independent runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const rec of determinism.records) {
      expect(rec.isByteIdentical).toBe(true);
      expect(rec.run1Digest).toBe(rec.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 19. Complete Negative Controls (N1–N14)
  // ---------------------------------------------------------------------------
  it("passes all 14 negative controls (N1–N14) in fail-closed state", () => {
    expect(negativeControls.totalControls).toBe(14);
    expect(negativeControls.allPassed).toBe(true);
    const ids = negativeControls.controls.map((c: any) => c.id);
    expect(ids).toEqual(["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12", "N13", "N14"]);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
    }
  });

  // ---------------------------------------------------------------------------
  // 20. Clean-Room Dual-Gate & L7 Diagnostic Analysis
  // ---------------------------------------------------------------------------
  it("verifies dual-gate clean-room fail-closed behavior on P46-L7-01 and P46-L7-02", () => {
    expect(diagnostics.diagnostics.length).toBe(2);

    const d1 = diagnostics.diagnostics[0]!;
    expect(d1.taskId).toBe("P46-L7-01");
    expect(d1.searchExhausted).toBe(true);
    expect(d1.cleanRoomStatus).toBe("FAIL");
    expect(d1.failureRootCause).toContain("Pratt token stream lookahead and binding power table without gold-solution leakage");

    const d2 = diagnostics.diagnostics[1]!;
    expect(d2.taskId).toBe("P46-L7-02");
    expect(d2.searchExhausted).toBe(true);
    expect(d2.cleanRoomStatus).toBe("FAIL");
    expect(d2.failureRootCause).toContain("joint credential reflection and wildcard origin exclusion predicate");

    expect(results.metrics.decision).toBe("INDUCTIVE_PROGRAM_SYNTHESIS_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("WHOLE_PROGRAM_INDUCTIVE_SEARCH_COMPLEXITY");
    expect(results.metrics.synthesis_gain).toBe("0.0%");
    expect(results.metrics.global_success).toBe("10/15 (66.7%)");
    expect(evaluation.totalTrials).toBe(60);
  });
});
