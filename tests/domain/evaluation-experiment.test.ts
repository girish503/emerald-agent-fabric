/**
 * Phase 7.3 — Controlled Evaluation Experiment Contracts Test Suite
 *
 * Comprehensive tests for controlled evaluation experiment contracts across:
 * Domain (Tests 1–18):
 * 1. valid experiment creation
 * 2. invalid experiment ID
 * 3. invalid experiment version
 * 4. invalid experiment content hash
 * 5. hypothesis validation
 * 6. task identity validation
 * 7. condition validation
 * 8. configuration fingerprint validation
 * 9. planned trial count validation
 * 10. status validation
 * 11. deterministic experiment hashing
 * 12. key-order-independent hashing
 * 13. hash changes when semantic content changes
 * 14. ephemeral fields excluded from semantic hash
 * 15. JSON serialization
 * 16. secret keyword rejection
 * 17. authority field rejection
 * 18. immutable semantic identity
 *
 * Conditions (Tests 19–23):
 * 19. valid condition
 * 20. condition identity stability
 * 21. different configuration produces different condition identity
 * 22. condition cannot contain authority
 * 23. configuration mutation cannot alter historical identity
 *
 * Trial membership (Tests 24–30):
 * 24. compatible trial accepted
 * 25. task mismatch rejected
 * 26. task version mismatch rejected
 * 27. task hash mismatch rejected
 * 28. configuration mismatch rejected
 * 29. incomparable trial rejected
 * 30. trial ordinal does not affect condition comparability
 *
 * Experiment invariants (Tests 31–38):
 * 31. experiment reuses existing EvaluationTrial comparability
 * 32. experiment does not create Runtime Run state
 * 33. experiment has no execution authority
 * 34. experiment does not override objective verification
 * 35. invalid experiment cannot be constructed
 * 36. trial collection remains deterministic
 * 37. duplicate semantic trial membership is rejected
 * 38. planned count does not become statistical sample-size logic
 */

import { describe, expect, it } from "vitest";
import {
  areTrialsComparable,
  assertTrialCompatibleWithCondition,
  computeConditionHash,
  computeEvaluationExperimentHash,
  computeEvaluationTaskHash,
  createEvaluationConfigFingerprint,
  createEvaluationExperiment,
  createEvaluationMetrics,
  createEvaluationTask,
  createEvaluationTrial,
  createExperimentCondition,
  createTaskReference,
  EvaluationConfigFingerprint,
  EvaluationExperiment,
  EvaluationExperimentCondition,
  EvaluationTaskDefinition,
  isTrialCompatibleWithCondition,
  validateEvaluationExperiment,
  validateExperimentCondition,
  validateExperimentConditionTrials,
  MAX_EXPERIMENT_ID_LENGTH,
  MAX_PLANNED_TRIAL_COUNT,
  CURRENT_HARNESS_VERSION,
} from "../../src/domain/evaluation.js";

// ============================================================================
// Helper Factories
// ============================================================================

function createSampleTask(overrides: Partial<EvaluationTaskDefinition> = {}): EvaluationTaskDefinition {
  return createEvaluationTask({
    taskId: "benchmark-task-1",
    version: 1,
    description: "Controlled benchmark evaluation task",
    fixture: {
      initialFiles: { "src/input.txt": "Original data\n" },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    },
    successCriteria: [
      { criterionId: "c1", kind: "FILE_EXISTS", path: "src/input.txt" },
    ],
    budget: { maxSteps: 5, maxActions: 3, maxWallClockMs: 60000 },
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
    harnessVersion: CURRENT_HARNESS_VERSION,
    generationConfig: { temperature: 0.2 },
    ...overrides,
  });
}

function createSampleCondition(
  conditionId = "condition-a",
  overrides: Partial<Parameters<typeof createExperimentCondition>[0]> = {}
): EvaluationExperimentCondition {
  return createExperimentCondition({
    conditionId,
    name: `Condition ${conditionId}`,
    description: `Controlled condition for ${conditionId}`,
    configFingerprint: createSampleFingerprint(),
    ...overrides,
  });
}

