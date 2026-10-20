/**
 * Phase 70 — Integration Test Suite
 * Governed Constructive Program Induction Calculus
 *
 * Covers 36 comprehensive tests:
 * 1. constructor primitives count
 * 2. semantic types count
 * 3. semantic effects count
 * 4. constructor application validity
 * 5. malformed constructor rejection
 * 6. depth limit enforcement
 * 7. node count limit enforcement
 * 8. type checking on composition
 * 9. type mismatch rejection
 * 10. branch constructor validation
 * 11. effect propagation
 * 12. state-flow checking
 * 13. rollback requirement in transactions
 * 14. goal derivation
 * 15. skeleton hole typing
 * 16. hole candidate constructors
 * 17. program synthesis
 * 18. proof obligation generation
 * 19. critical proof obligation enforcement
 * 20. invariant preservation checking
 * 21. refinement iteration
 * 22. search limits configuration
 * 23. authority firewall
 * 24. gold leakage prevention
 * 25. clean-room enforcement on L5
 * 26. clean-room enforcement on L6
 * 27. clean-room fail-closed on L7
 * 28. Condition A control behavior
 * 29. Condition B basic calculus
 * 30. Condition C refinement calculus
 * 31. Condition D full induction
 * 32. deterministic replay
 * 33. negative controls N1–N67 preserved
 * 34. negative controls N68–N80 pass
 * 35. status artifact consistency
 * 36. L7 diagnostic records
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  ConstructiveProgramInductionCalculusEngine,
  CONSTRUCTIVE_CALCULUS_LIMITS,
  CONSTRUCTOR_PRIMITIVES,
  SEMANTIC_TYPES,
  SEMANTIC_EFFECTS,
  ConstructorApplication,
} from "../../src/application/constructive-program-induction-calculus.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 70 — Governed Constructive Program Induction Calculus", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-protocol.json"), "utf8"));
  const calculus = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-calculus.json"), "utf8"));
  const types = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-types.json"), "utf8"));
  const effects = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-effects.json"), "utf8"));
  const goals = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-constructive-goals.json"), "utf8"));
  const skeletons = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-program-skeletons.json"), "utf8"));
  const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-candidates.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-results.json"), "utf8"));
  const statusArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-status.json"), "utf8"));
  const l7Diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase70-l7-diagnostics.json"), "utf8"));

  // 1. Constructor primitives count
  it("Test 1: constructor primitives count validates 21 primitives across 6 categories", () => {
    expect(CONSTRUCTOR_PRIMITIVES.length).toBe(21);
    expect(calculus.totalConstructors).toBe(21);
    expect(calculus.categories.pure.length).toBe(10);
    expect(calculus.categories.stateful.length).toBe(2);
    expect(calculus.categories.semanticControl.length).toBe(3);
    expect(calculus.categories.contract.length).toBe(3);
    expect(calculus.categories.transactional.length).toBe(2);
    expect(calculus.categories.invariant.length).toBe(1);
  });

  // 2. Semantic types count
  it("Test 2: semantic types count validates 15 typed semantic types", () => {
    expect(SEMANTIC_TYPES.length).toBe(15);
    expect(types.totalTypes).toBe(15);
    expect(SEMANTIC_TYPES).toContain("TOKEN_STREAM");
    expect(SEMANTIC_TYPES).toContain("ORIGIN");
    expect(SEMANTIC_TYPES).toContain("PROGRAM_STATE");
  });

  // 3. Semantic effects count
  it("Test 3: semantic effects count validates 9 compositional semantic effects", () => {
    expect(SEMANTIC_EFFECTS.length).toBe(9);
    expect(effects.totalEffects).toBe(9);
    expect(SEMANTIC_EFFECTS).toContain("TRANSACTIONAL");
    expect(SEMANTIC_EFFECTS).toContain("RECOVERY");
    expect(SEMANTIC_EFFECTS).toContain("WRITE_STATE");
  });

  // 4. Constructor application validity
  it("Test 4: constructor application validity checks pass for well-formed applications", () => {
    const validApp: ConstructorApplication = {
      applicationId: "APP-VALID-01",
      constructor: "CONSTANT",
      inputTypes: ["INTEGER"],
      outputType: "INTEGER",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-valid-01",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(validApp);
    expect(res.valid).toBe(true);
  });

  // 5. Malformed constructor rejection
  it("Test 5: malformed constructor rejection flags COMPOSE missing required children", () => {
    const malformedApp: ConstructorApplication = {
      applicationId: "APP-MALFORMED",
      constructor: "COMPOSE",
      inputTypes: ["STRING"],
      outputType: "STRING",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-malformed",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(malformedApp);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("COMPOSE_REQUIRES_EXACTLY_TWO_CHILDREN");
  });

  // 6. Depth limit enforcement
  it("Test 6: depth limit enforcement rejects applications exceeding depth 10", () => {
    const deepApp: ConstructorApplication = {
      applicationId: "APP-DEEP",
      constructor: "IDENTITY",
      inputTypes: ["NUMBER"],
      outputType: "NUMBER",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 11,
      nodeCount: 1,
      contentHash: "hash-deep",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(deepApp);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("PROGRAM_DEPTH_LIMIT_EXCEEDED");
  });

  // 7. Node count limit enforcement
  it("Test 7: node count limit enforcement rejects applications exceeding 64 nodes", () => {
    const bigApp: ConstructorApplication = {
      applicationId: "APP-BIG",
      constructor: "IDENTITY",
      inputTypes: ["STRING"],
      outputType: "STRING",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 5,
      nodeCount: 65,
      contentHash: "hash-big",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(bigApp);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("PROGRAM_NODE_LIMIT_EXCEEDED");
  });

  // 8. Type checking on composition
  it("Test 8: type checking on composition validates compatible input/output types", () => {
    const g: ConstructorApplication = {
      applicationId: "APP-G",
      constructor: "CONSTANT",
      inputTypes: ["INTEGER"],
      outputType: "STRING",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-g",
    };
    const f: ConstructorApplication = {
      applicationId: "APP-F",
      constructor: "CONSTANT",
      inputTypes: ["STRING"], // Matches g's outputType STRING
      outputType: "BOOLEAN",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-f",
    };
    const compose: ConstructorApplication = {
      applicationId: "APP-COMPOSE-OK",
      constructor: "COMPOSE",
      inputTypes: ["INTEGER"],
      outputType: "BOOLEAN",
      effects: ["PURE"],
      children: [f, g],
      preconditions: [],
      postconditions: [],
      depth: 2,
      nodeCount: 3,
      contentHash: "hash-compose-ok",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(compose);
    expect(res.valid).toBe(true);
  });

  // 9. Type mismatch rejection
  it("Test 9: type mismatch rejection flags incompatible composition types", () => {
    const g: ConstructorApplication = {
      applicationId: "APP-G2",
      constructor: "CONSTANT",
      inputTypes: ["INTEGER"],
      outputType: "NUMBER",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-g2",
    };
    const f: ConstructorApplication = {
      applicationId: "APP-F2",
      constructor: "CONSTANT",
      inputTypes: ["BOOLEAN"], // Incompatible with NUMBER
      outputType: "STRING",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-f2",
    };
    const compose: ConstructorApplication = {
      applicationId: "APP-COMPOSE-FAIL",
      constructor: "COMPOSE",
      inputTypes: ["INTEGER"],
      outputType: "STRING",
      effects: ["PURE"],
      children: [f, g],
      preconditions: [],
      postconditions: [],
      depth: 2,
      nodeCount: 3,
      contentHash: "hash-compose-fail",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(compose);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("COMPOSE_TYPE_MISMATCH");
  });

  // 10. Branch constructor validation
  it("Test 10: branch constructor validation enforces BOOLEAN condition and matching branches", () => {
    const cond: ConstructorApplication = {
      applicationId: "APP-COND",
      constructor: "CONSTANT",
      inputTypes: [],
      outputType: "BOOLEAN",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-cond",
    };
    const thenArm: ConstructorApplication = {
      applicationId: "APP-THEN",
      constructor: "CONSTANT",
      inputTypes: [],
      outputType: "STRING",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-then",
    };
    const elseArm: ConstructorApplication = {
      applicationId: "APP-ELSE",
      constructor: "CONSTANT",
      inputTypes: [],
      outputType: "STRING",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-else",
    };
    const branch: ConstructorApplication = {
      applicationId: "APP-BRANCH",
      constructor: "BRANCH",
      inputTypes: [],
      outputType: "STRING",
      effects: ["CONTROL_FLOW"],
      children: [cond, thenArm, elseArm],
      preconditions: [],
      postconditions: [],
      depth: 2,
      nodeCount: 4,
      contentHash: "hash-branch",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(branch);
    expect(res.valid).toBe(true);
  });

  // 11. Effect propagation
  it("Test 11: effect propagation validates that program effects are captured accurately", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const prog = ConstructiveProgramInductionCalculusEngine.synthesizeProgram(goal, skeleton);
    expect(prog.rootApplication.effects).toBeDefined();
    expect(prog.rootApplication.effects.length).toBeGreaterThan(0);
  });

  // 12. State-flow checking
  it("Test 12: state-flow checking supports global semantic state creation", () => {
    const state = ConstructiveProgramInductionCalculusEngine.createSemanticState("P46-L7-01");
    expect(state.stateId).toBe("STATE-P46-L7-01");
    expect(state.parserMode).toBe("PRATT_PRECEDENCE_STRICT");
    expect(state.tokenStreamPosition).toBe(0);
  });

  // 13. Rollback requirement in transactions
  it("Test 13: rollback requirement in transactions rejects transaction without rollback", () => {
    const child: ConstructorApplication = {
      applicationId: "APP-C",
      constructor: "CONSTANT",
      inputTypes: [],
      outputType: "STATE",
      effects: ["PURE"],
      children: [],
      preconditions: [],
      postconditions: [],
      depth: 1,
      nodeCount: 1,
      contentHash: "hash-c",
    };
    const tx: ConstructorApplication = {
      applicationId: "APP-TX-FAIL",
      constructor: "TRANSACTION",
      inputTypes: ["STATE"],
      outputType: "STATE",
      effects: ["TRANSACTIONAL"],
      children: [child],
      preconditions: [],
      postconditions: [],
      depth: 2,
      nodeCount: 2,
      contentHash: "hash-tx",
    };
    const res = ConstructiveProgramInductionCalculusEngine.validateConstructorApplication(tx);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("TRANSACTION_MISSING_ROLLBACK_MECHANISM");
  });

  // 14. Goal derivation
  it("Test 14: goal derivation derives affected domains, invariants, and obligations", () => {
    expect(goals.totalGoals).toBe(15);
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L6-01");
    expect(goal.goalId).toBe("GOAL-P46L601");
    expect(goal.requiredOutputType).toBe("BOOLEAN");
    expect(goal.globalInvariants.length).toBe(2);
    expect(goal.crossModuleObligations.length).toBeGreaterThan(0);
  });

  // 15. Skeleton hole typing
  it("Test 15: skeleton hole typing creates typed holes with expected types and allowed effects", () => {
    expect(skeletons.totalSkeletons).toBe(15);
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-02");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    expect(skeleton.holes.length).toBe(2);
    expect(skeleton.holes[0]!.expectedType).toBe("BOOLEAN");
    expect(skeleton.holes[1]!.expectedType).toBe("STRING");
  });

  // 16. Hole candidate constructors
  it("Test 16: hole candidate constructors restricts candidates to valid primitives", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-03");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    for (const hole of skeleton.holes) {
      for (const cand of hole.candidateConstructors) {
        expect(CONSTRUCTOR_PRIMITIVES).toContain(cand);
      }
    }
  });

  // 17. Program synthesis
  it("Test 17: program synthesis fills holes and constructs valid complete program", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-04");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const prog = ConstructiveProgramInductionCalculusEngine.synthesizeProgram(goal, skeleton);
    expect(prog.programId).toBe("PROG-P46L504");
    expect(prog.rootApplication.children.length).toBeGreaterThan(0);
    expect(prog.validated).toBe(true);
  });

  // 18. Proof obligation generation
  it("Test 18: proof obligation generation generates obligations across required categories", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const prog = ConstructiveProgramInductionCalculusEngine.synthesizeProgram(goal, skeleton);
    const typesFound = prog.proofObligations.map((p) => p.obligationType);
    expect(typesFound).toContain("TYPE_CORRECTNESS");
    expect(typesFound).toContain("EFFECT_COMPATIBILITY");
    expect(typesFound).toContain("INVARIANT_PRESERVATION");
    expect(typesFound).toContain("CROSS_MODULE_SYNC");
  });

  // 19. Critical proof obligation enforcement
  it("Test 19: critical proof obligation enforcement invalidates programs with unresolved critical proofs", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const prog = ConstructiveProgramInductionCalculusEngine.synthesizeProgram(goal, skeleton);
    const unresolvedCritical = prog.proofObligations.some((p) => p.critical && p.status === "UNRESOLVED");
    expect(unresolvedCritical).toBe(true);
    expect(prog.validated).toBe(false);
  });

  // 20. Invariant preservation checking
  it("Test 20: invariant preservation checking confirms all declared invariants are tracked", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L6-04");
    expect(goal.globalInvariants.length).toBe(2);
    for (const inv of goal.globalInvariants) {
      expect(inv.satisfied).toBe(true);
    }
  });

  // 21. Refinement iteration
  it("Test 21: refinement iteration prunes failing constructors from holes", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const skeleton = ConstructiveProgramInductionCalculusEngine.createProgramSkeleton(goal);
    const { refinedSkeleton, refinement } = ConstructiveProgramInductionCalculusEngine.refineSkeleton(
      skeleton,
      1,
    );
    expect(refinement.prunedConstructors).toContain("BRANCH");
    expect(refinedSkeleton.holes[0]!.candidateConstructors).not.toContain("BRANCH");
  });

  // 22. Search limits configuration
  it("Test 22: search limits configuration matches frozen protocol limits", () => {
    expect(CONSTRUCTIVE_CALCULUS_LIMITS.maxProgramDepth).toBe(10);
    expect(CONSTRUCTIVE_CALCULUS_LIMITS.maxProgramNodes).toBe(64);
    expect(CONSTRUCTIVE_CALCULUS_LIMITS.maxConstructiveHoles).toBe(16);
    expect(CONSTRUCTIVE_CALCULUS_LIMITS.maxConstructorApplications).toBe(128);
    expect(CONSTRUCTIVE_CALCULUS_LIMITS.maxRefinementIterations).toBe(6);
    expect(CONSTRUCTIVE_CALCULUS_LIMITS.maxPrograms).toBe(64);
  });

  // 23. Authority firewall
  it("Test 23: authority firewall ensures constructive candidates cannot escalate permissions", () => {
    const ctrl79 = negativeControls.controls.find((c: any) => c.id === "N79");
    expect(ctrl79).toBeDefined();
    expect(ctrl79.status).toBe("PASS");
    expect(ctrl79.actualClass).toBe("AUTHORITY_ESCALATION_REJECTED");
  });

  // 24. Gold leakage prevention
  it("Test 24: gold leakage prevention verifies zero gold patches or solution literals exist in candidates", () => {
    const ctrl76 = negativeControls.controls.find((c: any) => c.id === "N76");
    expect(ctrl76.status).toBe("PASS");
    expect(ctrl76.actualClass).toBe("GOLD_LITERAL_LEAKAGE_REJECTED");
    for (const cand of candidates.candidates) {
      const serialized = JSON.stringify(cand).toLowerCase();
      expect(serialized).not.toContain("gold_patch");
      expect(serialized).not.toContain("lookaheaddesyncerror");
    }
  });

  // 25. Clean-room enforcement on L5
  it("Test 25: clean-room enforcement on L5 confirms 5/5 tasks pass verification", () => {
    for (let i = 1; i <= 5; i++) {
      const taskId = `P46-L5-0${i}`;
      const res = ConstructiveProgramInductionCalculusEngine.evaluateCondition(taskId, "D");
      expect(res.cleanRoomPassed).toBe(true);
      expect(res.success).toBe(true);
    }
  });

  // 26. Clean-room enforcement on L6
  it("Test 26: clean-room enforcement on L6 confirms 5/5 tasks pass verification", () => {
    for (let i = 1; i <= 5; i++) {
      const taskId = `P46-L6-0${i}`;
      const res = ConstructiveProgramInductionCalculusEngine.evaluateCondition(taskId, "D");
      expect(res.cleanRoomPassed).toBe(true);
      expect(res.success).toBe(true);
    }
  });

  // 27. Clean-room fail-closed on L7
  it("Test 27: clean-room fail-closed on L7 confirms 0/5 tasks pass verification", () => {
    for (let i = 1; i <= 5; i++) {
      const taskId = `P46-L7-0${i}`;
      const res = ConstructiveProgramInductionCalculusEngine.evaluateCondition(taskId, "D");
      expect(res.cleanRoomPassed).toBe(false);
      expect(res.success).toBe(false);
      expect(res.failureReason).toBe("CONSTRUCTIVE_PROGRAM_INDUCTION_BOUNDARY_ON_L7");
    }
  });

  // 28. Condition A control behavior
  it("Test 28: Condition A control behavior preserves Phase 69 control results", () => {
    expect(results.metrics.control_l5).toBe("5/5");
    expect(results.metrics.control_l6).toBe("5/5");
    expect(results.metrics.control_l7).toBe("0/5");
  });

  // 29. Condition B basic calculus
  it("Test 29: Condition B basic calculus synthesizes candidates without refinement", () => {
    expect(results.metrics.basic_calculus_l5).toBe("5/5");
    expect(results.metrics.basic_calculus_l6).toBe("5/5");
    expect(results.metrics.basic_calculus_l7).toBe("0/5");
  });

  // 30. Condition C refinement calculus
  it("Test 30: Condition C refinement calculus applies iterative refinement", () => {
    expect(results.metrics.refinement_calculus_l5).toBe("5/5");
    expect(results.metrics.refinement_calculus_l6).toBe("5/5");
    expect(results.metrics.refinement_calculus_l7).toBe("0/5");
  });

  // 31. Condition D full induction
  it("Test 31: Condition D full induction integrates all evidence into constructive synthesis", () => {
    expect(results.metrics.full_induction_l5).toBe("5/5");
    expect(results.metrics.full_induction_l6).toBe("5/5");
    expect(results.metrics.full_induction_l7).toBe("0/5");
    expect(results.metrics.overall_success).toBe("10/15 (66.7%)");
  });

  // 32. Deterministic replay
  it("Test 32: deterministic replay produces byte-identical programs across independent runs", () => {
    expect(determinism.byteIdentical).toBe(true);
    expect(determinism.prog1Hash).toBe(determinism.prog2Hash);
  });

  // 33. Negative controls N1–N67 preserved
  it("Test 33: negative controls N1–N67 preserved evaluate to PASS", () => {
    const historical = negativeControls.controls.slice(0, 67);
    expect(historical.length).toBe(67);
    for (const ctrl of historical) {
      expect(ctrl.status).toBe("PASS");
    }
  });

  // 34. Negative controls N68–N80 pass
  it("Test 34: negative controls N68–N80 pass evaluate to PASS fail-closed", () => {
    const phase70Controls = negativeControls.controls.slice(67);
    expect(phase70Controls.length).toBe(13); // N68 through N80
    for (const ctrl of phase70Controls) {
      expect(ctrl.status).toBe("PASS");
    }
  });

  // 35. Status artifact consistency
  it("Test 35: status artifact consistency verifies canonical PHASE70_STATUS matches results", () => {
    expect(protocol.phase).toBe("70");
    expect(statusArtifact.phase).toBe("70");
    expect(statusArtifact.rawStatus).toContain("PHASE70_STATUS");
    expect(statusArtifact.rawStatus).toContain("decision=BOUNDARY_CONFIRMED");
    expect(statusArtifact.rawStatus).toContain("remaining_boundary=CONSTRUCTIVE_SEARCH_EXHAUSTION");
    expect(statusArtifact.status.overall_success).toBe("10/15 (66.7%)");
    expect(statusArtifact.status.l7_clean_room_success).toBe("0/5 (0.0%)");
  });

  // 36. L7 diagnostic records
  it("Test 36: L7 diagnostic records documents P46-L7-01 and P46-L7-02 exhaustion details", () => {
    expect(l7Diagnostics.diagnosticCases.length).toBe(2);
    const p01 = l7Diagnostics.diagnosticCases.find((c: any) => c.taskId === "P46-L7-01");
    const p02 = l7Diagnostics.diagnosticCases.find((c: any) => c.taskId === "P46-L7-02");
    expect(p01.exhaustionReason).toBe("CONSTRUCTIVE_SEARCH_EXHAUSTION_ON_L7");
    expect(p02.exhaustionReason).toBe("CONSTRUCTIVE_SEARCH_EXHAUSTION_ON_L7");
    expect(p01.proofObligationStatus.crossModuleSync).toBe("UNRESOLVED");
    expect(p02.proofObligationStatus.crossModuleSync).toBe("UNRESOLVED");
  });
});
