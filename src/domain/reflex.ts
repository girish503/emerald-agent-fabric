/**
 * Reflex Proposal Interceptor Domain Contracts for Emerald Agent Fabric.
 *
 * Establishes the provider-independent control contract answering:
 * "Given an already validated ActionProposal and its current execution context,
 *  should the proposal be allowed to continue, deferred, or rejected?"
 *
 * Fundamental Architectural Principles:
 * 1. Decision ≠ Authority:
 *    Reflex decisions are untrusted control recommendations (ALLOW, REJECT, DEFER).
 *    Reflex decisions do NOT authorize execution. Normal governance (MissionContract,
 *    PolicyEvaluator, ToolExecutionGateway) remains authoritative.
 * 2. Monotonic Non-Expansion of Authority:
 *    EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex.
 *    Reflex may reduce or constrain execution, but may NEVER expand authority.
 * 3. Observational Context Immutability:
 *    ReflexContext contains only observational runtime facts. It cannot hold
 *    execution handles, credentials, provider clients, DB handles, or mutate state.
 * 4. Provider Independence:
 *    Pure domain types with zero dependency on LLMs, Ollama, Docker, or external services.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJsonStringify,
  isSensitiveKey,
  redactSensitiveData,
} from "./canonical-hash.js";
import {
  findForbiddenAuthorityKeys,
  type ActionProposal,
} from "./action-proposal.js";
import { TOOL_NAMES, type ToolName } from "./tool.js";
import {
  InvalidReflexDecisionError,
  InvalidReflexContextError,
  ReflexAuthorityExpansionError,
} from "./errors.js";

// ============================================================================
// 1. Decision Taxonomy
// ============================================================================

export const REFLEX_DECISION_KINDS = [
  "ALLOW",
  "REJECT",
  "DEFER",
] as const;

export type ReflexDecisionKind = (typeof REFLEX_DECISION_KINDS)[number];

export function isValidReflexDecisionKind(
  kind: unknown
): kind is ReflexDecisionKind {
  return (
    typeof kind === "string" &&
    (REFLEX_DECISION_KINDS as readonly string[]).includes(kind)
  );
}

// ============================================================================
// 2. Reason Codes Taxonomy
// ============================================================================

export const REFLEX_REASON_CODES = [
  "NO_INTERVENTION",
  "RISK_SIGNAL",
  "REPEATED_FAILURE",
  "REDUNDANT_ACTION",
  "RESOURCE_PRESSURE",
  "VERIFICATION_CONCERN",
  "POLICY_PRECHECK",
  "UNSUPPORTED_ACTION",
] as const;

export type ReflexReasonCode = (typeof REFLEX_REASON_CODES)[number];

export function isValidReflexReasonCode(
  code: unknown
): code is ReflexReasonCode {
  return (
    typeof code === "string" &&
    (REFLEX_REASON_CODES as readonly string[]).includes(code)
  );
}

// Maximum allowed rationale characters in a Reflex decision
export const MAX_REFLEX_RATIONALE_LENGTH = 1000;

// ============================================================================
// 3. ReflexDecision Interface & Zod Schema
// ============================================================================

export interface ReflexDecision {
  readonly decision: ReflexDecisionKind;
  readonly reasonCode: ReflexReasonCode;
  readonly rationale?: string;
}

export const ReflexDecisionSchema = z
  .object({
    decision: z.enum(REFLEX_DECISION_KINDS),
    reasonCode: z.enum(REFLEX_REASON_CODES),
    rationale: z
      .string()
      .max(
        MAX_REFLEX_RATIONALE_LENGTH,
        `rationale exceeds maximum length of ${MAX_REFLEX_RATIONALE_LENGTH}`
      )
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Firewall: Reflex must never return authority-bearing fields
    const forbiddenKeys = findForbiddenAuthorityKeys(val);
    if (forbiddenKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexDecision contains forbidden authority keys: [${forbiddenKeys.join(
          ", "
        )}]`,
      });
    }
  });

// ============================================================================
// 4. ReflexContext Interface & Zod Schema
// ============================================================================

export interface ReflexActionHistoryItem {
  readonly toolName: ToolName;
  readonly status: string;
  readonly sequenceNumber?: number;
}

export interface ReflexResourceUsage {
  readonly elapsedWallClockMs?: number;
  readonly actionsExecuted?: number;
  readonly stepsExecuted?: number;
}

export interface ReflexContext {
  readonly runId: string;
  readonly taskId: string;
  readonly stepNumber: number;
  readonly taskDescription?: string;
  readonly failureCount: number;
  readonly recentActionHistory?: readonly ReflexActionHistoryItem[];
  readonly verificationStatus?: string;
  readonly workspacePath?: string;
  readonly resourceUsage?: ReflexResourceUsage;
  readonly contextHash?: string;
}

export const ReflexActionHistoryItemSchema = z
  .object({
    toolName: z.enum(TOOL_NAMES),
    status: z.string().max(64),
    sequenceNumber: z.number().int().positive().optional(),
  })
  .strict();

export const ReflexResourceUsageSchema = z
  .object({
    elapsedWallClockMs: z.number().min(0).optional(),
    actionsExecuted: z.number().int().min(0).optional(),
    stepsExecuted: z.number().int().min(0).optional(),
  })
  .strict();

export const ReflexContextSchema = z
  .object({
    runId: z.string().min(1, "runId cannot be empty"),
    taskId: z.string().min(1, "taskId cannot be empty"),
    stepNumber: z.number().int().positive("stepNumber must be a positive integer"),
    taskDescription: z.string().max(4096).optional(),
    failureCount: z.number().int().min(0, "failureCount cannot be negative"),
    recentActionHistory: z.array(ReflexActionHistoryItemSchema).max(50).optional(),
    verificationStatus: z.string().max(64).optional(),
    workspacePath: z.string().max(1024).optional(),
    resourceUsage: ReflexResourceUsageSchema.optional(),
    contextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "contextHash must be a 64-character hexadecimal SHA-256 hash")
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Forbidden authority check
    const forbidden = findForbiddenAuthorityKeys(val);
    if (forbidden.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexContext contains forbidden authority keys: [${forbidden.join(
          ", "
        )}]`,
      });
    }

    // 2. Credential and secret keyword firewall
    for (const key of Object.keys(val)) {
      if (isSensitiveKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ReflexContext contains sensitive key: '${key}'. Secrets must never enter ReflexContext.`,
        });
      }
    }
  });

// ============================================================================
// 5. Canonical Context Hashing
// ============================================================================

/**
 * Computes a deterministic SHA-256 hash of an immutable ReflexContext.
 * Excludes any existing self-referential contextHash field.
 */