function createSampleExperimentParams(
  overrides: Partial<Parameters<typeof createEvaluationExperiment>[0]> = {}
) {
  const task = createSampleTask();
  const condA = createSampleCondition("condition-a");
  const condB = createSampleCondition("condition-b", {
    configFingerprint: createSampleFingerprint({ model: "llama3.2:3b" }),
  });

  return {
    experimentId: "exp-model-comparison",
    version: 1,
    title: "Comparison of Local Open-Source Models on File Tasks",
    description: "Evaluates task completion across Qwen and Llama local models under harness-0.1",
    hypothesis: "Qwen2.5-coder achieves higher objective verification rate than Llama3.2 on structured coding tasks.",
    taskRef: createTaskReference(task),
    conditions: [condA, condB],
    plannedTrialCount: 5,
    harnessVersion: CURRENT_HARNESS_VERSION,
    status: "DRAFT" as const,
    ...overrides,
  };
}

describe("Phase 7.3 — Evaluation Experiment Domain Contracts", () => {
  // 1. valid experiment creation
  it("1. valid experiment creation initializes frozen, deterministic experiment", () => {
    const params = createSampleExperimentParams();
    const exp = createEvaluationExperiment(params);

    expect(exp.experimentId).toBe("exp-model-comparison");
    expect(exp.version).toBe(1);
    expect(exp.title).toContain("Comparison");
    expect(exp.hypothesis).toContain("Qwen2.5-coder");
    expect(exp.taskRef.taskId).toBe("benchmark-task-1");
    expect(exp.taskRef.taskVersion).toBe(1);
    expect(exp.conditions).toHaveLength(2);
    expect(exp.conditions[0]!.conditionId).toBe("condition-a");
    expect(exp.conditions[1]!.conditionId).toBe("condition-b");
    expect(exp.plannedTrialCount).toBe(5);
    expect(exp.status).toBe("DRAFT");
    expect(exp.experimentContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(exp)).toBe(true);
  });

  // 2. invalid experiment ID
  it("2. invalid experiment ID is rejected", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, experimentId: "" })).toThrow(/experimentId cannot be empty/);
    expect(() => createEvaluationExperiment({ ...params, experimentId: "exp with space" })).toThrow(/alphanumeric/);
    expect(() => createEvaluationExperiment({ ...params, experimentId: "exp@special" })).toThrow(/alphanumeric/);
    expect(() => createEvaluationExperiment({ ...params, experimentId: "a".repeat(MAX_EXPERIMENT_ID_LENGTH + 1) })).toThrow(/cannot exceed/);
  });

  // 3. invalid experiment version
  it("3. invalid experiment version is rejected", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, version: 0 })).toThrow(/positive integer/);
    expect(() => createEvaluationExperiment({ ...params, version: -1 })).toThrow(/positive integer/);
    expect(() => createEvaluationExperiment({ ...params, version: 1.5 })).toThrow(/positive integer/);
  });

  // 4. invalid experiment content hash
  it("4. invalid experiment content hash is rejected", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, experimentContentHash: "not-a-hash" })).toThrow(/64-char hex/);
    expect(() => createEvaluationExperiment({ ...params, experimentContentHash: "0".repeat(64) })).toThrow(/experimentContentHash mismatch/);
  });

  // 5. hypothesis validation
  it("5. hypothesis validation rejects empty, non-string, or oversized values", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, hypothesis: "" })).toThrow(/hypothesis cannot be empty/);
    expect(() => createEvaluationExperiment({ ...params, hypothesis: "a".repeat(4097) })).toThrow(/cannot exceed/);
  });

  // 6. task identity validation
  it("6. task identity validation rejects malformed task reference", () => {
    const params = createSampleExperimentParams();

    expect(() =>
      createEvaluationExperiment({
        ...params,
        taskRef: { taskId: "", taskVersion: 1, taskContentHash: "a".repeat(64) },
      })
    ).toThrow(/taskId cannot be empty/);

    expect(() =>
      createEvaluationExperiment({
        ...params,
        taskRef: { taskId: "t1", taskVersion: 0, taskContentHash: "a".repeat(64) },
      })
    ).toThrow(/positive integer/);

    expect(() =>
      createEvaluationExperiment({
        ...params,
        taskRef: { taskId: "t1", taskVersion: 1, taskContentHash: "short-hash" },
      })
    ).toThrow(/64-char hex/);
  });

  // 7. condition validation
  it("7. condition validation enforces bounds and uniqueness", () => {
    const params = createSampleExperimentParams();

    // Empty conditions rejected
    expect(() => createEvaluationExperiment({ ...params, conditions: [] })).toThrow(/at least one condition/);

    // Duplicate condition IDs rejected
    const condA1 = createSampleCondition("cond-1");
    const condA2 = createSampleCondition("cond-1");
    expect(() => createEvaluationExperiment({ ...params, conditions: [condA1, condA2] })).toThrow(/Duplicate conditionId/);
  });

  // 8. configuration fingerprint validation
  it("8. configuration fingerprint validation enforces taskVersion and harnessVersion alignment", () => {
    const params = createSampleExperimentParams();

    // Mismatched taskVersion between condition and taskRef
    const badTaskVersionFp = createSampleFingerprint({ taskVersion: 2 });
    const badTaskVersionCond = createSampleCondition("cond-mismatch", { configFingerprint: badTaskVersionFp });
    expect(() => createEvaluationExperiment({ ...params, conditions: [badTaskVersionCond] })).toThrow(/taskVersion.*does not match/);

    // Mismatched harnessVersion
    const badHarnessFp = createSampleFingerprint({ harnessVersion: "harness-9.9" });
    const badHarnessCond = createSampleCondition("cond-harness", { configFingerprint: badHarnessFp });
    expect(() => createEvaluationExperiment({ ...params, conditions: [badHarnessCond] })).toThrow(/harnessVersion.*does not match/);
  });

  // 9. planned trial count validation
  it("9. planned trial count must be a positive bounded integer", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, plannedTrialCount: 0 })).toThrow(/positive integer/);
    expect(() => createEvaluationExperiment({ ...params, plannedTrialCount: -3 })).toThrow(/positive integer/);
    expect(() => createEvaluationExperiment({ ...params, plannedTrialCount: 2.5 })).toThrow(/positive integer/);
    expect(() => createEvaluationExperiment({ ...params, plannedTrialCount: MAX_PLANNED_TRIAL_COUNT + 1 })).toThrow(/cannot exceed/);
  });

  // 10. status validation
  it("10. status validation strictly permits defined experiment statuses", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, status: "PENDING" as any })).toThrow(/status/);
    expect(() => createEvaluationExperiment({ ...params, status: "RUNNING" })).not.toThrow();
    expect(() => createEvaluationExperiment({ ...params, status: "COMPLETED" })).not.toThrow();
  });

  // 11. deterministic experiment hashing
  it("11. deterministic experiment hashing produces consistent hash across invocations", () => {
    const params = createSampleExperimentParams();
    const exp1 = createEvaluationExperiment(params);
    const exp2 = createEvaluationExperiment(params);

    expect(exp1.experimentContentHash).toBe(exp2.experimentContentHash);
  });

  // 12. key-order-independent hashing
  it("12. condition ordering in experiment definition does not alter canonical content hash", () => {
    const task = createSampleTask();
    const condA = createSampleCondition("cond-a");
    const condB = createSampleCondition("cond-b", {
      configFingerprint: createSampleFingerprint({ model: "llama3.2:3b" }),
    });

    const expAB = createEvaluationExperiment({
      experimentId: "exp-order-test",
      version: 1,
      title: "Order Test",
      description: "Testing order invariance",
      hypothesis: "Order should not change hash",
      taskRef: createTaskReference(task),
      conditions: [condA, condB],
      plannedTrialCount: 3,
    });

    const expBA = createEvaluationExperiment({
      experimentId: "exp-order-test",
      version: 1,
      title: "Order Test",
      description: "Testing order invariance",
      hypothesis: "Order should not change hash",
      taskRef: createTaskReference(task),
      conditions: [condB, condA], // Reversed order
      plannedTrialCount: 3,
    });

    expect(expAB.experimentContentHash).toBe(expBA.experimentContentHash);
  });

  // 13. hash changes when semantic content changes
  it("13. experiment content hash changes when any semantic definition field changes", () => {
    const baseParams = createSampleExperimentParams();
    const baseHash = createEvaluationExperiment(baseParams).experimentContentHash;

    const modifiedTitleHash = createEvaluationExperiment({
      ...baseParams,
      title: "Modified Experiment Title",
    }).experimentContentHash;
    expect(modifiedTitleHash).not.toBe(baseHash);

    const modifiedHypothesisHash = createEvaluationExperiment({
      ...baseParams,
      hypothesis: "Alternative hypothesis statement.",
    }).experimentContentHash;
    expect(modifiedHypothesisHash).not.toBe(baseHash);

    const modifiedCountHash = createEvaluationExperiment({
      ...baseParams,
      plannedTrialCount: 10,
    }).experimentContentHash;
    expect(modifiedCountHash).not.toBe(baseHash);
  });

  // 14. ephemeral fields excluded from semantic hash
  it("14. ephemeral lifecycle status is excluded from semantic content hash", () => {
    const params = createSampleExperimentParams();
    const draftExp = createEvaluationExperiment({ ...params, status: "DRAFT" });
    const runningExp = createEvaluationExperiment({ ...params, status: "RUNNING" });
    const completedExp = createEvaluationExperiment({ ...params, status: "COMPLETED" });

    expect(draftExp.experimentContentHash).toBe(runningExp.experimentContentHash);
    expect(draftExp.experimentContentHash).toBe(completedExp.experimentContentHash);
  });

  // 15. JSON serialization
  it("15. JSON serialization round-trips cleanly and validates identically", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const json = JSON.stringify(exp);
    const parsed = JSON.parse(json);
    const validated = validateEvaluationExperiment(parsed);

    expect(validated).toEqual(exp);
  });

  // 16. secret keyword rejection
  it("16. secret and credential keywords in experiment metadata are rejected", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, experimentId: "exp-api-key-test" })).toThrow(/sensitive keyword/);
    expect(() => createEvaluationExperiment({ ...params, title: "secret-benchmark-experiment" })).toThrow(/sensitive keyword/);
  });

  // 17. authority field rejection
  it("17. authority fields in experiment metadata are rejected", () => {
    const params = createSampleExperimentParams();

    expect(() => createEvaluationExperiment({ ...params, experimentId: "exp-workerId-injection" })).toThrow(/forbidden authority keyword/);
    expect(() => createEvaluationExperiment({ ...params, title: "Grant capability to agent" })).toThrow(/forbidden authority keyword/);
  });

  // 18. immutable semantic identity
  it("18. experiment instance and child references are deeply frozen and immutable", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());

    expect(Object.isFrozen(exp)).toBe(true);
    expect(Object.isFrozen(exp.conditions)).toBe(true);
    expect(Object.isFrozen(exp.taskRef)).toBe(true);
    expect(() => {
      (exp as any).status = "RUNNING";
    }).toThrow();
  });
});

