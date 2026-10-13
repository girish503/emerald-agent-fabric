/**
 * Phase 7.2 — Evaluation Trial Domain Contracts & Comparability Test Suite
 *
 * Covers:
 * Domain (Tests 1–17):
 * 1. valid trial creation
 * 2. invalid trial ID
 * 3. invalid task ID
 * 4. invalid task version
 * 5. invalid task hash
 * 6. invalid config fingerprint
 * 7. trial ordinal must be positive
 * 8. trial ordinal is immutable
 * 9. trial identity consistency
 * 10. task identity consistency
 * 11. configuration identity consistency
 * 12. JSON serialization
 * 13. malformed metrics rejected
 * 14. zero metric preserved
 * 15. unavailable metric preserved
 * 16. outcome validation
 * 17. runtime run reference validation
 *
 * Comparable trials (Tests 18–22):
 * 18. same task/config + different ordinal are distinct trials
 * 19. same trial identity cannot represent different task hash
 * 20. different task versions are not interchangeable
 * 21. different config fingerprints are not interchangeable
 * 22. task hash change invalidates equivalence
 */

import { describe, expect, it } from "vitest";
import {
  areTrialsComparable,
  assertTrialsComparable,
  computeEvaluationTaskHash,
  computeEvaluationTrialIdentityHash,
  createEvaluationConfigFingerprint,
  createEvaluationMetrics,
  createEvaluationTask,
  createEvaluationTrial,
  createEvaluationTrialCollection,
  createEvaluationTrialFromRunResult,
  EvaluationConfigFingerprint,
  EvaluationMetrics,
  EvaluationRunResult,
  EvaluationTaskDefinition,
  EvaluationTrial,
  validateEvaluationTrial,
  MAX_TRIAL_ORDINAL,
  MAX_TRIAL_ID_LENGTH,
} from "../../src/domain/evaluation.js";

// ============================================================================
// Helper Factories
// ============================================================================

function createSampleTask(overrides: Partial<EvaluationTaskDefinition> = {}): EvaluationTaskDefinition {
  return createEvaluationTask({
    taskId: "task-alpha",
    version: 1,
    description: "Sample test evaluation task",
    fixture: {
      initialFiles: {
        "readme.txt": "Hello from fixture\n",
      },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    },
    successCriteria: [
      {
        criterionId: "c1",
        kind: "FILE_EXISTS",
        path: "readme.txt",
      },
    ],
    budget: {
      maxSteps: 5,
      maxActions: 3,
      maxWallClockMs: 30000,
    },
    ...overrides,
  });
}

function createSampleFingerprint(
  overrides: Partial<Parameters<typeof createEvaluationConfigFingerprint>[0]> = {}
): EvaluationConfigFingerprint {
  return createEvaluationConfigFingerprint({
    modelProvider: "ollama",
    model: "qwen2.5-coder:7b",
    taskVersion: 1,
    harnessVersion: "harness-0.1",
    generationConfig: { temperature: 0 },
    ...overrides,
  });
}

function createSampleMetrics(overrides: Partial<EvaluationMetrics> = {}): EvaluationMetrics {
  return createEvaluationMetrics({
    steps: 3,
    actions: 2,
    attempts: 2,
    modelCalls: 3,
    toolCalls: 2,
    proposalRejections: 0,
    executionFailures: 0,
    modelFailures: 0,
    wallClockMs: 1200,
    modelLatencyMs: 900,
    toolLatencyMs: 300,
    inputTokens: 150,
    outputTokens: 75,
    totalTokens: 225,
    ...overrides,
  });
}

function createSampleTrialParams(overrides: Partial<Parameters<typeof createEvaluationTrial>[0]> = {}) {
  const task = createSampleTask();
  const taskContentHash = computeEvaluationTaskHash(task);
  const configFingerprint = createSampleFingerprint({ taskVersion: task.version });

  return {
    trialOrdinal: 1,
    taskId: task.taskId,
    taskVersion: task.version,
    taskContentHash,
    configFingerprint,
    runtimeRunId: "run-test-12345",
    outcome: "PASSED" as const,
    statusMessage: "All criteria satisfied",
    verificationPassed: true,
    agentClaimedGoal: true,
    criteriaResults: [
      {
        criterionId: "c1",
        kind: "FILE_EXISTS" as const,
        passed: true,
        message: "File exists",
      },
    ],
    metrics: createSampleMetrics(),
    evidenceReferences: ["action-1", "action-2"],
    startedAt: "2026-10-13T10:00:00.000Z",
    completedAt: "2026-10-13T10:00:01.200Z",
    ...overrides,
  };
}

