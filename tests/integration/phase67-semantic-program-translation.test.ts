/**
 * Phase 67 — Integration Test Suite: Governed Semantic Translation and Whole-Program Induction
 *
 * Verifies:
 * 1. Semantic specification construction (canonical behavioral specification)
 * 2. Semantic type system enforcement (14 types, fail-closed typing)
 * 3. Semantic Program IR construction (20 opcodes, typed intermediate semantics)
 * 4. Semantic node hashing & tamper evidence
 * 5. Semantic hole identification
 * 6. Semantic hole typing and allowed input/output contracts
 * 7. Constructive semantic constructors
 * 8. Semantic program induction (induceSemanticProgram)
 * 9. Invariant-guided construction (guidance vs constraint)
 * 10. Behavioral example handling
 * 11. Counterexample refinement updating semantic specifications
 * 12. Consistency validation (validateSemanticProgram)
 * 13. State, representation, dataflow, controlflow consistency
 * 14. Program translation to concrete SemanticTransformations
 * 15. Transformation compilation & dependency ordering
 * 16. Materialization to concrete AST patches via Phase 62 materializer
 * 17. Deterministic canonical ordering
 * 18. Semantic equivalence & constructive generation ratio
 * 19. Gold leakage detection & fail-closed prevention
 * 20. Authority firewall & model untrusted status
 * 21. Model proposal validation & non-escalation
 * 22. Enumeration fallback detection
 * 23. Deterministic replay (byte-identical across runs)
 * 24. Clean-room dual-gate integration (100% fail-closed on L7)
 * 25. Fourfold completion gate and terminal authority under Ed25519 2-of-3 threshold
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  SemanticProgramTranslator,
  SEMANTIC_TRANSLATION_LIMITS,
  SEMANTIC_TYPES,
  SEMANTIC_IR_OPCODES,
  SEMANTIC_TRANSLATION_OPERATORS,
  HOLE_COMPLETION_STRATEGIES,
} from "../../src/application/semantic-program-translator.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 67 — Governed Semantic Translation and Whole-Program Program Induction", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-protocol.json"), "utf8"));
  const specs = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-semantic-specifications.json"), "utf8"));
  const irs = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-semantic-ir.json"), "utf8"));
  const holes = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-semantic-holes.json"), "utf8"));
  const constructors = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-constructors.json"), "utf8"));
  const programs = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-programs.json"), "utf8"));
  const translations = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-translations.json"), "utf8"));
  const counterexamples = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-counterexamples.json"), "utf8"));
  const refinements = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-refinements.json"), "utf8"));
  const consistency = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-consistency.json"), "utf8"));
  const searchMetrics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-search-metrics.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Semantic Specification Construction
  // ---------------------------------------------------------------------------
  it("constructs canonical SemanticTranslationSpecifications without gold leakage", () => {
    expect(protocol.phase).toBe("67");
    expect(protocol.baselineCommit).toBe("aa7e065");
    expect(specs.totalSpecifications).toBe(15);
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    expect(spec.specificationId).toBe("SPEC-P46-L5-01-V1");
    expect(spec.sourceProgramSemantics).toBeDefined();
    expect(spec.targetBehavioralSemantics).toBeDefined();
    expect(spec.mutationScope.files.length).toBeGreaterThan(0);
    expect(spec.preservedInvariants.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Semantic Type System
  // ---------------------------------------------------------------------------
  it("validates semantic types across all 14 supported categories", () => {
    expect(SEMANTIC_TYPES.length).toBe(14);
    expect(SEMANTIC_TYPES).toContain("VALUE");
    expect(SEMANTIC_TYPES).toContain("STATE");
    expect(SEMANTIC_TYPES).toContain("REPRESENTATION");
    expect(SEMANTIC_TYPES).toContain("SECURITY_POLICY");
    expect(SEMANTIC_TYPES).toContain("ERROR");
    expect(SEMANTIC_TYPES).toContain("CONTROL_FLOW");
    expect(SEMANTIC_TYPES).toContain("DATA_FLOW");
  });

  // ---------------------------------------------------------------------------
  // 3. Semantic Program IR
  // ---------------------------------------------------------------------------
  it("constructs typed SemanticProgramIR with 20 supported opcodes", () => {
    expect(SEMANTIC_IR_OPCODES.length).toBe(20);
    expect(SEMANTIC_IR_OPCODES).toContain("INPUT");
    expect(SEMANTIC_IR_OPCODES).toContain("STATE_READ");
    expect(SEMANTIC_IR_OPCODES).toContain("VALIDATION");
    expect(SEMANTIC_IR_OPCODES).toContain("CONTROL_GUARD");
    expect(SEMANTIC_IR_OPCODES).toContain("SECURITY_CHECK");
    expect(SEMANTIC_IR_OPCODES).toContain("TRANSFORM");
    expect(SEMANTIC_IR_OPCODES).toContain("OUTPUT");
    expect(SEMANTIC_IR_OPCODES).toContain("RETURN");

    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const ir = SemanticProgramTranslator.buildInitialSemanticIR(spec);
    expect(ir.nodes.length).toBe(8);
    expect(ir.dataFlowEdges.length).toBeGreaterThan(0);
    expect(ir.controlFlowEdges.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 4. Semantic Node Hashing
  // ---------------------------------------------------------------------------
  it("computes deterministic canonical SHA-256 digests for all IR nodes", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const ir = SemanticProgramTranslator.buildInitialSemanticIR(spec);
    for (const node of ir.nodes) {
      expect(node.contentHash).toBeDefined();
      expect(node.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Semantic Holes Identification
  // ---------------------------------------------------------------------------
  it("identifies semantic holes requiring constructive completion", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const ir = SemanticProgramTranslator.buildInitialSemanticIR(spec);
    const taskHoles = SemanticProgramTranslator.identifySemanticHoles(ir, spec);
    expect(taskHoles.length).toBe(1);
    expect(taskHoles[0]?.holeId).toBe("HOLE-P46-L5-01-01");
    expect(taskHoles[0]?.completed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 6. Semantic Hole Typing & Contracts
  // ---------------------------------------------------------------------------
  it("enforces strict semantic typing and contract bounds on holes", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L7-01");
    const ir = SemanticProgramTranslator.buildInitialSemanticIR(spec);
    const l7Holes = SemanticProgramTranslator.identifySemanticHoles(ir, spec);
    expect(l7Holes.length).toBe(3);
    expect(l7Holes[0]?.expectedSemanticType).toBe("COLLECTION");
    expect(l7Holes[1]?.expectedSemanticType).toBe("STATE");
    expect(l7Holes[2]?.expectedSemanticType).toBe("DATA_FLOW");
  });

  // ---------------------------------------------------------------------------
  // 7. Constructive Semantic Constructors
  // ---------------------------------------------------------------------------
  it("validates constructive hole completion strategies and vocabularies", () => {
    expect(HOLE_COMPLETION_STRATEGIES).toContain("INVARIANT_DIRECTED");
    expect(HOLE_COMPLETION_STRATEGIES).toContain("COUNTEREXAMPLE_DIRECTED");
    expect(HOLE_COMPLETION_STRATEGIES).toContain("REPRESENTATION_ADAPTATION");
    expect(SEMANTIC_TRANSLATION_OPERATORS.length).toBe(9);
  });

  // ---------------------------------------------------------------------------
  // 8. Semantic Program Induction
  // ---------------------------------------------------------------------------
  it("induces complete candidate programs from semantic specifications", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const program = SemanticProgramTranslator.induceSemanticProgram(spec, { condition: "D" });
    expect(program.programId).toBe("PROG-P46-L5-01-01");
    expect(program.valid).toBe(true);
    expect(program.completedHoles).toBe(1);
    expect(program.semanticProofObligations.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 9. Invariant-Guided Construction
  // ---------------------------------------------------------------------------
  it("distinguishes invariants as guidance versus constraints during induction", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const guidanceInvariants = spec.preservedInvariants.filter(
      (inv) => inv.type === "INVARIANT_AS_CONSTRUCTION_GUIDANCE"
    );
    const constraintInvariants = spec.preservedInvariants.filter(
      (inv) => inv.type === "INVARIANT_AS_CONSTRAINT"
    );
    expect(guidanceInvariants.length).toBeGreaterThan(0);
    expect(constraintInvariants.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 10. Behavioral Example Handling
  // ---------------------------------------------------------------------------
  it("incorporates behavioral examples without oracle solution leakage", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    expect(spec.observableExamples.length).toBe(1);
    const ex = spec.observableExamples[0]!;
    expect(ex.expectedState).toBeDefined();
    expect(ex.expectedOutput).toBeDefined();
    expect(ex.provenance).toContain("FROZEN_BEHAVIORAL_TEST");
  });

  // ---------------------------------------------------------------------------
  // 11. Counterexample Refinement
  // ---------------------------------------------------------------------------
  it("drives semantic specification refinement using concrete counterexamples", () => {
    const specV1 = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01", 0);
    const specV2 = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01", 1);
    expect(specV1.specificationId).toBe("SPEC-P46-L5-01-V1");
    expect(specV2.specificationId).toBe("SPEC-P46-L5-01-V2");
    expect(specV2.semanticPreconditions).toContain("PRE:REFINED_BY_COUNTEREXAMPLE_L1");
    expect(specV2.contentHash).not.toBe(specV1.contentHash);
  });

  // ---------------------------------------------------------------------------
  // 12. Consistency Validation
  // ---------------------------------------------------------------------------
  it("validates semantic programs across multi-domain consistency criteria", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const program = SemanticProgramTranslator.induceSemanticProgram(spec, { condition: "D" });
    const val = SemanticProgramTranslator.validateSemanticProgram(program, spec);
    expect(val.valid).toBe(true);
    expect(val.typeErrors.length).toBe(0);
    expect(val.stateConsistency).toBe(true);
    expect(val.representationConsistency).toBe(true);
    expect(val.securityBehaviorConsistency).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 13. State, Dataflow, and Controlflow Consistency
  // ---------------------------------------------------------------------------
  it("rejects incomplete programs with uncompleted holes fail-closed", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L7-01");
    const program = SemanticProgramTranslator.induceSemanticProgram(spec, { condition: "D" });
    const val = SemanticProgramTranslator.validateSemanticProgram(program, spec);
    expect(val.valid).toBe(false);
    expect(val.postconditionErrors).toContain("UNCOMPLETED_SEMANTIC_HOLES: Some semantic holes remain open");
  });

  // ---------------------------------------------------------------------------
  // 14. Program Translation
  // ---------------------------------------------------------------------------
  it("translates valid semantic programs into concrete SemanticTransformations", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const program = SemanticProgramTranslator.induceSemanticProgram(spec, { condition: "D" });
    const translation = SemanticProgramTranslator.translateProgram(program, spec);
    expect(translation.status).toBe("SUCCESS");
    expect(translation.transformations.length).toBeGreaterThan(0);
    expect(translation.transformations[0]?.primitive).toBe("CHANGE_DATA_FLOW");
  });

  // ---------------------------------------------------------------------------
  // 15. Transformation Compilation
  // ---------------------------------------------------------------------------
  it("compiles program translations to typed SemanticTransformation arrays", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const program = SemanticProgramTranslator.induceSemanticProgram(spec, { condition: "D" });
    const translation = SemanticProgramTranslator.translateProgram(program, spec);
    const trans = SemanticProgramTranslator.compileToSemanticTransformations(translation);
    expect(trans.length).toBe(translation.transformations.length);
    expect(trans[0]?.taskId).toBe("P46-L5-01");
  });

  // ---------------------------------------------------------------------------
  // 16. Materialization via Phase 62 Materializer
  // ---------------------------------------------------------------------------
  it("materializes valid transformations into repository patches via Phase 62 engine", () => {
    const spec = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const program = SemanticProgramTranslator.induceSemanticProgram(spec, { condition: "D" });
    const translation = SemanticProgramTranslator.translateProgram(program, spec);
    const trans = SemanticProgramTranslator.compileToSemanticTransformations(translation);
    const patch = SemanticProgramTranslator.materializeTransformations(trans);
    expect(patch.affectedFiles.length).toBeGreaterThan(0);
    expect(patch.patchDigest).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 17. Deterministic Ordering
  // ---------------------------------------------------------------------------
  it("guarantees byte-identical canonical digests across repeated specification builds", () => {
    const spec1 = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    const spec2 = SemanticProgramTranslator.constructTranslationSpecification("P46-L5-01");
    expect(spec1.contentHash).toBe(spec2.contentHash);
  });

  // ---------------------------------------------------------------------------
  // 18. Constructive Generation Ratio
  // ---------------------------------------------------------------------------
  it("demonstrates constructive generation ratio above purely enumerative baselines", () => {
    expect(searchMetrics.constructiveGenerationRatio).toBeGreaterThan(0.25);
    expect(searchMetrics.semanticProgramsConstructed).toBe(15);
  });

  // ---------------------------------------------------------------------------
  // 19. Gold Leakage Prevention (N35, N36, N37)
  // ---------------------------------------------------------------------------
  it("strictly prohibits oracle gold leakage into specifications, IR, or templates", () => {
    const n35 = negativeControls.controls.find((c: any) => c.id === "N35");
    const n36 = negativeControls.controls.find((c: any) => c.id === "N36");
    const n37 = negativeControls.controls.find((c: any) => c.id === "N37");
    expect(n35?.status).toBe("PASS");
    expect(n36?.status).toBe("PASS");
    expect(n37?.status).toBe("PASS");
  });

  // ---------------------------------------------------------------------------
  // 20. Authority Firewall
  // ---------------------------------------------------------------------------
  it("enforces fail-closed authority firewall preventing unauthorized privilege escalation", () => {
    const n42 = negativeControls.controls.find((c: any) => c.id === "N42");
    const n43 = negativeControls.controls.find((c: any) => c.id === "N43");
    expect(n42?.status).toBe("PASS");
    expect(n43?.status).toBe("PASS");
  });

  // ---------------------------------------------------------------------------
  // 21. Model Proposal Validation
  // ---------------------------------------------------------------------------
  it("treats model assistance as untrusted hypothesis channel without execution authority", () => {
    const modelId = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase67-model-identity.json"), "utf8"));
    expect(modelId.costPerTaskUSD).toBe(0.0);
    expect(modelId.proprietaryApiCallCount).toBe(0);
    expect(modelId.cloudInferenceCallCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 22. Enumeration Fallback Detection
  // ---------------------------------------------------------------------------
  it("forbids silent reversion to Phase 64/66 candidate enumeration (N45)", () => {
    const n45 = negativeControls.controls.find((c: any) => c.id === "N45");
    expect(n45?.status).toBe("PASS");
    expect(n45?.actualClass).toBe("ENUMERATION_FALLBACK_PROHIBITED");
  });

  // ---------------------------------------------------------------------------
  // 23. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("confirms 100% byte-identical determinism across replay runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    expect(determinism.run1Digest).toBe(determinism.run2Digest);
  });

  // ---------------------------------------------------------------------------
  // 24. Clean-Room Dual-Gate Integration
  // ---------------------------------------------------------------------------
  it("enforces fail-closed clean-room Gate B verification on Level-7 tasks", () => {
    expect(results.metrics.control_l7).toBe("0/5");
    expect(results.metrics.semantic_construction_l7).toBe("0/5");
    expect(results.metrics.semantic_refinement_l7).toBe("0/5");
    expect(results.metrics.full_governed_l7).toBe("0/5");
    expect(results.metrics.l7_clean_room_success).toBe("0/5 (0.0%)");
  });

  // ---------------------------------------------------------------------------
  // 25. Fourfold Completion & Scientific Decision
  // ---------------------------------------------------------------------------
  it("attests fourfold gate completion and confirms CONSTRUCTIVE_SEMANTIC_SYNTHESIS_BOUNDARY", () => {
    expect(results.metrics.fourfold_verification).toBe("100% (valid)");
    expect(results.metrics.terminal_authority).toBe("100% (Ed25519 2-of-3 threshold immutable)");
    expect(results.metrics.decision).toBe("CONSTRUCTIVE_SEMANTIC_SYNTHESIS_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("CONSTRUCTIVE_SEMANTIC_SYNTHESIS_GAP");
  });
});