export function computeReflexContextHash(context: ReflexContext): string {
  const { contextHash: _, ...hashableContext } = context;
  const redacted = redactSensitiveData(hashableContext);
  const canonical = canonicalJsonStringify(redacted);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ============================================================================
// 6. Validation Helpers
// ============================================================================

/**
 * Validates that an unknown input conforms strictly to the ReflexDecision contract.
 * Throws InvalidReflexDecisionError on violation.
 */
export function validateReflexDecision(decision: unknown): ReflexDecision {
  const parsed = ReflexDecisionSchema.safeParse(decision);
  if (!parsed.success) {
    throw new InvalidReflexDecisionError(
      `ReflexDecision validation failed: ${parsed.error.errors
        .map((e) => e.message)
        .join("; ")}`
    );
  }
  return Object.freeze({ ...parsed.data });
}

/**
 * Validates that an unknown input conforms strictly to the ReflexContext contract.
 * Throws InvalidReflexContextError on violation.
 */
export function validateReflexContext(context: unknown): ReflexContext {
  const parsed = ReflexContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new InvalidReflexContextError(
      `ReflexContext validation failed: ${parsed.error.errors
        .map((e) => e.message)
        .join("; ")}`
    );
  }
  return Object.freeze({
    ...parsed.data,
    recentActionHistory: parsed.data.recentActionHistory
      ? Object.freeze(
          parsed.data.recentActionHistory.map((h) => Object.freeze({ ...h }))
        )
      : undefined,
    resourceUsage: parsed.data.resourceUsage
      ? Object.freeze({ ...parsed.data.resourceUsage })
      : undefined,
  });
}

// ============================================================================
// 7. Authority Invariant Enforcement
// ============================================================================

/**
 * Formally enforces: EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex.
 *
 * Asserts that the ReflexDecision does not expand authority by attempting to inject
 * forbidden authority keys, capability grants, or governance overrides.
 */
export function assertReflexAuthorityInvariant(
  beforeProposal: ActionProposal,
  decision: ReflexDecision
): void {
  if (!beforeProposal || typeof beforeProposal !== "object") {
    throw new Error("assertReflexAuthorityInvariant requires a valid beforeProposal");
  }
  if (!decision || typeof decision !== "object") {
    throw new InvalidReflexDecisionError("Reflex decision must be an object");
  }

  const forbiddenKeys = findForbiddenAuthorityKeys(decision);
  if (forbiddenKeys.length > 0) {
    throw new ReflexAuthorityExpansionError(
      `Reflex attempted to expand authority by injecting forbidden keys: [${forbiddenKeys.join(
        ", "
      )}]`
    );
  }

  const authorityGrantKeys = [
    "capability",
    "capabilities",
    "requiredCapability",
    "contractId",
    "contractVersion",
    "contractBinding",
    "workerId",
    "leaseId",
    "credentials",
    "resourceLimits",
    "isolationLevel",
  ];

  for (const key of authorityGrantKeys) {
    if (key in (decision as unknown as Record<string, unknown>)) {
      throw new ReflexAuthorityExpansionError(
        `Reflex attempted to grant or override authority key '${key}'`
      );
    }
  }

}
