/**
 * Statistical Evaluation Analysis Domain Contracts for Emerald Agent Fabric.
 *
 * Establishes mathematically explicit, provider-neutral domain contracts
 * for quantifying observed differences, sample statistics, and uncertainty
 * estimates across repeated evaluation trials and experiment conditions.
 *
 * Architectural Invariants:
 * 1. Analysis is Derived Evidence (Zero Execution Authority):
 *    StatisticalAnalysis is a pure read/derive operation over completed
 *    evaluation records (EvaluationExperiment, EvaluationTrial, EvaluationReport).
 *    It has zero execution authority, zero policy authority, and does not alter
 *    Runtime Runs, MissionContracts, or tool permissions.
 * 2. Independent Samples by Default:
 *    Trials are treated as independent observations unless explicit paired
 *    semantics are declared in the experiment. No implicit pairing is assumed.
 * 3. Strict Missing Metric Semantics:
 *    Observed zero (0) is strictly preserved and participates in samples.
 *    Missing observations (undefined) are tracked explicitly (unavailableCount)
 *    and excluded from sample denominators. Values are never fabricated.
 * 4. Numerically Stable Computation:
 *    Sample variance and standard deviation are computed using Welford's algorithm
 *    to prevent catastrophic cancellation. Non-finite values (NaN, Infinity) fail closed.
 * 5. Explicit Uncertainty Contracts:
 *    - Objective success rates use Wilson score intervals.
 *    - Continuous metrics use Student's t-distribution confidence intervals with df = n - 1.
 *    - For n < 2, uncertainty intervals are explicitly unavailable.
 * 6. Directional Differences != Causal Claims:
 *    Differences are reported as descriptive deltas (absoluteDifference, relativeDifference).
 *    No claims of statistical significance, hypothesis rejection, or causation are made.
 * 7. Methodological Warnings:
 *    Small samples, missing data, and wide intervals produce transparent warnings
 *    without failing mathematically valid computations.
 */

import { z } from "zod";
import { computeCanonicalHash, isSensitiveKey } from "./canonical-hash.js";
import { FORBIDDEN_AUTHORITY_KEYS } from "./action-proposal.js";
import {
  EvaluationExperiment,
  EvaluationTaskReference,
  EvaluationTaskReferenceSchema,
  EvaluationTrial,
  EVALUATION_METRIC_KEYS,
  EvaluationMetricKey,
} from "./evaluation.js";

// ============================================================================
// 1. Constants & Taxonomies
// ============================================================================

export const STATISTICAL_ANALYSIS_METHODS = [
  "STUDENT_T",
  "WILSON_SCORE",
] as const;
export type StatisticalAnalysisMethod = (typeof STATISTICAL_ANALYSIS_METHODS)[number];

export const METRIC_DIRECTIONS = [
  "HIGHER_IS_BETTER",
  "LOWER_IS_BETTER",
  "NEUTRAL",
] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const STATISTICAL_WARNING_CODES = [
  "INSUFFICIENT_OBSERVATIONS",
  "MISSING_DATA",
  "ZERO_BASELINE",
  "WIDE_INTERVAL",
  "SINGLE_OBSERVATION",
  "UNEQUAL_SAMPLE_COUNTS",
] as const;
export type StatisticalWarningCode = (typeof STATISTICAL_WARNING_CODES)[number];

export const DEFAULT_CONFIDENCE_LEVEL = 0.95;

/**
 * Default metric direction mapping for known evaluation metrics.
 */
export const DEFAULT_METRIC_DIRECTIONS: Readonly<Record<string, MetricDirection>> = Object.freeze({
  objectivePassRate: "HIGHER_IS_BETTER",
  steps: "LOWER_IS_BETTER",
  actions: "LOWER_IS_BETTER",
  attempts: "LOWER_IS_BETTER",
  modelCalls: "LOWER_IS_BETTER",
  toolCalls: "LOWER_IS_BETTER",
  proposalRejections: "LOWER_IS_BETTER",
  executionFailures: "LOWER_IS_BETTER",
  modelFailures: "LOWER_IS_BETTER",
  wallClockMs: "LOWER_IS_BETTER",
  modelLatencyMs: "LOWER_IS_BETTER",
  toolLatencyMs: "LOWER_IS_BETTER",
  inputTokens: "LOWER_IS_BETTER",
  outputTokens: "LOWER_IS_BETTER",
  totalTokens: "LOWER_IS_BETTER",
});

// ============================================================================
// 2. Mathematical Kernels (Acklam's Probit, Student-t Quantile, Wilson Score)
// ============================================================================

// Acklam's algorithm coefficients for standard normal quantile Φ⁻¹(p)
const ACK_A = [
  -3.969683028665376e1,
   2.209460984245205e2,
  -2.759285104469687e2,
   1.383577518672690e2,
  -3.066479806614716e1,
   2.506628277459239e0,
];

