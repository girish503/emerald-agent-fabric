/**
 * Reflex Evidence and Replay Domain Model for Emerald Agent Fabric.
 *
 * Establishes an immutable, tamper-evident observational record of every Reflex
 * proposal evaluation and a pure deterministic replay capability to verify
 * Reflex decisions offline without invoking models, executing tools, or mutating state.
 *
 * Architectural Invariants:
 * 1. Evidence is purely OBSERVATIONAL: It confers ZERO execution authority.
 * 2. Monotonic Authority Invariant Preserved:
 *    EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex
 * 3. Secret Protection: Evidence records must NEVER contain credentials, tokens,
 *    authorization secrets, worker lease secrets, or sensitive payloads.
 * 4. Zero External Execution during Replay:
 *    Replay must NEVER call model providers, execute tools, modify filesystems,
 *    mutate databases, or spawn containers.
 * 5. Epistemic Integrity:
 *    UNKNOWN execution outcomes remain UNKNOWN and are never fabricated into success or failure.
 * 6. Tamper-Evident Integrity:
 *    Every evidence record carries an evidenceIdentityHash computed via deterministic
 *    canonical JSON serialization and SHA-256 digest.
 */

import { z } from "zod";
import {
  canonicalJsonStringify,
  computeCanonicalHash,
  isSensitiveKey,
  redactSensitiveData,
  sha256Hex,
} from "./canonical-hash.js";
import {
  findForbiddenAuthorityKeys,
  type ActionProposal,
  ActionProposalSchema,
} from "./action-proposal.js";
import { TOOL_NAMES, type ToolName } from "./tool.js";
import {
  type ReflexContext,
  type ReflexDecision,
  type ReflexDecisionEvidence,
  type ReflexDecisionKind,
  type ReflexReasonCode,
  type RuleBasedReflexConfig,
  computeReflexContextHash,
  computeRuleBasedReflexConfigHash,
  REFLEX_DECISION_KINDS,
  REFLEX_REASON_CODES,
  ReflexContextSchema,
  RuleBasedReflexConfigSchema,
} from "./reflex.js";
import { RuleBasedReflex } from "../adapters/reflex/rule-based-reflex.js";
import type { ReflexPort } from "../ports/reflex.port.js";

// ============================================================================
// 1. Constants & Bounds
// ============================================================================

export const REFLEX_EVIDENCE_SCHEMA_VERSION = 1;
export const MAX_REFLEX_EVIDENCE_BYTES = 65536; // 64 KB serialized canonical JSON limit
export const REFLEX_IMPLEMENTATION_DEFAULT = "RuleBasedReflex";
export const REFLEX_IMPLEMENTATION_VERSION_DEFAULT = "1.0.0";

// ============================================================================
// 2. Precedence Indexing Helper
// ============================================================================

/**
 * Returns the deterministic evaluation precedence index for a given Reflex rule / decision:
 * 1 = Failure Loop (reflex.failure-loop.v1)
 * 2 = Redundant Action (reflex.redundant-action.v1)
 * 3 = Budget Pressure (reflex.budget-pressure.v1)
 * 4 = Default ALLOW (NO_INTERVENTION)
 * 0 = Other / Error / Custom
 */
export function getReflexPrecedenceIndex(
  ruleId?: string,
  decision?: ReflexDecisionKind,
  reasonCode?: ReflexReasonCode
): number {
  if (ruleId === "reflex.failure-loop.v1" || reasonCode === "REPEATED_FAILURE") {
    return 1;
  }
  if (ruleId === "reflex.redundant-action.v1" || reasonCode === "REDUNDANT_ACTION") {
    return 2;
  }
  if (ruleId === "reflex.budget-pressure.v1" || reasonCode === "RESOURCE_PRESSURE") {
    return 3;
  }
  if (decision === "ALLOW" && reasonCode === "NO_INTERVENTION") {
    return 4;
  }
  return 0;
}

// ============================================================================
// 3. Reflex Replay Input Model
// ============================================================================

export interface ReflexReplayInput {
  readonly proposal: ActionProposal;
  readonly context: ReflexContext;
  readonly ruleConfig?: RuleBasedReflexConfig;
}

