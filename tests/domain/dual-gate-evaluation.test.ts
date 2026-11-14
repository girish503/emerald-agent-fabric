import { describe, expect, it } from "vitest";
import {
  computeTrialEvidenceHash,
  GATE_EVALUATION_THRESHOLDS,
} from "../../src/domain/dual-gate-evaluation.js";
import {
  CAPABILITY_GATE_DEFINITIONS,
  MODEL_CAPABILITY_GATE_IDS,
} from "../../src/domain/model-routing.js";

describe("Domain: Dual-Gate Model Evaluation", () => {
  it("defines explicit statistical thresholds for every capability gate G1-G10", () => {
    for (const gateId of MODEL_CAPABILITY_GATE_IDS) {
      const threshold = GATE_EVALUATION_THRESHOLDS[gateId];
      expect(threshold).toBeDefined();
      expect(threshold.minTrials).toBeGreaterThanOrEqual(3);
      expect(threshold.minPassRate).toBeGreaterThanOrEqual(0.6);
      expect(threshold.minPassRate).toBeLessThanOrEqual(1.0);
      expect(threshold.maxTimeoutRate).toBeGreaterThanOrEqual(0.0);
      expect(threshold.maxTimeoutRate).toBeLessThanOrEqual(0.1);
    }
  });

  it("enforces ratified unified 70% pass-rate threshold for G3 and G4", () => {
    expect(GATE_EVALUATION_THRESHOLDS.G3_CODE_UNDERSTANDING).toEqual({
      minTrials: 5,
      minPassRate: 0.7,
      maxTimeoutRate: 0.1,
    });
    expect(GATE_EVALUATION_THRESHOLDS.G4_SINGLE_FILE_REPAIR).toEqual({
      minTrials: 5,
      minPassRate: 0.7,
      maxTimeoutRate: 0.1,
    });

    expect(CAPABILITY_GATE_DEFINITIONS.G3_CODE_UNDERSTANDING.passCriteria).toContain("70%");
    expect(CAPABILITY_GATE_DEFINITIONS.G4_SINGLE_FILE_REPAIR.passCriteria).toContain("70%");
  });

  it("computes deterministic cryptographic trial evidence hashes", () => {
    const trial1 = {
      trialId: "trial-1",
      taskId: "task-nav-1",
      gateId: "G2_REPO_NAVIGATION",
      modelId: "qwen2.5-coder:1.5b",
      modelDigest: "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668",
      harnessVersion: "cleanroom-eval-v1.0",
      evaluationMode: "LIVE_MODEL_EVALUATION",
      observedAt: "2026-11-11T12:00:00.000Z",
      configHash: "a".repeat(64),
      inputHash: "b".repeat(64),
      outputHash: "c".repeat(64),
      gateAPassed: true,
      gateBPassed: true,
      overallPassed: true,
    };

    const hash1 = computeTrialEvidenceHash(trial1);
    const hash2 = computeTrialEvidenceHash(trial1);
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);

    // Tampering outcome changes the hash
    const tampered = { ...trial1, overallPassed: false };
    const tamperedHash = computeTrialEvidenceHash(tampered);
    expect(tamperedHash).not.toBe(hash1);

    // Tampering evaluationMode changes the hash
    const tamperedMode = { ...trial1, evaluationMode: "FIXTURE_VALIDATION" };
    const tamperedModeHash = computeTrialEvidenceHash(tamperedMode);
    expect(tamperedModeHash).not.toBe(hash1);
  });
});