const ACK_B = [
  -5.447609879822406e1,
   1.615858368580409e2,
  -1.556989798598866e2,
   6.680131188771972e1,
  -1.328068155288572e1,
];

const ACK_C = [
  -7.784894002430293e-3,
  -3.223964580411365e-1,
  -2.400758277161838e0,
  -2.549732539343734e0,
   4.374664141464968e0,
   2.938163982698783e0,
];

const ACK_D = [
   7.784695709041462e-3,
   3.224671290700398e-1,
   2.445134137142996e0,
   3.754408661907416e0,
];

const ACK_P_LOW = 0.02425;
const ACK_P_HIGH = 1 - ACK_P_LOW;

/**
 * Computes standard normal inverse CDF (probit) Φ⁻¹(p) using Acklam's rational approximation.
 * Precision: < 1.15e-9 across (0, 1).
 */
export function normalQuantile(p: number): number {
  if (typeof p !== "number" || isNaN(p) || p <= 0 || p >= 1) {
    throw new Error(`Probability p must be strictly between 0 and 1, received ${p}`);
  }

  if (p < ACK_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((ACK_C[0]! * q + ACK_C[1]!) * q + ACK_C[2]!) * q + ACK_C[3]!) * q + ACK_C[4]!) * q + ACK_C[5]!
    ) / (
      (((ACK_D[0]! * q + ACK_D[1]!) * q + ACK_D[2]!) * q + ACK_D[3]!) * q + 1
    );
  }

  if (p <= ACK_P_HIGH) {
    const q = p - 0.5;
    const r = q * q;
    return (
      (((((ACK_A[0]! * r + ACK_A[1]!) * r + ACK_A[2]!) * r + ACK_A[3]!) * r + ACK_A[4]!) * r + ACK_A[5]!) * q
    ) / (
      ((((ACK_B[0]! * r + ACK_B[1]!) * r + ACK_B[2]!) * r + ACK_B[3]!) * r + ACK_B[4]!) * r + 1
    );
  }

  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    ((((ACK_C[0]! * q + ACK_C[1]!) * q + ACK_C[2]!) * q + ACK_C[3]!) * q + ACK_C[4]!) * q + ACK_C[5]!
  ) / (
    (((ACK_D[0]! * q + ACK_D[1]!) * q + ACK_D[2]!) * q + ACK_D[3]!) * q + 1
  );
}

/**
 * Computes the Student's t critical value t_{p, df} for probability p ∈ (0.5, 1) and degrees of freedom df ≥ 1.
 * Uses exact closed-form expressions for df = 1 (Cauchy) and df = 2, and Cornish-Fisher expansion for df ≥ 3.
 */
export function studentTQuantile(p: number, df: number): number {
  if (typeof p !== "number" || isNaN(p) || p <= 0.5 || p >= 1) {
    throw new Error(`Probability p must be strictly between 0.5 and 1, received ${p}`);
  }
  if (typeof df !== "number" || isNaN(df) || df < 1 || !Number.isInteger(df)) {
    throw new Error(`Degrees of freedom df must be an integer >= 1, received ${df}`);
  }

  if (df === 1) {
    return Math.tan(Math.PI * (p - 0.5));
  }

  if (df === 2) {
    return (2 * p - 1) / Math.sqrt(2 * p * (1 - p));
  }

  // Cornish-Fisher expansion around standard normal quantile z
  const z = normalQuantile(p);
  const y = z * z;
  const v = df;

  const term1 = (y + 1) / (4 * v);
  const term2 = (5 * y * y + 16 * y + 3) / (96 * v * v);
  const term3 = (3 * y * y * y + 19 * y * y + 17 * y - 15) / (384 * v * v * v);
  const term4 =
    (79 * Math.pow(y, 4) + 776 * Math.pow(y, 3) + 1482 * y * y - 1920 * y - 945) /
    (92160 * Math.pow(v, 4));

  return z * (1 + term1 + term2 + term3 + term4);
}

// ============================================================================
// 3. Domain Interfaces & Schemas
// ============================================================================

export interface StatisticalWarning {
  readonly code: StatisticalWarningCode;
  readonly message: string;
}

export const StatisticalWarningSchema = z
  .object({
    code: z.enum(STATISTICAL_WARNING_CODES),
    message: z.string().min(1),
  })
  .strict();

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  readonly confidenceLevel: number;
  readonly degreesOfFreedom?: number;
}

