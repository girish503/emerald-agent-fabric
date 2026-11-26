/**
 * Versioned Execution Trace Format for Emerald Agent Fabric.
 *
 * One trace corresponds to one run (`runId`), capturing pinned model settings,
 * hierarchical / DAG execution spans, tool provenance, approval events,
 * verification verdicts, and repair attempts — with mandatory secret redaction
 * and bounded summaries.
 *
 * Architectural Invariants:
 * 1. Pure Domain Schema: Depends only on Zod and canonical redaction helpers.
 * 2. Zero Secrets: Arguments and results store redacted summaries only. Any
 *    unredacted sensitive key or secret-shaped substring fails schema validation.
 * 3. Tool Provenance: Every `tool` span MUST declare `provenance` as either
 *    `"trusted"` or `"untrusted"`.
 * 4. Format Versioning: Every trace carries an explicit immutable `formatVersion`.
 */

import { z } from "zod";
import { containsUnredactedSecrets, isSensitiveKey } from "./canonical-hash.js";

export const TRACE_FORMAT_VERSION = "emerald-trace-v1" as const;
export const DEFAULT_TRACE_SUMMARY_MAX_CHARS = 512;

// ============================================================================
// Secret-Shaped String Detection & Summary Redaction
// ============================================================================

const TRACE_SENSITIVE_KEY_EXTRA = /prompt|env|cookie|private|passwd|pwd|auth/i;

/**
 * Patterns matching common credential / token / key formats inside arbitrary strings.
 * Intentionally stateless (never use global `/g` with `.test()` directly without resetting).
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{12,}\b/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgsk_[A-Za-z0-9]{16,}\b/,
  /\bhf_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{8,}=*/i,
  /\bBasic\s+(?!\[REDACTED\])[A-Za-z0-9+/=]{8,}/i,
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|credential)\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"';,]{6,}["']?/i,
];

