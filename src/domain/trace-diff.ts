/**
 * Versioned Trace Diff & Scorecard Domain Schemas (Idea 3, Phase 4).
 *
 * Pure Zod schemas and canonical SHA-256 hashing helpers for deterministic
 * trace comparison and trace-set scorecards. Zero model calls, zero p-values,
 * and zero significance labels — raw deterministic counts and deltas only.
 */

import { z } from "zod";
import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import {
  TRACE_GUARDRAIL_RULES,
  TraceGuardrailRuleSchema,
} from "./trace-replay.js";
import { TraceSpanKindSchema, TraceSpanStatusSchema } from "./trace.js";

// ============================================================================
// 1. Span, Trace, and Replay Report Diff Schemas
// ============================================================================

export const SPAN_DIFF_KINDS = ["same", "changed", "added", "removed"] as const;
export const SpanDiffKindSchema = z.enum(SPAN_DIFF_KINDS);
export type SpanDiffKind = z.infer<typeof SpanDiffKindSchema>;

export const TRACE_SPAN_DIFF_FIELDS = [
  "status",
  "verdict",
  "cost",
  "latency",
  "provenance",
  "argsSummary",
  "resultSummary",
  "tokens",
  "order",
] as const;
export const TraceSpanDiffFieldSchema = z.enum(TRACE_SPAN_DIFF_FIELDS);
export type TraceSpanDiffField = z.infer<typeof TraceSpanDiffFieldSchema>;

export const TraceSpanDiffEntrySchema = z
  .object({
    spanId: z.string().min(1),
    kind: TraceSpanKindSchema,
    name: z.string().min(1),
    change: SpanDiffKindSchema,
    oldIndex: z.number().int().min(0).nullable(),
    newIndex: z.number().int().min(0).nullable(),
    changedFields: z.array(TraceSpanDiffFieldSchema),
  })
  .strict();

export type TraceSpanDiffEntry = z.infer<typeof TraceSpanDiffEntrySchema>;

export const VerdictTransitionSchema = z
  .object({
    verifierId: z.string().min(1),
    specId: z.string().min(1),
    oldVerdict: z.string().nullable(),
    newVerdict: z.string().nullable(),
    change: z.enum(["changed", "added", "removed"]),
  })
  .strict();

export type VerdictTransition = z.infer<typeof VerdictTransitionSchema>;

export const ApprovalDifferenceSchema = z
  .object({
    approvalId: z.string().min(1),
    operation: z.string().min(1),
    oldStatus: z.string().nullable(),
    newStatus: z.string().nullable(),
    oldApprover: z.string().nullable(),
    newApprover: z.string().nullable(),
    change: z.enum(["changed", "added", "removed"]),
  })
  .strict();

export type ApprovalDifference = z.infer<typeof ApprovalDifferenceSchema>;

export const GuardrailRuleOutcomeDiffSchema = z
  .object({
    rule: TraceGuardrailRuleSchema,
    oldPassed: z.boolean(),
    newPassed: z.boolean(),
    oldViolationCount: z.number().int().min(0),
    newViolationCount: z.number().int().min(0),
    direction: z.enum(["improved", "regressed", "unchanged"]),
  })
  .strict();

export type GuardrailRuleOutcomeDiff = z.infer<typeof GuardrailRuleOutcomeDiffSchema>;

export const TraceDiffBodySchema = z
  .object({
    oldTraceId: z.string().min(1),
    newTraceId: z.string().min(1),
    oldStatus: z.string().min(1),
    newStatus: z.string().min(1),
    isEmpty: z.boolean(),
    spans: z.array(TraceSpanDiffEntrySchema),
    changes: z.array(TraceSpanDiffEntrySchema),
    summary: z
      .object({
        sameCount: z.number().int().min(0),
        changedCount: z.number().int().min(0),
        addedCount: z.number().int().min(0),
        removedCount: z.number().int().min(0),
      })
      .strict(),
    verdictTransitions: z.array(VerdictTransitionSchema),
    approvalDifferences: z.array(ApprovalDifferenceSchema),
    oldTotalCostUsd: z.number().min(0),
    newTotalCostUsd: z.number().min(0),
    costDeltaUsd: z.number(),
    oldTotalLatencyMs: z.number().min(0),
    newTotalLatencyMs: z.number().min(0),
    latencyDeltaMs: z.number(),
    ruleOutcomeChanges: z.array(GuardrailRuleOutcomeDiffSchema),
  })
  .strict();

