/**
 * Phase 55 — Governed Model Capability Substitution Integration Tests
 *
 * Verifies:
 * 1. Model feasibility inventory, RAM gate, and Latency gate evaluation
 * 2. Model identity specification and canonical hashing
 * 3. Capability gate battery (G1–G6)
 * 4. Model isolation & authority firewall (N1–N8)
 * 5. Diagnostic tasks P46-L7-01 and P46-L7-02 under capability substitution
 * 6. Capability attribution decomposition
 * 7. Complete 60-trial comparative evaluation matrix (15 tasks x 4 conditions)
 * 8. Governance invariants (Clean-room dual-gate, Fourfold, Ed25519 threshold, Offline auditor)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ModelCapabilityEvaluator,
  HOST_CONSTRAINTS
} from "../../src/application/model-capability-evaluator.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 55 — Governed Model Capability Substitution", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-protocol.json"), "utf8"));
  const feasibility = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-model-feasibility.json"), "utf8"));
  const identity = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-model-identity.json"), "utf8"));
  const capability = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-capability-gate.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase55-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Model Feasibility, RAM Gate & Latency Gate
  // ---------------------------------------------------------------------------
  it("evaluates hardware feasibility against host RAM and latency gates", () => {
    expect(protocol.phase).toBe("55");
    expect(protocol.frozenBaselineCommit).toBe("41f64f6");
    expect(feasibility.models.length).toBeGreaterThanOrEqual(6);

    const r1 = feasibility.models.find((m: any) => m.modelName === "deepseek-r1:8b");
    expect(r1).toBeDefined();
    expect(r1.feasibilityStatus).toBe("MODEL_ENVIRONMENTALLY_INFEASIBLE");
    expect(r1.measuredProbeLatencyMs).toBe(94613);
    expect(r1.memoryFootprintBytes).toBeGreaterThan(HOST_CONSTRAINTS.MAX_SAFE_MODEL_RAM_BYTES);

    const qwen3b = feasibility.models.find((m: any) => m.modelName === "qwen2.5-coder:3b");
    expect(qwen3b).toBeDefined();
    expect(qwen3b.feasibilityStatus).toBe("FEASIBLE");
    expect(qwen3b.memoryFootprintBytes).toBeLessThan(HOST_CONSTRAINTS.MAX_SAFE_MODEL_RAM_BYTES);
    expect(qwen3b.expectedStepLatencyMs).toBeLessThan(HOST_CONSTRAINTS.STEP_TIMEOUT_CEILING_MS);
  });

  // ---------------------------------------------------------------------------
  // 2. Model Identity & Canonical Hashing
  // ---------------------------------------------------------------------------
  it("verifies model identity determinism and canonical hashing", () => {
    expect(identity.strongerCandidate.modelName).toBe("qwen2.5-coder:3b");
    expect(identity.strongerCandidate.parameterCount).toBe(3090000000);
    expect(identity.strongerCandidate.quantization).toBe("Q4_K_M");
    expect(identity.strongerCandidate.license).toBe("Apache-2.0");

    const recomputedHash = ModelCapabilityEvaluator.computeModelIdentityHash(identity.strongerCandidate);
    expect(identity.strongerCandidate.identityHash).toBe(recomputedHash);

    const controlHash = ModelCapabilityEvaluator.computeModelIdentityHash(identity.control);
    expect(identity.control.identityHash).toBe(controlHash);
  });

  // ---------------------------------------------------------------------------
  // 3. Capability Gate Battery (G1–G6)
  // ---------------------------------------------------------------------------
  it("evaluates capability gate tests G1 through G6", () => {
    expect(capability.gates.length).toBe(6);

    const g1 = capability.gates.find((g: any) => g.gateId === "G1");
    expect(g1.passed).toBe(true);

    const g2 = capability.gates.find((g: any) => g.gateId === "G2");
    expect(g2.passed).toBe(true);

    const g3 = capability.gates.find((g: any) => g.gateId === "G3");
    expect(g3.passed).toBe(true);

    const g4 = capability.gates.find((g: any) => g.gateId === "G4");
    expect(g4.passed).toBe(true);

    const g5 = capability.gates.find((g: any) => g.gateId === "G5");
    expect(g5.passed).toBe(false); // L7 multi-hop diagnostic fails

    const g6 = capability.gates.find((g: any) => g.gateId === "G6");
    expect(g6.passed).toBe(false); // L7 regression preservation fails
  });

  // ---------------------------------------------------------------------------
  // 4. Critical Diagnostic Tasks P46-L7-01 & P46-L7-02
  // ---------------------------------------------------------------------------
  it("confirms failure modes on critical diagnostic tasks P46-L7-01 and P46-L7-02", () => {
    const trials01 = evaluation.trials.filter((t: any) => t.taskId === "P46-L7-01");
    const trials02 = evaluation.trials.filter((t: any) => t.taskId === "P46-L7-02");

    expect(trials01.length).toBe(4);
    expect(trials02.length).toBe(4);

    for (const t of [...trials01, ...trials02]) {
      expect(t.repositorySuccess).toBe(false);
      expect(t.cleanRoomStatus).toBe("FAILED");
      expect(["REGRESSION_FAILURE", "INVARIANT_REGRESSION", "PATCH_SYNTHESIS_FAILURE"]).toContain(t.failureClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Capability Attribution
  // ---------------------------------------------------------------------------
  it("computes capability attribution decomposition across conditions", () => {
    const attr = ModelCapabilityEvaluator.computeAttribution({
      condASuccessRate: 10 / 15,
      condBSuccessRate: 10 / 15,
      condCSuccessRate: 10 / 15,
      condDSuccessRate: 10 / 15
    });

    expect(attr.modelOnlyGain).toBe(0.0);
    expect(attr.diagnosticGain).toBe(0.0);
    expect(attr.patchSynthesisGain).toBe(0.0);
    expect(attr.orchestrationGain).toBe(0.0);
    expect(attr.totalDelta).toBe(0.0);
  });

  // ---------------------------------------------------------------------------
  // 6. Complete Negative Controls (N1–N8)
  // ---------------------------------------------------------------------------
  it("verifies all 8 negative controls pass deterministically", () => {
    expect(negativeControls.controls.length).toBe(8);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
      expect(ctrl.expectedClass).toBe(ctrl.actualClass);
    }

    // N1 & N5: Workspace boundary
    expect(() =>
      ModelCapabilityEvaluator.assertModelAuthority({
        claimsTerminalSuccess: false,
        modifiesVerification: false,
        modifiesAuthority: false,
        targetsOutsideSlice: true,
        authorizedFiles: ["src/calc.js"],
        targetFile: "src/secret.js"
      })
    ).toThrow(/WORKSPACE_BOUNDARY_VIOLATION/);

    // N2: Verification modification
    expect(() =>
      ModelCapabilityEvaluator.assertModelAuthority({
        claimsTerminalSuccess: false,
        modifiesVerification: true,
        modifiesAuthority: false,
        targetsOutsideSlice: false,
        authorizedFiles: ["src/calc.js"],
        targetFile: "src/calc.js"
      })
    ).toThrow(/CAPABILITY_DENIED/);

    // N3: Unverified completion claim
    expect(() =>
      ModelCapabilityEvaluator.assertModelAuthority({
        claimsTerminalSuccess: true,
        modifiesVerification: false,
        modifiesAuthority: false,
        targetsOutsideSlice: false,
        authorizedFiles: ["src/calc.js"],
        targetFile: "src/calc.js"
      })
    ).toThrow(/UNVERIFIED_COMPLETION_CLAIM/);

    // N8: Authority modification
    expect(() =>
      ModelCapabilityEvaluator.assertModelAuthority({
        claimsTerminalSuccess: false,
        modifiesVerification: false,
        modifiesAuthority: true,
        targetsOutsideSlice: false,
        authorizedFiles: ["src/calc.js"],
        targetFile: "src/calc.js"
      })
    ).toThrow(/CAPABILITY_DENIED/);

    // N7: Gold leakage
    expect(ModelCapabilityEvaluator.detectGoldLeakage("return __SWE_BENCH_GOLD_PATCH__;")).toBe(true);
    expect(ModelCapabilityEvaluator.detectGoldLeakage("return 42;")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 7. Full 60-Trial Evaluation Matrix & Success Metrics
  // ---------------------------------------------------------------------------
  it("verifies the complete 60-trial matrix results and governance integrity", () => {
    expect(evaluation.trials.length).toBe(60);

    const condA = evaluation.trials.filter((t: any) => t.condition === "CONDITION_A_EXISTING_CONTROL");
    const condB = evaluation.trials.filter((t: any) => t.condition === "CONDITION_B_STRONGER_MODEL_ALONE");
    const condC = evaluation.trials.filter((t: any) => t.condition === "CONDITION_C_STRONGER_MODEL_DIAGNOSTIC");
    const condD = evaluation.trials.filter((t: any) => t.condition === "CONDITION_D_STRONGER_MODEL_FULL_STACK");

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
    expect(results.metrics.controlSuccess).toBe(10 / 15);
    expect(results.metrics.strongerModelSuccess).toBe(10 / 15);
    expect(results.metrics.diagnosticSuccess).toBe(10 / 15);
    expect(results.metrics.fullStackSuccess).toBe(10 / 15);
    expect(results.metrics.l5Success).toBe(1.0);
    expect(results.metrics.l6Success).toBe(1.0);
    expect(results.metrics.l7Success).toBe(0.0);
    expect(results.metrics.l7Delta).toBe(0.0);

    // Governance invariants
    expect(results.metrics.cleanRoomIntegrity).toBe(1.0);
    expect(results.metrics.fourfoldIntegrity).toBe(1.0);
    expect(results.metrics.ed25519ThresholdIntegrity).toBe(1.0);
    expect(results.metrics.offlineAuditorAgreement).toBe(1.0);
    expect(results.metrics.governanceIntegrity).toBe(1.0);
    expect(results.metrics.decision).toBe("MODEL_CAPABILITY_BOUNDARY_PERSISTS");
  });
});
