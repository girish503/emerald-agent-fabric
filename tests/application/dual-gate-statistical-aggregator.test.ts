import { describe, expect, it } from "vitest";
import {
  DualGateTrialResult,
  EvaluationExecutionMode,
} from "../../src/domain/dual-gate-evaluation.js";
import { DualGateStatisticalAggregator } from "../../src/application/evaluation/dual-gate-statistical-aggregator.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";

describe("Application: Dual-Gate Statistical Aggregator", () => {
  const modelId = "qwen2.5-coder:1.5b";
  const modelDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";

  function createMockTrial(
    gateId: any,
    index: number,
    overallPassed: boolean,
    timeout: boolean = false,
    mode: EvaluationExecutionMode = "FIXTURE_VALIDATION"
  ): DualGateTrialResult {
    return {
      trialId: `trial-${gateId}-${index}`,
      trialIndex: index,
      taskId: `task-${gateId}-${index}`,
      gateId,
      modelId,
      modelDigest,
      harnessVersion: "cleanroom-eval-v3.0",
      evaluationMode: mode,
      gateA: { passed: overallPassed, score: overallPassed ? 1 : 0, rationale: "", details: [] },
      gateB: { passed: overallPassed, verifierType: "CLEANROOM_ORACLE", details: [], independentEvidenceRef: "" },
      overallPassed,
      durationMs: 1000 + index * 100,
      observedAt: new Date().toISOString(),
      configHash: "a".repeat(64),
      inputHash: "b".repeat(64),
      outputHash: "c".repeat(64),
      trialEvidenceHash: "d".repeat(64),
      failureClassification: timeout ? "TIMEOUT" : overallPassed ? undefined : "MODEL_BEHAVIORAL_FAILURE",
    };
  }

  it("classifies small sample size as INSUFFICIENT_EVIDENCE", () => {
    // G2 requires at least 5 trials
    const trials = [
      createMockTrial("G2_REPO_NAVIGATION", 0, true),
      createMockTrial("G2_REPO_NAVIGATION", 1, true),
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials("G2_REPO_NAVIGATION", modelId, modelDigest, trials);
    expect(summary.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(summary.totalTrials).toBe(2);

    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
    expect(evidence).toBeNull();
  });

  it("classifies trials below required pass threshold as FAILED", () => {
    // G2 requires 80% pass rate (4/5)
    const trials = [
      createMockTrial("G2_REPO_NAVIGATION", 0, true),
      createMockTrial("G2_REPO_NAVIGATION", 1, true),
      createMockTrial("G2_REPO_NAVIGATION", 2, true),
      createMockTrial("G2_REPO_NAVIGATION", 3, false),
      createMockTrial("G2_REPO_NAVIGATION", 4, false),
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials("G2_REPO_NAVIGATION", modelId, modelDigest, trials);
    expect(summary.status).toBe("FAILED");
    expect(summary.successRate).toBe(0.6);

    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
    expect(evidence).toBeNull();
  });

  it("classifies trials exceeding timeout threshold as FAILED", () => {
    const trials = [
      createMockTrial("G2_REPO_NAVIGATION", 0, true),
      createMockTrial("G2_REPO_NAVIGATION", 1, true),
      createMockTrial("G2_REPO_NAVIGATION", 2, true),
      createMockTrial("G2_REPO_NAVIGATION", 3, true),
      createMockTrial("G2_REPO_NAVIGATION", 4, false, true), // timed out
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials("G2_REPO_NAVIGATION", modelId, modelDigest, trials);
    // 1 timeout out of 5 is 20%, exceeds 10% maxTimeoutRate
    expect(summary.status).toBe("FAILED");
  });

  it("certifies PASSED when trials satisfy sample size and pass rate criteria", () => {
    const trials = [
      createMockTrial("G2_REPO_NAVIGATION", 0, true),
      createMockTrial("G2_REPO_NAVIGATION", 1, true),
      createMockTrial("G2_REPO_NAVIGATION", 2, true),
      createMockTrial("G2_REPO_NAVIGATION", 3, true),
      createMockTrial("G2_REPO_NAVIGATION", 4, true),
    ];

    const summary = DualGateStatisticalAggregator.aggregateTrials("G2_REPO_NAVIGATION", modelId, modelDigest, trials);
    expect(summary.status).toBe("PASSED");
    expect(summary.successRate).toBe(1.0);

    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
    expect(evidence).toBeDefined();
    expect(evidence?.gateId).toBe("G2_REPO_NAVIGATION");
    expect(evidence?.outcome).toBe("PASSED");
    expect(evidence?.modelId).toBe(modelId);
    expect(evidence?.modelDigest).toBe(modelDigest);
  });

  describe("Unified 70% minPassRate Threshold (G3 & G4)", () => {
    it("enforces full discrete outcome boundary spectrum (0/5 through 5/5) for both G3 and G4", () => {
      const gates = ["G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"] as const;

      for (const gateId of gates) {
        for (let passedCount = 0; passedCount <= 5; passedCount++) {
          const trials = Array.from({ length: 5 }, (_, i) =>
            createMockTrial(gateId, i, i < passedCount)
          );

          const summary = DualGateStatisticalAggregator.aggregateTrials(
            gateId,
            modelId,
            modelDigest,
            trials
          );
          const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
          const expectedRate = passedCount / 5;

          expect(summary.totalTrials).toBe(5);
          expect(summary.passedTrials).toBe(passedCount);
          expect(summary.failedTrials).toBe(5 - passedCount);
          expect(summary.successRate).toBeCloseTo(expectedRate, 4);

          if (passedCount >= 4) {
            // 4/5 = 80.0%, 5/5 = 100.0% -> PASSED (>= 70%)
            expect(summary.status).toBe("PASSED");
            expect(evidence).not.toBeNull();
            expect(evidence?.outcome).toBe("PASSED");
            expect(evidence?.gateId).toBe(gateId);
          } else {
            // 0/5 = 0%, 1/5 = 20%, 2/5 = 40%, 3/5 = 60% -> FAILED (< 70%)
            expect(summary.status).toBe("FAILED");
            expect(evidence).toBeNull();
            expect(summary.reasons.some((r) => r.includes("below required threshold"))).toBe(true);
          }
        }
      }
    });

    it("enforces exact 70.0% boundary for 10 trials: 6/10 (60%) fails, 7/10 (70%) passes for both G3 and G4", () => {
      const gates = ["G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"] as const;

      for (const gateId of gates) {
        // 6/10 = 60.0% -> FAILED (< 70%)
        const trials6of10 = Array.from({ length: 10 }, (_, i) =>
          createMockTrial(gateId, i, i < 6)
        );
        const summary6 = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, trials6of10);
        expect(summary6.status).toBe("FAILED");
        expect(summary6.successRate).toBe(0.6);
        expect(DualGateStatisticalAggregator.createEvidenceRecord(summary6)).toBeNull();

        // 7/10 = 70.0% -> PASSED (>= 70%)
        const trials7of10 = Array.from({ length: 10 }, (_, i) =>
          createMockTrial(gateId, i, i < 7)
        );
        const summary7 = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, trials7of10);
        expect(summary7.status).toBe("PASSED");
        expect(summary7.successRate).toBe(0.7);
        const evidence7 = DualGateStatisticalAggregator.createEvidenceRecord(summary7);
        expect(evidence7).not.toBeNull();
        expect(evidence7?.outcome).toBe("PASSED");
      }
    });

    it("enforces sample size requirement: fewer than minTrials (5) yields INSUFFICIENT_EVIDENCE even with 100% pass rate", () => {
      const gates = ["G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"] as const;

      for (const gateId of gates) {
        for (let count = 1; count < 5; count++) {
          const trials = Array.from({ length: count }, (_, i) =>
            createMockTrial(gateId, i, true)
          );
          const summary = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, trials);
          expect(summary.status).toBe("INSUFFICIENT_EVIDENCE");
          expect(summary.totalTrials).toBe(count);
          expect(DualGateStatisticalAggregator.createEvidenceRecord(summary)).toBeNull();
        }
      }
    });

    it("enforces timeout threshold: timeout rate > 10% fails certification even when passing rate is satisfied", () => {
      const gates = ["G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"] as const;

      for (const gateId of gates) {
        // 5 trials: 4 passes, 1 timeout (20% timeout rate > 10% maxTimeoutRate) -> FAILED
        const trialsWithTimeout = [
          createMockTrial(gateId, 0, true),
          createMockTrial(gateId, 1, true),
          createMockTrial(gateId, 2, true),
          createMockTrial(gateId, 3, true),
          createMockTrial(gateId, 4, false, true), // timed out
        ];
        const summary = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, trialsWithTimeout);
        expect(summary.status).toBe("FAILED");
        expect(summary.timedOutTrials).toBe(1);
        expect(summary.reasons.some((r) => r.includes("Timeout rate"))).toBe(true);
        expect(DualGateStatisticalAggregator.createEvidenceRecord(summary)).toBeNull();

        // 10 trials: 9 passes, 1 timeout (10% timeout rate <= 10% maxTimeoutRate, 90% pass rate) -> PASSED
        const trials10WithTimeout = [
          ...Array.from({ length: 9 }, (_, i) => createMockTrial(gateId, i, true)),
          createMockTrial(gateId, 9, false, true),
        ];
        const summary10 = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, trials10WithTimeout);
        expect(summary10.status).toBe("PASSED");
        expect(summary10.timedOutTrials).toBe(1);
        expect(DualGateStatisticalAggregator.createEvidenceRecord(summary10)).not.toBeNull();
      }
    });

    it("tracks evaluationMode fidelity: LIVE_MODEL_EVALUATION when all trials live, FIXTURE_VALIDATION if any fixture trial", () => {
      const gateId = "G3_CODE_UNDERSTANDING";

      // All live trials
      const liveTrials = Array.from({ length: 5 }, (_, i) =>
        createMockTrial(gateId, i, true, false, "LIVE_MODEL_EVALUATION")
      );
      const liveSummary = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, liveTrials);
      expect(liveSummary.evaluationMode).toBe("LIVE_MODEL_EVALUATION");
      const liveEvidence = DualGateStatisticalAggregator.createEvidenceRecord(liveSummary);
      expect(liveEvidence?.evaluationMode).toBe("LIVE_MODEL_EVALUATION");

      // Mixed: 4 live, 1 fixture
      const mixedTrials = [
        ...Array.from({ length: 4 }, (_, i) =>
          createMockTrial(gateId, i, true, false, "LIVE_MODEL_EVALUATION")
        ),
        createMockTrial(gateId, 4, true, false, "FIXTURE_VALIDATION"),
      ];
      const mixedSummary = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, mixedTrials);
      expect(mixedSummary.evaluationMode).toBe("FIXTURE_VALIDATION");
      const mixedEvidence = DualGateStatisticalAggregator.createEvidenceRecord(mixedSummary);
      expect(mixedEvidence?.evaluationMode).toBe("FIXTURE_VALIDATION");
    });

    it("integrates with GovernedModelRouterService: certifications at 70% threshold unlock CODER role", () => {
      const router = new GovernedModelRouterService();
      router.applyInstalledInventory([{ name: modelId, digest: modelDigest }]);

      const initialProfile = router.getModelProfile(modelId);
      expect(initialProfile).toBeDefined();

      // Create passing G3 and G4 evidence at 70% threshold (4/5 passes) with LIVE_MODEL_EVALUATION mode
      const g3Trials = Array.from({ length: 5 }, (_, i) =>
        createMockTrial("G3_CODE_UNDERSTANDING", i, i < 4, false, "LIVE_MODEL_EVALUATION")
      );
      const g3Summary = DualGateStatisticalAggregator.aggregateTrials("G3_CODE_UNDERSTANDING", modelId, modelDigest, g3Trials);
      const g3Evidence = DualGateStatisticalAggregator.createEvidenceRecord(g3Summary);
      expect(g3Evidence).not.toBeNull();

      const g4Trials = Array.from({ length: 5 }, (_, i) =>
        createMockTrial("G4_SINGLE_FILE_REPAIR", i, i < 4, false, "LIVE_MODEL_EVALUATION")
      );
      const g4Summary = DualGateStatisticalAggregator.aggregateTrials("G4_SINGLE_FILE_REPAIR", modelId, modelDigest, g4Trials);
      const g4Evidence = DualGateStatisticalAggregator.createEvidenceRecord(g4Summary);
      expect(g4Evidence).not.toBeNull();

      // Apply evidence to router
      router.applyGateEvidence(g3Evidence!);
      router.applyGateEvidence(g4Evidence!);

      // Check gate certification status
      expect(router.getGateCertificationStatus(modelId, "G3_CODE_UNDERSTANDING")).toBe("PASSED");
      expect(router.getGateCertificationStatus(modelId, "G4_SINGLE_FILE_REPAIR")).toBe("PASSED");

      const decision = router.routeModel({
        role: "CODER",
        tenantId: "tenant-a",
        taskId: "task-1",
        contractId: "contract-1",
        remainingBudgetMs: 0,
        stepBudgetMs: 0,
        estimatedContextTokens: 2000,
      });
      expect(decision.selectedModelId).toBe(modelId);
      expect(decision.request.role).toBe("CODER");
      expect(decision.requiredGates).toEqual(["G1_STRUCTURED_JSON", "G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"]);
    });
  });

  describe("Evidence Deduplication and Integrity", () => {
    it("deduplicates trials with identical trialId or identical (taskId, trialIndex)", () => {
      const gateId = "G3_CODE_UNDERSTANDING";
      const baseTrial = createMockTrial(gateId, 0, true);
      // Duplicate submission of same trial 5 times
      const duplicateTrials = [baseTrial, baseTrial, baseTrial, baseTrial, baseTrial];

      const summary = DualGateStatisticalAggregator.aggregateTrials(gateId, modelId, modelDigest, duplicateTrials);
      // Only 1 unique trial should be counted -> INSUFFICIENT_EVIDENCE because 1 < minTrials (5)
      expect(summary.totalTrials).toBe(1);
      expect(summary.status).toBe("INSUFFICIENT_EVIDENCE");
    });
  });
});