export type TraceDiffBody = z.infer<typeof TraceDiffBodySchema>;

export const TraceDiffSchema = TraceDiffBodySchema.extend({
  diffHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type TraceDiff = z.infer<typeof TraceDiffSchema>;

export const ReplayReportDiffBodySchema = z
  .object({
    oldTraceId: z.string().min(1),
    newTraceId: z.string().min(1),
    oldStatus: z.string().min(1),
    newStatus: z.string().min(1),
    isEmpty: z.boolean(),
    oldPassed: z.boolean(),
    newPassed: z.boolean(),
    checksPassedDelta: z.number().int(),
    checksFailedDelta: z.number().int(),
    ruleOutcomeChanges: z.array(GuardrailRuleOutcomeDiffSchema),
    verdictTransitions: z.array(VerdictTransitionSchema),
    oldTotalCostUsd: z.number().min(0),
    newTotalCostUsd: z.number().min(0),
    costDeltaUsd: z.number(),
    oldTotalLatencyMs: z.number().min(0),
    newTotalLatencyMs: z.number().min(0),
    latencyDeltaMs: z.number(),
  })
  .strict();

export type ReplayReportDiffBody = z.infer<typeof ReplayReportDiffBodySchema>;

export const ReplayReportDiffSchema = ReplayReportDiffBodySchema.extend({
  diffHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type ReplayReportDiff = z.infer<typeof ReplayReportDiffSchema>;

// ============================================================================
// 2. Trace Set Scorecard & Scorecard Delta Schemas
// ============================================================================

export const TRACE_VERDICT_OUTCOMES = [
  "COMPLETED_VERIFIED",
  "COMPLETED_WITHOUT_VERDICT",
  "COMPLETED_NON_VERIFIED",
  "VERIFIED",
  "FAILED",
  "REJECTED",
  "UNVERIFIABLE",
  "NO_VERDICT_NON_COMPLETED",
] as const;

export const TraceVerdictOutcomeSchema = z.enum(TRACE_VERDICT_OUTCOMES);
export type TraceVerdictOutcome = z.infer<typeof TraceVerdictOutcomeSchema>;

export const FAILURE_TAXONOMY_CATEGORIES = [
  "NONE",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED",
  "REPAIR_EXHAUSTED",
  "TENANT_ISOLATION_DENIED",
  "PROMPT_INJECTION_POISONING",
  "UNVERIFIED_COMPLETION",
  "EMPTY_PATCH_REJECTED",
  "TIMEOUT_LLM",
  "TIMEOUT_TOOL",
  "OPERATOR_CANCELLED",
  "OTHER_FAILURE",
] as const;

export const FailureTaxonomyCategorySchema = z.enum(FAILURE_TAXONOMY_CATEGORIES);
export type FailureTaxonomyCategory = z.infer<typeof FailureTaxonomyCategorySchema>;

export const GuardrailRuleScoreSchema = z
  .object({
    rule: TraceGuardrailRuleSchema,
    passedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
  })
  .strict();

export type GuardrailRuleScore = z.infer<typeof GuardrailRuleScoreSchema>;

export const TraceVerdictCountsSchema = z
  .object({
    COMPLETED_VERIFIED: z.number().int().min(0),
    COMPLETED_WITHOUT_VERDICT: z.number().int().min(0),
    COMPLETED_NON_VERIFIED: z.number().int().min(0),
    VERIFIED: z.number().int().min(0),
    FAILED: z.number().int().min(0),
    REJECTED: z.number().int().min(0),
    UNVERIFIABLE: z.number().int().min(0),
    NO_VERDICT_NON_COMPLETED: z.number().int().min(0),
  })
  .strict();

export const FailureTaxonomyCountsSchema = z
  .object({
    NONE: z.number().int().min(0),
    APPROVAL_PENDING: z.number().int().min(0),
    APPROVAL_REJECTED: z.number().int().min(0),
    REPAIR_EXHAUSTED: z.number().int().min(0),
    TENANT_ISOLATION_DENIED: z.number().int().min(0),
    PROMPT_INJECTION_POISONING: z.number().int().min(0),
    UNVERIFIED_COMPLETION: z.number().int().min(0),
    EMPTY_PATCH_REJECTED: z.number().int().min(0),
    TIMEOUT_LLM: z.number().int().min(0),
    TIMEOUT_TOOL: z.number().int().min(0),
    OPERATOR_CANCELLED: z.number().int().min(0),
    OTHER_FAILURE: z.number().int().min(0),
  })
  .strict();

export const TraceSetScorecardBodySchema = z
  .object({
    scorecardId: z.string().min(1),
    totalTraces: z.number().int().min(0),
    statusCounts: z.record(z.number().int().min(0)),
    guardrailRuleCounts: z.array(GuardrailRuleScoreSchema).length(TRACE_GUARDRAIL_RULES.length),
    tracesAllPassedCount: z.number().int().min(0),
    tracesWithViolationsCount: z.number().int().min(0),
    verdictCounts: TraceVerdictCountsSchema,
    completedWithoutVerdictCount: z.number().int().min(0),
    totalCostUsd: z.number().min(0),
    meanCostUsd: z.number().min(0),
    totalLatencyMs: z.number().min(0),
    meanLatencyMs: z.number().min(0),
    failureTaxonomyCounts: FailureTaxonomyCountsSchema,
  })
  .strict();

export type TraceSetScorecardBody = z.infer<typeof TraceSetScorecardBodySchema>;

export const TraceSetScorecardSchema = TraceSetScorecardBodySchema.extend({
  scorecardHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type TraceSetScorecard = z.infer<typeof TraceSetScorecardSchema>;

export const ScorecardMetricDeltaSchema = z
  .object({
    metric: z.string().min(1),
    before: z.number(),
    after: z.number(),
    delta: z.number(),
    direction: z.enum(["improved", "regressed", "unchanged"]),
  })
  .strict();

export type ScorecardMetricDelta = z.infer<typeof ScorecardMetricDeltaSchema>;

export const ScorecardDeltaBodySchema = z
  .object({
    beforeScorecardHash: z.string().regex(/^[0-9a-f]{64}$/),
    afterScorecardHash: z.string().regex(/^[0-9a-f]{64}$/),
    metrics: z.array(ScorecardMetricDeltaSchema),
    improvedCount: z.number().int().min(0),
    regressedCount: z.number().int().min(0),
    unchangedCount: z.number().int().min(0),
  })
  .strict();

export type ScorecardDeltaBody = z.infer<typeof ScorecardDeltaBodySchema>;

export const ScorecardDeltaSchema = ScorecardDeltaBodySchema.extend({
  deltaHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type ScorecardDelta = z.infer<typeof ScorecardDeltaSchema>;

// Keep explicit use of TraceSpanStatusSchema exported cleanly for callers if needed.
export const TraceDiffSpanStatusSchema = TraceSpanStatusSchema;

export function computeTraceDiffHash(body: TraceDiffBody): string {
  return sha256Hex(canonicalJsonStringify(body));
}

export function computeReplayReportDiffHash(body: ReplayReportDiffBody): string {
  return sha256Hex(canonicalJsonStringify(body));
}

export function computeScorecardHash(body: TraceSetScorecardBody): string {
  return sha256Hex(canonicalJsonStringify(body));
}

export function computeScorecardDeltaHash(body: ScorecardDeltaBody): string {
  return sha256Hex(canonicalJsonStringify(body));
}
