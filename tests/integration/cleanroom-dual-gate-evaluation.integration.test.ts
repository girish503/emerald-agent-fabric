import { describe, expect, it } from "vitest";
import { getBenchmarkTasksForGate } from "../../src/application/evaluation/capability-benchmark-suite.js";
import { DeterministicEvalFixtureModelProvider } from "../../src/application/evaluation/deterministic-eval-fixture-model.js";
import { DualGateEvaluationHarness } from "../../src/application/evaluation/dual-gate-eval-harness.js";
import { DualGateStatisticalAggregator } from "../../src/application/evaluation/dual-gate-statistical-aggregator.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { ModelRoutingError } from "../../src/domain/model-routing.js";

describe("Integration: Clean-Room Dual-Gate Capability Evaluation & Registry Routing", () => {
  const modelId = "qwen2.5-coder:1.5b";
  const modelDigest = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";

  it("evaluates G2_REPO_NAVIGATION, certifies PASSED, and authorizes governed routing", async () => {
    const router = new GovernedModelRouterService();
    router.applyInstalledInventory([
      { name: modelId, digest: modelDigest },
    ]);

    // Initially G2 is unverified
    expect(router.getGateCertificationStatus(modelId, "G2_REPO_NAVIGATION")).toBe("UNVERIFIED");

    // Attempting to route RESEARCHER (requires G1 and G2) fails closed
    expect(() =>
      router.routeModel({
        role: "RESEARCHER",
        tenantId: "tenant-eval",
        taskId: "task-eval-1",
        contractId: "contract-eval-1",
        remainingBudgetMs: 300000,
        stepBudgetMs: 150000,
        estimatedContextTokens: 1000,
      })
    ).toThrowError(/MISSING_GATE_EVIDENCE/);

    // Run cleanroom dual-gate evaluation harness across G2 benchmark tasks
    const tasks = getBenchmarkTasksForGate("G2_REPO_NAVIGATION");
    const harness = new DualGateEvaluationHarness();
    const fixtureModel = new DeterministicEvalFixtureModelProvider({ mode: "ALL_PASS" });

    const trials = [];
    for (const task of tasks) {
      const trial = await harness.executeTrial({
        task,
        modelProvider: fixtureModel,
        modelId,
        modelDigest,
        trialIndex: trials.length,
        evaluationMode: "LIVE_MODEL_EVALUATION",
      });
      trials.push(trial);
    }

    expect(trials.length).toBe(5);
    expect(trials.every((t) => t.overallPassed)).toBe(true);

    // Aggregate statistics
    const summary = DualGateStatisticalAggregator.aggregateTrials("G2_REPO_NAVIGATION", modelId, modelDigest, trials);
    expect(summary.status).toBe("PASSED");
    expect(summary.successRate).toBe(1.0);

    // Create authoritative evidence
    const evidence = DualGateStatisticalAggregator.createEvidenceRecord(summary);
    expect(evidence).toBeDefined();

    // Apply evidence to router
    router.applyGateEvidence(evidence!);
    expect(router.getGateCertificationStatus(modelId, "G2_REPO_NAVIGATION")).toBe("PASSED");

    // Routing RESEARCHER now succeeds
    const decision = router.routeModel({
      role: "RESEARCHER",
      tenantId: "tenant-eval",
      taskId: "task-eval-1",
      contractId: "contract-eval-1",
      remainingBudgetMs: 300000,
      stepBudgetMs: 150000,
      estimatedContextTokens: 1000,
    });

    expect(decision.selectedModelId).toBe(modelId);
    expect(decision.modelDigest).toBe(modelDigest);
    expect(decision.requiredGates).toContain("G2_REPO_NAVIGATION");
  });

  it("fails closed when evidence modelDigest does not match verified registry digest", () => {
    const router = new GovernedModelRouterService();
    const wrongDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    const fakeEvidence = {
      gateId: "G2_REPO_NAVIGATION" as const,
      outcome: "PASSED" as const,
      modelId,
      modelDigest: wrongDigest,
      evaluationVersion: "cleanroom-eval-v1.0",
      evidenceRef: "fake-ref",
      summary: "tampered summary",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    expect(() => router.applyGateEvidence(fakeEvidence)).toThrowError(ModelRoutingError);
    expect(() => router.applyGateEvidence(fakeEvidence)).toThrowError(/does not match verified registry digest/);
  });

  it("fails closed when attempting to apply evidence to unverified model", () => {
    const router = new GovernedModelRouterService();
    // llama3.2:1b has digestVerified: false in registry
    const unverifiedModelId = "llama3.2:1b";

    const evidence = {
      gateId: "G2_REPO_NAVIGATION" as const,
      outcome: "PASSED" as const,
      modelId: unverifiedModelId,
      modelDigest: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      evaluationVersion: "cleanroom-eval-v1.0",
      evidenceRef: "ref-1",
      summary: "test",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    expect(() => router.applyGateEvidence(evidence)).toThrowError(ModelRoutingError);
    expect(() => router.applyGateEvidence(evidence)).toThrowError(/does not have a verified registry digest/);
  });

  it("fails closed when fixture validation evidence is submitted for production routing authorization", () => {
    const router = new GovernedModelRouterService();
    router.applyInstalledInventory([{ name: modelId, digest: modelDigest }]);

    const fixtureEvidence = {
      gateId: "G2_REPO_NAVIGATION" as const,
      outcome: "PASSED" as const,
      modelId,
      modelDigest,
      evaluationVersion: "cleanroom-eval-v1.0",
      evaluationMode: "FIXTURE_VALIDATION" as const,
      evidenceRef: "fixture-eval-ref",
      summary: "fixture run",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    expect(() => router.applyGateEvidence(fixtureEvidence)).toThrowError(ModelRoutingError);
    expect(() => router.applyGateEvidence(fixtureEvidence)).toThrowError(/EVALUATION_MODE_VIOLATION/);
  });
});
