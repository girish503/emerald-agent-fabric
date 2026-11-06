/**
 * Milestone 2.25 Phase 4 — Evaluation Metrics, Aggregation, and Reporting.
 *
 * Implements pure domain contracts, metric calculations, deterministic aggregation,
 * model comparison, and reporting for local open-weight model reliability benchmarks.
 *
 * Invariants & Principles:
 * 1. Claims != Verified Success: Task success is decided exclusively by authoritative runtime
 *    verification specifications evaluated against physical workspace evidence.
 *    Model completion assertions (e.g. finishReason === "GOAL_REACHED" or isGoalReached: true)
 *    are strictly recorded as completion claims, and NEVER dictate verified success.
 * 2. Exhaustive Outcome Accounting: All seven TrialFinalOutcome values (VERIFIED_SUCCESS,
 *    FALSE_COMPLETION, COMPLETION_UNVERIFIABLE, LOOP_DETECTED, EXECUTION_FAILURE, TIMEOUT,
 *    BLOCKED) are preserved in outcome distributions. No trial is silently excluded.
 * 3. Explicit Metric Semantics: Every metric's numerator, denominator, and formula are
 *    strictly defined. Where multiple denominators exist (e.g. total trials vs completed trials
 *    vs completion claims), they are exposed as separately named, un-aliased metrics.
 * 4. Provenance & Deduplication: Trials are verified for authentic run identity, model identity,
 *    and verification assessment provenance. Inconsistent or duplicate records are rejected fail-closed.
 * 5. Strict Comparability: Cross-model comparisons require identical benchmark tasks and execution
 *    budgets. Small samples (N < 30) carry explicit scientific disclaimers.
 * 6. Pure Domain Layer: Zero I/O, zero network calls, zero provider SDKs, zero database handles.
 */

import { z } from "zod";
import { computeCanonicalHash } from "./canonical-hash.js";
import {
  type TrialFinalOutcome,
  TRIAL_FINAL_OUTCOMES,
  type ModelCompletionClaimObservation,
  type TrialVerificationAssessment,
  type EvaluationTrial,
  CURRENT_HARNESS_VERSION,
} from "./evaluation.js";

// ============================================================================
// 1. Metric Definitions & Constants
// ============================================================================

export const RELIABILITY_SUITE_VERSION = "reliability-benchmark-v1";

export interface MetricDefinition {
  readonly name: string;
  readonly description: string;
  readonly formula: string;
  readonly numerator: string;
  readonly denominator: string;
}

export const RELIABILITY_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: "verifiedSuccessRate_TotalTrials",
    description: "Proportion of all observed trials that achieved independent authoritative verification",
    formula: "verifiedSuccesses / totalTrials",
    numerator: "verifiedSuccesses (count of trials with finalOutcome === 'VERIFIED_SUCCESS')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "verifiedSuccessRate_CompletedTrials",
    description: "Proportion of completed trials that achieved independent authoritative verification",
    formula: "verifiedSuccesses / completedTrials",
    numerator: "verifiedSuccesses (count of trials with finalOutcome === 'VERIFIED_SUCCESS')",
    denominator: "completedTrials (trials reaching a terminal outcome, excluding governance-BLOCKED)",
  },
  {
    name: "claimAccuracyRate",
    description: "Proportion of model completion claims that were verified as true task successes",
    formula: "verifiedSuccesses / modelCompletionClaims",
    numerator: "verifiedSuccesses (count of trials with finalOutcome === 'VERIFIED_SUCCESS')",
    denominator: "modelCompletionClaims (count of trials where model claimed completion)",
  },
  {
    name: "falseCompletionRate_Claims",
    description: "Proportion of model completion claims that were proven false by independent verification",
    formula: "falseCompletions / modelCompletionClaims",
    numerator: "falseCompletions (count of trials with finalOutcome === 'FALSE_COMPLETION')",
    denominator: "modelCompletionClaims (count of trials where model claimed completion)",
  },
  {
    name: "falseCompletionRate_Total",
    description: "Proportion of all trials where the model made a false completion claim",
    formula: "falseCompletions / totalTrials",
    numerator: "falseCompletions (count of trials with finalOutcome === 'FALSE_COMPLETION')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "completionUnverifiableRate",
    description: "Proportion of trials where completion could not be independently established",
    formula: "completionUnverifiable / totalTrials",
    numerator: "completionUnverifiable (count of trials with finalOutcome === 'COMPLETION_UNVERIFIABLE')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "loopDetectionRate",
    description: "Proportion of trials terminated due to repeated ineffective action cycles (Milestone 2.24)",
    formula: "loopDetections / totalTrials",
    numerator: "loopDetections (count of trials with finalOutcome === 'LOOP_DETECTED')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "executionFailureRate",
    description: "Proportion of trials terminated due to model/brain or tool execution errors",
    formula: "executionFailures / totalTrials",
    numerator: "executionFailures (count of trials with finalOutcome === 'EXECUTION_FAILURE')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "timeoutRate",
    description: "Proportion of trials terminated due to step, action, or wall-clock budget exhaustion",
    formula: "timeouts / totalTrials",
    numerator: "timeouts (count of trials with finalOutcome === 'TIMEOUT')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "blockedRate",
    description: "Proportion of trials halted due to governance, lease revocation, or policy fencing",
    formula: "blockedTrials / totalTrials",
    numerator: "blockedTrials (count of trials with finalOutcome === 'BLOCKED')",
    denominator: "totalTrials (count of all valid observed trials)",
  },
  {
    name: "claimRate",
    description: "Proportion of trials where the model asserted that the task goal was reached",
    formula: "modelCompletionClaims / totalTrials",
    numerator: "modelCompletionClaims (count of trials where model claimed completion)",
    denominator: "totalTrials (count of all valid observed trials)",
  },
] as const;