export const ConfidenceIntervalSchema = z
  .object({
    lower: z.number(),
    upper: z.number(),
    confidenceLevel: z.number().positive().max(1),
    degreesOfFreedom: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.lower > val.upper) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Confidence interval lower bound (${val.lower}) cannot exceed upper bound (${val.upper})`,
      });
    }
  });

export interface NumericSampleSummary {
  readonly sampleCount: number;
  readonly observedCount: number;
  readonly unavailableCount: number;
  readonly mean?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly variance?: number;
  readonly standardDeviation?: number;
  readonly standardError?: number;
  readonly confidenceInterval?: ConfidenceInterval;
}

export const NumericSampleSummarySchema = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    observedCount: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
    mean: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    variance: z.number().nonnegative().optional(),
    standardDeviation: z.number().nonnegative().optional(),
    standardError: z.number().nonnegative().optional(),
    confidenceInterval: ConfidenceIntervalSchema.optional(),
  })
  .strict();

export interface BinarySampleSummary {
  readonly totalTrials: number;
  readonly observedTrials: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate?: number;
  readonly confidenceInterval?: ConfidenceInterval;
}

export const BinarySampleSummarySchema = z
  .object({
    totalTrials: z.number().int().nonnegative(),
    observedTrials: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1).optional(),
    confidenceInterval: ConfidenceIntervalSchema.optional(),
  })
  .strict();

export interface StatisticalDifference {
  readonly absoluteDifference?: number;
  readonly relativeDifference?: number;
  readonly direction: MetricDirection;
}

export const StatisticalDifferenceSchema = z
  .object({
    absoluteDifference: z.number().optional(),
    relativeDifference: z.number().optional(),
    direction: z.enum(METRIC_DIRECTIONS),
  })
  .strict();

export interface StatisticalAnalysisConfig {
  readonly confidenceLevel: number;
  readonly metric: string;
  readonly direction?: MetricDirection;
  readonly analysisMethod: StatisticalAnalysisMethod;
  readonly configHash: string;
}

export function computeStatisticalAnalysisConfigHash(params: {
  readonly confidenceLevel: number;
  readonly metric: string;
  readonly direction?: MetricDirection;
  readonly analysisMethod: StatisticalAnalysisMethod;
}): string {
  const canonicalPayload = {
    analysisMethod: params.analysisMethod,
    confidenceLevel: params.confidenceLevel,
    direction: params.direction ?? DEFAULT_METRIC_DIRECTIONS[params.metric] ?? "NEUTRAL",
    metric: params.metric,
  };
  return computeCanonicalHash(canonicalPayload).contentHash;
}

export const StatisticalAnalysisConfigSchema = z
  .object({
    confidenceLevel: z.number().positive().max(1),
    metric: z.string().min(1),
    direction: z.enum(METRIC_DIRECTIONS).optional(),
    analysisMethod: z.enum(STATISTICAL_ANALYSIS_METHODS),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface StatisticalAnalysis {
  readonly analysisId: string;
  readonly experimentId: string;
  readonly experimentVersion: number;
  readonly experimentContentHash: string;
  readonly taskRef: EvaluationTaskReference;
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly metric: string;
  readonly analysisMethod: StatisticalAnalysisMethod;
  readonly direction: MetricDirection;
  readonly confidenceLevel: number;
  readonly baselineSummary: NumericSampleSummary | BinarySampleSummary;
  readonly candidateSummary: NumericSampleSummary | BinarySampleSummary;
  readonly difference: StatisticalDifference;
  readonly warnings: readonly StatisticalWarning[];
  readonly analysisContentHash: string;
}

export function computeStatisticalAnalysisHash(params: {
  readonly experimentId: string;
  readonly experimentVersion: number;
  readonly experimentContentHash: string;
  readonly taskRef: EvaluationTaskReference;
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly metric: string;
  readonly analysisMethod: StatisticalAnalysisMethod;
  readonly direction: MetricDirection;
  readonly confidenceLevel: number;
  readonly baselineSummary: NumericSampleSummary | BinarySampleSummary;
  readonly candidateSummary: NumericSampleSummary | BinarySampleSummary;
  readonly difference: StatisticalDifference;
  readonly warnings: readonly StatisticalWarning[];
}): string {
  const canonicalPayload = {
    analysisMethod: params.analysisMethod,
    baselineConditionId: params.baselineConditionId,
    baselineSummary: params.baselineSummary,
    candidateConditionId: params.candidateConditionId,
    candidateSummary: params.candidateSummary,
    confidenceLevel: params.confidenceLevel,
    difference: params.difference,
    direction: params.direction,
    experimentContentHash: params.experimentContentHash,
    experimentId: params.experimentId,
    experimentVersion: params.experimentVersion,
    metric: params.metric,
    taskRef: {
      taskId: params.taskRef.taskId,
      taskVersion: params.taskRef.taskVersion,
      taskContentHash: params.taskRef.taskContentHash,
    },
    warnings: [...params.warnings].sort((a, b) => a.code.localeCompare(b.code)),
  };

  return computeCanonicalHash(canonicalPayload).contentHash;
}

export const StatisticalAnalysisSchema = z
  .object({
    analysisId: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    taskRef: EvaluationTaskReferenceSchema,
    baselineConditionId: z.string().min(1),
    candidateConditionId: z.string().min(1),
    metric: z.string().min(1),
    analysisMethod: z.enum(STATISTICAL_ANALYSIS_METHODS),
    direction: z.enum(METRIC_DIRECTIONS),
    confidenceLevel: z.number().positive().max(1),
    baselineSummary: z.union([NumericSampleSummarySchema, BinarySampleSummarySchema]),
    candidateSummary: z.union([NumericSampleSummarySchema, BinarySampleSummarySchema]),
    difference: StatisticalDifferenceSchema,
    warnings: z.array(StatisticalWarningSchema),
    analysisContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Content hash verification
    const expectedHash = computeStatisticalAnalysisHash({
      experimentId: val.experimentId,
      experimentVersion: val.experimentVersion,
      experimentContentHash: val.experimentContentHash,
      taskRef: val.taskRef,
      baselineConditionId: val.baselineConditionId,
      candidateConditionId: val.candidateConditionId,
      metric: val.metric,
      analysisMethod: val.analysisMethod,
      direction: val.direction,
      confidenceLevel: val.confidenceLevel,
      baselineSummary: val.baselineSummary as any,
      candidateSummary: val.candidateSummary as any,
      difference: val.difference,
      warnings: val.warnings,
    });
    if (val.analysisContentHash !== expectedHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `analysisContentHash mismatch. Expected '${expectedHash}', received '${val.analysisContentHash}'`,
      });
    }

    // 2. Sensitive key check
    if (isSensitiveKey(val.analysisId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "analysisId contains a sensitive or secret keyword",
      });
    }

    // 3. Security firewall: authority keyword checks
    for (const forbidden of FORBIDDEN_AUTHORITY_KEYS) {
      if (val.analysisId.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `analysisId contains forbidden authority keyword '${forbidden}'`,
        });
      }
      if (val.experimentId.toLowerCase().includes(forbidden.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `experimentId contains forbidden authority keyword '${forbidden}'`,
        });
      }
    }
  });

export function validateStatisticalAnalysis(def: unknown): StatisticalAnalysis {
  const result = StatisticalAnalysisSchema.safeParse(def);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed StatisticalAnalysis: ${issues}`);
  }
  return Object.freeze({
    analysisId: result.data.analysisId,
    experimentId: result.data.experimentId,
    experimentVersion: result.data.experimentVersion,
    experimentContentHash: result.data.experimentContentHash,
    taskRef: Object.freeze({ ...result.data.taskRef }),
    baselineConditionId: result.data.baselineConditionId,
    candidateConditionId: result.data.candidateConditionId,
    metric: result.data.metric,
    analysisMethod: result.data.analysisMethod,
    direction: result.data.direction,
    confidenceLevel: result.data.confidenceLevel,
    baselineSummary: Object.freeze({ ...result.data.baselineSummary }) as NumericSampleSummary | BinarySampleSummary,
    candidateSummary: Object.freeze({ ...result.data.candidateSummary }) as NumericSampleSummary | BinarySampleSummary,
    difference: Object.freeze({ ...result.data.difference }),
    warnings: Object.freeze(result.data.warnings.map((w) => Object.freeze({ ...w }))),
    analysisContentHash: result.data.analysisContentHash,
  });
}