describe("Phase 7.3 — Experiment Conditions", () => {
  // 19. valid condition
  it("19. valid condition initializes frozen record with deterministic conditionHash", () => {
    const cond = createSampleCondition("cond-qwen");

    expect(cond.conditionId).toBe("cond-qwen");
    expect(cond.name).toContain("cond-qwen");
    expect(cond.conditionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(cond)).toBe(true);
  });

  // 20. condition identity stability
  it("20. condition identity hash is stable across calls with same parameters", () => {
    const fp = createSampleFingerprint();
    const hash1 = computeConditionHash({ conditionId: "c1", configFingerprintHash: fp.fingerprintHash });
    const hash2 = computeConditionHash({ conditionId: "c1", configFingerprintHash: fp.fingerprintHash });

    expect(hash1).toBe(hash2);
  });

  // 21. different configuration produces different condition identity
  it("21. different configuration fingerprints produce distinct condition hashes", () => {
    const fpA = createSampleFingerprint({ model: "model-a" });
    const fpB = createSampleFingerprint({ model: "model-b" });

    const hashA = computeConditionHash({ conditionId: "cond", configFingerprintHash: fpA.fingerprintHash });
    const hashB = computeConditionHash({ conditionId: "cond", configFingerprintHash: fpB.fingerprintHash });

    expect(hashA).not.toBe(hashB);
  });

  // 22. condition cannot contain authority
  it("22. condition definition cannot contain authority keys or credentials", () => {
    expect(() =>
      createSampleCondition("cond-leaseId-bypass")
    ).toThrow(/forbidden authority keyword/);

    expect(() =>
      createSampleCondition("cond-token-secret")
    ).toThrow(/sensitive keyword/);
  });

  // 23. configuration mutation cannot alter historical identity
  it("23. configuration fingerprint is frozen preventing in-place mutation of historical identity", () => {
    const cond = createSampleCondition("cond-immutable");

    expect(Object.isFrozen(cond.configFingerprint)).toBe(true);
    expect(() => {
      (cond.configFingerprint as any).model = "mutated-model";
    }).toThrow();
  });
});

