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
  compareConditions,
  ConditionComparison,
  createEvaluationConfigFingerprint,
  createEvaluationExperiment,
  createExperimentCondition,
  CURRENT_HARNESS_VERSION,
  EvaluationExperiment,
  EvaluationExperimentCondition,
  EvaluationReport,
  EvaluationTaskDefinition,
  EvaluationTrial,
  generateEvaluationReport,
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

// ============================================================================
// Interfaces & Contracts
// ============================================================================

export interface ExecuteControlledBaselineReflexExperimentParams {
  readonly task: EvaluationTaskDefinition;
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly trialsPerCondition: number;
  readonly ruleBasedReflexConfig?: RuleBasedReflexConfig;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
  readonly confidenceLevel?: number;
}

export interface ControlledBaselineReflexExperimentResult {
  readonly experiment: EvaluationExperiment;
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
}

// ============================================================================
// Orchestrator Implementation
// ============================================================================

export async function executeControlledBaselineReflexExperiment(
  params: ExecuteControlledBaselineReflexExperimentParams
): Promise<ControlledBaselineReflexExperimentResult> {
  // 1. Validate inputs
  const task = validateEvaluationTask(params.task);

  if (
    typeof params.trialsPerCondition !== "number" ||
    !Number.isInteger(params.trialsPerCondition) ||
    params.trialsPerCondition < 1
  ) {
    throw new Error(
      `trialsPerCondition must be a positive integer >= 1, received ${params.trialsPerCondition}`
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

  // 5. Construct Experiment specification
  const experiment = createEvaluationExperiment({
    experimentId: `exp-baseline-reflex-${task.taskId}`,
    version: 1,
    title: `Controlled Baseline vs Reflex Comparison: ${task.taskId}`,
    description: `Empirical comparison of baseline unassisted execution vs RuleBasedReflex interceptor on ${task.taskId}`,
    hypothesis:
      "Reflex intercepts repeated failures and redundant action loops deterministically without compromising objective task completion",
    taskRef: task,
    conditions: [baselineCondition, reflexCondition],
    plannedTrialCount: params.trialsPerCondition,
    harnessVersion,
    status: "RUNNING",
  });

  // 6. Execute Baseline Trials (1..N)
  const baselineTrials: EvaluationTrial[] = [];
  for (let ordinal = 1; ordinal <= params.trialsPerCondition; ordinal++) {
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

  // 7. Execute Reflex Trials (1..N)
  const reflexTrials: EvaluationTrial[] = [];
  for (let ordinal = 1; ordinal <= params.trialsPerCondition; ordinal++) {
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

  // 8. Generate pure descriptive report
  const allTrials = [...baselineTrials, ...reflexTrials];
  const report = generateEvaluationReport(experiment, allTrials);

  // 9. Generate baseline-to-candidate condition comparison
  const baseReport = report.conditions.find((c) => c.conditionId === "condition-baseline")!;
  const reflexReport = report.conditions.find((c) => c.conditionId === "condition-reflex")!;
  const comparison = compareConditions(baseReport, reflexReport, experiment.taskRef);

  // 10. Run statistical analyses
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

  return Object.freeze({
    experiment,
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
  });
}