// ============================================================================
// 2. Domain Types & Schemas
// ============================================================================

export interface ReliabilityModelMetadata {
  readonly modelId: string;
  readonly modelName?: string;
  readonly provider?: string;
  readonly quantization?: string;
  readonly runtimeVersion?: string;
  readonly parameters?: string;
}

export const ReliabilityModelMetadataSchema = z
  .object({
    modelId: z.string().min(1, "modelId must be non-empty"),
    modelName: z.string().optional(),
    provider: z.string().optional(),
    quantization: z.string().optional(),
    runtimeVersion: z.string().optional(),
    parameters: z.string().optional(),
  })
  .strict();

export interface ReliabilityExecutionBudget {
  readonly maxSteps?: number;
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

export const ReliabilityExecutionBudgetSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxActions: z.number().int().positive().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
  })
  .strict();

export interface ReliabilityTrialRecord {
  readonly trialId: string;
  readonly runtimeRunId: string;
  readonly model: ReliabilityModelMetadata;
  readonly taskId: string;
  readonly category: string;
  readonly finalOutcome: TrialFinalOutcome;
  readonly modelCompletionClaim: ModelCompletionClaimObservation;
  readonly verificationAssessment: TrialVerificationAssessment;
  readonly allowUnverifiedCompletion?: boolean;
  readonly durationMs?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly budget?: ReliabilityExecutionBudget;
  readonly suiteVersion?: string;
  readonly harnessVersion?: string;
  readonly trialOrdinal?: number;
}

export const ReliabilityTrialRecordSchema = z
  .object({
    trialId: z.string().min(1, "trialId must be non-empty"),
    runtimeRunId: z.string().min(1, "runtimeRunId must be non-empty"),
    model: ReliabilityModelMetadataSchema,
    taskId: z.string().min(1, "taskId must be non-empty"),
    category: z.string().min(1, "category must be non-empty"),
    finalOutcome: z.enum(TRIAL_FINAL_OUTCOMES),
    modelCompletionClaim: z.object({
      claimed: z.boolean(),
      stepNumber: z.number().int().positive().optional(),
      finishReason: z.string().optional(),
      rationale: z.string().optional(),
      claimedAt: z.string().optional(),
    }),
    verificationAssessment: z.object({
      decision: z.enum(["VERIFIED", "REJECTED", "UNVERIFIABLE", "NOT_EVALUATED"]),
      reasonCode: z.string().optional(),
      message: z.string().optional(),
      specCount: z.number().int().nonnegative().optional(),
      passedSpecCount: z.number().int().nonnegative().optional(),
      failedSpecCount: z.number().int().nonnegative().optional(),
      specResults: z.array(z.any()).optional(),
      criteriaResults: z.array(z.any()).optional(),
    }),
    allowUnverifiedCompletion: z.boolean().optional(),
    durationMs: z.number().nonnegative().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    budget: ReliabilityExecutionBudgetSchema.optional(),
    suiteVersion: z.string().optional(),
    harnessVersion: z.string().optional(),
    trialOrdinal: z.number().int().positive().optional(),
  })
  .strict();

export interface ReliabilityOutcomeDistribution {
  readonly totalTrials: number;
  readonly startedTrials: number;
  readonly completedTrials: number;
  readonly verifiedSuccesses: number;
  readonly falseCompletions: number;
  readonly completionUnverifiable: number;
  readonly loopDetections: number;
  readonly executionFailures: number;
  readonly timeouts: number;
  readonly blockedTrials: number;
  readonly modelCompletionClaims: number;
}

export interface ReliabilityRates {
  readonly verifiedSuccessRate_TotalTrials: number;
  readonly verifiedSuccessRate_CompletedTrials?: number;
  readonly claimAccuracyRate?: number;
  readonly falseCompletionRate_Claims?: number;
  readonly falseCompletionRate_Total: number;
  readonly completionUnverifiableRate: number;
  readonly loopDetectionRate: number;
  readonly executionFailureRate: number;
  readonly timeoutRate: number;
  readonly blockedRate: number;
  readonly claimRate: number;
}

export interface ReliabilityDurationStats {
  readonly sampleCount: number;
  readonly averageMs?: number;
  readonly medianMs?: number;
  readonly minMs?: number;
  readonly maxMs?: number;
}

export interface ReliabilityGroupAggregate {
  readonly groupKey: string;
  readonly groupType: "OVERALL" | "MODEL" | "CATEGORY" | "TASK";
  readonly label: string;
  readonly outcomes: ReliabilityOutcomeDistribution;
  readonly rates: ReliabilityRates;
  readonly duration: ReliabilityDurationStats;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ModelComparison {
  readonly baselineModelId: string;
  readonly candidateModelId: string;
  readonly isComparable: boolean;
  readonly incomparabilityReasons: readonly string[];
  readonly commonTaskCount: number;
  readonly baselineTotalTrials: number;
  readonly candidateTotalTrials: number;
  readonly baselineVerifiedSuccesses: number;
  readonly candidateVerifiedSuccesses: number;
  readonly baselineVerifiedSuccessRate: number;
  readonly candidateVerifiedSuccessRate: number;
  readonly deltaVerifiedSuccessRate: number;
  readonly baselineClaimAccuracyRate?: number;
  readonly candidateClaimAccuracyRate?: number;
  readonly deltaClaimAccuracyRate?: number;
  readonly disclaimer: string;
}

export interface RejectedTrialRecord {
  readonly trialId?: string;
  readonly runId?: string;
  readonly reason: string;
  readonly rawRecordSummary: string;
}

export interface ReliabilityEvaluationReport {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly suiteVersion: string;
  readonly harnessVersion: string;
  readonly reportContentHash: string;
  readonly totalRecordsReceived: number;
  readonly acceptedRecordsCount: number;
  readonly rejectedRecordsCount: number;
  readonly metricDefinitions: readonly MetricDefinition[];
  readonly overall: ReliabilityGroupAggregate;
  readonly byModel: readonly ReliabilityGroupAggregate[];
  readonly byCategory: readonly ReliabilityGroupAggregate[];
  readonly byTask: readonly ReliabilityGroupAggregate[];
  readonly modelComparisons: readonly ModelComparison[];
  readonly rejectedRecords: readonly RejectedTrialRecord[];
  readonly limitations: readonly string[];
}

// ============================================================================
// 3. Provenance & Validation Logic
// ============================================================================

export type TrialValidationResult =
  | { readonly valid: true; readonly record: ReliabilityTrialRecord }
  | { readonly valid: false; readonly reason: string; readonly record?: unknown };

/**
 * Validates the schema and internal semantic integrity of a raw trial record.
 * Fails closed on corrupted, contradictory, or unverifiable provenance.
 */
export function validateReliabilityTrialRecord(raw: unknown): TrialValidationResult {
  const parseResult = ReliabilityTrialRecordSchema.safeParse(raw);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { valid: false, reason: `Malformed trial schema: ${issues}`, record: raw };
  }