describe("Phase 7.3 — Trial Membership & Fencing", () => {
  function createTrialForTaskAndCondition(
    task: EvaluationTaskDefinition,
    cond: EvaluationExperimentCondition,
    ordinal = 1
  ) {
    const taskContentHash = computeEvaluationTaskHash(task);
    return createEvaluationTrial({
      trialOrdinal: ordinal,
      taskId: task.taskId,
      taskVersion: task.version,
      taskContentHash,
      configFingerprint: cond.configFingerprint,
      runtimeRunId: `run-test-${ordinal}`,
      outcome: "PASSED",
      statusMessage: "Criteria verified",
      verificationPassed: true,
      agentClaimedGoal: true,
      criteriaResults: [{ criterionId: "c1", kind: "FILE_EXISTS", passed: true, message: "OK" }],
      metrics: createEvaluationMetrics({
        steps: 2,
        actions: 1,
        attempts: 1,
        modelCalls: 2,
        toolCalls: 1,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 500,
      }),
      evidenceReferences: ["action-1"],
      startedAt: "2026-10-13T10:00:00.000Z",
      completedAt: "2026-10-13T10:00:00.500Z",
    });
  }

  // 24. compatible trial accepted
  it("24. compatible trial is accepted into experiment condition", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const task = createSampleTask();
    const trial = createTrialForTaskAndCondition(task, condA, 1);

    expect(isTrialCompatibleWithCondition(trial, exp, "condition-a")).toBe(true);
    expect(() => assertTrialCompatibleWithCondition(trial, exp, "condition-a")).not.toThrow();
  });

  // 25. task mismatch rejected
  it("25. trial with different taskId is rejected from condition", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const differentTask = createSampleTask({ taskId: "other-task" });
    const trial = createTrialForTaskAndCondition(differentTask, condA, 1);

    expect(isTrialCompatibleWithCondition(trial, exp, "condition-a")).toBe(false);
    expect(() => assertTrialCompatibleWithCondition(trial, exp, "condition-a")).toThrow(/Trial task mismatch/);
  });

  // 26. task version mismatch rejected
  it("26. trial with different taskVersion is rejected from condition", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    // Same taskId, version 2
    const v2Task = createSampleTask({ version: 2 });
    const trial = createTrialForTaskAndCondition(v2Task, {
      ...condA,
      configFingerprint: createSampleFingerprint({ taskVersion: 2 }),
    }, 1);

    expect(isTrialCompatibleWithCondition(trial, exp, "condition-a")).toBe(false);
    expect(() => assertTrialCompatibleWithCondition(trial, exp, "condition-a")).toThrow(/task version mismatch/);
  });

  // 27. task hash mismatch rejected
  it("27. trial with modified task fixture content hash is rejected from condition", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const alteredFixtureTask = createSampleTask({
      fixture: { initialFiles: { "src/input.txt": "Altered content\n" } },
    });
    const trial = createTrialForTaskAndCondition(alteredFixtureTask, condA, 1);

    expect(isTrialCompatibleWithCondition(trial, exp, "condition-a")).toBe(false);
    expect(() => assertTrialCompatibleWithCondition(trial, exp, "condition-a")).toThrow(/content hash mismatch/);
  });

  // 28. configuration mismatch rejected
  it("28. trial with configuration fingerprint mismatch is rejected from condition", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const task = createSampleTask();
    // Trial run with condition-b config, attempted membership into condition-a
    const condB = exp.conditions[1]!;
    const trialB = createTrialForTaskAndCondition(task, condB, 1);

    expect(isTrialCompatibleWithCondition(trialB, exp, "condition-a")).toBe(false);
    expect(() => assertTrialCompatibleWithCondition(trialB, exp, "condition-a")).toThrow(/fingerprint mismatch/);
  });

  // 29. incomparable trial rejected
  it("29. incomparable trial throws descriptive error and fails closed", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const wrongTask = createSampleTask({ taskId: "incompatible-task" });
    const condA = exp.conditions[0]!;
    const trial = createTrialForTaskAndCondition(wrongTask, condA, 1);

    expect(() => validateExperimentConditionTrials(exp, "condition-a", [trial])).toThrow();
  });

  // 30. trial ordinal does not affect condition comparability
  it("30. trial ordinal does not affect condition compatibility", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const task = createSampleTask();

    const trial1 = createTrialForTaskAndCondition(task, condA, 1);
    const trial2 = createTrialForTaskAndCondition(task, condA, 2);

    expect(isTrialCompatibleWithCondition(trial1, exp, "condition-a")).toBe(true);
    expect(isTrialCompatibleWithCondition(trial2, exp, "condition-a")).toBe(true);
  });
});