// ============================================================================
// 4. Sample Statistics & Difference Calculation
// ============================================================================

/**
 * Computes sample statistics for a collection of numeric observations using Welford's algorithm.
 * Rejects non-finite values (NaN, Infinity).
 * Preserves observed zero (0).
 * Excludes undefined from sample denominators while tracking unavailableCount.
 */
export function calculateSampleStatistics(
  values: readonly (number | undefined)[],
  confidenceLevel?: number
): NumericSampleSummary {
  if (confidenceLevel !== undefined) {
    if (typeof confidenceLevel !== "number" || isNaN(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
      throw new Error(`confidenceLevel must be strictly between 0 and 1, received ${confidenceLevel}`);
    }
  }

  let observedCount = 0;
  let unavailableCount = 0;
  let mean = 0;
  let M2 = 0;
  let minimum = Infinity;
  let maximum = -Infinity;

  for (const v of values) {
    if (v === undefined) {
      unavailableCount++;
      continue;
    }

    if (typeof v !== "number" || isNaN(v) || !Number.isFinite(v)) {
      throw new Error(`Invalid non-finite numeric observation: ${v}`);
    }

    observedCount++;
    const delta = v - mean;
    mean += delta / observedCount;
    const delta2 = v - mean;
    M2 += delta * delta2;

    if (v < minimum) minimum = v;
    if (v > maximum) maximum = v;
  }

  const sampleCount = observedCount + unavailableCount;

  if (observedCount === 0) {
    return Object.freeze({
      sampleCount,
      observedCount: 0,
      unavailableCount,
      mean: undefined,
      minimum: undefined,
      maximum: undefined,
      variance: undefined,
      standardDeviation: undefined,
      standardError: undefined,
      confidenceInterval: undefined,
    });
  }

  const roundedMean = Math.round(mean * 1e8) / 1e8;

  if (observedCount === 1) {
    return Object.freeze({
      sampleCount,
      observedCount: 1,
      unavailableCount,
      mean: roundedMean,
      minimum,
      maximum,
      variance: undefined,
      standardDeviation: undefined,
      standardError: undefined,
      confidenceInterval: undefined,
    });
  }

  const varianceRaw = Math.max(0, M2 / (observedCount - 1));
  const variance = Math.round(varianceRaw * 1e8) / 1e8;
  const standardDeviationRaw = Math.sqrt(varianceRaw);
  const standardDeviation = Math.round(standardDeviationRaw * 1e8) / 1e8;
  const standardErrorRaw = standardDeviationRaw / Math.sqrt(observedCount);
  const standardError = Math.round(standardErrorRaw * 1e8) / 1e8;

  let confidenceInterval: ConfidenceInterval | undefined = undefined;
  if (confidenceLevel !== undefined) {
    const df = observedCount - 1;
    const tCrit = studentTQuantile((1 + confidenceLevel) / 2, df);
    const margin = tCrit * standardErrorRaw;
    const lower = Math.round((mean - margin) * 1e8) / 1e8;
    const upper = Math.round((mean + margin) * 1e8) / 1e8;
    confidenceInterval = Object.freeze({
      lower,
      upper,
      confidenceLevel,
      degreesOfFreedom: df,
    });
  }

  return Object.freeze({
    sampleCount,
    observedCount,
    unavailableCount,
    mean: roundedMean,
    minimum,
    maximum,
    variance,
    standardDeviation,
    standardError,
    confidenceInterval,
  });
}

/**
 * Calculates Wilson score confidence interval for a binomial proportion.
 */
export function calculateWilsonScoreInterval(
  successes: number,
  total: number,
  confidenceLevel: number
): ConfidenceInterval | undefined {
  if (typeof confidenceLevel !== "number" || isNaN(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error(`confidenceLevel must be strictly between 0 and 1, received ${confidenceLevel}`);
  }
  if (total <= 0) {
    return undefined;
  }
  if (successes < 0 || successes > total) {
    throw new Error(`successes (${successes}) must be between 0 and total (${total})`);
  }

  const alpha = 1 - confidenceLevel;
  const z = normalQuantile(1 - alpha / 2);

  const z2 = z * z;
  const p = successes / total;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;

  const lower = Math.max(0, Math.round((center - margin) * 1e8) / 1e8);
  const upper = Math.min(1, Math.round((center + margin) * 1e8) / 1e8);

  return Object.freeze({
    lower,
    upper,
    confidenceLevel,
  });
}

/**
 * Computes descriptive differences (absoluteDifference, relativeDifference).
 * When baseline is 0 or undefined, relativeDifference remains undefined (no Infinity or NaN).
 */
export function calculateDifference(params: {
  baseline: number | undefined;
  candidate: number | undefined;
  direction?: MetricDirection;
}): StatisticalDifference {
  const direction = params.direction ?? "NEUTRAL";

  if (params.baseline === undefined || params.candidate === undefined) {
    return Object.freeze({
      absoluteDifference: undefined,
      relativeDifference: undefined,
      direction,
    });
  }

  const rawAbs = params.candidate - params.baseline;
  const absoluteDifference = Math.round(rawAbs * 1e8) / 1e8;

  let relativeDifference: number | undefined = undefined;
  if (params.baseline !== 0) {
    const rawRel = (params.candidate - params.baseline) / params.baseline;
    relativeDifference = Math.round(rawRel * 1e8) / 1e8;
  }

  return Object.freeze({
    absoluteDifference,
    relativeDifference,
    direction,
  });
}

// ============================================================================
// 5. High-Level Pure Statistical Analysis Engine
// ============================================================================

export interface AnalyzeNumericMetricParams {
  readonly experiment: EvaluationExperiment;
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly metric: string;
  readonly baselineValues: readonly (number | undefined)[];
  readonly candidateValues: readonly (number | undefined)[];
  readonly confidenceLevel?: number;
  readonly direction?: MetricDirection;
}

export function analyzeNumericMetric(params: AnalyzeNumericMetricParams): StatisticalAnalysis {
  const confidenceLevel = params.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const direction = params.direction ?? DEFAULT_METRIC_DIRECTIONS[params.metric] ?? "NEUTRAL";

  const baselineCondition = params.experiment.conditions.find(
    (c) => c.conditionId === params.baselineConditionId
  );
  if (!baselineCondition) {
    throw new Error(`Baseline condition '${params.baselineConditionId}' not found in experiment`);
  }

  const candidateCondition = params.experiment.conditions.find(
    (c) => c.conditionId === params.candidateConditionId
  );
  if (!candidateCondition) {
    throw new Error(`Candidate condition '${params.candidateConditionId}' not found in experiment`);
  }

  const baselineSummary = calculateSampleStatistics(params.baselineValues, confidenceLevel);
  const candidateSummary = calculateSampleStatistics(params.candidateValues, confidenceLevel);

  const difference = calculateDifference({
    baseline: baselineSummary.mean,
    candidate: candidateSummary.mean,
    direction,
  });

  const warnings: StatisticalWarning[] = [];

  if (baselineSummary.observedCount === 1 || candidateSummary.observedCount === 1) {
    warnings.push(
      Object.freeze({
        code: "SINGLE_OBSERVATION",
        message: "At least one condition contains only a single observation; variance and uncertainty intervals cannot be established",
      })
    );
  }

  if (baselineSummary.observedCount < 2 || candidateSummary.observedCount < 2) {
    warnings.push(
      Object.freeze({
        code: "INSUFFICIENT_OBSERVATIONS",
        message: "Fewer than 2 observations available in at least one condition; uncertainty intervals are unavailable",
      })
    );
  }

  if (baselineSummary.unavailableCount > 0 || candidateSummary.unavailableCount > 0) {
    warnings.push(
      Object.freeze({
        code: "MISSING_DATA",
        message: "At least one condition contains unavailable observations that were excluded from the sample",
      })
    );
  }

  if (baselineSummary.mean === 0 && candidateSummary.mean !== 0) {
    warnings.push(
      Object.freeze({
        code: "ZERO_BASELINE",
        message: "Baseline point estimate is zero; relative difference cannot be defined mathematically",
      })
    );
  }

  if (baselineSummary.observedCount !== candidateSummary.observedCount) {
    warnings.push(
      Object.freeze({
        code: "UNEQUAL_SAMPLE_COUNTS",
        message: `Baseline observed count (${baselineSummary.observedCount}) does not match candidate observed count (${candidateSummary.observedCount})`,
      })
    );
  }

  if (baselineSummary.confidenceInterval && candidateSummary.confidenceInterval) {
    const baseWidth = baselineSummary.confidenceInterval.upper - baselineSummary.confidenceInterval.lower;
    const candWidth = candidateSummary.confidenceInterval.upper - candidateSummary.confidenceInterval.lower;
    const baseMeanAbs = Math.abs(baselineSummary.mean ?? 1);
    const candMeanAbs = Math.abs(candidateSummary.mean ?? 1);
    if (baseWidth > 2 * baseMeanAbs || candWidth > 2 * candMeanAbs) {
      warnings.push(
        Object.freeze({
          code: "WIDE_INTERVAL",
          message: "At least one condition exhibits a wide confidence interval indicating high uncertainty",
        })
      );
    }
  }

  const analysisId = `analysis-${params.experiment.experimentId}-${params.metric}-${params.baselineConditionId}-vs-${params.candidateConditionId}`;

  const analysisContentHash = computeStatisticalAnalysisHash({
    experimentId: params.experiment.experimentId,
    experimentVersion: params.experiment.version,
    experimentContentHash: params.experiment.experimentContentHash,
    taskRef: params.experiment.taskRef,
    baselineConditionId: params.baselineConditionId,
    candidateConditionId: params.candidateConditionId,
    metric: params.metric,
    analysisMethod: "STUDENT_T",
    direction,
    confidenceLevel,
    baselineSummary,
    candidateSummary,
    difference,
    warnings,
  });

  return Object.freeze({
    analysisId,
    experimentId: params.experiment.experimentId,
    experimentVersion: params.experiment.version,
    experimentContentHash: params.experiment.experimentContentHash,
    taskRef: params.experiment.taskRef,
    baselineConditionId: params.baselineConditionId,
    candidateConditionId: params.candidateConditionId,
    metric: params.metric,
    analysisMethod: "STUDENT_T",
    direction,
    confidenceLevel,
    baselineSummary,
    candidateSummary,
    difference,
    warnings: Object.freeze(warnings),
    analysisContentHash,
  });
}

export interface AnalyzeBinaryOutcomeParams {
  readonly experiment: EvaluationExperiment;
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly baselineSuccesses: number;
  readonly baselineFailures: number;
  readonly candidateSuccesses: number;
  readonly candidateFailures: number;
  readonly baselineTotalTrials?: number;
  readonly candidateTotalTrials?: number;
  readonly confidenceLevel?: number;
}

export function analyzeBinaryOutcome(params: AnalyzeBinaryOutcomeParams): StatisticalAnalysis {
  const confidenceLevel = params.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const direction: MetricDirection = "HIGHER_IS_BETTER";

  const baselineCondition = params.experiment.conditions.find(
    (c) => c.conditionId === params.baselineConditionId
  );
  if (!baselineCondition) {
    throw new Error(`Baseline condition '${params.baselineConditionId}' not found in experiment`);
  }

  const candidateCondition = params.experiment.conditions.find(
    (c) => c.conditionId === params.candidateConditionId
  );
  if (!candidateCondition) {
    throw new Error(`Candidate condition '${params.candidateConditionId}' not found in experiment`);
  }

  const baselineObserved = params.baselineSuccesses + params.baselineFailures;
  const candidateObserved = params.candidateSuccesses + params.candidateFailures;
  const baselineTotal = params.baselineTotalTrials ?? baselineObserved;
  const candidateTotal = params.candidateTotalTrials ?? candidateObserved;

  const baselineRate =
    baselineObserved > 0 ? Math.round((params.baselineSuccesses / baselineObserved) * 1e8) / 1e8 : undefined;
  const candidateRate =
    candidateObserved > 0 ? Math.round((params.candidateSuccesses / candidateObserved) * 1e8) / 1e8 : undefined;

  const baselineInterval = calculateWilsonScoreInterval(
    params.baselineSuccesses,
    baselineObserved,
    confidenceLevel
  );
  const candidateInterval = calculateWilsonScoreInterval(
    params.candidateSuccesses,
    candidateObserved,
    confidenceLevel
  );

  const baselineSummary: BinarySampleSummary = Object.freeze({
    totalTrials: baselineTotal,
    observedTrials: baselineObserved,
    successes: params.baselineSuccesses,
    failures: params.baselineFailures,
    successRate: baselineRate,
    confidenceInterval: baselineInterval,
  });

  const candidateSummary: BinarySampleSummary = Object.freeze({
    totalTrials: candidateTotal,
    observedTrials: candidateObserved,
    successes: params.candidateSuccesses,
    failures: params.candidateFailures,
    successRate: candidateRate,
    confidenceInterval: candidateInterval,
  });

  const difference = calculateDifference({
    baseline: baselineRate,
    candidate: candidateRate,
    direction,
  });

  const warnings: StatisticalWarning[] = [];

  if (baselineObserved === 1 || candidateObserved === 1) {
    warnings.push(
      Object.freeze({
        code: "SINGLE_OBSERVATION",
        message: "At least one condition contains only a single completed trial",
      })
    );
  }

  if (baselineObserved < 2 || candidateObserved < 2) {
    warnings.push(
      Object.freeze({
        code: "INSUFFICIENT_OBSERVATIONS",
        message: "Fewer than 2 completed trials in at least one condition",
      })
    );
  }

  if (baselineTotal > baselineObserved || candidateTotal > candidateObserved) {
    warnings.push(
      Object.freeze({
        code: "MISSING_DATA",
        message: "Incomplete trial outcomes were excluded from the completion denominator",
      })
    );
  }

  if (baselineRate === 0 && candidateRate !== 0 && candidateRate !== undefined) {
    warnings.push(
      Object.freeze({
        code: "ZERO_BASELINE",
        message: "Baseline success rate is zero; relative difference cannot be defined mathematically",
      })
    );
  }

  if (baselineObserved !== candidateObserved) {
    warnings.push(
      Object.freeze({
        code: "UNEQUAL_SAMPLE_COUNTS",
        message: `Baseline observed trial count (${baselineObserved}) does not match candidate (${candidateObserved})`,
      })
    );
  }

  if (baselineInterval && candidateInterval) {
    const baseWidth = baselineInterval.upper - baselineInterval.lower;
    const candWidth = candidateInterval.upper - candidateInterval.lower;
    if (baseWidth > 0.5 || candWidth > 0.5) {
      warnings.push(
        Object.freeze({
          code: "WIDE_INTERVAL",
          message: "At least one condition exhibits a wide confidence interval indicating high uncertainty",
        })
      );
    }
  }

  const analysisId = `analysis-${params.experiment.experimentId}-objectivePassRate-${params.baselineConditionId}-vs-${params.candidateConditionId}`;

  const analysisContentHash = computeStatisticalAnalysisHash({
    experimentId: params.experiment.experimentId,
    experimentVersion: params.experiment.version,
    experimentContentHash: params.experiment.experimentContentHash,
    taskRef: params.experiment.taskRef,
    baselineConditionId: params.baselineConditionId,
    candidateConditionId: params.candidateConditionId,
    metric: "objectivePassRate",
    analysisMethod: "WILSON_SCORE",
    direction,
    confidenceLevel,
    baselineSummary,
    candidateSummary,
    difference,
    warnings,
  });

  return Object.freeze({
    analysisId,
    experimentId: params.experiment.experimentId,
    experimentVersion: params.experiment.version,
    experimentContentHash: params.experiment.experimentContentHash,
    taskRef: params.experiment.taskRef,
    baselineConditionId: params.baselineConditionId,
    candidateConditionId: params.candidateConditionId,
    metric: "objectivePassRate",
    analysisMethod: "WILSON_SCORE",
    direction,
    confidenceLevel,
    baselineSummary,
    candidateSummary,
    difference,
    warnings: Object.freeze(warnings),
    analysisContentHash,
  });
}

/**
 * Analyzes a metric directly across an EvaluationExperiment and its completed EvaluationTrial records.
 */
export function analyzeExperiment(params: {
  readonly experiment: EvaluationExperiment;
  readonly trials: readonly EvaluationTrial[];
  readonly baselineConditionId: string;
  readonly candidateConditionId: string;
  readonly metric: string;
  readonly confidenceLevel?: number;
  readonly direction?: MetricDirection;
}): StatisticalAnalysis {
  const baseCond = params.experiment.conditions.find((c) => c.conditionId === params.baselineConditionId);
  if (!baseCond) {
    throw new Error(`Baseline condition '${params.baselineConditionId}' not found in experiment`);
  }
  const candCond = params.experiment.conditions.find((c) => c.conditionId === params.candidateConditionId);
  if (!candCond) {
    throw new Error(`Candidate condition '${params.candidateConditionId}' not found in experiment`);
  }

  // Validate comparability of all trials against experiment task and conditions
  for (const t of params.trials) {
    if (t.taskId !== params.experiment.taskRef.taskId) {
      throw new Error(`Trial '${t.trialId}' taskId mismatch: expected '${params.experiment.taskRef.taskId}', received '${t.taskId}'`);
    }
    if (t.taskVersion !== params.experiment.taskRef.taskVersion) {
      throw new Error(`Trial '${t.trialId}' taskVersion mismatch: expected ${params.experiment.taskRef.taskVersion}, received ${t.taskVersion}`);
    }
    if (t.taskContentHash !== params.experiment.taskRef.taskContentHash) {
      throw new Error(`Trial '${t.trialId}' taskContentHash mismatch: expected '${params.experiment.taskRef.taskContentHash}', received '${t.taskContentHash}'`);
    }

    const matchesAnyCondition = params.experiment.conditions.some(
      (c) => c.configFingerprint.fingerprintHash === t.configFingerprint.fingerprintHash
    );
    if (!matchesAnyCondition) {
      throw new Error(`Trial '${t.trialId}' configuration fingerprint does not match any condition in experiment '${params.experiment.experimentId}'`);
    }
  }

  // Filter trials for baseline and candidate
  const baseTrials = params.trials.filter(
    (t) => t.configFingerprint.fingerprintHash === baseCond.configFingerprint.fingerprintHash
  );
  const candTrials = params.trials.filter(
    (t) => t.configFingerprint.fingerprintHash === candCond.configFingerprint.fingerprintHash
  );

  if (params.metric === "objectivePassRate") {
    let baseSuccess = 0;
    let baseFail = 0;
    for (const t of baseTrials) {
      if (t.outcome === "PASSED") baseSuccess++;
      else if (t.outcome === "FAILED") baseFail++;
    }
    let candSuccess = 0;
    let candFail = 0;
    for (const t of candTrials) {
      if (t.outcome === "PASSED") candSuccess++;
      else if (t.outcome === "FAILED") candFail++;
    }

    return analyzeBinaryOutcome({
      experiment: params.experiment,
      baselineConditionId: params.baselineConditionId,
      candidateConditionId: params.candidateConditionId,
      baselineSuccesses: baseSuccess,
      baselineFailures: baseFail,
      candidateSuccesses: candSuccess,
      candidateFailures: candFail,
      baselineTotalTrials: baseTrials.length,
      candidateTotalTrials: candTrials.length,
      confidenceLevel: params.confidenceLevel,
    });
  }

  // Continuous numeric metric
  const metricKey = params.metric as EvaluationMetricKey;
  if (!EVALUATION_METRIC_KEYS.includes(metricKey)) {
    throw new Error(`Unknown evaluation metric key '${params.metric}'`);
  }

  const baseValues = baseTrials.map((t) => t.metrics[metricKey]);
  const candValues = candTrials.map((t) => t.metrics[metricKey]);

  return analyzeNumericMetric({
    experiment: params.experiment,
    baselineConditionId: params.baselineConditionId,
    candidateConditionId: params.candidateConditionId,
    metric: params.metric,
    baselineValues: baseValues,
    candidateValues: candValues,
    confidenceLevel: params.confidenceLevel,
    direction: params.direction,
  });
}