  const rec = parseResult.data;

  // Semantic Provenance Checks:

  // 1. VERIFIED_SUCCESS MUST have authoritative verification decision VERIFIED and MUST NOT allow unverified completion
  if (rec.finalOutcome === "VERIFIED_SUCCESS") {
    if (rec.verificationAssessment.decision !== "VERIFIED") {
      return {
        valid: false,
        reason: `Provenance violation: trial marked VERIFIED_SUCCESS but verification decision is '${rec.verificationAssessment.decision}' (must be VERIFIED)`,
        record: rec,
      };
    }
    if (rec.allowUnverifiedCompletion) {
      return {
        valid: false,
        reason: "Provenance violation: trial marked VERIFIED_SUCCESS with allowUnverifiedCompletion: true. Unverified completions can never count as VERIFIED_SUCCESS.",
        record: rec,
      };
    }
  }

  // 2. FALSE_COMPLETION requires that the model claimed completion
  if (rec.finalOutcome === "FALSE_COMPLETION") {
    if (!rec.modelCompletionClaim.claimed) {
      return {
        valid: false,
        reason: "Provenance violation: trial marked FALSE_COMPLETION but modelCompletionClaim.claimed is false. A trial without a completion claim cannot be a false completion.",
        record: rec,
      };
    }
    if (rec.verificationAssessment.decision === "VERIFIED") {
      return {
        valid: false,
        reason: "Provenance violation: trial marked FALSE_COMPLETION but verification assessment decision is VERIFIED.",
        record: rec,
      };
    }
  }

  return { valid: true, record: Object.freeze(rec) as ReliabilityTrialRecord };
}

// ============================================================================
// 4. Deterministic Aggregation Functions
// ============================================================================

/**
 * Computes duration statistics (sample count, average, median, min, max)
 * from a collection of millisecond duration samples.
 */
export function computeDurationStats(durationsMs: readonly number[]): ReliabilityDurationStats {
  const valid = durationsMs.filter((d) => typeof d === "number" && !isNaN(d) && d >= 0);
  if (valid.length === 0) {
    return Object.freeze({ sampleCount: 0 });
  }

  const sorted = [...valid].sort((a, b) => a - b);
  const sampleCount = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const averageMs = Math.round((sum / sampleCount) * 100) / 100;
  const minMs = sorted[0]!;
  const maxMs = sorted[sorted.length - 1]!;

  let medianMs: number;
  const mid = Math.floor(sampleCount / 2);
  if (sampleCount % 2 === 0) {
    medianMs = Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100;
  } else {
    medianMs = sorted[mid]!;
  }

  return Object.freeze({
    sampleCount,
    averageMs,
    medianMs,
    minMs,
    maxMs,
  });
}

/**
 * Pure aggregation function for a single group of validated ReliabilityTrialRecord items.
 */
