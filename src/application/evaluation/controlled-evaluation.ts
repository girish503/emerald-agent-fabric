/**
 * Phase 8.3 — Controlled Baseline-vs-Reflex Evaluation Orchestrator.
 *
 * Implements the end-to-end controlled scientific evaluation between:
 * - Condition A: BASELINE (unassisted, governed agent loop without Reflex)
 * - Condition B: REFLEX (governed agent loop with deterministic RuleBasedReflex)
 *
 * Principles:
 * 1. Single Variable Control:
 *    Only executionMode and ruleConfigurationHash differ. Task, fixture, mission,
 *    model provider, model name, and generation config are identical.
 * 2. Governance Supremacy:
 *    Evaluation exercises the real governed runtime (MissionContract, Policy, Gateway).
 *    Reflex never bypasses or expands authority.
 * 3. Objective Truth:
 *    Success is strictly decided by physical workspace criteria verification.
 * 4. Immutability & Replay:
 *    Every trial is recorded as an immutable EvaluationTrial record with full metrics.
 * 5. Deterministic Analysis:
 *    Produces descriptive reporting (EvaluationReport), baseline comparison (ConditionComparison),
 *    and mathematical statistical analysis (Wilson score, Student's t).
 */

import {
  calculateReflexInterventionMetrics,
  calculateReflexStabilityMetrics,
  compareConditions,
  ConditionComparison,
  createEvaluationConfigFingerprint,
  createEvaluationExperiment,
  createExperimentCondition,
  createExperimentManifest,
  CURRENT_HARNESS_VERSION,
  EvaluationExperiment,
  EvaluationExperimentCondition,
  EvaluationReport,
  EvaluationTaskDefinition,
  EvaluationTrial,
  ExperimentManifest,
  generateEvaluationReport,
  ReflexInterventionMetrics,
  ReflexStabilityMetrics,
  validateEvaluationTask,
} from "../../domain/evaluation.js";
import {
  computeRuleBasedReflexConfigHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  RuleBasedReflexConfig,
} from "../../domain/reflex.js";
import {
  analyzeExperiment,
  StatisticalAnalysis,
} from "../../domain/statistical-analysis.js";
import { ModelProviderPort } from "../../ports/model-provider.port.js";
import { executeEvaluationTrial } from "./evaluation-runner.js";
import { ALL_BASELINE_REFLEX_TASKS } from "./baseline-reflex-tasks.js";

// ============================================================================
// Interfaces & Contracts
// ============================================================================

export interface ExecuteControlledBaselineReflexExperimentParams {
  readonly task: EvaluationTaskDefinition;
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly trialsPerCondition?: number;
  readonly ruleBasedReflexConfig?: RuleBasedReflexConfig;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
  readonly confidenceLevel?: number;
}

export interface ControlledBaselineReflexExperimentResult {
  readonly experiment: EvaluationExperiment;
  readonly manifest: ExperimentManifest;
  readonly baselineCondition: EvaluationExperimentCondition;
  readonly reflexCondition: EvaluationExperimentCondition;
  readonly baselineTrials: readonly EvaluationTrial[];
  readonly reflexTrials: readonly EvaluationTrial[];
  readonly report: EvaluationReport;
  readonly comparison: ConditionComparison;
  readonly passRateAnalysis: StatisticalAnalysis;
  readonly stepCountAnalysis: StatisticalAnalysis;
  readonly toolCallsAnalysis: StatisticalAnalysis;
  readonly wallClockAnalysis: StatisticalAnalysis;
  readonly proposalRejectionsAnalysis: StatisticalAnalysis;
  readonly reflexLatencyAnalysis?: StatisticalAnalysis;
  readonly baselineInterventionMetrics: ReflexInterventionMetrics;
  readonly reflexInterventionMetrics: ReflexInterventionMetrics;
  readonly baselineStabilityMetrics?: ReflexStabilityMetrics;
  readonly reflexStabilityMetrics?: ReflexStabilityMetrics;
}

// ============================================================================
// Orchestrator Implementation
// ============================================================================

