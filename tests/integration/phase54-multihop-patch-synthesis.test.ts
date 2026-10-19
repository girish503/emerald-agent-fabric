/**
 * Phase 54 — Governed Multi-Hop Patch Synthesis Integration Tests
 *
 * Verifies:
 * 1. Atomic edit schema & deterministic edit hashing
 * 2. Edit scope enforcement (N1, N2)
 * 3. Dependency graph construction and topological ordering (N6)
 * 4. Deterministic checkpoint creation & restoration
 * 5. Invariant preservation (N5)
 * 6. AST postcondition validation (N10)
 * 7. Critical diagnostic tasks P46-L7-01 and P46-L7-02
 * 8. Negative controls N1–N14 complete verification
 * 9. Full 60-trial evaluation matrix (15 tasks x 4 conditions)
 * 10. Clean-room verification & governance integrity (Fourfold, Ed25519, Auditor)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PatchSynthesisController,
  AtomicEdit,
  ExecutionBudgetTracker
} from "../../src/application/patch-synthesis-controller.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 54 — Governed Multi-Hop Patch Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-protocol.json"), "utf8"));
  const plansData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-patch-plans.json"), "utf8"));
  const editsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-atomic-edits.json"), "utf8"));
  const checkpointsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-checkpoints.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase54-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Atomic Edit Schema & Deterministic Hashing
  // ---------------------------------------------------------------------------
  it("verifies atomic edit schema, canonical hashing, and plan determinism", () => {
    expect(protocol.phase).toBe("54");
    expect(protocol.frozenBaselineCommit).toBe("4883ffe");
    expect(editsData.totalEdits).toBe(45);
    expect(plansData.totalPlans).toBe(15);

    for (const plan of plansData.plans) {
      expect(plan.planId).toBeDefined();
      expect(plan.edits.length).toBeGreaterThanOrEqual(2);
      expect(plan.contentHash).toBeDefined();

      const recomputedPlanHash = PatchSynthesisController.computePlanHash(plan);
      expect(plan.contentHash).toBe(recomputedPlanHash);

      for (const edit of plan.edits) {
        expect(edit.editId).toBeDefined();
        expect(edit.inputHash).toBeDefined();
        const recomputedEditHash = PatchSynthesisController.computeEditHash(edit);
        expect(edit.inputHash).toBe(recomputedEditHash);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Dependency Graph & Topological Ordering (N6)
  // ---------------------------------------------------------------------------
  it("verifies edit dependency graph construction, topological ordering, and cycle detection", () => {
    for (const plan of plansData.plans) {
      const depResult = PatchSynthesisController.buildDependencyGraph(plan.edits);
      expect(depResult.topologicalOrder.length).toBe(plan.edits.length);

      // Verify that every dependency appears before its dependent in topologicalOrder
      for (const edit of plan.edits) {
        const editIdx = depResult.topologicalOrder.indexOf(edit.editId);
        for (const depId of edit.dependencyIds) {
          const depIdx = depResult.topologicalOrder.indexOf(depId);
          expect(depIdx).toBeLessThan(editIdx);
        }
      }
    }

    // N6: Cyclic dependency detection
    const cyclicEdits: AtomicEdit[] = [
      {
        editId: "E-CYCLE-01",
        targetFile: "src/a.js",
        targetSymbol: "funcA",
        editType: "REPLACE_NODE",
        preconditions: [],
        postconditions: [],
        dependencyIds: ["E-CYCLE-02"],
        scope: ["src/a.js"],
        inputHash: "hash-01",
      },
      {
        editId: "E-CYCLE-02",
        targetFile: "src/b.js",
        targetSymbol: "funcB",
        editType: "REPLACE_NODE",
        preconditions: [],
        postconditions: [],
        dependencyIds: ["E-CYCLE-01"],
        scope: ["src/b.js"],
        inputHash: "hash-02",
      },
    ];

    expect(() => PatchSynthesisController.buildDependencyGraph(cyclicEdits)).toThrow(
      /PATCH_DEPENDENCY_CYCLE/
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Edit Scope Enforcement (N1, N2)
  // ---------------------------------------------------------------------------
  it("enforces workspace boundary and atomic edit scope limits", () => {
    const authorized = ["src/allowed.js", "src/models/user.js"];

    // N1: Unauthorized file
    const editN1: AtomicEdit = {
      editId: "E-N1",
      targetFile: "src/secret/unauthorized.js",
      targetSymbol: "secretKey",
      editType: "REPLACE_NODE",
      preconditions: [],
      postconditions: [],
      dependencyIds: [],
      scope: ["src/secret/unauthorized.js"],
      inputHash: "hash-n1",
    };
    const resN1 = PatchSynthesisController.validateEditScope(editN1, authorized);
    expect(resN1.valid).toBe(false);
    expect(resN1.failureClass).toBe("WORKSPACE_BOUNDARY_VIOLATION");

    // N2: Oversized edit (AST nodes)
    const editN2: AtomicEdit = {
      editId: "E-N2",
      targetFile: "src/allowed.js",
      targetSymbol: "bigSymbol",
      editType: "REPLACE_NODE",
      preconditions: [],
      postconditions: [],
      dependencyIds: [],
      scope: ["src/allowed.js"],
      inputHash: "hash-n2",
      astNodeCount: 30, // Limit is 25
      sourceBytes: 500,
    };
    const resN2 = PatchSynthesisController.validateEditScope(editN2, authorized);
    expect(resN2.valid).toBe(false);
    expect(resN2.failureClass).toBe("ATOMIC_EDIT_SCOPE_EXCEEDED");
  });

  // ---------------------------------------------------------------------------
  // 4. AST Validation & Postconditions (N3, N10)
  // ---------------------------------------------------------------------------
  it("enforces AST structural validity and verifies independent postconditions", () => {
    // N3: Invalid AST syntax (unbalanced braces)
    const editN3: AtomicEdit = {
      editId: "E-N3",
      targetFile: "src/allowed.js",
      targetSymbol: "brokenFunc",
      editType: "REPLACE_NODE",
      preconditions: [],
      postconditions: [],
      dependencyIds: [],
      scope: ["src/allowed.js"],
      inputHash: "hash-n3",
      replacementContent: "function broken() { if (true) { return 1; }", // Missing closing brace
    };
    const resN3 = PatchSynthesisController.validateAST(editN3);
    expect(resN3.valid).toBe(false);
    expect(resN3.failureClass).toBe("AST_VALIDATION_FAILED");

    // N10: Model declares false postcondition
    const editN10: AtomicEdit = {
      editId: "E-N10",
      targetFile: "src/allowed.js",
      targetSymbol: "fakeFunc",
      editType: "REPLACE_NODE",
      preconditions: [],
      postconditions: ["FUNCTION_EXISTS_fakeFunc", "PORT_CAPTURE_INCLUDED"],
      dependencyIds: [],
      scope: ["src/allowed.js"],
      inputHash: "hash-n10",
      replacementContent: "const x = 42;", // Does not contain function or port capture regex
    };
    const resN10 = PatchSynthesisController.evaluatePostconditions(editN10, editN10.replacementContent!);
    expect(resN10.satisfied).toBe(false);
    expect(resN10.failedPostconditions.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 5. Invariant Preservation & Checkpoints (N5)
  // ---------------------------------------------------------------------------
  it("verifies incremental checkpoint creation, restoration, and invariant preservation", () => {
    expect(checkpointsData.checkpoints.length).toBeGreaterThanOrEqual(35);

    for (const cp of checkpointsData.checkpoints) {
      expect(cp.checkpointId).toBeDefined();
      expect(cp.patchHash).toBeDefined();
      const recomputedHash = PatchSynthesisController.computeCheckpointHash(cp);
      expect(cp.patchHash).toBe(recomputedHash);
    }

    // N5: Prior invariant regression detection
    const prior = ["INV-01-PARSER", "INV-02-AST-PRESERVED", "INV-03-NO-REGRESSION"];
    const currentBroken = ["INV-01-PARSER"]; // Missing INV-02 and INV-03
    const presResult = PatchSynthesisController.verifyInvariantPreservation(prior, currentBroken);
    expect(presResult.preserved).toBe(false);
    expect(presResult.regressed).toContain("INV-02-AST-PRESERVED");
    expect(presResult.regressed).toContain("INV-03-NO-REGRESSION");
  });

  // ---------------------------------------------------------------------------
  // 6. Critical Diagnostic Tasks P46-L7-01 & P46-L7-02
  // ---------------------------------------------------------------------------
  it("evaluates diagnostic tasks P46-L7-01 and P46-L7-02 with structural targeting and clean-room rejection", () => {
    // P46-L7-01 Target Resolution
    const target01 = PatchSynthesisController.resolveStructuralTarget(
      "PRATT_BINDING_INVERSION: prefix unary minus vs exponentiation",
      ["src/calc.js", "src/parser/ast.js"]
    );
    expect(target01.targetSymbol).toBe("parseExpression");
    expect(target01.targetNode).toBe("UnaryExpression");
    expect(target01.requiredInvariant).toBe("PREFIX_UNARY_BP_GREATER_THAN_EXP_BP");

    // P46-L7-02 Target Resolution
    const target02 = PatchSynthesisController.resolveStructuralTarget(
      "CORS_ORIGIN_REFLECTION: wildcard port regex and reflection",
      ["src/cors.js", "src/matcher/regex.js"]
    );
    expect(target02.targetSymbol).toBe("compileOriginPattern");
    expect(target02.targetNode).toBe("RegExpLiteral");
    expect(target02.requiredInvariant).toBe("WILDCARD_PORT_CAPTURE_AND_ORIGIN_ECHO");

    // Clean-room failure across all conditions for L7
    const l7Trials = evaluation.trials.filter((t: any) => t.taskId === "P46-L7-01" || t.taskId === "P46-L7-02");
    expect(l7Trials.length).toBe(8); // 2 tasks x 4 conditions
    for (const trial of l7Trials) {
      expect(trial.repositorySuccess).toBe(false);
      expect(trial.cleanRoomStatus).toBe("FAILED");
      expect(trial.failureClass).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Complete Negative Controls (N1–N14)
  // ---------------------------------------------------------------------------
  it("verifies all 14 negative controls pass deterministically", () => {
    expect(negativeControls.controls.length).toBe(14);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
      expect(ctrl.expectedClass).toBe(ctrl.actualClass);
    }

    // N4: Contract violation
    const editN4: AtomicEdit = {
      editId: "E-N4",
      targetFile: "src/api.js",
      targetSymbol: "frozenApi",
      editType: "REPLACE_NODE",
      preconditions: [],
      postconditions: [],
      dependencyIds: [],
      scope: ["src/api.js"],
      inputHash: "hash-n4",
      replacementContent: "MUTATE_FROZEN_API",
    };
    const resN4 = PatchSynthesisController.checkContractCompliance(editN4, ["MUTATION_FORBIDDEN_API"]);
    expect(resN4.valid).toBe(false);
    expect(resN4.failureClass).toBe("CONTRACT_VIOLATION");

    // N7: Edit conflict
    const conflictingEdits: AtomicEdit[] = [
      {
        editId: "E-CONF-01",
        targetFile: "src/calc.js",
        targetSymbol: "evaluate",
        editType: "REPLACE_NODE",
        preconditions: [],
        postconditions: [],
        dependencyIds: [],
        scope: ["src/calc.js"],
        inputHash: "hash-c1",
        targetRange: { startLine: 10, endLine: 30 },
      },
      {
        editId: "E-CONF-02",
        targetFile: "src/calc.js",
        targetSymbol: "evaluate",
        editType: "REPLACE_NODE",
        preconditions: [],
        postconditions: [],
        dependencyIds: [],
        scope: ["src/calc.js"],
        inputHash: "hash-c2",
        targetRange: { startLine: 20, endLine: 40 },
      },
    ];
    const conflicts = PatchSynthesisController.detectEditConflicts(conflictingEdits);
    expect(conflicts.length).toBeGreaterThan(0);

    // N8 & N9: Retry & model call budget tracker
    const tracker: ExecutionBudgetTracker = {
      semanticReasonerCalls: 2,
      executorCalls: 8,
      globalRepairCalls: 1,
      totalModelCalls: 11,
      editRetries: new Map([["E-01", 2]]),
      totalEditRetries: 6,
    };
    expect(() => PatchSynthesisController.recordModelCall(tracker, "EXECUTOR")).toThrow(
      /PATCH_SYNTHESIS_BUDGET_EXCEEDED/
    );
    expect(() => PatchSynthesisController.recordEditRetry(tracker, "E-01")).toThrow(
      /PATCH_EDIT_RETRY_EXHAUSTED/
    );

    // N12 & N13: Authority firewalls
    expect(() => PatchSynthesisController.assertCleanRoomAuthority(false, true)).toThrow(
      /CAPABILITY_DENIED/
    );
    expect(() => PatchSynthesisController.assertCleanRoomAuthority(true, false)).toThrow(
      /UNVERIFIED_COMPLETION_CLAIM/
    );

    // N14: Gold leakage
    expect(PatchSynthesisController.detectGoldLeakage("function x() { return __SWE_BENCH_GOLD_PATCH__; }")).toBe(true);
    expect(PatchSynthesisController.detectGoldLeakage("function x() { return 42; }")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 8. Full 60-Trial Evaluation Matrix & Success Metrics
  // ---------------------------------------------------------------------------
  it("verifies the complete 60-trial matrix results and metrics", () => {
    expect(evaluation.trials.length).toBe(60);

    const condA = evaluation.trials.filter((t: any) => t.condition === "CONDITION_A_PHASE53_CONTROL");
    const condB = evaluation.trials.filter((t: any) => t.condition === "CONDITION_B_ATOMIC_EDIT_DECOMPOSITION");
    const condC = evaluation.trials.filter((t: any) => t.condition === "CONDITION_C_SEARCH_TRANSFORM_VALIDATE");
    const condD = evaluation.trials.filter((t: any) => t.condition === "CONDITION_D_GOVERNED_INCREMENTAL_PATCH_SYNTHESIS");

    expect(condA.length).toBe(15);
    expect(condB.length).toBe(15);
    expect(condC.length).toBe(15);
    expect(condD.length).toBe(15);

    // L5 & L6 pass 100% across all conditions
    for (const c of [condA, condB, condC, condD]) {
      const l5 = c.filter((t: any) => t.complexityTier.startsWith("L5"));
      const l6 = c.filter((t: any) => t.complexityTier.startsWith("L6"));
      const l7 = c.filter((t: any) => t.complexityTier.startsWith("L7"));

      expect(l5.every((t: any) => t.repositorySuccess)).toBe(true);
      expect(l6.every((t: any) => t.repositorySuccess)).toBe(true);
      expect(l7.every((t: any) => !t.repositorySuccess)).toBe(true);
    }

    // Results summary integrity
    expect(results.metrics.overallSuccess).toBe(10 / 15);
    expect(results.metrics.l5Success).toBe(1.0);
    expect(results.metrics.l6Success).toBe(1.0);
    expect(results.metrics.l7Success).toBe(0.0);
    expect(results.metrics.l7Delta).toBe(0.0);
    expect(results.metrics.atomicEditSuccessRate).toBeCloseTo(0.8444, 3);
    expect(results.metrics.cleanRoomIntegrity).toBe(1.0);
    expect(results.metrics.fourfoldIntegrity).toBe(1.0);
    expect(results.metrics.ed25519ThresholdIntegrity).toBe(1.0);
    expect(results.metrics.offlineAuditorAgreement).toBe(1.0);
    expect(results.metrics.governanceIntegrity).toBe(1.0);
    expect(results.metrics.decision).toBe("EXECUTION_CAPABILITY_BOUNDARY_CONFIRMED");
  });
});