export const ReflexReplayInputSchema = z
  .object({
    proposal: ActionProposalSchema,
    context: ReflexContextSchema,
    ruleConfig: RuleBasedReflexConfigSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Firewall check on proposal and context
    const forbiddenProposalKeys = findForbiddenAuthorityKeys(val.proposal);
    if (forbiddenProposalKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexReplayInput.proposal contains forbidden authority keys: [${forbiddenProposalKeys.join(
          ", "
        )}]`,
      });
    }

    const forbiddenContextKeys = findForbiddenAuthorityKeys(val.context);
    if (forbiddenContextKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexReplayInput.context contains forbidden authority keys: [${forbiddenContextKeys.join(
          ", "
        )}]`,
      });
    }

    // Secret keyword check
    for (const key of Object.keys(val.proposal)) {
      if (isSensitiveKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ReflexReplayInput.proposal contains sensitive key: '${key}'`,
        });
      }
    }
    if (val.proposal.inputPayload && typeof val.proposal.inputPayload === "object") {
      for (const key of Object.keys(val.proposal.inputPayload)) {
        if (isSensitiveKey(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `ReflexReplayInput.proposal.inputPayload contains sensitive key: '${key}'`,
          });
        }
      }
    }
    for (const key of Object.keys(val.context)) {
      if (isSensitiveKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ReflexReplayInput.context contains sensitive key: '${key}'`,
        });
      }
    }
  });

// ============================================================================
// 4. Reflex Evidence Contract & Schema
// ============================================================================

export interface ReflexEvidence {
  readonly evidenceId: string;
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly proposalId: string;
  readonly toolName: ToolName;
  readonly actionInputHash: string;
  readonly contextSnapshotHash?: string;
  readonly reflexImplementation: string;
  readonly reflexImplementationVersion: string;
  readonly ruleConfigurationHash: string;
  readonly reflexContextHash: string;
  readonly decision: ReflexDecisionKind;
  readonly reasonCode: ReflexReasonCode;
  readonly triggeredRuleId?: string;
  readonly observedSignal?: string;
  readonly thresholdUsed?: number;
  readonly observedCount?: number;
  readonly rationale?: string;
  readonly precedenceIndex?: number;
  readonly replayInput: ReflexReplayInput;
  readonly evidenceIdentityHash: string;
  readonly evaluatedAt: string;
}

export const ReflexEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1, "evidenceId cannot be empty").max(128),
    schemaVersion: z.literal(REFLEX_EVIDENCE_SCHEMA_VERSION),
    runId: z.string().min(1, "runId cannot be empty").max(128),
    sequenceNumber: z.number().int().positive("sequenceNumber must be positive"),
    proposalId: z.string().min(1, "proposalId cannot be empty").max(128),
    toolName: z.enum(TOOL_NAMES),
    actionInputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "actionInputHash must be a 64-char hex SHA-256 digest"),
    contextSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "contextSnapshotHash must be a 64-char hex SHA-256 digest")
      .optional(),
    reflexImplementation: z.string().min(1).max(128),
    reflexImplementationVersion: z.string().min(1).max(64),
    ruleConfigurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "ruleConfigurationHash must be a 64-char hex SHA-256 digest"),
    reflexContextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "reflexContextHash must be a 64-char hex SHA-256 digest"),
    decision: z.enum(REFLEX_DECISION_KINDS),
    reasonCode: z.enum(REFLEX_REASON_CODES),
    triggeredRuleId: z.string().min(1).max(128).optional(),
    observedSignal: z.string().max(512).optional(),
    thresholdUsed: z.number().min(0).optional(),
    observedCount: z.number().min(0).optional(),
    rationale: z.string().max(1024).optional(),
    precedenceIndex: z.number().int().min(0).max(10).optional(),
    replayInput: ReflexReplayInputSchema,
    evidenceIdentityHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "evidenceIdentityHash must be a 64-char hex SHA-256 digest"),
    evaluatedAt: z.string().datetime({ message: "evaluatedAt must be a valid ISO 8601 datetime" }),
  })
  .strict()
  .superRefine((val, ctx) => {
    // 1. Forbidden authority check on the evidence record itself
    const forbidden = findForbiddenAuthorityKeys(val).filter((k) => k !== "evidence");
    if (forbidden.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexEvidence contains forbidden authority keys: [${forbidden.join(", ")}]`,
      });
    }

    // 2. Sensitive keys check
    for (const key of Object.keys(val)) {
      if (isSensitiveKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ReflexEvidence contains sensitive key: '${key}'. Secrets must never be stored in evidence.`,
        });
      }
    }

    // 3. Payload size check
    const serialized = canonicalJsonStringify(val);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_REFLEX_EVIDENCE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexEvidence byte size (${byteLength} bytes) exceeds maximum limit of ${MAX_REFLEX_EVIDENCE_BYTES} bytes`,
      });
    }

    // 4. Verification of tamper-evident identity hash
    const expectedIdentityHash = computeReflexEvidenceIdentityHash(val);
    if (val.evidenceIdentityHash !== expectedIdentityHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ReflexEvidence evidenceIdentityHash mismatch. Expected '${expectedIdentityHash}', received '${val.evidenceIdentityHash}'`,
      });
    }
  });