export async function executeControlledBaselineReflexExperiment(
  params: ExecuteControlledBaselineReflexExperimentParams
): Promise<ControlledBaselineReflexExperimentResult> {
  // 1. Validate inputs
  const task = validateEvaluationTask(params.task);

  const trialsPerCondition = params.trialsPerCondition ?? 10;

  if (
    typeof trialsPerCondition !== "number" ||
    !Number.isInteger(trialsPerCondition) ||
    trialsPerCondition < 1
  ) {
    throw new Error(
      `trialsPerCondition must be a positive integer >= 1, received ${trialsPerCondition}`
    );
  }

  // 2. Resolve Reflex configuration and compute canonical hash
  const ruleConfig = params.ruleBasedReflexConfig ?? DEFAULT_RULE_BASED_REFLEX_CONFIG;
  const ruleConfigurationHash = computeRuleBasedReflexConfigHash(ruleConfig);

  // 3. Build identical configuration fingerprint
  const harnessVersion = params.harnessVersion ?? CURRENT_HARNESS_VERSION;
  const configFingerprint = createEvaluationConfigFingerprint({
    modelProvider: params.modelProvider.providerName,
    model: params.model,
    taskVersion: task.version,
    harnessVersion,
    generationConfig: params.generationConfig,
  });

  // 4. Construct controlled experimental conditions
  const baselineCondition = createExperimentCondition({
    conditionId: "condition-baseline",
    name: "Baseline (Unassisted)",
    description: "Standard governed runtime execution without Reflex proposal interceptor",
    executionMode: "BASELINE",
    configFingerprint,
  });

  const reflexCondition = createExperimentCondition({
    conditionId: "condition-reflex",
    name: "Reflex (Rule-Based Interceptor)",
    description: "Governed runtime execution with deterministic RuleBasedReflex safety heuristics",
    executionMode: "REFLEX",
    ruleConfigurationHash,
    configFingerprint,
  });

  // 5. Build experiment manifest (Phase 8.7)
  const manifest = createExperimentManifest({
    experimentId: `exp-baseline-reflex-${task.taskId}`,
    taskRegistry: "emerald-controlled-baseline-reflex",
    taskIds: [task.taskId],
    trialCount: trialsPerCondition,
    executionModes: ["BASELINE", "REFLEX"],
    ruleConfigurationHash,
    modelProvider: params.modelProvider.providerName,
    model: params.model,
    generationConfig: params.generationConfig,
    harnessVersion,
  });

  // 6. Construct Experiment specification
  const experiment = createEvaluationExperiment({
    experimentId: `exp-baseline-reflex-${task.taskId}`,
    version: 1,
    title: `Controlled Baseline vs Reflex Comparison: ${task.taskId}`,
    description: `Empirical comparison of baseline unassisted execution vs RuleBasedReflex interceptor on ${task.taskId}`,
    hypothesis:
      "Reflex intercepts repeated failures and redundant action loops deterministically without compromising objective task completion",
    taskRef: task,
    conditions: [baselineCondition, reflexCondition],
    plannedTrialCount: trialsPerCondition,
    harnessVersion,
    status: "RUNNING",
  });

  // 7. Execute Baseline Trials (1..N)
  const baselineTrials: EvaluationTrial[] = [];
  for (let ordinal = 1; ordinal <= trialsPerCondition; ordinal++) {
    const trial = await executeEvaluationTrial({
      task,
      modelProvider: params.modelProvider,
      model: params.model,
      trialOrdinal: ordinal,
      harnessVersion,
      generationConfig: params.generationConfig,
      executionMode: "BASELINE",
      condition: baselineCondition,
      abortSignal: params.abortSignal,
    });
    baselineTrials.push(trial);
  }

  // 8. Execute Reflex Trials (1..N)
  const reflexTrials: EvaluationTrial[] = [];
  for (let ordinal = 1; ordinal <= trialsPerCondition; ordinal++) {
    const trial = await executeEvaluationTrial({
      task,
      modelProvider: params.modelProvider,
      model: params.model,
      trialOrdinal: ordinal,
      harnessVersion,
      generationConfig: params.generationConfig,
      executionMode: "REFLEX",
      condition: reflexCondition,
      ruleBasedReflexConfig: ruleConfig,
      abortSignal: params.abortSignal,
    });
    reflexTrials.push(trial);
  }

  // 9. Generate pure descriptive report
  const allTrials = [...baselineTrials, ...reflexTrials];
  const report = generateEvaluationReport(experiment, allTrials);

  // 10. Generate baseline-to-candidate condition comparison
  const baseReport = report.conditions.find((c) => c.conditionId === "condition-baseline")!;
  const reflexReport = report.conditions.find((c) => c.conditionId === "condition-reflex")!;
  const comparison = compareConditions(baseReport, reflexReport, experiment.taskRef);

  // 11. Run statistical analyses
  const confidenceLevel = params.confidenceLevel ?? 0.95;

  const passRateAnalysis = analyzeExperiment({
    experiment,
    trials: allTrials,
    baselineConditionId: "condition-baseline",
    candidateConditionId: "condition-reflex",
    metric: "objectivePassRate",
    confidenceLevel,
  });

  const stepCountAnalysis = analyzeExperiment({
    experiment,
    trials: allTrials,
    baselineConditionId: "condition-baseline",
    candidateConditionId: "condition-reflex",
    metric: "steps",
    confidenceLevel,
    direction: "LOWER_IS_BETTER",
  });

  const toolCallsAnalysis = analyzeExperiment({
    experiment,
    trials: allTrials,
    baselineConditionId: "condition-baseline",
    candidateConditionId: "condition-reflex",
    metric: "toolCalls",
    confidenceLevel,
    direction: "LOWER_IS_BETTER",
  });

  const wallClockAnalysis = analyzeExperiment({
    experiment,
    trials: allTrials,
    baselineConditionId: "condition-baseline",
    candidateConditionId: "condition-reflex",
    metric: "wallClockMs",
    confidenceLevel,
    direction: "LOWER_IS_BETTER",
  });

  const proposalRejectionsAnalysis = analyzeExperiment({
    experiment,
    trials: allTrials,
    baselineConditionId: "condition-baseline",
    candidateConditionId: "condition-reflex",
    metric: "proposalRejections",
    confidenceLevel,
    direction: "LOWER_IS_BETTER",
  });

  let reflexLatencyAnalysis: StatisticalAnalysis | undefined = undefined;
  try {
    reflexLatencyAnalysis = analyzeExperiment({
      experiment,
      trials: allTrials,
      baselineConditionId: "condition-baseline",
      candidateConditionId: "condition-reflex",
      metric: "reflexLatencyMs",
      confidenceLevel,
      direction: "LOWER_IS_BETTER",
    });
  } catch {
    // Graceful fallback if missing data prevents analysis
  }

  // 12. Compute Phase 8.7 Intervention & Stability Metrics
  const baselineInterventionMetrics = calculateReflexInterventionMetrics(baselineTrials, task);
  const reflexInterventionMetrics = calculateReflexInterventionMetrics(reflexTrials, task);

  const baselineStabilityMetrics = calculateReflexStabilityMetrics(baselineTrials);
  const reflexStabilityMetrics = calculateReflexStabilityMetrics(reflexTrials);

  return Object.freeze({
    experiment,
    manifest,
    baselineCondition,
    reflexCondition,
    baselineTrials: Object.freeze(baselineTrials),
    reflexTrials: Object.freeze(reflexTrials),
    report,
    comparison,
    passRateAnalysis,
    stepCountAnalysis,
    toolCallsAnalysis,
    wallClockAnalysis,
    proposalRejectionsAnalysis,
    reflexLatencyAnalysis,
    baselineInterventionMetrics,
    reflexInterventionMetrics,
    baselineStabilityMetrics,
    reflexStabilityMetrics,
  });
}

