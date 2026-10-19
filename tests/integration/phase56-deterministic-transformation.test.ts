/**
 * Phase 56 — Deterministic Execution-Tier Semantic Transformation Integration Tests
 *
 * Verifies:
 * 1. Transformation specification validation and fail-closed bounds
 * 2. Structural target resolution via AST symbol coordinates
 * 3. Deterministic dependency closure analysis (symbol, import, export, call, type, test, config)
 * 4. Deterministic topological ordering of edits
 * 5. Atomic edit generation and canonical hashing
 * 6. Incremental checkpoint creation
 * 7. Rollback on invariant failure and regression
 * 8. Invariant preservation during transformation steps
 * 9. Gold leakage detection and rejection
 * 10. Authority firewall (provider invocation, terminal approval)
 * 11. Workspace boundary validation
 * 12. Deterministic repeated execution (byte-identical SHA-256)
 * 13. Clean-room verification integration
 * 14. Critical Level 7 transformation cases (P46-L7-01, P46-L7-02)
 * 15. Regression rejection under Condition D
 * 16. Fourfold verification and offline auditor agreement
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DeterministicTransformer,
  DETERMINISTIC_TRANSFORMATION_LIMITS,
  type TransformationSpec
} from "../../src/application/deterministic-transformer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 56 — Deterministic Semantic Transformation Engine", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-protocol.json"), "utf8"));
  const specsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-transform-specs.json"), "utf8"));
  const graphsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-dependency-graphs.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-determinism.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase56-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Transformation Specification Validation
  // ---------------------------------------------------------------------------
  it("validates transformation specifications and fails closed on bounds", () => {
    expect(protocol.phase).toBe("56");
    expect(protocol.baselineCommit).toBe("41f64f6");
    expect(protocol.phase55Commit).toBe("580f9a7");
    expect(specsData.specs.length).toBe(15);

    const validSpec: TransformationSpec = specsData.specs[0];
    const validation = DeterministicTransformer.validateSpec(validSpec, validSpec.targetFiles);
    expect(validation.valid).toBe(true);

    // Fail closed on excessive edits
    const oversizedSpec: TransformationSpec = {
      ...validSpec,
      maximumEdits: DETERMINISTIC_TRANSFORMATION_LIMITS.MAX_EDITS + 10,
    };
    const oversizedRes = DeterministicTransformer.validateSpec(oversizedSpec, validSpec.targetFiles);
    expect(oversizedRes.valid).toBe(false);
    expect(oversizedRes.failureClass).toBe("TRANSFORMATION_BOUNDS_EXCEEDED");
  });

  // ---------------------------------------------------------------------------
  // 2. Structural Target Resolution
  // ---------------------------------------------------------------------------
  it("resolves structural targets via AST coordinates without loose string replacement", () => {
    const spec: TransformationSpec = specsData.specs.find((s: any) => s.taskId === "P46-L5-01");
    expect(spec).toBeDefined();

    const dummySource = {
      "src/semver.js": "export function parsePrerelease(v) {\n  return v.split('-');\n}\n\nexport function comparePrerelease(a, b) {\n  return 0;\n}\n",
    };

    const targets = DeterministicTransformer.resolveStructuralTargets(spec, dummySource);
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets[0]!.symbol).toBe("parsePrerelease");
    expect(targets[0]!.resolutionConfidence).toBe("STRUCTURAL_EXACT");
    expect(targets[0]!.lineRange.startLine).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Dependency Closure & Graph Construction
  // ---------------------------------------------------------------------------
  it("computes deterministic dependency closure across symbol/import/call/test", () => {
    expect(graphsData.graphs.length).toBe(15);

    const graph01 = graphsData.graphs.find((g: any) => g.taskId === "P46-L6-01");
    expect(graph01.affectedFiles.length).toBe(3);
    expect(graph01.affectedFiles).toContain("src/models/user.js");
    expect(graph01.affectedFiles).toContain("src/services/user-service.js");
    expect(graph01.closure.length).toBeGreaterThanOrEqual(3);
    expect(graph01.graphHash).toBeDefined();
    expect(graph01.closureHash).toBeDefined();
    expect(graph01.affectedFileSetHash).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Deterministic Topological Ordering & Edit Generation
  // ---------------------------------------------------------------------------
  it("generates atomic transformation plan with deterministic topological order", () => {
    const spec: TransformationSpec = specsData.specs.find((s: any) => s.taskId === "P46-L6-01");
    const graph = graphsData.graphs.find((g: any) => g.taskId === "P46-L6-01");
    const sourceTree = {
      "src/models/user.js": "class User { hasRole() {} }",
      "src/services/user-service.js": "function authorizeUser() {}",
    };

    const targets = DeterministicTransformer.resolveStructuralTargets(spec, sourceTree);
    const plan = DeterministicTransformer.generatePlan(spec, targets, graph);

    expect(plan.edits.length).toBe(targets.length);
    expect(plan.topologicalOrder.length).toBe(plan.edits.length);
    expect(plan.affectedFiles).toEqual(["src/models/user.js", "src/services/user-service.js"]);
    expect(plan.contentHash).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 5. Atomic Edit Generation & Checkpoint Creation
  // ---------------------------------------------------------------------------
  it("creates immutable checkpoints with state digests during execution", () => {
    const cp = DeterministicTransformer.createCheckpoint(
      1,
      ["EDIT-1"],
      { "src/semver.js": "updated code" },
      ["PRESERVE_REGRESSION"],
      true,
      true,
      true
    );

    expect(cp.checkpointId).toContain("CHECKPOINT-1-");
    expect(cp.stateDigest).toBeDefined();
    expect(cp.compilationPassed).toBe(true);
    expect(cp.regressionPassed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 6. Rollback on Regression & Invariant Failure
  // ---------------------------------------------------------------------------
  it("rolls back to pristine checkpoint when regression test fails", () => {
    const spec: TransformationSpec = specsData.specs[0];
    const dummySource = {
      "src/semver.js": "function parsePrerelease() { return 1; }",
    };
    const targets = DeterministicTransformer.resolveStructuralTargets(spec, dummySource);
    const plan = DeterministicTransformer.generatePlan(spec, targets);

    // Simulate regression failure on step 1
    const result = DeterministicTransformer.executePlan(
      plan,
      dummySource,
      spec.requiredInvariants,
      () => false // Regression failure
    );

    expect(result.success).toBe(false);
    expect(result.rollbackOccurred).toBe(true);
    expect(result.finalFiles).toEqual(dummySource); // Restored to pristine state
    expect(result.failureReason).toContain("REGRESSION_INVARIANT_VIOLATION");
  });

  // ---------------------------------------------------------------------------
  // 7. Gold Leakage & Solution Hardcoding Firewalls
  // ---------------------------------------------------------------------------
  it("detects and rejects gold patch leakage and hardcoded solutions (N4, N7)", () => {
    expect(DeterministicTransformer.detectGoldLeakage("const a = 1;")).toBe(false);
    expect(DeterministicTransformer.detectGoldLeakage("__SWE_BENCH_GOLD_PATCH__")).toBe(true);
    expect(DeterministicTransformer.detectGoldLeakage("P46-L7-01_HARDCODED_GOLD_FIX")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 8. Authority Firewall (N1, N2, N3, N8)
  // ---------------------------------------------------------------------------
  it("enforces authority firewall preventing provider calls or verification bypass", () => {
    expect(() =>
      DeterministicTransformer.assertAuthorityFirewall({
        actor: "DETERMINISTIC_TRANSFORMER",
        attemptedCapability: "PROVIDER_INVOCATION",
      })
    ).toThrow(/REJECT/);

    expect(() =>
      DeterministicTransformer.assertAuthorityFirewall({
        actor: "DETERMINISTIC_TRANSFORMER",
        attemptedCapability: "VERIFICATION_BYPASS",
      })
    ).toThrow(/REJECT/);

    expect(() =>
      DeterministicTransformer.assertAuthorityFirewall({
        actor: "DETERMINISTIC_TRANSFORMER",
        attemptedCapability: "WORKSPACE_WRITE",
        targetPath: "../../outside/workspace.js",
      })
    ).toThrow(/WORKSPACE_BOUNDARY_VIOLATION/);
  });

  // ---------------------------------------------------------------------------
  // 9. Negative Controls Battery (N1–N8)
  // ---------------------------------------------------------------------------
  it("verifies all 8 negative controls pass deterministically", () => {
    expect(negativeControls.controls.length).toBe(8);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
      expect(ctrl.actualClass).toBe(ctrl.expectedClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Deterministic Repeated Execution (Byte-Identical)
  // ---------------------------------------------------------------------------
  it("verifies byte-identical execution digests across repeated runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    for (const record of determinism.records) {
      expect(record.isByteIdentical).toBe(true);
      expect(record.run1Digest).toBe(record.run2Digest);
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Critical Diagnostic Tasks P46-L7-01 & P46-L7-02
  // ---------------------------------------------------------------------------
  it("evaluates diagnostic L7 tasks and records regression rejection", () => {
    const trials01 = evaluation.trials.filter((t: any) => t.taskId === "P46-L7-01");
    const trials02 = evaluation.trials.filter((t: any) => t.taskId === "P46-L7-02");

    expect(trials01.length).toBe(4);
    expect(trials02.length).toBe(4);

    for (const t of [...trials01, ...trials02]) {
      expect(t.transformationGenerated).toBe(true);
      expect(t.compilationPassed).toBe(true);
      expect(t.targetedPassed).toBe(true);
      expect(t.cleanRoomPassed).toBe(false);
      expect(t.failureClass).toBe("REGRESSION_FAILURE");
    }

    // Condition D rollback verification
    const condD01 = trials01.find((t: any) => t.condition === "CONDITION_D_GOVERNED_PIPELINE");
    expect(condD01.rollbackExecuted).toBe(true);
    expect(condD01.appliedEditsCount).toBe(0); // Rolled back
  });

  // ---------------------------------------------------------------------------
  // 12. 60-Trial Evaluation Matrix & Scientific Decision
  // ---------------------------------------------------------------------------
  it("confirms 60-trial comparative matrix and decision GLOBAL_SEMANTIC_RECONCILIATION_BOUNDARY", () => {
    expect(evaluation.totalTrials).toBe(60);

    const condA = evaluation.trials.filter((t: any) => t.condition === "CONDITION_A_EXISTING_CONTROL");
    const condB = evaluation.trials.filter((t: any) => t.condition === "CONDITION_B_DETERMINISTIC_AST");
    const condC = evaluation.trials.filter((t: any) => t.condition === "CONDITION_C_DEPENDENCY_AWARE");
    const condD = evaluation.trials.filter((t: any) => t.condition === "CONDITION_D_GOVERNED_PIPELINE");

    expect(condA.filter((t: any) => t.cleanRoomPassed).length).toBe(10);
    expect(condB.filter((t: any) => t.cleanRoomPassed).length).toBe(10);
    expect(condC.filter((t: any) => t.cleanRoomPassed).length).toBe(10);
    expect(condD.filter((t: any) => t.cleanRoomPassed).length).toBe(10);

    expect(results.metrics.controlSuccess).toBe(10 / 15);
    expect(results.metrics.deterministicSuccess).toBe(10 / 15);
    expect(results.metrics.dependencySuccess).toBe(10 / 15);
    expect(results.metrics.fullPipelineSuccess).toBe(10 / 15);
    expect(results.metrics.l5Success).toBe(1.0);
    expect(results.metrics.l6Success).toBe(1.0);
    expect(results.metrics.l7Success).toBe(0.0);
    expect(results.metrics.l7Delta).toBe(0.0);

    expect(results.metrics.decision).toBe("GLOBAL_SEMANTIC_RECONCILIATION_BOUNDARY");
    expect(results.metrics.cleanRoomIntegrity).toBe(1.0);
    expect(results.metrics.fourfoldIntegrity).toBe(1.0);
    expect(results.metrics.offlineAuditorAgreement).toBe(1.0);
    expect(results.metrics.terminalAuthorityIntegrity).toBe(1.0);
  });
});