const SECRET_REPLACEMENT_RULES: readonly { readonly regex: RegExp; readonly replace: string | ((...args: string[]) => string) }[] = [
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  {
    regex: /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    regex: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
  {
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
  {
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
  {
    regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[REDACTED_ACCESS_KEY]",
  },
  {
    regex: /\bgsk_[A-Za-z0-9]{16,}\b/g,
    replace: "[REDACTED_API_KEY]",
  },
  {
    regex: /\bhf_[A-Za-z0-9]{16,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
  {
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: "[REDACTED_JWT]",
  },
  {
    regex: /\b(Bearer)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: (_m, scheme: string) => `${scheme} [REDACTED]`,
  },
  {
    regex: /\b(Basic)\s+(?!\[REDACTED\])[A-Za-z0-9+/=]{8,}/gi,
    replace: (_m, scheme: string) => `${scheme} [REDACTED]`,
  },
  {
    regex: /((?:^|[^A-Za-z0-9])[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|credential))\s*([:=])\s*["']?(?!\[REDACTED\])[^\s"';,]{6,}["']?/gi,
    replace: (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  },
];

function isTraceSensitiveKey(key: string): boolean {
  if (isSensitiveKey(key)) return true;
  if (/(?:estimated|prompt|input|output|total|eval)[_-]?tokens?$|^token[_-]?counts?$/i.test(key)) {
    return false;
  }
  if (/^idempotency[_-]?tokens?$/i.test(key)) {
    return false;
  }
  return TRACE_SENSITIVE_KEY_EXTRA.test(key);
}

/**
 * Redacts secret-shaped substrings from a string and bounds its length.
 */
export function redactTraceString(
  raw: string,
  maxLength: number = DEFAULT_TRACE_SUMMARY_MAX_CHARS
): string {
  let sanitized = raw;
  for (const rule of SECRET_REPLACEMENT_RULES) {
    if (typeof rule.replace === "string") {
      sanitized = sanitized.replace(rule.regex, rule.replace);
    } else {
      sanitized = sanitized.replace(rule.regex, rule.replace);
    }
  }
  if (sanitized.length > maxLength) {
    return `${sanitized.slice(0, maxLength)}... [truncated ${sanitized.length - maxLength} chars]`;
  }
  return sanitized;
}

/**
 * Recursively redacts sensitive keys, secret-shaped strings, and oversized values
 * into a bounded JSON-safe summary suitable for trace argsSummary / resultSummary.
 */
export function redactTraceValue(
  value: unknown,
  maxStringLength: number = DEFAULT_TRACE_SUMMARY_MAX_CHARS,
  depth: number = 0,
  visited: Set<unknown> = new Set()
): TraceSummaryValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return redactTraceString(value, maxStringLength);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (depth >= 6 || visited.has(value)) {
    return "[DEPTH_LIMIT]";
  }
  if (Array.isArray(value)) {
    visited.add(value);
    const items = value.slice(0, 32).map((item) =>
      redactTraceValue(item, maxStringLength, depth + 1, visited)
    );
    if (value.length > 32) {
      items.push(`... [${value.length - 32} more items truncated]`);
    }
    visited.delete(value);
    return items;
  }
  if (typeof value === "object") {
    visited.add(value);
    const out: Record<string, TraceSummaryValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isTraceSensitiveKey(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactTraceValue(v, maxStringLength, depth + 1, visited);
      }
    }
    visited.delete(value);
    return out;
  }
  return redactTraceString(String(value), maxStringLength);
}

/**
 * Normalizes an arbitrary payload into a redacted summary object, string, or null.
 */
export function toRedactedTraceSummary(
  value: unknown,
  maxStringLength: number = DEFAULT_TRACE_SUMMARY_MAX_CHARS
): TraceSummary {
  const redacted = redactTraceValue(value, maxStringLength);
  if (redacted === null) {
    return null;
  }
  if (typeof redacted === "string") {
    return redacted;
  }
  if (typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

/**
 * Returns true if any string inside `value` matches an unredacted secret pattern.
 */
export function containsSecretShapedString(
  value: unknown,
  depth: number = 0,
  visited: Set<unknown> = new Set()
): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (typeof value !== "object" || depth > 10 || visited.has(value)) {
    return false;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    const found = value.some((item) => containsSecretShapedString(item, depth + 1, visited));
    visited.delete(value);
    return found;
  }
  const found = Object.entries(value as Record<string, unknown>).some(([, v]) =>
    containsSecretShapedString(v, depth + 1, visited)
  );
  visited.delete(value);
  return found;
}

// ============================================================================
// Zod Schemas
// ============================================================================

export type TraceSummaryValue =
  | string
  | number
  | boolean
  | null
  | readonly TraceSummaryValue[]
  | { readonly [key: string]: TraceSummaryValue };

export const TraceSummarySchema = z.union([
  z.string(),
  z.record(z.unknown()),
  z.null(),
]);

export type TraceSummary = z.infer<typeof TraceSummarySchema>;

export const TraceModelRecordSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).nullable(),
    seed: z.number().int().nullable(),
    toolList: z.array(z.string().min(1)),
    retryBudget: z.number().int().min(0),
  })
  .strict();

export type TraceModelRecord = z.infer<typeof TraceModelRecordSchema>;

export const TRACE_SPAN_KINDS = [
  "agent",
  "llm",
  "tool",
  "approval",
  "verification",
  "repair",
] as const;

export const TraceSpanKindSchema = z.enum(TRACE_SPAN_KINDS);
export type TraceSpanKind = z.infer<typeof TraceSpanKindSchema>;

export const TRACE_SPAN_STATUSES = [
  "OK",
  "ERROR",
  "PAUSED",
  "DENIED",
  "TIMED_OUT",
  "CANCELLED",
  "UNSET",
] as const;

export const TraceSpanStatusSchema = z.enum(TRACE_SPAN_STATUSES);
export type TraceSpanStatus = z.infer<typeof TraceSpanStatusSchema>;

export const TRACE_PROVENANCE_VALUES = ["trusted", "untrusted"] as const;
export const TraceProvenanceSchema = z.enum(TRACE_PROVENANCE_VALUES);
export type TraceProvenance = z.infer<typeof TraceProvenanceSchema>;

export const TraceSpanSchema = z
  .object({
    spanId: z.string().min(1),
    parentSpanId: z.string().min(1).nullable(),
    parentSpanIds: z.array(z.string().min(1)).optional(),
    kind: TraceSpanKindSchema,
    name: z.string().min(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    latencyMs: z.number().min(0),
    tokensIn: z.number().int().min(0).nullable(),
    tokensOut: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
    status: TraceSpanStatusSchema,
    provenance: TraceProvenanceSchema.nullable(),
    argsSummary: TraceSummarySchema,
    resultSummary: TraceSummarySchema,
  })
  .strict();

export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const TraceApprovalEventSchema = z
  .object({
    approvalId: z.string().min(1),
    operation: z.string().min(1),
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "CONSUMED", "EXPIRED"]),
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    requestedAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    approver: z.string().min(1).nullable(),
    reasonSummary: z.string().nullable(),
  })
  .strict();

export type TraceApprovalEvent = z.infer<typeof TraceApprovalEventSchema>;

export const TraceVerificationVerdictSchema = z
  .object({
    verifierId: z.string().min(1),
    specId: z.string().min(1),
    verdict: z.enum(["VERIFIED", "FAILED", "REJECTED", "UNVERIFIABLE"]),
    verifiedAt: z.string().datetime(),
    proofHash: z.string().min(1).nullable(),
    messageSummary: z.string(),
    evidenceIds: z.array(z.string().min(1)),
  })
  .strict();

export type TraceVerificationVerdict = z.infer<typeof TraceVerificationVerdictSchema>;

export const TraceRepairAttemptSchema = z
  .object({
    attemptNumber: z.number().int().min(1),
    category: z.string().min(1),
    status: z.enum(["ATTEMPTED", "SUCCEEDED", "FAILED", "EXHAUSTED"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    summary: z.string(),
  })
  .strict();

export type TraceRepairAttempt = z.infer<typeof TraceRepairAttemptSchema>;

export const TRACE_RUN_STATUSES = [
  "CREATED",
  "QUEUED",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "RECOVERING",
  "QUARANTINED",
] as const;

export const RunTraceSchema = z
  .object({
    traceId: z.string().min(1),
    runId: z.string().min(1),
    missionId: z.string().min(1),
    formatVersion: z.literal(TRACE_FORMAT_VERSION),
    createdAt: z.string().datetime(),
    tenantId: z.string().min(1).default("default-tenant"),
    status: z.enum(TRACE_RUN_STATUSES),
    parentTaskIds: z.array(z.string().min(1)).optional(),
    model: TraceModelRecordSchema.nullable(),
    spans: z.array(TraceSpanSchema),
    approvalEvents: z.array(TraceApprovalEventSchema),
    verificationVerdicts: z.array(TraceVerificationVerdictSchema),
    repairAttempts: z.array(TraceRepairAttemptSchema),
  })
  .strict()
  .superRefine((trace, ctx) => {
    const spanIds = new Set<string>();
    for (let i = 0; i < trace.spans.length; i++) {
      const span = trace.spans[i]!;
      if (spanIds.has(span.spanId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spans", i, "spanId"],
          message: `Duplicate spanId '${span.spanId}' in trace '${trace.traceId}'.`,
        });
      }
      spanIds.add(span.spanId);

      if (span.kind === "tool" && span.provenance === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spans", i, "provenance"],
          message: `Tool span '${span.spanId}' must declare provenance ('trusted' or 'untrusted').`,
        });
      }

      if (containsUnredactedSecrets(span.argsSummary) || containsSecretShapedString(span.argsSummary)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spans", i, "argsSummary"],
          message: `Span '${span.spanId}' argsSummary contains unredacted secret material.`,
        });
      }

      if (containsUnredactedSecrets(span.resultSummary) || containsSecretShapedString(span.resultSummary)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spans", i, "resultSummary"],
          message: `Span '${span.spanId}' resultSummary contains unredacted secret material.`,
        });
      }
    }

    for (let i = 0; i < trace.spans.length; i++) {
      const span = trace.spans[i]!;
      if (span.parentSpanId !== null && !spanIds.has(span.parentSpanId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spans", i, "parentSpanId"],
          message: `Span '${span.spanId}' references unknown parentSpanId '${span.parentSpanId}'.`,
        });
      }
      if (span.parentSpanIds) {
        for (let j = 0; j < span.parentSpanIds.length; j++) {
          const parentId = span.parentSpanIds[j]!;
          if (!spanIds.has(parentId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["spans", i, "parentSpanIds", j],
              message: `Span '${span.spanId}' references unknown parentSpanId '${parentId}'.`,
            });
          }
        }
      }
    }

    for (let i = 0; i < trace.approvalEvents.length; i++) {
      const approval = trace.approvalEvents[i]!;
      if (containsSecretShapedString(approval.reasonSummary)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvalEvents", i, "reasonSummary"],
          message: "Approval reasonSummary contains unredacted secret material.",
        });
      }
    }

    for (let i = 0; i < trace.verificationVerdicts.length; i++) {
      const verdict = trace.verificationVerdicts[i]!;
      if (containsSecretShapedString(verdict.messageSummary)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verificationVerdicts", i, "messageSummary"],
          message: "Verification messageSummary contains unredacted secret material.",
        });
      }
    }

    for (let i = 0; i < trace.repairAttempts.length; i++) {
      const repair = trace.repairAttempts[i]!;
      if (containsSecretShapedString(repair.summary)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repairAttempts", i, "summary"],
          message: "Repair attempt summary contains unredacted secret material.",
        });
      }
    }
  });

export type RunTrace = z.infer<typeof RunTraceSchema>;

/**
 * Validates and returns a strongly typed `RunTrace`, throwing a ZodError if invalid.
 */
export function validateRunTrace(input: unknown): RunTrace {
  return RunTraceSchema.parse(input);
}

/**
 * Safe validation wrapper returning Zod's discriminated parse result.
 */
export function safeValidateRunTrace(input: unknown) {
  return RunTraceSchema.safeParse(input);
}