// ============================================================================
// Multi-Task Suite Orchestrator (Phase 8.7)
// ============================================================================

export interface ExecuteControlledBaselineReflexSuiteParams {
  readonly tasks?: readonly EvaluationTaskDefinition[];
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly trialsPerCondition?: number;
  readonly ruleBasedReflexConfig?: RuleBasedReflexConfig;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
  readonly confidenceLevel?: number;
}

export interface ControlledBaselineReflexSuiteResult {
  readonly suiteManifest: ExperimentManifest;
  readonly taskResults: readonly ControlledBaselineReflexExperimentResult[];
  readonly overallReflexInterventionMetrics: ReflexInterventionMetrics;
  readonly overallReflexStabilityMetrics?: ReflexStabilityMetrics;
}

export async function executeControlledBaselineReflexSuite(
  params: ExecuteControlledBaselineReflexSuiteParams
): Promise<ControlledBaselineReflexSuiteResult> {
  const tasks = params.tasks ?? ALL_BASELINE_REFLEX_TASKS;
  const trialsPerCondition = params.trialsPerCondition ?? 10;
  const harnessVersion = params.harnessVersion ?? CURRENT_HARNESS_VERSION;
  const ruleConfig = params.ruleBasedReflexConfig ?? DEFAULT_RULE_BASED_REFLEX_CONFIG;
  const ruleConfigurationHash = computeRuleBasedReflexConfigHash(ruleConfig);

  const suiteManifest = createExperimentManifest({
    experimentId: `exp-suite-baseline-reflex-${Date.now()}`,
    taskRegistry: "emerald-controlled-baseline-reflex",
    taskIds: tasks.map((t) => t.taskId),
    trialCount: trialsPerCondition,
    executionModes: ["BASELINE", "REFLEX"],
    ruleConfigurationHash,
    modelProvider: params.modelProvider.providerName,
    model: params.model,
    generationConfig: params.generationConfig,
    harnessVersion,
  });

  const taskResults: ControlledBaselineReflexExperimentResult[] = [];
  const allReflexTrials: EvaluationTrial[] = [];

  for (const task of tasks) {
    if (params.abortSignal?.aborted) break;
    const result = await executeControlledBaselineReflexExperiment({
      task,
      modelProvider: params.modelProvider,
      model: params.model,
      trialsPerCondition,
      ruleBasedReflexConfig: ruleConfig,
      harnessVersion,
      generationConfig: params.generationConfig,
      abortSignal: params.abortSignal,
      confidenceLevel: params.confidenceLevel,
    });
    taskResults.push(result);
    allReflexTrials.push(...result.reflexTrials);
  }

  const overallReflexInterventionMetrics = calculateReflexInterventionMetrics(allReflexTrials);
  const overallReflexStabilityMetrics = calculateReflexStabilityMetrics(allReflexTrials);

  return Object.freeze({
    suiteManifest,
    taskResults: Object.freeze(taskResults),
    overallReflexInterventionMetrics,
    overallReflexStabilityMetrics,
  });
}

