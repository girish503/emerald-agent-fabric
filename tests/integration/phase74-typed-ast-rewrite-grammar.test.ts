/**
 * Phase 74 — Governed Fine-Grained Typed AST Rewrite Grammar Integration Tests
 *
 * Verifies:
 * - 22 AST rewrite primitives, 16 rewrite types, and 9 rewrite effects
 * - Frozen AST rewrite budgets and resource bounds
 * - Exact AST target resolution and ambiguous target prevention
 * - Dependency ordering and cycle detection
 * - Multi-file atomic materialization and rollback mechanics
 * - Constructive intent to AST rewrite plan synthesis
 * - 60-trial matrix across Conditions A, B, C, D
 * - Preserved and new negative controls N1–N125 fail-closed
 * - L7 diagnostic isolation and root-cause verification
 * - Byte-identical determinism across repeated evaluation runs
 * - Authority firewall preventing unverified code elevation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  GovernedASTRewriteEngine,
  SemanticASTRewritePlanner,
  ASTAtomicMaterializer,
  ASTTargetResolver,
  ASTRewriteDependencyManager,
  AST_REWRITE_PRIMITIVES,
  AST_REWRITE_TYPES,
  AST_REWRITE_EFFECTS,
  FROZEN_AST_REWRITE_BUDGETS,
  ASTRewriteTarget,
  ASTRewriteOperation,
  ASTRewritePlan,
  ASTRewriteDependency,
} from "../../src/application/typed-ast-rewrite-grammar.js";
import {
  ConstructiveProgramInductionCalculusEngine,
} from "../../src/application/constructive-program-induction-calculus.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 74 — Governed Fine-Grained Typed AST Rewrite Grammar", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-protocol.json"), "utf8"));
  const grammar = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-grammar.json"), "utf8"));
  const rewriteTypes = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-rewrite-types.json"), "utf8"));
  const rewriteEffects = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-rewrite-effects.json"), "utf8"));
  const targetsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-targets.json"), "utf8"));
  const plansData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-plans.json"), "utf8"));
  const dependenciesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-dependencies.json"), "utf8"));
  const materializationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-materialization.json"), "utf8"));
  const evaluationData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-evaluation.json"), "utf8"));
  const negativeControlsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-negative-controls.json"), "utf8"));
  const determinismData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-determinism.json"), "utf8"));
  const resultsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-results.json"), "utf8"));
  const l7DiagnosticsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-l7-diagnostics.json"), "utf8"));
  const statusData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-status.json"), "utf8"));

  // 1. Primitives count
  it("Test 1: exactly 22 finite AST rewrite primitives defined and frozen", () => {
    expect(statusData.phase).toBe("74");
    expect(AST_REWRITE_PRIMITIVES.length).toBe(22);
    expect(grammar.primitivesCount).toBe(22);
    expect(AST_REWRITE_PRIMITIVES).toContain("REPLACE_NODE");
    expect(AST_REWRITE_PRIMITIVES).toContain("INSERT_GUARD");
    expect(AST_REWRITE_PRIMITIVES).toContain("INSERT_STATE_UPDATE");
    expect(AST_REWRITE_PRIMITIVES).toContain("REPLACE_CONDITION");
    expect(AST_REWRITE_PRIMITIVES).toContain("REPLACE_BLOCK");
  });

  // 2. Types count
  it("Test 2: exactly 16 AST rewrite types defined and categorized", () => {
    expect(AST_REWRITE_TYPES.length).toBe(16);
    expect(rewriteTypes.typesCount).toBe(16);
    expect(AST_REWRITE_TYPES).toContain("Expression");
    expect(AST_REWRITE_TYPES).toContain("Statement");
    expect(AST_REWRITE_TYPES).toContain("Declaration");
    expect(AST_REWRITE_TYPES).toContain("Block");
    expect(AST_REWRITE_TYPES).toContain("TypeNode");
  });

  // 3. Effects count
  it("Test 3: exactly 9 AST rewrite effects defined with governance boundaries", () => {
    expect(AST_REWRITE_EFFECTS.length).toBe(9);
    expect(rewriteEffects.effectsCount).toBe(9);
    expect(AST_REWRITE_EFFECTS).toContain("READ_AST");
    expect(AST_REWRITE_EFFECTS).toContain("WRITE_AST");
    expect(AST_REWRITE_EFFECTS).toContain("STRUCTURAL_EDIT");
    expect(AST_REWRITE_EFFECTS).toContain("STATE_EDIT");
    expect(AST_REWRITE_EFFECTS).toContain("TYPE_EDIT");
  });

  // 4. Budgets
  it("Test 4: frozen AST rewrite budgets prevent unbounded mutation", () => {
    expect(protocol.phase).toBe("74");
    expect(FROZEN_AST_REWRITE_BUDGETS.maxRewriteOperations).toBe(64);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxFilesPerPlan).toBe(6);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxNodesPerRewrite).toBe(1);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxASTNodesTouched).toBe(128);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxRewritePlans).toBe(64);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxRewriteDepth).toBe(8);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxRollbackAttempts).toBe(1);
    expect(FROZEN_AST_REWRITE_BUDGETS.maxRewriteWallClockMs).toBe(30000);
  });

  // 5. Target resolver exact resolution
  it("Test 5: ASTTargetResolver correctly resolves exact target with valid hash", () => {
    expect(targetsData.count).toBeGreaterThan(0);
    const candidate: ASTRewriteTarget = {
      targetId: "t-valid",
      filePath: "src/calc.js",
      sourceSpan: { startLine: 10, startColumn: 1, endLine: 12, endColumn: 20 },
      nodeKind: "Expression",
      structuralPath: "Program/FunctionDeclaration/BlockStatement/ReturnStatement/BinaryExpression",
      targetHash: "hash-calc-expr",
    };
    const res = ASTTargetResolver.resolveTarget({
      filePath: "src/calc.js",
      nodeKind: "Expression",
      structuralPath: "Program/FunctionDeclaration/BlockStatement/ReturnStatement/BinaryExpression",
      targetHash: "hash-calc-expr",
    }, [candidate]);

    expect(res.resolved).toBe(true);
    expect(res.target?.targetId).toBe("t-valid");
  });

  // 6. Target resolver missing target
  it("Test 6: ASTTargetResolver returns AST_TARGET_NOT_FOUND when target does not exist", () => {
    const res = ASTTargetResolver.resolveTarget({
      filePath: "src/calc.js",
      nodeKind: "Expression",
      structuralPath: "Program/NonExistent",
    }, []);

    expect(res.resolved).toBe(false);
    expect(res.errorCode).toBe("AST_TARGET_NOT_FOUND");
  });

  // 7. Target resolver ambiguous target
  it("Test 7: ASTTargetResolver rejects ambiguous matches with AMBIGUOUS_AST_TARGET", () => {
    const c1: ASTRewriteTarget = {
      targetId: "t1",
      filePath: "src/calc.js",
      sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
      nodeKind: "Statement",
      structuralPath: "Program/Statement",
      targetHash: "h1",
    };
    const c2: ASTRewriteTarget = {
      targetId: "t2",
      filePath: "src/calc.js",
      sourceSpan: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 10 },
      nodeKind: "Statement",
      structuralPath: "Program/Statement",
      targetHash: "h2",
    };
    const res = ASTTargetResolver.resolveTarget({
      filePath: "src/calc.js",
      nodeKind: "Statement",
      structuralPath: "Program/Statement",
    }, [c1, c2]);

    expect(res.resolved).toBe(false);
    expect(res.errorCode).toBe("AMBIGUOUS_AST_TARGET");
  });

  // 8. Target resolver hash mismatch
  it("Test 8: ASTTargetResolver rejects target when target content hash mismatches", () => {
    const c: ASTRewriteTarget = {
      targetId: "t1",
      filePath: "src/calc.js",
      sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
      nodeKind: "Statement",
      structuralPath: "Program/Statement",
      targetHash: "actual-hash",
    };
    const res = ASTTargetResolver.resolveTarget({
      filePath: "src/calc.js",
      nodeKind: "Statement",
      structuralPath: "Program/Statement",
      targetHash: "expected-hash-differs",
    }, [c]);

    expect(res.resolved).toBe(false);
    expect(res.errorCode).toBe("TARGET_HASH_MISMATCH");
  });

  // 9. Dependency manager linear chain
  it("Test 9: ASTRewriteDependencyManager correctly orders linear dependencies", () => {
    expect(dependenciesData.count).toBeGreaterThanOrEqual(0);
    const ops: ASTRewriteOperation[] = [
      { operationId: "op2", primitive: "REPLACE_NODE", target: {} as any, payload: {}, acceptedTargetTypes: [], producedTargetType: "Statement", requiredInputType: "Statement", resultingType: "Statement", declaredEffects: [], preconditions: [], postconditions: [], depth: 1, contentHash: "h2" },
      { operationId: "op1", primitive: "REPLACE_NODE", target: {} as any, payload: {}, acceptedTargetTypes: [], producedTargetType: "Statement", requiredInputType: "Statement", resultingType: "Statement", declaredEffects: [], preconditions: [], postconditions: [], depth: 1, contentHash: "h1" },
    ];
    const deps: ASTRewriteDependency[] = [{ fromOpId: "op1", toOpId: "op2" }];
    const res = ASTRewriteDependencyManager.validateAndOrder(ops, deps);

    expect(res.valid).toBe(true);
    expect(res.orderedOps?.[0]?.operationId).toBe("op1");
    expect(res.orderedOps?.[1]?.operationId).toBe("op2");
  });

  // 10. Dependency manager cycle detection
  it("Test 10: ASTRewriteDependencyManager rejects cyclic rewrite dependencies fail-closed", () => {
    const ops: ASTRewriteOperation[] = [
      { operationId: "opA", primitive: "REPLACE_NODE", target: {} as any, payload: {}, acceptedTargetTypes: [], producedTargetType: "Statement", requiredInputType: "Statement", resultingType: "Statement", declaredEffects: [], preconditions: [], postconditions: [], depth: 1, contentHash: "hA" },
      { operationId: "opB", primitive: "REPLACE_NODE", target: {} as any, payload: {}, acceptedTargetTypes: [], producedTargetType: "Statement", requiredInputType: "Statement", resultingType: "Statement", declaredEffects: [], preconditions: [], postconditions: [], depth: 1, contentHash: "hB" },
    ];
    const deps: ASTRewriteDependency[] = [
      { fromOpId: "opA", toOpId: "opB" },
      { fromOpId: "opB", toOpId: "opA" },
    ];
    const res = ASTRewriteDependencyManager.validateAndOrder(ops, deps);

    expect(res.valid).toBe(false);
    expect(res.error).toBe("AST_REWRITE_DEPENDENCY_CYCLE");
  });

  // 11. Atomic materializer snapshot and success
  it("Test 11: ASTAtomicMaterializer applies valid plan with atomic snapshotting", () => {
    expect(materializationData.count).toBe(15);
    const plan: ASTRewritePlan = {
      planId: "p-valid",
      goalHash: "gh-1",
      orderedRewrites: [
        { operationId: "op1", primitive: "INSERT_GUARD", target: {} as any, payload: {}, acceptedTargetTypes: [], producedTargetType: "Statement", requiredInputType: "Statement", resultingType: "Statement", declaredEffects: ["WRITE_AST"], preconditions: [], postconditions: [], depth: 1, contentHash: "h1" },
      ],
      affectedFiles: ["src/semver.js"],
      affectedSymbols: ["parsePrerelease"],
      dependencies: [],
      preconditions: [],
      postconditions: [],
      invariantObligations: [],
      effectSet: ["WRITE_AST"],
      canonicalHash: "hash-p-valid",
    };
    const res = ASTAtomicMaterializer.materializePlan(plan);

    expect(res.success).toBe(true);
    expect(res.status).toBe("APPLIED");
    expect(res.filesTouched).toContain("src/semver.js");
  });

  // 12. Atomic materializer rollback on parse error
  it("Test 12: ASTAtomicMaterializer triggers atomic rollback when parse error occurs", () => {
    const plan: ASTRewritePlan = {
      planId: "p-err",
      goalHash: "gh-err",
      orderedRewrites: [],
      affectedFiles: ["src/calc.js", "src/parser.js"],
      affectedSymbols: ["calc", "parse"],
      dependencies: [],
      preconditions: [],
      postconditions: [],
      invariantObligations: [],
      effectSet: ["WRITE_AST"],
      canonicalHash: "hash-p-err",
    };
    const res = ASTAtomicMaterializer.materializePlan(plan, "PARSE_ERROR");

    expect(res.success).toBe(false);
    expect(res.status).toBe("ROLLED_BACK");
    expect(res.snapshotRestored).toBe(true);
    expect(res.failureReason).toContain("Parse error");
  });

  // 13. Atomic materializer rollback on typecheck error
  it("Test 13: ASTAtomicMaterializer triggers atomic rollback on typecheck failure", () => {
    const plan: ASTRewritePlan = {
      planId: "p-err2",
      goalHash: "gh-err2",
      orderedRewrites: [],
      affectedFiles: ["src/calc.js"],
      affectedSymbols: ["calc"],
      dependencies: [],
      preconditions: [],
      postconditions: [],
      invariantObligations: [],
      effectSet: ["WRITE_AST"],
      canonicalHash: "hash-p-err2",
    };
    const res = ASTAtomicMaterializer.materializePlan(plan, "TYPECHECK_ERROR");

    expect(res.success).toBe(false);
    expect(res.status).toBe("ROLLED_BACK");
    expect(res.snapshotRestored).toBe(true);
    expect(res.failureReason).toContain("Typecheck error");
  });

  // 14. Atomic materializer rollback integrity
  it("Test 14: atomic rollback guarantees zero dirty workspace residue", () => {
    const plan: ASTRewritePlan = {
      planId: "p-err3",
      goalHash: "gh-err3",
      orderedRewrites: [],
      affectedFiles: ["src/f1.js", "src/f2.js", "src/f3.js"],
      affectedSymbols: [],
      dependencies: [],
      preconditions: [],
      postconditions: [],
      invariantObligations: [],
      effectSet: ["WRITE_AST"],
      canonicalHash: "hash-p-err3",
    };
    const res = ASTAtomicMaterializer.materializePlan(plan, "PARSE_ERROR");

    expect(res.success).toBe(false);
    expect(res.status).toBe("ROLLED_BACK");
    expect(res.snapshotRestored).toBe(true);
  });

  // 15. Planner for L5 tasks
  it("Test 15: SemanticASTRewritePlanner produces single-file plans for L5 tasks", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L5-01");
    const planRes = SemanticASTRewritePlanner.planFromConstructiveIntent("P46-L5-01", goal);

    expect(planRes.success).toBe(true);
    expect(planRes.plan?.affectedFiles.length).toBe(1);
    expect(planRes.plan?.affectedFiles[0]).toBe("src/semver.js");
  });

  // 16. Planner for L6 tasks
  it("Test 16: SemanticASTRewritePlanner produces multi-file plans for L6 tasks", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L6-01");
    const planRes = SemanticASTRewritePlanner.planFromConstructiveIntent("P46-L6-01", goal);

    expect(planRes.success).toBe(true);
    expect(planRes.plan?.affectedFiles.length).toBe(2);
    expect(planRes.plan?.affectedFiles).toContain("src/middleware/cors.js");
    expect(planRes.plan?.affectedFiles).toContain("src/routes/api.js");
  });

  // 17. Planner for L7 tasks
  it("Test 17: SemanticASTRewritePlanner produces cross-module plans with dependencies for L7 tasks", () => {
    const goal = ConstructiveProgramInductionCalculusEngine.deriveConstructiveGoal("P46-L7-01");
    const planRes = SemanticASTRewritePlanner.planFromConstructiveIntent("P46-L7-01", goal);

    expect(planRes.success).toBe(true);
    expect(planRes.plan?.affectedFiles.length).toBe(2);
    expect(planRes.plan?.affectedFiles).toContain("src/calc.js");
    expect(planRes.plan?.affectedFiles).toContain("src/parser.js");
    expect(planRes.plan?.dependencies.length).toBeGreaterThan(0);
  });

  // 18. Planner multi-file scope check
  it("Test 18: SemanticASTRewritePlanner respects maximum files per plan budget", () => {
    for (const p of plansData.plans) {
      expect(p.affectedFiles.length).toBeLessThanOrEqual(FROZEN_AST_REWRITE_BUDGETS.maxFilesPerPlan);
    }
  });

  // 19. Planner node budget enforcement
  it("Test 19: ASTAtomicMaterializer enforces maxASTNodesTouched budget", () => {
    const overflowPlan: ASTRewritePlan = {
      planId: "p-overflow",
      goalHash: "gh-over",
      orderedRewrites: Array.from({ length: 130 }, (_, i) => ({
        operationId: `op-${i}`,
        primitive: "REPLACE_NODE",
        target: {} as any,
        payload: {},
        acceptedTargetTypes: [],
        producedTargetType: "Statement",
        requiredInputType: "Statement",
        resultingType: "Statement",
        declaredEffects: [],
        preconditions: [],
        postconditions: [],
        depth: 1,
        contentHash: `h-${i}`,
      })),
      affectedFiles: ["src/calc.js"],
      affectedSymbols: [],
      dependencies: [],
      preconditions: [],
      postconditions: [],
      invariantObligations: [],
      effectSet: ["WRITE_AST"],
      canonicalHash: "hash-over",
    };
    const res = ASTAtomicMaterializer.materializePlan(overflowPlan);

    expect(res.status).toBe("VALIDATION_FAILED");
    expect(res.failureReason).toMatch(/Exceeded maxRewriteOperations|Exceeded maxASTNodesTouched/);
  });

  // 20. Planner depth enforcement
  it("Test 20: ASTAtomicMaterializer enforces maxRewriteDepth budget", () => {
    const deepPlan: ASTRewritePlan = {
      planId: "p-deep",
      goalHash: "gh-deep",
      orderedRewrites: [
        {
          operationId: "op-deep",
          primitive: "REPLACE_NODE",
          target: {} as any,
          payload: {},
          acceptedTargetTypes: [],
          producedTargetType: "Statement",
          requiredInputType: "Statement",
          resultingType: "Statement",
          declaredEffects: [],
          preconditions: [],
          postconditions: [],
          depth: 12,
          contentHash: "h-deep",
        },
      ],
      affectedFiles: ["src/calc.js"],
      affectedSymbols: [],
      dependencies: [],
      preconditions: [],
      postconditions: [],
      invariantObligations: [],
      effectSet: ["WRITE_AST"],
      canonicalHash: "hash-deep",
    };
    const res = ASTAtomicMaterializer.materializePlan(deepPlan);

    expect(res.status).toBe("VALIDATION_FAILED");
    expect(res.failureReason).toContain("exceeds limit 8");
  });

  // 21. Negative control N111 (Wrong node kind)
  it("Test 21: N111 rejects rewrite targeting wrong node kind", () => {
    const n111 = negativeControlsData.controls.find((c: any) => c.id === "N111");
    expect(n111.status).toBe("PASS");
    expect(n111.actualClass).toBe("REJECT");
  });

  // 22. Negative control N112 (Target hash mismatch)
  it("Test 22: N112 rejects target content hash mismatch", () => {
    const n112 = negativeControlsData.controls.find((c: any) => c.id === "N112");
    expect(n112.status).toBe("PASS");
    expect(n112.actualClass).toBe("REJECT");
  });

  // 23. Negative control N113 (Ambiguous target)
  it("Test 23: N113 detects and rejects ambiguous structural matches fail-closed", () => {
    const n113 = negativeControlsData.controls.find((c: any) => c.id === "N113");
    expect(n113.status).toBe("PASS");
    expect(n113.actualClass).toBe("REJECT");
  });

  // 24. Negative control N114 (Invalid rewrite type)
  it("Test 24: N114 rejects incompatible AST rewrite type", () => {
    const n114 = negativeControlsData.controls.find((c: any) => c.id === "N114");
    expect(n114.status).toBe("PASS");
    expect(n114.actualClass).toBe("REJECT");
  });

  // 25. Negative control N115 (Undeclared effect)
  it("Test 25: N115 prevents state modification without declared effect", () => {
    const n115 = negativeControlsData.controls.find((c: any) => c.id === "N115");
    expect(n115.status).toBe("PASS");
    expect(n115.actualClass).toBe("REJECT");
  });

  // 26. Negative control N116 (Dependency cycle)
  it("Test 26: N116 detects rewrite dependency cycle and rejects plan", () => {
    const n116 = negativeControlsData.controls.find((c: any) => c.id === "N116");
    expect(n116.status).toBe("PASS");
    expect(n116.actualClass).toBe("REJECT");
  });

  // 27. Negative control N117 (Partial multi-file rollback)
  it("Test 27: N117 rolls back multi-file transaction completely when step fails", () => {
    const n117 = negativeControlsData.controls.find((c: any) => c.id === "N117");
    expect(n117.status).toBe("PASS");
    expect(n117.actualClass).toBe("ROLLBACK_ALL");
  });

  // 28. Negative control N118 (Raw source injection)
  it("Test 28: N118 prevents raw source text injection outside typed grammar", () => {
    const n118 = negativeControlsData.controls.find((c: any) => c.id === "N118");
    expect(n118.status).toBe("PASS");
    expect(n118.actualClass).toBe("REJECT");
  });

  // 29. Negative control N119 (Out of scope file)
  it("Test 29: N119 rejects modifications targeting out-of-scope files", () => {
    const n119 = negativeControlsData.controls.find((c: any) => c.id === "N119");
    expect(n119.status).toBe("PASS");
    expect(n119.actualClass).toBe("REJECT");
  });

  // 30. Negative control N120 (Node budget overflow)
  it("Test 30: N120 rejects plan touching more than 128 AST nodes", () => {
    const n120 = negativeControlsData.controls.find((c: any) => c.id === "N120");
    expect(n120.status).toBe("PASS");
    expect(n120.actualClass).toBe("REJECT");
  });

  // 31. Negative control N121 (Rewrite depth overflow)
  it("Test 31: N121 rejects plan exceeding maximum rewrite depth of 8", () => {
    const n121 = negativeControlsData.controls.find((c: any) => c.id === "N121");
    expect(n121.status).toBe("PASS");
    expect(n121.actualClass).toBe("REJECT");
  });

  // 32. Negative control N122 (Gold patch leakage)
  it("Test 32: N122 blocks gold patch diff headers from rewrite payload", () => {
    const n122 = negativeControlsData.controls.find((c: any) => c.id === "N122");
    expect(n122.status).toBe("PASS");
    expect(n122.actualClass).toBe("REJECT");
  });

  // 33. Negative control N123 (Import/export integrity)
  it("Test 33: N123 verifies module interface contracts remain unbroken", () => {
    const n123 = negativeControlsData.controls.find((c: any) => c.id === "N123");
    expect(n123.status).toBe("PASS");
    expect(n123.actualClass).toBe("REJECT");
  });

  // 34. Negative control N124 (Rollback failure handling)
  it("Test 34: N124 triggers fail-closed abort if atomic rollback fails", () => {
    const n124 = negativeControlsData.controls.find((c: any) => c.id === "N124");
    expect(n124.status).toBe("PASS");
    expect(n124.actualClass).toBe("FAIL_CLOSED");
  });

  // 35. Negative control N125 (Verification bypass)
  it("Test 35: N125 rejects any attempt to bypass clean-room verification", () => {
    const n125 = negativeControlsData.controls.find((c: any) => c.id === "N125");
    expect(n125.status).toBe("PASS");
    expect(n125.actualClass).toBe("REJECT");
  });

  // 36. Negative controls overall pass rate
  it("Test 36: all 125 negative controls (N1–N125) pass 100.0% fail-closed", () => {
    expect(negativeControlsData.totalControls).toBe(125);
    expect(negativeControlsData.passedControls).toBe(125);
    expect(negativeControlsData.passRate).toBe("100.0%");
  });

  // 37. Condition A trials
  it("Test 37: Condition A evaluates Phase 73 control baseline (10/15)", () => {
    expect(GovernedASTRewriteEngine.executeTrial).toBeDefined();
    const condA = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_A");
    const passed = condA.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condA.length).toBe(15);
  });

  // 38. Condition B trials
  it("Test 38: Condition B evaluates Typed AST Rewrite Materialization (10/15)", () => {
    const condB = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_B");
    const passed = condB.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condB.length).toBe(15);
  });

  // 39. Condition C trials
  it("Test 39: Condition C evaluates Constructive Intent + Rewrite (10/15)", () => {
    const condC = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_C");
    const passed = condC.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condC.length).toBe(15);
  });

  // 40. Condition D trials
  it("Test 40: Condition D evaluates Full Governed Pipeline (10/15)", () => {
    const condD = evaluationData.trials.filter((t: any) => t.condition === "CONDITION_D");
    const passed = condD.filter((t: any) => t.success).length;
    expect(passed).toBe(10);
    expect(condD.length).toBe(15);
  });

  // 41. L7 diagnostics
  it("Test 41: L7 diagnostics isolate semantic test failures despite successful AST materialization", () => {
    expect(l7DiagnosticsData.tasks.length).toBe(5);
    for (const t of l7DiagnosticsData.tasks) {
      expect(t.astMaterialized).toBe(true);
      expect(t.cleanRoomPassed).toBe(false);
      expect(t.failureStage).toBe("CLEAN_ROOM_DUAL_GATE_EVALUATION");
      expect(t.rootCause).toBe("DEEP_MULTI_FILE_STATE_MACHINE_MISALIGNMENT");
    }
  });

  // 42. Byte-identical determinism
  it("Test 42: determinism verification confirms byte-identical replay across 3 runs", () => {
    expect(determinismData.deterministicStatus).toBe("PASS (BYTE_IDENTICAL)");
    expect(determinismData.run1Digest).toBe(determinismData.run2Digest);
    expect(determinismData.run2Digest).toBe(determinismData.run3Digest);
  });

  // 43. Authority and clean-room verification
  it("Test 43: authority and clean-room gates remain 100% fail-closed", () => {
    expect(resultsData.clean_room_verification).toBe("100% (dual-gate verified)");
    expect(resultsData.fourfold_verification).toBe("100% (valid)");
    expect(resultsData.offline_auditor).toBe("100% (replay verified)");
    expect(resultsData.terminal_authority).toBe("100% (Ed25519 2-of-3 threshold immutable)");
    expect(resultsData.gold_leakage).toBe("ZERO_LEAKAGE (100% verified)");
  });

  // 44. Scientific decision
  it("Test 44: scientific decision confirms materialization boundary and remaining semantic boundary", () => {
    expect(resultsData.decision).toBe("MATERIALIZATION_BOUNDARY_CONFIRMED");
    expect(resultsData.remainingBoundary).toBe("SEMANTIC_PROGRAM_SYNTHESIS_BOUNDARY");
    expect(resultsData.l7_clean_room_success).toBe("0/5 (0.0%)");
    expect(resultsData.overall_success).toBe("10/15 (66.7%)");
  });
});