describe("Phase 7.2 — Evaluation Trial Domain Contracts", () => {
  // 1. valid trial creation
  it("1. valid trial creation initializes frozen record with deterministic identity", () => {
    const params = createSampleTrialParams();
    const trial = createEvaluationTrial(params);

    expect(trial.trialOrdinal).toBe(1);
    expect(trial.taskId).toBe("task-alpha");
    expect(trial.taskVersion).toBe(1);
    expect(trial.taskContentHash).toBe(params.taskContentHash);
    expect(trial.configFingerprint.fingerprintHash).toBe(params.configFingerprint.fingerprintHash);
    expect(trial.runtimeRunId).toBe("run-test-12345");
    expect(trial.outcome).toBe("PASSED");
    expect(trial.verificationPassed).toBe(true);
    expect(trial.agentClaimedGoal).toBe(true);
    expect(trial.metrics.steps).toBe(3);
    expect(trial.trialIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(trial)).toBe(true);
  });

  it("1b. creates valid EvaluationTrial from EvaluationRunResult", () => {
    const params = createSampleTrialParams();
    const runResult: EvaluationRunResult = {
      evaluationRunId: "eval-run-1",
      taskId: params.taskId,
      taskVersion: params.taskVersion,
      taskContentHash: params.taskContentHash,
      configFingerprint: params.configFingerprint,
      trialNumber: 1,
      runId: params.runtimeRunId,
      status: params.outcome,
      statusMessage: params.statusMessage,
      verificationPassed: params.verificationPassed,
      agentClaimedGoal: params.agentClaimedGoal,
      criteriaResults: params.criteriaResults,
      metrics: params.metrics,
      evidenceReferences: params.evidenceReferences,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
    };

    const trial: EvaluationTrial = createEvaluationTrialFromRunResult(runResult, 1);
    expect(trial.trialOrdinal).toBe(1);
    expect(trial.outcome).toBe("PASSED");
    expect(trial.trialIdentityHash).toBe(
      computeEvaluationTrialIdentityHash({
        taskId: runResult.taskId,
        taskVersion: runResult.taskVersion,
        taskContentHash: runResult.taskContentHash,
        configFingerprintHash: runResult.configFingerprint.fingerprintHash,
        trialOrdinal: 1,
      })
    );
  });

  // 2. invalid trial ID
  it("2. invalid trial ID is rejected", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, trialId: "" })).toThrow(/trialId cannot be empty/);
    expect(() => createEvaluationTrial({ ...params, trialId: "trial with spaces" })).toThrow(/alphanumeric/);
    expect(() => createEvaluationTrial({ ...params, trialId: "trial@special!" })).toThrow(/alphanumeric/);
    expect(() => createEvaluationTrial({ ...params, trialId: "a".repeat(MAX_TRIAL_ID_LENGTH + 1) })).toThrow(/exceed/);
  });

  // 3. invalid task ID
  it("3. invalid task ID is rejected", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, taskId: "" })).toThrow(/taskId cannot be empty/);
    expect(() => createEvaluationTrial({ ...params, taskId: "invalid task name" })).toThrow(/alphanumeric/);
    expect(() => createEvaluationTrial({ ...params, taskId: "task#invalid" })).toThrow(/alphanumeric/);
  });

  // 4. invalid task version
  it("4. invalid task version is rejected", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, taskVersion: 0 })).toThrow(/positive integer/);
    expect(() => createEvaluationTrial({ ...params, taskVersion: -1 })).toThrow(/positive integer/);
    expect(() => createEvaluationTrial({ ...params, taskVersion: 1.5 })).toThrow(/positive integer/);
  });

  // 5. invalid task hash
  it("5. invalid task hash is rejected", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, taskContentHash: "not-a-hash" })).toThrow(/64-char hex/);
    expect(() => createEvaluationTrial({ ...params, taskContentHash: "0".repeat(63) })).toThrow(/64-char hex/);
    expect(() => createEvaluationTrial({ ...params, taskContentHash: "0".repeat(65) })).toThrow(/64-char hex/);
  });

  // 6. invalid config fingerprint
  it("6. invalid config fingerprint is rejected", () => {
    const params = createSampleTrialParams();
    const badFingerprint = {
      ...params.configFingerprint,
      fingerprintHash: "invalid-hash",
    };

    expect(() => createEvaluationTrial({ ...params, configFingerprint: badFingerprint as any })).toThrow(/64-char hex/);
  });

  // 7. trial ordinal must be positive
  it("7. trial ordinal must be a positive bounded integer", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, trialOrdinal: 0 })).toThrow(/positive integer/);
    expect(() => createEvaluationTrial({ ...params, trialOrdinal: -5 })).toThrow(/positive integer/);
    expect(() => createEvaluationTrial({ ...params, trialOrdinal: MAX_TRIAL_ORDINAL + 1 })).toThrow(/between 1 and/);
    expect(() =>
      validateEvaluationTrial({
        ...createEvaluationTrial(params),
        trialOrdinal: MAX_TRIAL_ORDINAL + 1,
      })
    ).toThrow(/cannot exceed/);
  });

  // 8. trial ordinal is immutable
  it("8. trial ordinal and record fields are deeply immutable", () => {
    const trial = createEvaluationTrial(createSampleTrialParams());

    expect(Object.isFrozen(trial)).toBe(true);
    expect(() => {
      (trial as any).trialOrdinal = 2;
    }).toThrow();
    expect(trial.trialOrdinal).toBe(1);
  });

  // 9. trial identity consistency
  it("9. trial identity hash mismatch is rejected", () => {
    const params = createSampleTrialParams();
    const forgedIdentityHash = "f".repeat(64);

    expect(() =>
      createEvaluationTrial({
        ...params,
        trialIdentityHash: forgedIdentityHash,
      })
    ).toThrow(/trialIdentityHash mismatch/);
  });

  // 10. task identity consistency
  it("10. inconsistent taskVersion between trial and configFingerprint is rejected", () => {
    const params = createSampleTrialParams({ taskVersion: 2 });
    // configFingerprint has taskVersion 1

    expect(() => createEvaluationTrial(params)).toThrow(/Inconsistent taskVersion/);
  });

  // 11. configuration identity consistency
  it("11. configuration fingerprint hash tampering is rejected", () => {
    const params = createSampleTrialParams();
    const tamperedFingerprint = {
      ...params.configFingerprint,
      fingerprintHash: "a".repeat(64),
    };

    expect(() =>
      validateEvaluationTrial({
        ...createEvaluationTrial(params),
        configFingerprint: tamperedFingerprint,
      })
    ).toThrow(/Inconsistent configFingerprint/);
  });

  // 12. JSON serialization
  it("12. JSON serialization produces identical validated trial record", () => {
    const trial = createEvaluationTrial(createSampleTrialParams());
    const serialized = JSON.stringify(trial);
    const parsed = JSON.parse(serialized);
    const validated = validateEvaluationTrial(parsed);

    expect(validated).toEqual(trial);
  });

  // 13. malformed metrics rejected
  it("13. malformed metrics are rejected", () => {
    const params = createSampleTrialParams();

    expect(() =>
      createEvaluationTrial({
        ...params,
        metrics: { ...params.metrics, steps: -1 } as any,
      })
    ).toThrow();
  });

  // 14. zero metric preserved
  it("14. observed zero in metrics is preserved without modification", () => {
    const metrics = createSampleMetrics({
      inputTokens: 0,
      proposalRejections: 0,
      executionFailures: 0,
    });
    const trial = createEvaluationTrial(createSampleTrialParams({ metrics }));

    expect(trial.metrics.inputTokens).toBe(0);
    expect(trial.metrics.proposalRejections).toBe(0);
    expect(trial.metrics.executionFailures).toBe(0);
  });

  // 15. unavailable metric preserved
  it("15. unavailable metric is preserved as undefined and not coerced to zero", () => {
    const metrics = createSampleMetrics({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      modelLatencyMs: undefined,
    });
    const trial = createEvaluationTrial(createSampleTrialParams({ metrics }));

    expect(trial.metrics.inputTokens).toBeUndefined();
    expect(trial.metrics.outputTokens).toBeUndefined();
    expect(trial.metrics.totalTokens).toBeUndefined();
    expect(trial.metrics.modelLatencyMs).toBeUndefined();
  });

  // 16. outcome validation
  it("16. outcome validation strictly rejects unknown statuses", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, outcome: "SUCCEEDED" as any })).toThrow(/outcome/);
    expect(() => createEvaluationTrial({ ...params, outcome: "UNKNOWN" as any })).toThrow(/outcome/);

    const validTrial = createEvaluationTrial({ ...params, outcome: "FAILED" });
    expect(validTrial.outcome).toBe("FAILED");
  });

  // 17. runtime run reference validation
  it("17. runtime run reference validation rejects empty reference", () => {
    const params = createSampleTrialParams();

    expect(() => createEvaluationTrial({ ...params, runtimeRunId: "" })).toThrow(/runtimeRunId cannot be empty/);
  });
});