describe("Phase 7.3 — Experiment Invariants", () => {
  function createTrial(task: EvaluationTaskDefinition, cond: EvaluationExperimentCondition, ordinal: number) {
    const taskContentHash = computeEvaluationTaskHash(task);
    return createEvaluationTrial({
      trialOrdinal: ordinal,
      taskId: task.taskId,
      taskVersion: task.version,
      taskContentHash,
      configFingerprint: cond.configFingerprint,
      runtimeRunId: `run-test-${ordinal}`,
      outcome: "PASSED",
      statusMessage: "Criteria verified",
      verificationPassed: true,
      agentClaimedGoal: true,
      criteriaResults: [{ criterionId: "c1", kind: "FILE_EXISTS", passed: true, message: "OK" }],
      metrics: createEvaluationMetrics({
        steps: 2,
        actions: 1,
        attempts: 1,
        modelCalls: 2,
        toolCalls: 1,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 500,
      }),
      evidenceReferences: ["action-1"],
      startedAt: "2026-10-13T10:00:00.000Z",
      completedAt: "2026-10-13T10:00:00.500Z",
    });
  }

  // 31. experiment reuses existing EvaluationTrial comparability
  it("31. trials validated under the same condition satisfy areTrialsComparable", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const task = createSampleTask();

    const trial1 = createTrial(task, condA, 1);
    const trial2 = createTrial(task, condA, 2);

    expect(areTrialsComparable(trial1, trial2)).toBe(true);
  });

  // 32. experiment does not create Runtime Run state
  it("32. EvaluationExperiment is a pure domain contract and creates no Runtime Run state", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());

    expect((exp as any).runId).toBeUndefined();
    expect((exp as any).workerId).toBeUndefined();
    expect((exp as any).leaseId).toBeUndefined();
  });

  // 33. experiment has no execution authority
  it("33. EvaluationExperiment contains no capabilities, credentials, or execution authority", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());

    expect((exp as any).capabilities).toBeUndefined();
    expect((exp as any).credentials).toBeUndefined();
    expect((exp as any).policy).toBeUndefined();
  });

  // 34. experiment does not override objective verification
  it("34. experiment does not override objective verification or trial outcome", () => {
    const task = createSampleTask();
    const condA = createSampleCondition("condition-a");
    const taskContentHash = computeEvaluationTaskHash(task);

    // Failing trial
    const failingTrial = createEvaluationTrial({
      trialOrdinal: 1,
      taskId: task.taskId,
      taskVersion: task.version,
      taskContentHash,
      configFingerprint: condA.configFingerprint,
      runtimeRunId: "run-failed-1",
      outcome: "FAILED",
      statusMessage: "Objective criteria failed",
      verificationPassed: false,
      agentClaimedGoal: true,
      criteriaResults: [{ criterionId: "c1", kind: "FILE_EXISTS", passed: false, message: "File missing" }],
      metrics: createEvaluationMetrics({
        steps: 1,
        actions: 0,
        attempts: 0,
        modelCalls: 1,
        toolCalls: 0,
        proposalRejections: 0,
        executionFailures: 0,
        modelFailures: 0,
        wallClockMs: 200,
      }),
      evidenceReferences: [],
      startedAt: "2026-10-13T10:00:00.000Z",
      completedAt: "2026-10-13T10:00:00.200Z",
    });

    const exp = createEvaluationExperiment(createSampleExperimentParams({ conditions: [condA] }));
    const group = validateExperimentConditionTrials(exp, "condition-a", [failingTrial]);

    expect(group.trials[0]!.outcome).toBe("FAILED");
    expect(group.trials[0]!.verificationPassed).toBe(false);
  });

  // 35. invalid experiment cannot be constructed
  it("35. malformed experiment parameters fail closed with validation error", () => {
    expect(() =>
      validateEvaluationExperiment({
        experimentId: "invalid",
        version: -1,
      })
    ).toThrow(/Malformed EvaluationExperiment/);
  });

  // 36. trial collection remains deterministic
  it("36. validated condition trials are ordered deterministically by trialOrdinal", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const task = createSampleTask();

    const trial3 = createTrial(task, condA, 3);
    const trial1 = createTrial(task, condA, 1);
    const trial2 = createTrial(task, condA, 2);

    const group = validateExperimentConditionTrials(exp, "condition-a", [trial3, trial1, trial2]);
    expect(group.trials.map((t) => t.trialOrdinal)).toEqual([1, 2, 3]);
  });

  // 37. duplicate semantic trial membership is rejected
  it("37. duplicate trialOrdinal within the same condition is rejected", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams());
    const condA = exp.conditions[0]!;
    const task = createSampleTask();

    const trial1A = createTrial(task, condA, 1);
    const trial1B = createTrial(task, condA, 1);

    expect(() =>
      validateExperimentConditionTrials(exp, "condition-a", [trial1A, trial1B])
    ).toThrow(/Duplicate trialOrdinal 1/);
  });

  // 38. planned count does not become statistical sample-size logic
  it("38. plannedTrialCount does not enforce or require a statistical sample size", () => {
    const exp = createEvaluationExperiment(createSampleExperimentParams({ plannedTrialCount: 10 }));
    const condA = exp.conditions[0]!;
    const task = createSampleTask();

    // Validating only 2 trials under an experiment that planned 10 trials is completely valid
    const trial1 = createTrial(task, condA, 1);
    const trial2 = createTrial(task, condA, 2);

    const group = validateExperimentConditionTrials(exp, "condition-a", [trial1, trial2]);
    expect(group.trials).toHaveLength(2);
    expect(exp.plannedTrialCount).toBe(10);
  });
});
