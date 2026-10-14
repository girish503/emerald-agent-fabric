/**
 * Phase 9 — Empirical Evaluation of Frozen Reflex on Live Software-Engineering Workloads.
 *
 * Implements the live and mock-compatible SWE evaluation orchestrator that empirically
 * measures the performance, stability, and false-positive characteristics of the frozen
 * RuleBasedReflex controller when stochastic models (e.g. Ollama open-source models)
 * operate on realistic multi-file software engineering tasks (Tasks J–O).
 *
 * Project Invariants:
 * 1. Frozen Reflex:
 *    Reflex rules, heuristics, and thresholds are FROZEN.
 *    No tuning, no heuristics mutation, no adaptive policies, no learning.
 * 2. Authority Invariant:
 *    EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex.
 *    Reflex remains advisory and cannot grant or expand authority.
 * 3. Objective Truth & Verification:
 *    Success is determined exclusively by physical workspace criteria (file contents,
 *    command exit codes), never by agent self-claims.
 * 4. Conservative False-Positive Classification:
 *    Tasks J–N represent normal productive SWE workloads where normal work is expected.
 *    Any Reflex intervention (reject or defer) on Tasks J–N is conservatively counted as a false positive.
 *    Task O is an unrecoverable failure loop; Reflex intervention is an expected true positive.
 * 5. Strict Telemetry Separation:
 *    Baseline execution does not invoke Reflex. Baseline reflex metrics are strictly undefined.
 * 6. Offline Replay Guarantee:
 *    All captured ReflexEvidence records must replay cleanly and deterministically
 *    offline via replayReflexEvidence with match: true.
 * 7. Fail-Closed Live Execution:
 *    When live testing is enabled (OLLAMA_LIVE_TESTS === "true"), unavailability
 *    of the local Ollama provider or target model immediately fails closed.
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
  EvaluationConfigFingerprint,
  EvaluationExperiment,
  EvaluationExperimentCondition,
  EvaluationReport,
  EvaluationTaskDefinition,
  EvaluationTrial,
  ExperimentManifest,
  generateEvaluationReport,
  isTaskInterventionFree,
  ReflexInterventionMetrics,
  ReflexStabilityMetrics,
  validateEvaluationTask,
} from "../../domain/evaluation.js";
import {
  ModelProviderUnavailableError,
} from "../../domain/errors.js";
import {
  computeRuleBasedReflexConfigHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  RuleBasedReflexConfig,
} from "../../domain/reflex.js";
import {
  ReflexEvidence,
  ReflexReplayResult,
  replayReflexEvidence,
} from "../../domain/reflex-evidence.js";
import { ModelProviderPort } from "../../ports/model-provider.port.js";
import { executeEvaluationTrial } from "./evaluation-runner.js";
import { SWE_EVAL_TASKS } from "./swe-eval-tasks.js";

// ============================================================================
// Interfaces & Contracts
// ============================================================================

export interface ExecuteLiveSweEvaluationParams {
  readonly tasks?: readonly EvaluationTaskDefinition[];
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly trialsPerCondition?: number;
  readonly ruleBasedReflexConfig?: RuleBasedReflexConfig;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
  readonly confidenceLevel?: number;
  readonly requireLiveOllama?: boolean;
  readonly ollamaBaseUrl?: string;
}

export interface LiveSweEvaluationTaskResult {
  readonly task: EvaluationTaskDefinition;
  readonly baselineTrials: readonly EvaluationTrial[];
  readonly reflexTrials: readonly EvaluationTrial[];
  readonly baselinePassRate?: number;
  readonly reflexPassRate?: number;
  readonly deltaPassRate?: number;
  readonly baselineInterventionMetrics: ReflexInterventionMetrics;
  readonly reflexInterventionMetrics: ReflexInterventionMetrics;
  readonly reflexStabilityMetrics?: ReflexStabilityMetrics;
  readonly comparison: ConditionComparison;
  readonly report: EvaluationReport;
  readonly replayResults: readonly ReflexReplayResult[];
  readonly allReplaysMatched: boolean;
}

export interface LiveSweEvaluationResult {
  readonly experimentId: string;
  readonly manifest: ExperimentManifest;
  readonly tasksEvaluated: readonly string[];
  readonly totalPlannedTrials: number;
  readonly totalObservedTrials: number;
  readonly taskResults: readonly LiveSweEvaluationTaskResult[];
  readonly overallBaselinePassRate?: number;
  readonly overallReflexPassRate?: number;
  readonly overallDeltaPassRate?: number;
  readonly overallFalsePositiveInterventions: number;
  readonly overallFalsePositiveRate?: number;
  readonly totalReflexEvaluations: number;
  readonly totalReflexInterventions: number;
  readonly totalReflexAllows: number;
  readonly totalReflexRejects: number;
  readonly totalReflexDefers: number;
  readonly ruleConfigurationHash: string;
  readonly isLiveRun: boolean;
  readonly completedAt: string;
}

// ============================================================================
// Live Ollama Preflight Verification
// ============================================================================

export async function checkOllamaLiveAvailability(
  baseUrl = "http://127.0.0.1:11434",
  targetModel?: string
): Promise<{ available: boolean; reason?: string; availableModels?: readonly string[] }> {
  const normalizedUrl = baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(`${normalizedUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        available: false,
        reason: `Ollama returned HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = (await res.json()) as { models?: Array<{ name: string; model: string }> };
    const modelNames = (data.models ?? []).flatMap((m) => [m.name, m.model]);

    if (targetModel && !modelNames.some((m) => m === targetModel || m.startsWith(`${targetModel}:`))) {
      return {
        available: false,
        reason: `Target model '${targetModel}' not found in local Ollama repository. Available: [${(data.models ?? []).map((m) => m.name).join(", ")}]`,
        availableModels: (data.models ?? []).map((m) => m.name),
      };
    }

    return {
      available: true,
      availableModels: (data.models ?? []).map((m) => m.name),
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    return {
      available: false,
      reason: `Cannot connect to Ollama at ${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================================
// Live SWE Evaluation Orchestrator
// ============================================================================

export async function executeLiveSweEvaluation(
  params: ExecuteLiveSweEvaluationParams
): Promise<LiveSweEvaluationResult> {
  const isLiveEnv = process.env.OLLAMA_LIVE_TESTS === "true";
  const shouldRequireLive = params.requireLiveOllama || isLiveEnv;

  // 1. Preflight check if live Ollama required
  if (shouldRequireLive) {
    const baseUrl = params.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    const targetModel = params.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
    const check = await checkOllamaLiveAvailability(baseUrl, targetModel);

    if (!check.available) {
      throw new ModelProviderUnavailableError(
        `Live SWE evaluation requires Ollama, but preflight check failed: ${check.reason}`
      );
    }
  }

  // 2. Validate tasks
  const tasksToEvaluate = (params.tasks ?? SWE_EVAL_TASKS).map(validateEvaluationTask);
  if (tasksToEvaluate.length === 0) {
    throw new Error("No evaluation tasks provided for Live SWE evaluation");
  }

  const trialsPerCondition = params.trialsPerCondition ?? 5;
  if (
    typeof trialsPerCondition !== "number" ||
    !Number.isInteger(trialsPerCondition) ||
    trialsPerCondition < 1
  ) {
    throw new Error(
      `trialsPerCondition must be a positive integer >= 1, received ${trialsPerCondition}`
    );
  }

  // 3. Reflex Configuration & Identity
  const ruleConfig = params.ruleBasedReflexConfig ?? DEFAULT_RULE_BASED_REFLEX_CONFIG;
  const ruleConfigurationHash = computeRuleBasedReflexConfigHash(ruleConfig);
  const harnessVersion = params.harnessVersion ?? CURRENT_HARNESS_VERSION;

  const experimentId = `exp-live-swe-${Date.now()}`;

  // 4. Create Experiment Manifest
  const manifest = createExperimentManifest({
    experimentId,
    taskRegistry: "emerald-swe-evaluation",
    taskIds: tasksToEvaluate.map((t) => t.taskId),
    trialCount: trialsPerCondition,
    executionModes: ["BASELINE", "REFLEX"],
    ruleConfigurationHash,
    modelProvider: params.modelProvider.providerName,
    model: params.model,
    generationConfig: params.generationConfig,
    harnessVersion,
  });

  const taskResults: LiveSweEvaluationTaskResult[] = [];

  let aggregateBaselinePasses = 0;
  let aggregateBaselineTrials = 0;
  let aggregateReflexPasses = 0;
  let aggregateReflexTrials = 0;

  let totalReflexEvaluations = 0;
  let totalReflexInterventions = 0;
  let totalReflexAllows = 0;
  let totalReflexRejects = 0;
  let totalReflexDefers = 0;
  let overallFalsePositiveInterventions = 0;
  let overallInterventionFreeEvaluations = 0;

  // 5. Evaluate each SWE Task
  for (const task of tasksToEvaluate) {
    if (params.abortSignal?.aborted) {
      break;
    }

    const configFingerprint: EvaluationConfigFingerprint = createEvaluationConfigFingerprint({
      modelProvider: params.modelProvider.providerName,
      model: params.model,
      taskVersion: task.version,
      harnessVersion,
      generationConfig: params.generationConfig,
    });

    const baselineCondition: EvaluationExperimentCondition = createExperimentCondition({
      conditionId: `condition-baseline-${task.taskId}`,
      name: `Baseline (Unassisted): ${task.taskId}`,
      description: `Governed execution without Reflex for ${task.taskId}`,
      executionMode: "BASELINE",
      configFingerprint,
    });

    const reflexCondition: EvaluationExperimentCondition = createExperimentCondition({
      conditionId: `condition-reflex-${task.taskId}`,
      name: `Reflex (Governed): ${task.taskId}`,
      description: `Governed execution with frozen RuleBasedReflex for ${task.taskId}`,
      executionMode: "REFLEX",
      ruleConfigurationHash,
      configFingerprint,
    });

    const taskExperiment: EvaluationExperiment = createEvaluationExperiment({
      experimentId: `exp-${experimentId}-${task.taskId}`,
      version: 1,
      title: `SWE Baseline vs Reflex: ${task.taskId}`,
      description: `Evaluation of frozen Reflex on realistic SWE task: ${task.description}`,
      hypothesis:
        "Frozen RuleBasedReflex maintains low false positives on solvable SWE tasks and bounds repetitive tool loops on unrecoverable tasks",
      taskRef: task,
      conditions: [baselineCondition, reflexCondition],
      plannedTrialCount: trialsPerCondition,
      harnessVersion,
      status: "RUNNING",
    });

    // Execute Baseline Trials
    const baselineTrials: EvaluationTrial[] = [];
    for (let ordinal = 1; ordinal <= trialsPerCondition; ordinal++) {
      if (params.abortSignal?.aborted) break;
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

      // Invariant: Baseline reflex telemetry is strictly undefined
      if (trial.metrics.reflexEvaluations !== undefined) {
        throw new Error(
          `Invariant violation: Baseline trial ${trial.trialId} recorded non-undefined reflexEvaluations`
        );
      }

      baselineTrials.push(trial);
    }

    // Execute Reflex Trials
    const reflexTrials: EvaluationTrial[] = [];
    for (let ordinal = 1; ordinal <= trialsPerCondition; ordinal++) {
      if (params.abortSignal?.aborted) break;
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

    // Generate descriptive report & comparison
    const allTaskTrials = [...baselineTrials, ...reflexTrials];
    const report = generateEvaluationReport(taskExperiment, allTaskTrials);

    const baseReport = report.conditions.find((c) => c.conditionId === baselineCondition.conditionId)!;
    const reflexReport = report.conditions.find((c) => c.conditionId === reflexCondition.conditionId)!;
    const comparison = compareConditions(baseReport, reflexReport, taskExperiment.taskRef);

    const baselineInterventionMetrics = calculateReflexInterventionMetrics(baselineTrials, task);
    const reflexInterventionMetrics = calculateReflexInterventionMetrics(reflexTrials, task);
    const reflexStabilityMetrics = calculateReflexStabilityMetrics(reflexTrials);

    // Deterministic Offline Replay Verification
    const capturedEvidenceList: ReflexEvidence[] = reflexTrials.flatMap(
      (t) => (t.reflexEvidence ? [...t.reflexEvidence] : [])
    );

    const replayResults: ReflexReplayResult[] = [];
    let allReplaysMatched = true;

    for (const evidence of capturedEvidenceList) {
      const replay = await replayReflexEvidence(evidence, { ruleConfig });
      replayResults.push(replay);
      if (!replay.match) {
        allReplaysMatched = false;
      }
    }

    const baselinePassRate = baseReport.objectivePassRate.rate;
    const reflexPassRate = reflexReport.objectivePassRate.rate;
    const deltaPassRate = comparison.passRateComparison.delta;

    aggregateBaselinePasses += baseReport.outcomes.passedTrials;
    aggregateBaselineTrials += baseReport.outcomes.totalTrials;
    aggregateReflexPasses += reflexReport.outcomes.passedTrials;
    aggregateReflexTrials += reflexReport.outcomes.totalTrials;

    totalReflexEvaluations += reflexInterventionMetrics.reflexEvaluations ?? 0;
    totalReflexInterventions += reflexInterventionMetrics.reflexInterventions ?? 0;
    totalReflexAllows += reflexInterventionMetrics.reflexAllows ?? 0;
    totalReflexRejects += reflexInterventionMetrics.reflexRejects ?? 0;
    totalReflexDefers += reflexInterventionMetrics.reflexDefers ?? 0;

    if (isTaskInterventionFree(task.taskId) === true) {
      overallFalsePositiveInterventions += reflexInterventionMetrics.falsePositiveInterventions ?? 0;
      overallInterventionFreeEvaluations += reflexInterventionMetrics.reflexEvaluations ?? 0;
    }

    taskResults.push(
      Object.freeze({
        task,
        baselineTrials: Object.freeze(baselineTrials),
        reflexTrials: Object.freeze(reflexTrials),
        baselinePassRate,
        reflexPassRate,
        deltaPassRate,
        baselineInterventionMetrics,
        reflexInterventionMetrics,
        reflexStabilityMetrics,
        comparison,
        report,
        replayResults: Object.freeze(replayResults),
        allReplaysMatched,
      })
    );
  }

  const totalCompletedBaseline = taskResults.reduce(
    (sum, r) =>
      sum +
      (r.report.conditions.find((c) => c.executionMode === "BASELINE")?.outcomes.completedTrials ?? 0),
    0
  );
  const totalCompletedReflex = taskResults.reduce(
    (sum, r) =>
      sum +
      (r.report.conditions.find((c) => c.executionMode === "REFLEX")?.outcomes.completedTrials ?? 0),
    0
  );

  const overallBaselinePassRate =
    totalCompletedBaseline > 0 ? aggregateBaselinePasses / totalCompletedBaseline : undefined;
  const overallReflexPassRate =
    totalCompletedReflex > 0 ? aggregateReflexPasses / totalCompletedReflex : undefined;
  const overallDeltaPassRate =
    overallBaselinePassRate !== undefined && overallReflexPassRate !== undefined
      ? Math.round((overallReflexPassRate - overallBaselinePassRate) * 1e8) / 1e8
      : undefined;

  const overallFalsePositiveRate =
    overallInterventionFreeEvaluations > 0
      ? overallFalsePositiveInterventions / overallInterventionFreeEvaluations
      : undefined;

  return Object.freeze({
    experimentId,
    manifest,
    tasksEvaluated: Object.freeze(tasksToEvaluate.map((t) => t.taskId)),
    totalPlannedTrials: tasksToEvaluate.length * trialsPerCondition * 2,
    totalObservedTrials: aggregateBaselineTrials + aggregateReflexTrials,
    taskResults: Object.freeze(taskResults),
    overallBaselinePassRate,
    overallReflexPassRate,
    overallDeltaPassRate,
    overallFalsePositiveInterventions,
    overallFalsePositiveRate,
    totalReflexEvaluations,
    totalReflexInterventions,
    totalReflexAllows,
    totalReflexRejects,
    totalReflexDefers,
    ruleConfigurationHash,
    isLiveRun: Boolean(shouldRequireLive),
    completedAt: new Date().toISOString(),
  });
}
