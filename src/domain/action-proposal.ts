/**
 * Action Proposal Domain Model for Emerald Agent Fabric.
 *
 * Establishes the typed proposal contract and trust boundary between
 * an untrusted Agent Brain / Model output and the authoritative Action domain.
 *
 * Architectural Invariants:
 * 1. Model output is strictly UNTRUSTED.
 * 2. Strict Schema Conformance: Proposals must adhere strictly to ActionProposalSchema with no extra fields.
 * 3. Authority Prohibition: Models can NEVER propose runtime authority (workerId, leaseId, contracts,
 *    capabilities, isolation levels, workspace mount paths, retry limits, or execution status/results).
 * 4. Bounded Allocation: Max proposal payload is bounded to 64 KB (MAX_PROPOSAL_BYTES = 65536) and rationale to 4 KB.
 * 5. Zero Side Effects: Proposal evaluation creates no files, executes no tools, and touches no ExecutionProviders.
 */

import { z } from "zod";
import { TOOL_NAMES, ToolName, ToolDefinition, ToolCapability } from "./tool.js";
import { ContractBinding } from "./invariants.js";

// ============================================================================
// 1. Proposal Ceilings & Bounds
// ============================================================================

export const MAX_PROPOSAL_BYTES = 65536; // 64 KB serialized canonical JSON limit
export const MAX_RATIONALE_LENGTH = 4096; // 4 KB max rationale characters

// ============================================================================
// 2. Forbidden Authority Fields
// ============================================================================

/**
 * Authority fields that an untrusted agent or model must NEVER propose or control.
 * Any proposal containing these keys is immediately rejected.
 */
export const FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
  "workerId",
  "leaseId",
  "contractId",
  "contractVersion",
  "contractHash",
  "contractBinding",
  "capability",
  "capabilities",
  "requiredCapability",
  "resourceCeilings",
  "resourceLimits",
  "limits",
  "timeoutMs",
  "isolationLevel",
  "isolationRequirement",
  "isolation",
  "workspaceRoot",
  "hostPath",
  "mountPath",
  "provider",
  "image",
  "container",
  "network",
  "credentials",
  "secret",
  "token",
  "retry",
  "maxAttempts",
  "attemptNumber",
  "activeAttemptNumber",
  "totalAttempts",
  "executionStatus",
  "status",
  "executionResult",
  "result",
  "resultPayload",
  "errorPayload",
  "exitCode",
  "evidence",
  "verification",
  "verificationResult",
  "verificationSpecs",
] as const);

export const ALLOWED_PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  "proposalId",
  "toolName",
  "inputPayload",
  "contextSnapshotHash",
  "rationale",
  "sequenceHint",
]);

/**
 * Checks an untrusted object for forbidden authority fields.
 * Returns an array of offending keys if found.
 */
export function findForbiddenAuthorityKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const violations: string[] = [];
  const keys = Object.keys(value as Record<string, unknown>);
  for (const key of keys) {
    if ((FORBIDDEN_AUTHORITY_KEYS as readonly string[]).includes(key as any)) {
      violations.push(key);
    }
  }
  return Object.freeze(violations);
}

// ============================================================================
// 3. Action Proposal Domain Type & Schema
// ============================================================================

export interface ActionProposal {
  readonly proposalId: string;
  readonly toolName: ToolName;
  readonly inputPayload: Readonly<Record<string, unknown>>;
  readonly contextSnapshotHash: string;
  readonly rationale?: string;
  readonly sequenceHint?: number;
}

export const ActionProposalSchema = z
  .object({
    proposalId: z
      .string()
      .min(1, "proposalId cannot be empty")
      .max(256, "proposalId exceeds max length of 256"),
    toolName: z.enum(TOOL_NAMES),
    inputPayload: z.record(z.unknown()),
    contextSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "contextSnapshotHash must be a 64-character hexadecimal SHA-256 hash"),
    rationale: z
      .string()
      .max(MAX_RATIONALE_LENGTH, `rationale exceeds maximum length of ${MAX_RATIONALE_LENGTH}`)
      .optional(),
    sequenceHint: z
      .number()
      .int("sequenceHint must be an integer")
      .positive("sequenceHint must be a positive integer")
      .optional(),
  })
  .strict();

// ============================================================================
// 4. Rejection Taxonomy
// ============================================================================

export type ProposalRejectionReason =
  | "MALFORMED_PROPOSAL"
  | "PROPOSAL_SIZE_EXCEEDED"
  | "RATIONALE_TOO_LONG"
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_INPUT"
  | "UNAUTHORIZED_CAPABILITY"
  | "FORBIDDEN_AUTHORITY_FIELD"
  | "CONTEXT_HASH_MISMATCH"
  | "CONTRACT_REVOKED"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "RUN_NOT_ACTIVE"
  | "LEASE_INVALID";

export interface ProposalValidationSuccess {
  readonly valid: true;
  readonly proposal: ActionProposal;
  readonly toolDefinition: ToolDefinition;
  readonly requiredCapability: ToolCapability;
  readonly contractBinding: ContractBinding;
  readonly maxAttempts: number;
}

export interface ProposalValidationFailure {
  readonly valid: false;
  readonly reason: ProposalRejectionReason;
  readonly message: string;
  readonly violations?: readonly string[];
}

export type ProposalValidationResult =
  | ProposalValidationSuccess
  | ProposalValidationFailure;