describe("Phase 7.2 — Comparable Trials", () => {
  // 18. same task/config + different ordinal are distinct trials
  it("18. repeated trials with same task/config and different ordinals are comparable and distinct", () => {
    const params = createSampleTrialParams();
    const trial1 = createEvaluationTrial({ ...params, trialOrdinal: 1 });
    const trial2 = createEvaluationTrial({ ...params, trialOrdinal: 2 });

    expect(trial1.trialOrdinal).toBe(1);
    expect(trial2.trialOrdinal).toBe(2);
    expect(trial1.trialIdentityHash).not.toBe(trial2.trialIdentityHash);
    expect(trial1.trialId).not.toBe(trial2.trialId);
    expect(areTrialsComparable(trial1, trial2)).toBe(true);
    expect(() => assertTrialsComparable([trial1, trial2])).not.toThrow();
  });

  // 19. same trial identity cannot represent different task hash
  it("19. trial comparison rejects different taskContentHash", () => {
    const params = createSampleTrialParams();
    const trial1 = createEvaluationTrial(params);
    const trial2 = createEvaluationTrial({
      ...params,
      taskContentHash: "b".repeat(64),
      trialOrdinal: 2,
    });

    expect(areTrialsComparable(trial1, trial2)).toBe(false);
    expect(() => assertTrialsComparable([trial1, trial2])).toThrow(/taskContentHash mismatch/);
  });

  // 20. different task versions are not interchangeable
  it("20. different task versions are not comparable", () => {
    const paramsV1 = createSampleTrialParams({ taskVersion: 1 });
    const fpV2 = createSampleFingerprint({ taskVersion: 2 });
    const paramsV2 = createSampleTrialParams({
      taskVersion: 2,
      configFingerprint: fpV2,
      trialOrdinal: 2,
    });

    const trialV1 = createEvaluationTrial(paramsV1);
    const trialV2 = createEvaluationTrial(paramsV2);

    expect(areTrialsComparable(trialV1, trialV2)).toBe(false);
    expect(() => assertTrialsComparable([trialV1, trialV2])).toThrow(/taskVersion mismatch/);
  });

  // 21. different config fingerprints are not interchangeable
  it("21. different config fingerprints are not comparable", () => {
    const params = createSampleTrialParams();
    const trial1 = createEvaluationTrial(params);

    const fpDifferentModel = createSampleFingerprint({ model: "different-model" });
    const trialDifferentModel = createEvaluationTrial({
      ...params,
      configFingerprint: fpDifferentModel,
      trialOrdinal: 2,
    });

    expect(areTrialsComparable(trial1, trialDifferentModel)).toBe(false);
    expect(() => assertTrialsComparable([trial1, trialDifferentModel])).toThrow(/configFingerprint mismatch/);
  });

  // 22. task hash change invalidates equivalence
  it("22. task hash change invalidates trial equivalence even if taskId and version match", () => {
    const taskA = createSampleTask();
    const taskB = createSampleTask({
      fixture: { initialFiles: { "readme.txt": "Different fixture\n" } },
    });

    const hashA = computeEvaluationTaskHash(taskA);
    const hashB = computeEvaluationTaskHash(taskB);
    expect(hashA).not.toBe(hashB);

    const trialA = createEvaluationTrial(createSampleTrialParams({ taskContentHash: hashA, trialOrdinal: 1 }));
    const trialB = createEvaluationTrial(createSampleTrialParams({ taskContentHash: hashB, trialOrdinal: 2 }));

    expect(areTrialsComparable(trialA, trialB)).toBe(false);
    expect(() => assertTrialsComparable([trialA, trialB])).toThrow(/taskContentHash mismatch/);
  });

  it("22b. creates bounded, deterministic EvaluationTrialCollection", () => {
    const params = createSampleTrialParams();
    const trial2 = createEvaluationTrial({ ...params, trialOrdinal: 2 });
    const trial1 = createEvaluationTrial({ ...params, trialOrdinal: 1 });

    const collection = createEvaluationTrialCollection([trial2, trial1]);
    expect(collection.trials[0]!.trialOrdinal).toBe(1);
    expect(collection.trials[1]!.trialOrdinal).toBe(2);

    // Duplicate ordinal rejected
    expect(() => createEvaluationTrialCollection([trial1, trial1])).toThrow(/Duplicate trialOrdinal/);
    // Empty collection rejected
    expect(() => createEvaluationTrialCollection([])).toThrow(/empty/);
  });
});