export function computeReliabilityGroupAggregate(params: {
  readonly groupKey: string;
  readonly groupType: "OVERALL" | "MODEL" | "CATEGORY" | "TASK";
  readonly label: string;
  readonly records: readonly ReliabilityTrialRecord[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}): ReliabilityGroupAggregate {
  const { groupKey, groupType, label, records, metadata } = params;

  let verifiedSuccesses = 0;
  let falseCompletions = 0;
  let completionUnverifiable = 0;
  let loopDetections = 0;
  let executionFailures = 0;
  let timeouts = 0;
  let blockedTrials = 0;
  let modelCompletionClaims = 0;

  const durations: number[] = [];

  for (const r of records) {
    if (r.modelCompletionClaim.claimed) {
      modelCompletionClaims++;
    }

    switch (r.finalOutcome) {
      case "VERIFIED_SUCCESS":
        verifiedSuccesses++;
        break;
      case "FALSE_COMPLETION":
        falseCompletions++;
        break;
      case "COMPLETION_UNVERIFIABLE":
        completionUnverifiable++;
        break;
      case "LOOP_DETECTED":
        loopDetections++;
        break;
      case "EXECUTION_FAILURE":
        executionFailures++;
        break;
      case "TIMEOUT":
        timeouts++;
        break;
      case "BLOCKED":
        blockedTrials++;
        break;
    }

    if (typeof r.durationMs === "number" && r.durationMs >= 0) {
      durations.push(r.durationMs);
    } else if (r.startedAt && r.completedAt) {
      const s = Date.parse(r.startedAt);
      const c = Date.parse(r.completedAt);
      if (!isNaN(s) && !isNaN(c) && c >= s) {
        durations.push(c - s);
      }
    }
  }

  const totalTrials = records.length;
  // Started trials: any trial that ran (all valid records in evaluation set are started trials)
  const startedTrials = totalTrials;
  // Completed trials: reached terminal step without governance or lease block
  const completedTrials = totalTrials - blockedTrials;

  const verifiedSuccessRate_TotalTrials = totalTrials > 0 ? verifiedSuccesses / totalTrials : 0;
  const verifiedSuccessRate_CompletedTrials =
    completedTrials > 0 ? verifiedSuccesses / completedTrials : undefined;
  const claimAccuracyRate =
    modelCompletionClaims > 0 ? verifiedSuccesses / modelCompletionClaims : undefined;
  const falseCompletionRate_Claims =
    modelCompletionClaims > 0 ? falseCompletions / modelCompletionClaims : undefined;
  const falseCompletionRate_Total = totalTrials > 0 ? falseCompletions / totalTrials : 0;
  const completionUnverifiableRate = totalTrials > 0 ? completionUnverifiable / totalTrials : 0;
  const loopDetectionRate = totalTrials > 0 ? loopDetections / totalTrials : 0;
  const executionFailureRate = totalTrials > 0 ? executionFailures / totalTrials : 0;
  const timeoutRate = totalTrials > 0 ? timeouts / totalTrials : 0;
  const blockedRate = totalTrials > 0 ? blockedTrials / totalTrials : 0;
  const claimRate = totalTrials > 0 ? modelCompletionClaims / totalTrials : 0;

  const outcomes: ReliabilityOutcomeDistribution = Object.freeze({
    totalTrials,
    startedTrials,
    completedTrials,
    verifiedSuccesses,
    falseCompletions,
    completionUnverifiable,
    loopDetections,
    executionFailures,
    timeouts,
    blockedTrials,
    modelCompletionClaims,
  });

  const rates: ReliabilityRates = Object.freeze({
    verifiedSuccessRate_TotalTrials: Math.round(verifiedSuccessRate_TotalTrials * 10000) / 10000,
    verifiedSuccessRate_CompletedTrials:
      verifiedSuccessRate_CompletedTrials !== undefined
        ? Math.round(verifiedSuccessRate_CompletedTrials * 10000) / 10000
        : undefined,
    claimAccuracyRate:
      claimAccuracyRate !== undefined
        ? Math.round(claimAccuracyRate * 10000) / 10000
        : undefined,
    falseCompletionRate_Claims:
      falseCompletionRate_Claims !== undefined
        ? Math.round(falseCompletionRate_Claims * 10000) / 10000
        : undefined,
    falseCompletionRate_Total: Math.round(falseCompletionRate_Total * 10000) / 10000,
    completionUnverifiableRate: Math.round(completionUnverifiableRate * 10000) / 10000,
    loopDetectionRate: Math.round(loopDetectionRate * 10000) / 10000,
    executionFailureRate: Math.round(executionFailureRate * 10000) / 10000,
    timeoutRate: Math.round(timeoutRate * 10000) / 10000,
    blockedRate: Math.round(blockedRate * 10000) / 10000,
    claimRate: Math.round(claimRate * 10000) / 10000,
  });

  const duration = computeDurationStats(durations);

  return Object.freeze({
    groupKey,
    groupType,
    label,
    outcomes,
    rates,
    duration,
    metadata: metadata ? Object.freeze({ ...metadata }) : undefined,
  });
}

// ============================================================================
// 5. Cross-Model Comparability & Comparison
// ============================================================================

export function compareModels(params: {
  readonly baselineGroup: ReliabilityGroupAggregate;
  readonly candidateGroup: ReliabilityGroupAggregate;
  readonly baselineRecords: readonly ReliabilityTrialRecord[];
  readonly candidateRecords: readonly ReliabilityTrialRecord[];
}): ModelComparison {
  const { baselineGroup, candidateGroup, baselineRecords, candidateRecords } = params;

  const baselineTasks = new Set(baselineRecords.map((r) => r.taskId));
  const candidateTasks = new Set(candidateRecords.map((r) => r.taskId));
  const commonTasks = [...baselineTasks].filter((t) => candidateTasks.has(t));

  const incomparabilityReasons: string[] = [];

  // Check 1: Matching Task Sets
  if (baselineTasks.size !== candidateTasks.size || commonTasks.length !== baselineTasks.size) {
    incomparabilityReasons.push(
      `Evaluated task sets differ (baseline has ${baselineTasks.size} tasks, candidate has ${candidateTasks.size} tasks, common: ${commonTasks.length})`
    );
  }

  // Check 2: Matching Budgets on Common Tasks
  for (const taskId of commonTasks) {
    const bSample = baselineRecords.find((r) => r.taskId === taskId)?.budget;
    const cSample = candidateRecords.find((r) => r.taskId === taskId)?.budget;

    if (bSample && cSample) {
      if (
        bSample.maxSteps !== cSample.maxSteps ||
        bSample.maxActions !== cSample.maxActions ||
        bSample.maxWallClockMs !== cSample.maxWallClockMs
      ) {
        incomparabilityReasons.push(
          `Task '${taskId}' has differing execution budgets (steps: ${bSample.maxSteps} vs ${cSample.maxSteps}, actions: ${bSample.maxActions} vs ${cSample.maxActions})`
        );
        break;
      }
    }
  }

  const isComparable = incomparabilityReasons.length === 0;

  const bSuccessRate = baselineGroup.rates.verifiedSuccessRate_TotalTrials;
  const cSuccessRate = candidateGroup.rates.verifiedSuccessRate_TotalTrials;
  const deltaVerifiedSuccessRate = Math.round((cSuccessRate - bSuccessRate) * 10000) / 10000;

  let deltaClaimAccuracyRate: number | undefined;
  if (
    candidateGroup.rates.claimAccuracyRate !== undefined &&
    baselineGroup.rates.claimAccuracyRate !== undefined
  ) {
    deltaClaimAccuracyRate =
      Math.round((candidateGroup.rates.claimAccuracyRate - baselineGroup.rates.claimAccuracyRate) * 10000) / 10000;
  }

  const disclaimer =
    "Notice: Small sample sizes (N < 30) are not statistically conclusive and should not be used as definitive model capability ratings. Comparisons reflect observed trial outcomes strictly under the configured harness and fixture conditions.";

  return Object.freeze({
    baselineModelId: baselineGroup.groupKey,
    candidateModelId: candidateGroup.groupKey,
    isComparable,
    incomparabilityReasons: Object.freeze(incomparabilityReasons),
    commonTaskCount: commonTasks.length,
    baselineTotalTrials: baselineGroup.outcomes.totalTrials,
    candidateTotalTrials: candidateGroup.outcomes.totalTrials,
    baselineVerifiedSuccesses: baselineGroup.outcomes.verifiedSuccesses,
    candidateVerifiedSuccesses: candidateGroup.outcomes.verifiedSuccesses,
    baselineVerifiedSuccessRate: bSuccessRate,
    candidateVerifiedSuccessRate: cSuccessRate,
    deltaVerifiedSuccessRate,
    baselineClaimAccuracyRate: baselineGroup.rates.claimAccuracyRate,
    candidateClaimAccuracyRate: candidateGroup.rates.claimAccuracyRate,
    deltaClaimAccuracyRate,
    disclaimer,
  });
}

// ============================================================================
// 6. Primary Evaluation Aggregator Function
// ============================================================================

export interface AggregateReliabilityEvaluationOptions {
  readonly suiteVersion?: string;
  readonly harnessVersion?: string;
  readonly generatedAt?: string;
  readonly reportId?: string;
  readonly knownLimitations?: readonly string[];
}

/**
 * Pure, deterministic evaluation report generator aggregating arbitrary trial records.
 *
 * Enforces:
 * 1. Deduplication of trials (rejects duplicate trialId or duplicate model/runId).
 * 2. Fail-closed validation of malformed or unverifiable trial schemas.
 * 3. Deterministic sorting across models, categories, and tasks.
 * 4. Pairwise model comparability evaluation.
 * 5. Canonical content hashing for reproducible evidence.
 */
export function aggregateReliabilityEvaluation(
  rawRecords: readonly unknown[],
  options?: AggregateReliabilityEvaluationOptions
): ReliabilityEvaluationReport {
  const suiteVersion = options?.suiteVersion ?? RELIABILITY_SUITE_VERSION;
  const harnessVersion = options?.harnessVersion ?? CURRENT_HARNESS_VERSION;
  const generatedAt = options?.generatedAt ?? new Date().toISOString();
  const reportId = options?.reportId ?? `eval-report-${Date.now()}`;

  const acceptedRecords: ReliabilityTrialRecord[] = [];
  const rejectedRecords: RejectedTrialRecord[] = [];

  const seenTrialIds = new Set<string>();
  const seenModelRunKeys = new Set<string>();

  for (let idx = 0; idx < rawRecords.length; idx++) {
    const raw = rawRecords[idx];
    const validation = validateReliabilityTrialRecord(raw);

    if (!validation.valid) {
      const summary =
        typeof raw === "object" && raw !== null
          ? JSON.stringify(raw).slice(0, 200)
          : String(raw);
      rejectedRecords.push(
        Object.freeze({
          trialId: (raw as any)?.trialId,
          runId: (raw as any)?.runtimeRunId,
          reason: validation.reason,
          rawRecordSummary: summary,
        })
      );
      continue;
    }

    const rec = validation.record;

    // Deduplication check: trialId must be unique
    if (seenTrialIds.has(rec.trialId)) {
      rejectedRecords.push(
        Object.freeze({
          trialId: rec.trialId,
          runId: rec.runtimeRunId,
          reason: `Duplicate trialId '${rec.trialId}' detected in evaluation trial set`,
          rawRecordSummary: `Model: ${rec.model.modelId}, Task: ${rec.taskId}`,
        })
      );
      continue;
    }
    seenTrialIds.add(rec.trialId);

    // Deduplication check: (modelId, runtimeRunId) must be unique
    const modelRunKey = `${rec.model.modelId}::${rec.runtimeRunId}`;
    if (seenModelRunKeys.has(modelRunKey)) {
      rejectedRecords.push(
        Object.freeze({
          trialId: rec.trialId,
          runId: rec.runtimeRunId,
          reason: `Duplicate execution runId '${rec.runtimeRunId}' for model '${rec.model.modelId}' detected`,
          rawRecordSummary: `TrialId: ${rec.trialId}, Task: ${rec.taskId}`,
        })
      );
      continue;
    }
    seenModelRunKeys.add(modelRunKey);

    acceptedRecords.push(rec);
  }

  // 1. Overall Aggregation
  const overall = computeReliabilityGroupAggregate({
    groupKey: "overall",
    groupType: "OVERALL",
    label: "All Observed Trials",
    records: acceptedRecords,
  });

  // 2. By Model Aggregation
  const recordsByModel = new Map<string, ReliabilityTrialRecord[]>();
  for (const r of acceptedRecords) {
    const mId = r.model.modelId;
    if (!recordsByModel.has(mId)) {
      recordsByModel.set(mId, []);
    }
    recordsByModel.get(mId)!.push(r);
  }

  const sortedModelKeys = [...recordsByModel.keys()].sort();
  const byModel: ReliabilityGroupAggregate[] = [];
  for (const mId of sortedModelKeys) {
    const mRecords = recordsByModel.get(mId)!;
    const firstRec = mRecords[0]!;
    byModel.push(
      computeReliabilityGroupAggregate({
        groupKey: mId,
        groupType: "MODEL",
        label: `Model: ${mId}`,
        records: mRecords,
        metadata: {
          modelId: mId,
          provider: firstRec.model.provider,
          quantization: firstRec.model.quantization,
          runtimeVersion: firstRec.model.runtimeVersion,
        },
      })
    );
  }

  // 3. By Category Aggregation
  const recordsByCategory = new Map<string, ReliabilityTrialRecord[]>();
  for (const r of acceptedRecords) {
    const cat = r.category;
    if (!recordsByCategory.has(cat)) {
      recordsByCategory.set(cat, []);
    }
    recordsByCategory.get(cat)!.push(r);
  }

  const sortedCategoryKeys = [...recordsByCategory.keys()].sort();
  const byCategory: ReliabilityGroupAggregate[] = [];
  for (const cat of sortedCategoryKeys) {
    const cRecords = recordsByCategory.get(cat)!;
    byCategory.push(
      computeReliabilityGroupAggregate({
        groupKey: cat,
        groupType: "CATEGORY",
        label: `Category: ${cat}`,
        records: cRecords,
      })
    );
  }

  // 4. By Task Aggregation
  const recordsByTask = new Map<string, ReliabilityTrialRecord[]>();
  for (const r of acceptedRecords) {
    const tId = r.taskId;
    if (!recordsByTask.has(tId)) {
      recordsByTask.set(tId, []);
    }
    recordsByTask.get(tId)!.push(r);
  }

  const sortedTaskKeys = [...recordsByTask.keys()].sort();
  const byTask: ReliabilityGroupAggregate[] = [];
  for (const tId of sortedTaskKeys) {
    const tRecords = recordsByTask.get(tId)!;
    const category = tRecords[0]?.category;
    byTask.push(
      computeReliabilityGroupAggregate({
        groupKey: tId,
        groupType: "TASK",
        label: `Task: ${tId}`,
        records: tRecords,
        metadata: { category },
      })
    );
  }

  // 5. Cross-Model Comparisons
  const modelComparisons: ModelComparison[] = [];
  for (let i = 0; i < byModel.length; i++) {
    for (let j = i + 1; j < byModel.length; j++) {
      const groupA = byModel[i]!;
      const groupB = byModel[j]!;
      modelComparisons.push(
        compareModels({
          baselineGroup: groupA,
          candidateGroup: groupB,
          baselineRecords: recordsByModel.get(groupA.groupKey)!,
          candidateRecords: recordsByModel.get(groupB.groupKey)!,
        })
      );
    }
  }

  // Default standard limitations
  const defaultLimitations: readonly string[] = [
    "Small sample sizes (N < 30) carry statistical variance and must not be interpreted as definitive rankings.",
    "Benchmark tasks run in hermetic local fixture workspaces; real-world repository tasks may introduce unpredictable external variables.",
    "ConstrainedHostExecutionProvider provides non-sandboxed host execution for trusted benchmark fixtures only; adversarial open-weight models strictly require containerized Docker isolation.",
    "Model completion claims are independently verified; unverified completion opt-ins can never produce VERIFIED_SUCCESS.",
  ];

  const limitations = options?.knownLimitations ?? defaultLimitations;

  // Canonical report content hashing for reproducibility
  const canonicalPayload = {
    suiteVersion,
    harnessVersion,
    overallOutcomes: overall.outcomes,
    overallRates: overall.rates,
    byModel: byModel.map((m) => ({ key: m.groupKey, outcomes: m.outcomes, rates: m.rates })),
    byCategory: byCategory.map((c) => ({ key: c.groupKey, outcomes: c.outcomes, rates: c.rates })),
    byTask: byTask.map((t) => ({ key: t.groupKey, outcomes: t.outcomes, rates: t.rates })),
    acceptedCount: acceptedRecords.length,
    rejectedCount: rejectedRecords.length,
  };
  const reportContentHash = computeCanonicalHash(canonicalPayload).contentHash;

  return Object.freeze({
    reportId,
    generatedAt,
    suiteVersion,
    harnessVersion,
    reportContentHash,
    totalRecordsReceived: rawRecords.length,
    acceptedRecordsCount: acceptedRecords.length,
    rejectedRecordsCount: rejectedRecords.length,
    metricDefinitions: RELIABILITY_METRIC_DEFINITIONS,
    overall,
    byModel: Object.freeze(byModel),
    byCategory: Object.freeze(byCategory),
    byTask: Object.freeze(byTask),
    modelComparisons: Object.freeze(modelComparisons),
    rejectedRecords: Object.freeze(rejectedRecords),
    limitations: Object.freeze(limitations),
  });
}

// ============================================================================
// 7. Human-Readable & JSON Reporting Formatters
// ============================================================================

export function formatReliabilityReportJson(report: ReliabilityEvaluationReport): string {
  return JSON.stringify(report, null, 2);
}

function pct(val: number | undefined): string {
  if (val === undefined || isNaN(val)) return "N/A";
  return `${(val * 100).toFixed(1)}%`;
}

function ms(val: number | undefined): string {
  if (val === undefined || isNaN(val)) return "N/A";
  return `${val.toLocaleString()}ms`;
}

export function formatReliabilityReportMarkdown(report: ReliabilityEvaluationReport): string {
  const lines: string[] = [];

  lines.push(`# Emerald Agent Fabric — Local Model Reliability Evaluation Report`);
  lines.push(``);
  lines.push(`**Report ID**: \`${report.reportId}\`  `);
  lines.push(`**Generated At**: \`${report.generatedAt}\`  `);
  lines.push(`**Suite Version**: \`${report.suiteVersion}\`  `);
  lines.push(`**Harness Version**: \`${report.harnessVersion}\`  `);
  lines.push(`**Content Fingerprint**: \`${report.reportContentHash}\`  `);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 1. Executive Summary Table
  lines.push(`## 1. Executive Reliability Summary`);
  lines.push(``);
  lines.push(`| Metric | Value | Description |`);
  lines.push(`| :--- | :--- | :--- |`);
  lines.push(`| **Total Trials** | \`${report.overall.outcomes.totalTrials}\` | Total valid evaluated trials |`);
  lines.push(`| **Verified Successes** | \`${report.overall.outcomes.verifiedSuccesses}\` | Tasks independently verified by evidence |`);
  lines.push(`| **Verified Success Rate** | **${pct(report.overall.rates.verifiedSuccessRate_TotalTrials)}** | \`verifiedSuccesses / totalTrials\` |`);
  lines.push(`| **Model Completion Claims** | \`${report.overall.outcomes.modelCompletionClaims}\` | Trials where model claimed completion |`);
  lines.push(`| **Claim Accuracy Rate** | **${pct(report.overall.rates.claimAccuracyRate)}** | \`verifiedSuccesses / claims\` |`);
  lines.push(`| **False Completions** | \`${report.overall.outcomes.falseCompletions}\` | Model claimed completion but verification failed |`);
  lines.push(`| **False Completion Rate (Claims)** | **${pct(report.overall.rates.falseCompletionRate_Claims)}** | \`falseCompletions / claims\` |`);
  lines.push(`| **Completion Unverifiable** | \`${report.overall.outcomes.completionUnverifiable}\` | Runtime lacked specs/verifier to prove success |`);
  lines.push(`| **Loop Detections** | \`${report.overall.outcomes.loopDetections}\` | Ineffective multi-step action repetitions |`);
  lines.push(`| **Execution Failures** | \`${report.overall.outcomes.executionFailures}\` | Model, parser, or tool execution failures |`);
  lines.push(`| **Timeouts** | \`${report.overall.outcomes.timeouts}\` | Step, action, or wall-clock budget exhausted |`);
  lines.push(`| **Blocked Trials** | \`${report.overall.outcomes.blockedTrials}\` | Governance or lease fencing halted trial |`);
  lines.push(`| **Average Duration** | \`${ms(report.overall.duration.averageMs)}\` | Mean execution time across samples |`);
  lines.push(`| **Median Duration** | \`${ms(report.overall.duration.medianMs)}\` | Median execution time across samples |`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 2. Metric Definitions Table
  lines.push(`## 2. Metric Definitions & Formulas`);
  lines.push(``);
  lines.push(`| Metric Name | Formula | Numerator | Denominator |`);
  lines.push(`| :--- | :--- | :--- | :--- |`);
  for (const def of report.metricDefinitions) {
    lines.push(`| \`${def.name}\` | \`${def.formula}\` | ${def.numerator} | ${def.denominator} |`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 3. Model Breakdown Table
  lines.push(`## 3. Model Performance Breakdown`);
  lines.push(``);
  if (report.byModel.length === 0) {
    lines.push(`*(No model records observed)*`);
  } else {
    lines.push(`| Model ID | Quant | Trials (N) | Verified Successes | Verified Success Rate | Claim Accuracy | False Claims | Loops | Timeouts | Avg Duration |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const m of report.byModel) {
      const q = (m.metadata?.quantization as string) ?? "N/A";
      lines.push(
        `| \`${m.groupKey}\` | \`${q}\` | ${m.outcomes.totalTrials} | ${m.outcomes.verifiedSuccesses} | **${pct(m.rates.verifiedSuccessRate_TotalTrials)}** | ${pct(m.rates.claimAccuracyRate)} | ${m.outcomes.falseCompletions} (${pct(m.rates.falseCompletionRate_Claims)}) | ${m.outcomes.loopDetections} | ${m.outcomes.timeouts} | ${ms(m.duration.averageMs)} |`
      );
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 4. Benchmark Category Breakdown Table
  lines.push(`## 4. Benchmark Category Breakdown`);
  lines.push(``);
  if (report.byCategory.length === 0) {
    lines.push(`*(No category records observed)*`);
  } else {
    lines.push(`| Category | Trials (N) | Verified Successes | Success Rate | Claims | False Claims | Loops | Timeouts | Blocked |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const c of report.byCategory) {
      lines.push(
        `| \`${c.groupKey}\` | ${c.outcomes.totalTrials} | ${c.outcomes.verifiedSuccesses} | **${pct(c.rates.verifiedSuccessRate_TotalTrials)}** | ${c.outcomes.modelCompletionClaims} | ${c.outcomes.falseCompletions} | ${c.outcomes.loopDetections} | ${c.outcomes.timeouts} | ${c.outcomes.blockedTrials} |`
      );
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 5. Benchmark Task Breakdown Table
  lines.push(`## 5. Benchmark Task Breakdown`);
  lines.push(``);
  if (report.byTask.length === 0) {
    lines.push(`*(No task records observed)*`);
  } else {
    lines.push(`| Task ID | Category | Trials (N) | Verified Successes | Success Rate | False Claims | Timeouts | Failures |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const t of report.byTask) {
      const cat = (t.metadata?.category as string) ?? "N/A";
      lines.push(
        `| \`${t.groupKey}\` | \`${cat}\` | ${t.outcomes.totalTrials} | ${t.outcomes.verifiedSuccesses} | **${pct(t.rates.verifiedSuccessRate_TotalTrials)}** | ${t.outcomes.falseCompletions} | ${t.outcomes.timeouts} | ${t.outcomes.executionFailures} |`
      );
    }
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 6. Cross-Model Comparisons
  lines.push(`## 6. Controlled Model Comparisons`);
  lines.push(``);
  if (report.modelComparisons.length === 0) {
    lines.push(`*(No cross-model comparisons available; requires >= 2 distinct evaluated models)*`);
  } else {
    for (const comp of report.modelComparisons) {
      lines.push(`### Comparison: \`${comp.candidateModelId}\` vs \`${comp.baselineModelId}\``);
      lines.push(``);
      lines.push(`- **Comparable**: \`${comp.isComparable}\``);
      if (!comp.isComparable) {
        lines.push(`- **Incomparability Reasons**:`);
        for (const r of comp.incomparabilityReasons) {
          lines.push(`  - ${r}`);
        }
      }
      lines.push(`- **Common Tasks Evaluated**: \`${comp.commonTaskCount}\``);
      lines.push(
        `- **Sample Counts**: Baseline \`N = ${comp.baselineTotalTrials}\`, Candidate \`N = ${comp.candidateTotalTrials}\``
      );
      lines.push(
        `- **Verified Success Rate**: Baseline \`${pct(comp.baselineVerifiedSuccessRate)}\` vs Candidate \`${pct(comp.candidateVerifiedSuccessRate)}\` (Δ **${comp.deltaVerifiedSuccessRate > 0 ? "+" : ""}${pct(comp.deltaVerifiedSuccessRate)}**)`
      );
      if (comp.baselineClaimAccuracyRate !== undefined && comp.candidateClaimAccuracyRate !== undefined) {
        lines.push(
          `- **Claim Accuracy Rate**: Baseline \`${pct(comp.baselineClaimAccuracyRate)}\` vs Candidate \`${pct(comp.candidateClaimAccuracyRate)}\` (Δ **${(comp.deltaClaimAccuracyRate ?? 0) > 0 ? "+" : ""}${pct(comp.deltaClaimAccuracyRate)}**)`
        );
      }
      lines.push(`- **Disclaimer**: *${comp.disclaimer}*`);
      lines.push(``);
    }
  }
  lines.push(`---`);
  lines.push(``);

  // 7. Incomplete or Rejected Records
  lines.push(`## 7. Data Provenance & Rejected Records`);
  lines.push(``);
  lines.push(`- **Total Records Processed**: \`${report.totalRecordsReceived}\``);
  lines.push(`- **Accepted Valid Records**: \`${report.acceptedRecordsCount}\``);
  lines.push(`- **Rejected Records**: \`${report.rejectedRecordsCount}\``);
  lines.push(``);
  if (report.rejectedRecords.length > 0) {
    lines.push(`| Trial ID | Run ID | Reason | Raw Summary |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const rej of report.rejectedRecords) {
      lines.push(
        `| \`${rej.trialId ?? "N/A"}\` | \`${rej.runId ?? "N/A"}\` | ${rej.reason} | \`${rej.rawRecordSummary.replace(/\|/g, "\\|")}\` |`
      );
    }
  } else {
    lines.push(`*(Zero records rejected; 100% provenance integrity verified)*`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 8. Known Limitations & Research Notices
  lines.push(`## 8. Limitations & Scientific Disclaimers`);
  lines.push(``);
  for (let i = 0; i < report.limitations.length; i++) {
    lines.push(`${i + 1}. ${report.limitations[i]}`);
  }
  lines.push(``);

  return lines.join("\n");
}

// ============================================================================
// 8. Adapter Utility: EvaluationTrial -> ReliabilityTrialRecord
// ============================================================================

export function trialToReliabilityRecord(
  trial: EvaluationTrial,
  options?: {
    category?: string;
    modelMetadata?: Partial<ReliabilityModelMetadata>;
    budget?: ReliabilityExecutionBudget;
  }
): ReliabilityTrialRecord {
  const modelId = trial.configFingerprint.model;
  const provider = trial.configFingerprint.modelProvider;

  const modelMeta: ReliabilityModelMetadata = {
    modelId,
    provider,
    modelName: options?.modelMetadata?.modelName ?? modelId,
    quantization: options?.modelMetadata?.quantization,
    runtimeVersion: options?.modelMetadata?.runtimeVersion,
    parameters: options?.modelMetadata?.parameters,
  };

  const finalOutcome = trial.finalOutcome ?? (trial.outcome === "PASSED" ? "VERIFIED_SUCCESS" : "EXECUTION_FAILURE");

  const modelClaim = trial.completionClaim ?? {
    claimed: Boolean(trial.agentClaimedGoal),
  };

  const verificationAss: TrialVerificationAssessment = trial.verificationAssessment ?? {
    decision: trial.verificationPassed ? "VERIFIED" : "REJECTED",
    reasonCode: trial.verificationPassed ? "AUTHORITATIVE_VERIFIED" : "SPEC_ASSERTION_FAILED",
  };

  return {
    trialId: trial.trialId,
    runtimeRunId: trial.runtimeRunId,
    model: modelMeta,
    taskId: trial.taskId,
    category: options?.category ?? "BENCH_GENERAL",
    finalOutcome,
    modelCompletionClaim: modelClaim,
    verificationAssessment: verificationAss,
    durationMs: trial.metrics.wallClockMs,
    startedAt: trial.startedAt,
    completedAt: trial.completedAt,
    budget: options?.budget,
    suiteVersion: RELIABILITY_SUITE_VERSION,
    harnessVersion: trial.configFingerprint.harnessVersion,
    trialOrdinal: trial.trialOrdinal,
  };
}