// ============================================================================
// 5. Tamper-Evident Identity Hashing
// ============================================================================

export interface ComputeEvidenceIdentityHashParams {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly proposalId: string;
  readonly toolName: string;
  readonly actionInputHash: string;
  readonly contextSnapshotHash?: string;
  readonly reflexImplementation: string;
  readonly reflexImplementationVersion: string;
  readonly ruleConfigurationHash: string;
  readonly reflexContextHash: string;
  readonly decision: ReflexDecisionKind;
  readonly reasonCode: ReflexReasonCode;
  readonly triggeredRuleId?: string;
  readonly observedSignal?: string;
  readonly thresholdUsed?: number;
  readonly observedCount?: number;
  readonly precedenceIndex?: number;
}

/**
 * Computes a deterministic SHA-256 tamper-evident integrity hash for a Reflex evidence record.
 *
 * Invariants:
 * 1. Excludes volatile runtime-only metadata (evaluatedAt, evidenceId).
 * 2. Uses canonical JSON serialization with deterministic lexicographical key sorting.
 * 3. Incorporates explicit schema version and cryptographic condition hashes.
 * 4. This hash verifies record tamper-evidence only; it NEVER confers execution authority.
 */
export function computeReflexEvidenceIdentityHash(params: {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly proposalId: string;
  readonly toolName: string;
  readonly actionInputHash: string;
  readonly contextSnapshotHash?: string;
  readonly reflexImplementation: string;
  readonly reflexImplementationVersion: string;
  readonly ruleConfigurationHash: string;
  readonly reflexContextHash: string;
  readonly decision: ReflexDecisionKind;
  readonly reasonCode: ReflexReasonCode;
  readonly triggeredRuleId?: string;
  readonly observedSignal?: string;
  readonly thresholdUsed?: number;
  readonly observedCount?: number;
  readonly precedenceIndex?: number;
}): string {
  const canonicalPayload: Record<string, unknown> = {
    schemaVersion: params.schemaVersion,
    runId: params.runId,
    sequenceNumber: params.sequenceNumber,
    proposalId: params.proposalId,
    toolName: params.toolName,
    actionInputHash: params.actionInputHash,
    reflexImplementation: params.reflexImplementation,
    reflexImplementationVersion: params.reflexImplementationVersion,
    ruleConfigurationHash: params.ruleConfigurationHash,
    reflexContextHash: params.reflexContextHash,
    decision: params.decision,
    reasonCode: params.reasonCode,
  };

  if (params.contextSnapshotHash !== undefined) {
    canonicalPayload.contextSnapshotHash = params.contextSnapshotHash;
  }
  if (params.triggeredRuleId !== undefined) {
    canonicalPayload.triggeredRuleId = params.triggeredRuleId;
  }
  if (params.observedSignal !== undefined) {
    canonicalPayload.observedSignal = params.observedSignal;
  }
  if (params.thresholdUsed !== undefined) {
    canonicalPayload.thresholdUsed = params.thresholdUsed;
  }
  if (params.observedCount !== undefined) {
    canonicalPayload.observedCount = params.observedCount;
  }
  if (params.precedenceIndex !== undefined) {
    canonicalPayload.precedenceIndex = params.precedenceIndex;
  }

  const redacted = redactSensitiveData(canonicalPayload);
  const serialized = canonicalJsonStringify(redacted);
  return sha256Hex(serialized);
}

// ============================================================================
// 6. Evidence Construction Helper
// ============================================================================

