/**
 * Versioned Trace Replay Report Contract for Emerald Agent Fabric (Idea 3, Phase 3).
 *
 * Pure domain Zod schemas and deterministic content-hash helpers for stub-backed
 * offline trace replay and guardrail verification.
 */

import { z } from "zod";
import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import {
  TraceSummarySchema,
  TraceVerificationVerdictSchema,
} from "./trace.js";

export const TRACE_GUARDRAIL_RULES = [
  "schema_valid",
  "provenance",
  "redaction",
  "capability",
  "approval",
  "verification",
  "llm_telemetry",
] as const;

export const TraceGuardrailRuleSchema = z.enum(TRACE_GUARDRAIL_RULES);
export type TraceGuardrailRuleName = z.infer<typeof TraceGuardrailRuleSchema>;

export const GuardrailViolationSchema = z
  .object({
    spanId: z.string().min(1),
    rule: TraceGuardrailRuleSchema,
    message: z.string().min(1),
  })
  .strict();

export type GuardrailViolation = z.infer<typeof GuardrailViolationSchema>;

export const GuardrailCheckOutcomeSchema = z
  .object({
    rule: TraceGuardrailRuleSchema,
    passed: z.boolean(),
    violationCount: z.number().int().min(0),
  })
  .strict();

export type GuardrailCheckOutcome = z.infer<typeof GuardrailCheckOutcomeSchema>;

export const StubLlmReplayOutputSchema = z
  .object({
    spanId: z.string().min(1),
    model: z.string().min(1),
    recordedResultSummary: TraceSummarySchema,
    stubOutputText: z.string(),
    costUsd: z.number().min(0).nullable(),
    latencyMs: z.number().min(0),
  })
  .strict();

export type StubLlmReplayOutput = z.infer<typeof StubLlmReplayOutputSchema>;

export const TraceReplayApprovalSummarySchema = z
  .object({
    totalEvents: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    approvedCount: z.number().int().min(0),
    rejectedCount: z.number().int().min(0),
    executionAfterPauseCount: z.number().int().min(0),
  })
  .strict();

export type TraceReplayApprovalSummary = z.infer<typeof TraceReplayApprovalSummarySchema>;

export const TraceReplayReportBodySchema = z
  .object({
    traceId: z.string().min(1),
    runId: z.string().min(1),
    missionId: z.string().min(1),
    formatVersion: z.string().min(1),
    traceStatus: z.string().min(1),
    mode: z.literal("stub-replay"),
    spansWalked: z.number().int().min(0),
    llmOutputs: z.array(StubLlmReplayOutputSchema),
    verdictsIntact: z.array(TraceVerificationVerdictSchema),
    approvalSummary: TraceReplayApprovalSummarySchema,
    redactionObservations: z.array(z.string().min(1)),
    checks: z.array(GuardrailCheckOutcomeSchema).length(TRACE_GUARDRAIL_RULES.length),
    checksPassed: z.number().int().min(0).max(TRACE_GUARDRAIL_RULES.length),
    checksFailed: z.number().int().min(0).max(TRACE_GUARDRAIL_RULES.length),
    passed: z.boolean(),
    violations: z.array(GuardrailViolationSchema),
  })
  .strict();

export type TraceReplayReportBody = z.infer<typeof TraceReplayReportBodySchema>;

export const TraceReplayReportSchema = TraceReplayReportBodySchema.extend({
  reportHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type TraceReplayReport = z.infer<typeof TraceReplayReportSchema>;

/**
 * Deterministically hashes a TraceReplayReportBody using canonical JSON serialization.
 */
export function computeTraceReplayReportHash(body: TraceReplayReportBody): string {
  return sha256Hex(canonicalJsonStringify(body));
}

/**
 * Validates a TraceReplayReport including its canonical SHA-256 `reportHash`.
 */
export function validateTraceReplayReport(input: unknown): TraceReplayReport {
  const parsed = TraceReplayReportSchema.parse(input);
  const { reportHash, ...body } = parsed;
  const expectedHash = computeTraceReplayReportHash(body);
  if (reportHash !== expectedHash) {
    throw new Error(
      `TraceReplayReport hash mismatch for '${parsed.traceId}': expected '${expectedHash}', got '${reportHash}'.`
    );
  }
  return parsed;
}