export interface CreateReflexEvidenceParams {
  readonly evidenceId?: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly proposal: ActionProposal;
  readonly context: ReflexContext;
  readonly decision: ReflexDecision;
  readonly reflexImplementation?: string;
  readonly reflexImplementationVersion?: string;
  readonly ruleConfigurationHash?: string;
  readonly reflexContextHash?: string;
  readonly ruleConfig?: RuleBasedReflexConfig;
  readonly evaluatedAt?: string;
}

/**
 * Creates, validates, and freezes an authoritative ReflexEvidence record from an
 * actual Reflex evaluation invocation.
 */
export function createReflexEvidence(params: CreateReflexEvidenceParams): ReflexEvidence {
  const proposal = params.proposal;
  const context = params.context;
  const decision = params.decision;

  if (!proposal || typeof proposal !== "object") {
    throw new Error("createReflexEvidence requires a valid ActionProposal");
  }
  if (!context || typeof context !== "object") {
    throw new Error("createReflexEvidence requires a valid ReflexContext");
  }
  if (!decision || typeof decision !== "object") {
    throw new Error("createReflexEvidence requires a valid ReflexDecision");
  }

  const forbiddenProposalKeys = findForbiddenAuthorityKeys(proposal);
  if (forbiddenProposalKeys.length > 0) {
    throw new Error(
      `ReflexEvidence proposal contains forbidden authority keys: [${forbiddenProposalKeys.join(", ")}]`
    );
  }
  const forbiddenContextKeys = findForbiddenAuthorityKeys(context);
  if (forbiddenContextKeys.length > 0) {
    throw new Error(
      `ReflexEvidence context contains forbidden authority keys: [${forbiddenContextKeys.join(", ")}]`
    );
  }

  for (const key of Object.keys(proposal)) {
    if (isSensitiveKey(key)) {
      throw new Error(`ReflexEvidence proposal contains sensitive key: '${key}'`);
    }
  }
  if (proposal.inputPayload && typeof proposal.inputPayload === "object") {
    for (const key of Object.keys(proposal.inputPayload)) {
      if (isSensitiveKey(key)) {
        throw new Error(`ReflexEvidence proposal contains sensitive key: '${key}'`);
      }
    }
  }
  for (const key of Object.keys(context)) {
    if (isSensitiveKey(key)) {
      throw new Error(`ReflexEvidence context contains sensitive key: '${key}'`);
    }
  }

  const actionInputHash = computeCanonicalHash(proposal.inputPayload).contentHash;
  const reflexContextHash =
    params.reflexContextHash ?? context.contextHash ?? computeReflexContextHash(context);

  const ruleConfigurationHash =
    params.ruleConfigurationHash ??
    (params.ruleConfig ? computeRuleBasedReflexConfigHash(params.ruleConfig) : "0".repeat(64));

  const reflexImplementation = params.reflexImplementation ?? REFLEX_IMPLEMENTATION_DEFAULT;
  const reflexImplementationVersion =
    params.reflexImplementationVersion ?? REFLEX_IMPLEMENTATION_VERSION_DEFAULT;

  const precedenceIndex = getReflexPrecedenceIndex(
    decision.ruleId,
    decision.decision,
    decision.reasonCode
  );

  const evidenceId =
    params.evidenceId ?? `rfe-${params.runId}-${params.sequenceNumber}-${proposal.proposalId.slice(0, 8)}`;

  const evaluatedAt = params.evaluatedAt ?? new Date().toISOString();

  const identityHash = computeReflexEvidenceIdentityHash({
    schemaVersion: REFLEX_EVIDENCE_SCHEMA_VERSION,
    runId: params.runId,
    sequenceNumber: params.sequenceNumber,
    proposalId: proposal.proposalId,
    toolName: proposal.toolName,
    actionInputHash,
    contextSnapshotHash: proposal.contextSnapshotHash,
    reflexImplementation,
    reflexImplementationVersion,
    ruleConfigurationHash,
    reflexContextHash,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    triggeredRuleId: decision.ruleId,
    observedSignal: decision.evidence?.signal,
    thresholdUsed: decision.threshold ?? decision.evidence?.threshold,
    observedCount: decision.observedCount ?? decision.evidence?.observedCount,
    precedenceIndex,
  });

  const replayInput: ReflexReplayInput = Object.freeze({
    proposal: Object.freeze({
      proposalId: proposal.proposalId,
      toolName: proposal.toolName,
      inputPayload: Object.freeze({ ...proposal.inputPayload }),
      contextSnapshotHash: proposal.contextSnapshotHash,
      ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {}),
      ...(proposal.sequenceHint !== undefined ? { sequenceHint: proposal.sequenceHint } : {}),
    }),
    context: Object.freeze({
      runId: context.runId,
      taskId: context.taskId,
      stepNumber: context.stepNumber,
      failureCount: context.failureCount,
      ...(context.taskDescription !== undefined ? { taskDescription: context.taskDescription } : {}),
      ...(context.recentActionHistory !== undefined
        ? {
            recentActionHistory: Object.freeze(
              context.recentActionHistory.map((item) => Object.freeze({ ...item }))
            ),
          }
        : {}),
      ...(context.resourceUsage !== undefined
        ? { resourceUsage: Object.freeze({ ...context.resourceUsage }) }
        : {}),
      ...(context.workspacePath !== undefined ? { workspacePath: context.workspacePath } : {}),
      ...(context.verificationStatus !== undefined
        ? { verificationStatus: context.verificationStatus }
        : {}),
      contextHash: reflexContextHash,
    }),
    ...(params.ruleConfig !== undefined ? { ruleConfig: Object.freeze({ ...params.ruleConfig }) } : {}),
  });

  const rawEvidence = {
    evidenceId,
    schemaVersion: REFLEX_EVIDENCE_SCHEMA_VERSION,
    runId: params.runId,
    sequenceNumber: params.sequenceNumber,
    proposalId: proposal.proposalId,
    toolName: proposal.toolName,
    actionInputHash,
    ...(proposal.contextSnapshotHash !== undefined
      ? { contextSnapshotHash: proposal.contextSnapshotHash }
      : {}),
    reflexImplementation,
    reflexImplementationVersion,
    ruleConfigurationHash,
    reflexContextHash,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    ...(decision.ruleId !== undefined ? { triggeredRuleId: decision.ruleId } : {}),
    ...(decision.evidence?.signal !== undefined ? { observedSignal: decision.evidence.signal } : {}),
    ...(decision.threshold !== undefined
      ? { thresholdUsed: decision.threshold }
      : decision.evidence?.threshold !== undefined
      ? { thresholdUsed: decision.evidence.threshold }
      : {}),
    ...(decision.observedCount !== undefined
      ? { observedCount: decision.observedCount }
      : decision.evidence?.observedCount !== undefined
      ? { observedCount: decision.evidence.observedCount }
      : {}),
    ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
    precedenceIndex,
    replayInput,
    evidenceIdentityHash: identityHash,
    evaluatedAt,
  };

  return validateReflexEvidence(rawEvidence);
}

/**
 * Validates unknown data strictly against the ReflexEvidenceSchema and freezes it.
 */
export function validateReflexEvidence(data: unknown): ReflexEvidence {
  const result = ReflexEvidenceSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Malformed ReflexEvidence: ${issues}`);
  }

  const d = result.data;
  return Object.freeze({
    evidenceId: d.evidenceId,
    schemaVersion: d.schemaVersion,
    runId: d.runId,
    sequenceNumber: d.sequenceNumber,
    proposalId: d.proposalId,
    toolName: d.toolName,
    actionInputHash: d.actionInputHash,
    contextSnapshotHash: d.contextSnapshotHash,
    reflexImplementation: d.reflexImplementation,
    reflexImplementationVersion: d.reflexImplementationVersion,
    ruleConfigurationHash: d.ruleConfigurationHash,
    reflexContextHash: d.reflexContextHash,
    decision: d.decision,
    reasonCode: d.reasonCode,
    triggeredRuleId: d.triggeredRuleId,
    observedSignal: d.observedSignal,
    thresholdUsed: d.thresholdUsed,
    observedCount: d.observedCount,
    rationale: d.rationale,
    precedenceIndex: d.precedenceIndex,
    replayInput: Object.freeze({
      proposal: Object.freeze({ ...d.replayInput.proposal }),
      context: Object.freeze({ ...d.replayInput.context }),
      ...(d.replayInput.ruleConfig !== undefined
        ? { ruleConfig: Object.freeze(d.replayInput.ruleConfig as any) }
        : {}),
    }),
    evidenceIdentityHash: d.evidenceIdentityHash,
    evaluatedAt: d.evaluatedAt,
  });
}

// ============================================================================
// 7. Pure Replay Contract & Comparison Semantics
// ============================================================================

export type ReflexReplayStatus =
  | "MATCH"
  | "MISMATCH_DECISION"
  | "MISMATCH_REASON"
  | "MISMATCH_RULE"
  | "MISMATCH_CONFIGURATION"
  | "MISMATCH_CONTEXT"
  | "INVALID_EVIDENCE";

export interface ReflexReplayResult {
  readonly status: ReflexReplayStatus;
  readonly match: boolean;
  readonly evidenceId: string;
  readonly recorded: {
    readonly decision: ReflexDecisionKind;
    readonly reasonCode: ReflexReasonCode;
    readonly ruleId?: string;
    readonly ruleConfigurationHash: string;
    readonly reflexContextHash: string;
    readonly actionInputHash: string;
  };
  readonly recomputed?: {
    readonly decision: ReflexDecisionKind;
    readonly reasonCode: ReflexReasonCode;
    readonly ruleId?: string;
    readonly ruleConfigurationHash: string;
    readonly reflexContextHash: string;
    readonly actionInputHash: string;
    readonly decisionEvidence?: ReflexDecisionEvidence;
  };
  readonly mismatchDetails?: string;
  readonly replayedAt: string;
}

export interface ReplayReflexEvidenceOptions {
  /**
   * Explicit rule configuration to use during replay.
   * If omitted, falls back to evidence.replayInput.ruleConfig, or default config.
   */
  readonly ruleConfig?: RuleBasedReflexConfig;

  /**
   * Optional custom Reflex implementation to evaluate against.
   * Defaults to pure in-memory RuleBasedReflex with the resolved configuration.
   */
  readonly reflex?: ReflexPort;

  /**
   * Deterministic replay timestamp. Defaults to current ISO string.
   */
  readonly replayedAt?: string;
}

/**
 * Pure, deterministic Reflex replay function.
 *
 * Guarantees:
 * 1. ZERO model calls (no LLM, no Ollama, no API invocations).
 * 2. ZERO tool execution (no workspace mutation, no process execution, no Docker).
 * 3. ZERO database mutations (in-memory evaluation only).
 * 4. Accepts captured Reflex input/context/configuration from evidence.
 * 5. Recomputes decision and produces structured comparison result.
 */
export async function replayReflexEvidence(
  evidence: ReflexEvidence,
  options: ReplayReflexEvidenceOptions = {}
): Promise<ReflexReplayResult> {
  const replayedAt = options.replayedAt ?? new Date().toISOString();

  // 1. Evidence schema and integrity validation
  let validatedEvidence: ReflexEvidence;
  try {
    validatedEvidence = validateReflexEvidence(evidence);
  } catch (err: unknown) {
    return Object.freeze({
      status: "INVALID_EVIDENCE",
      match: false,
      evidenceId: (evidence as any)?.evidenceId ?? "unknown",
      recorded: {
        decision: (evidence as any)?.decision ?? "ALLOW",
        reasonCode: (evidence as any)?.reasonCode ?? "NO_INTERVENTION",
        ruleConfigurationHash: (evidence as any)?.ruleConfigurationHash ?? "",
        reflexContextHash: (evidence as any)?.reflexContextHash ?? "",
        actionInputHash: (evidence as any)?.actionInputHash ?? "",
      },
      mismatchDetails: `Evidence failed schema/integrity validation: ${
        err instanceof Error ? err.message : String(err)
      }`,
      replayedAt,
    });
  }

  const recordedSummary = Object.freeze({
    decision: validatedEvidence.decision,
    reasonCode: validatedEvidence.reasonCode,
    ruleId: validatedEvidence.triggeredRuleId,
    ruleConfigurationHash: validatedEvidence.ruleConfigurationHash,
    reflexContextHash: validatedEvidence.reflexContextHash,
    actionInputHash: validatedEvidence.actionInputHash,
  });

  // 2. Context integrity check
  const recomputedContextHash = computeReflexContextHash(validatedEvidence.replayInput.context);
  if (recomputedContextHash !== validatedEvidence.reflexContextHash) {
    return Object.freeze({
      status: "MISMATCH_CONTEXT",
      match: false,
      evidenceId: validatedEvidence.evidenceId,
      recorded: recordedSummary,
      mismatchDetails: `Recomputed contextHash '${recomputedContextHash}' does not match recorded reflexContextHash '${validatedEvidence.reflexContextHash}'`,
      replayedAt,
    });
  }

  // 3. Resolve Reflex evaluator and verify configuration identity
  const effectiveConfig =
    options.ruleConfig ?? validatedEvidence.replayInput.ruleConfig;

  let reflex: ReflexPort;
  let activeConfigHash: string;

  if (options.reflex) {
    reflex = options.reflex;
    activeConfigHash = (reflex as any).activeConfigHash ?? validatedEvidence.ruleConfigurationHash;
  } else {
    const ruleBased = new RuleBasedReflex(effectiveConfig);
    reflex = ruleBased;
    activeConfigHash = ruleBased.activeConfigHash;
  }

  if (activeConfigHash !== validatedEvidence.ruleConfigurationHash) {
    return Object.freeze({
      status: "MISMATCH_CONFIGURATION",
      match: false,
      evidenceId: validatedEvidence.evidenceId,
      recorded: recordedSummary,
      mismatchDetails: `Replay activeConfigHash '${activeConfigHash}' does not match recorded ruleConfigurationHash '${validatedEvidence.ruleConfigurationHash}'`,
      replayedAt,
    });
  }

  // 4. Pure offline evaluation (zero tools, zero models, zero persistence)
  let recomputedDecision: ReflexDecision;
  try {
    recomputedDecision = await reflex.evaluate(
      validatedEvidence.replayInput.proposal,
      validatedEvidence.replayInput.context
    );
  } catch (err: unknown) {
    return Object.freeze({
      status: "INVALID_EVIDENCE",
      match: false,
      evidenceId: validatedEvidence.evidenceId,
      recorded: recordedSummary,
      mismatchDetails: `Replay evaluate threw error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      replayedAt,
    });
  }

  const recomputedSummary = Object.freeze({
    decision: recomputedDecision.decision,
    reasonCode: recomputedDecision.reasonCode,
    ruleId: recomputedDecision.ruleId,
    ruleConfigurationHash: activeConfigHash,
    reflexContextHash: recomputedContextHash,
    actionInputHash: validatedEvidence.actionInputHash,
    decisionEvidence: recomputedDecision.evidence,
  });

  // 5. Compare decision
  if (recomputedDecision.decision !== validatedEvidence.decision) {
    return Object.freeze({
      status: "MISMATCH_DECISION",
      match: false,
      evidenceId: validatedEvidence.evidenceId,
      recorded: recordedSummary,
      recomputed: recomputedSummary,
      mismatchDetails: `Decision mismatch: recorded '${validatedEvidence.decision}', recomputed '${recomputedDecision.decision}'`,
      replayedAt,
    });
  }

  // 6. Compare reason code
  if (recomputedDecision.reasonCode !== validatedEvidence.reasonCode) {
    return Object.freeze({
      status: "MISMATCH_REASON",
      match: false,
      evidenceId: validatedEvidence.evidenceId,
      recorded: recordedSummary,
      recomputed: recomputedSummary,
      mismatchDetails: `ReasonCode mismatch: recorded '${validatedEvidence.reasonCode}', recomputed '${recomputedDecision.reasonCode}'`,
      replayedAt,
    });
  }

  // 7. Compare triggered rule
  if (recomputedDecision.ruleId !== validatedEvidence.triggeredRuleId) {
    return Object.freeze({
      status: "MISMATCH_RULE",
      match: false,
      evidenceId: validatedEvidence.evidenceId,
      recorded: recordedSummary,
      recomputed: recomputedSummary,
      mismatchDetails: `RuleId mismatch: recorded '${validatedEvidence.triggeredRuleId}', recomputed '${recomputedDecision.ruleId}'`,
      replayedAt,
    });
  }

  // 8. Bit-for-bit deterministic match
  return Object.freeze({
    status: "MATCH",
    match: true,
    evidenceId: validatedEvidence.evidenceId,
    recorded: recordedSummary,
    recomputed: recomputedSummary,
    replayedAt,
  });
}
