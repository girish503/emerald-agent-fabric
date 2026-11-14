/**
 * Domain types, Truth Firewall invariants, and structured errors for
 * Emerald Agent Fabric Durable Scoped Context Memory.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import { DomainError } from "./errors.js";

export const ALL_MEMORY_SCOPES = [
  "CURRENT_TASK_CONTEXT",
  "DURABLE_TASK_HISTORY",
  "PROJECT_KNOWLEDGE",
  "AGENT_WORKING_CONTEXT",
  "VERIFIED_EVIDENCE",
  "UNTRUSTED_OBSERVATION",
] as const;

export type MemoryScope = (typeof ALL_MEMORY_SCOPES)[number];

export type MemoryProvenanceClassification =
  | "VERIFIED_FACT"
  | "UNVERIFIED_OBSERVATION"
  | "MODEL_HYPOTHESIS";

export const MAX_MEMORY_CONTENT_BYTES = 1024 * 1024; // 1 MB
export const MAX_MEMORY_METADATA_BYTES = 256 * 1024; // 256 KB
export const DEFAULT_MAX_QUERY_LIMIT = 500;

export interface MemoryEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId?: string | null;
  readonly agentId?: string | null;
  readonly scope: MemoryScope;
  readonly source: string;
  readonly isModelGenerated: boolean;
  readonly isIndependentlyVerified: boolean;
  readonly content: string;
  readonly timestamp: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string | null;
  readonly version: number;
  readonly estimatedTokens: number;
  readonly contentHash: string;
  readonly idempotencyKey?: string | null;
  readonly sequence?: number;
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// Structured Error Taxonomy (Fail-Closed, Zero Swallowed Persistence Errors)
// ============================================================================

export abstract class MemoryPersistenceError extends DomainError {
  readonly causeDetail?: string;

  constructor(message: string, causeDetail?: string) {
    super(message);
    this.causeDetail = causeDetail;
  }
}

export class MemoryStoreConfigurationError extends MemoryPersistenceError {
  readonly code = "MEMORY_STORE_CONFIGURATION_ERROR";
}

export class MemoryIsolationError extends MemoryPersistenceError {
  readonly code = "MEMORY_ISOLATION_VIOLATION";
}

export class TruthFirewallViolationError extends MemoryPersistenceError {
  readonly code = "TRUTH_FIREWALL_VIOLATION";
}

export class MemoryValidationError extends MemoryPersistenceError {
  readonly code = "MEMORY_VALIDATION_ERROR";
}

export class MemoryIdempotencyConflictError extends MemoryPersistenceError {
  readonly code = "MEMORY_IDEMPOTENCY_CONFLICT";

  constructor(
    readonly tenantId: string,
    readonly taskId: string,
    readonly idempotencyKey: string
  ) {
    super(
      `Idempotency conflict for key '${idempotencyKey}' in tenant '${tenantId}' task '${taskId}': payload or provenance differs from existing entry`
    );
  }
}

export class MemoryVersionConflictError extends MemoryPersistenceError {
  readonly code = "MEMORY_VERSION_CONFLICT";

  constructor(
    readonly entryId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number
  ) {
    super(
      `Version conflict for memory entry '${entryId}': expected version ${expectedVersion}, actual version ${actualVersion}`
    );
  }
}

export class MemoryNotFoundError extends MemoryPersistenceError {
  readonly code = "MEMORY_NOT_FOUND";

  constructor(readonly entryId: string, readonly tenantId: string, readonly taskId: string) {
    super(`Memory entry '${entryId}' not found for tenant '${tenantId}' and task '${taskId}'`);
  }
}

export class MemoryExpiredError extends MemoryPersistenceError {
  readonly code = "MEMORY_EXPIRED";

  constructor(readonly entryId: string, readonly expiresAt: string) {
    super(`Memory entry '${entryId}' expired at '${expiresAt}'`);
  }
}

export class MemoryCorruptRecordError extends MemoryPersistenceError {
  readonly code = "MEMORY_CORRUPT_RECORD";

  constructor(readonly entryId: string, reason: string) {
    super(`Corrupt memory record '${entryId}': ${reason}`, reason);
  }
}

export class MemoryStorageUnavailableError extends MemoryPersistenceError {
  readonly code = "MEMORY_STORAGE_UNAVAILABLE";

  constructor(operation: string, reason: string) {
    super(`Durable memory storage unavailable during '${operation}': ${reason}`, reason);
  }
}

// ============================================================================
// Validation & Truth Firewall Helpers
// ============================================================================

const MEMORY_SCOPE_SET: ReadonlySet<string> = new Set(ALL_MEMORY_SCOPES);

export function isValidMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && MEMORY_SCOPE_SET.has(value);
}

export function assertValidMemoryScope(value: unknown): MemoryScope {
  if (!isValidMemoryScope(value)) {
    throw new MemoryValidationError(`Invalid memory scope: '${String(value)}'`);
  }
  return value;
}

export function assertRequiredScopeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryIsolationError(`${fieldName} is required and must be a non-empty string`);
  }
  return value;
}

export function assertOptionalIdentifier(
  value: unknown,
  fieldName: string
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryValidationError(`${fieldName} must be a non-empty string when provided`);
  }
  return value;
}

export function assertValidIsoTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new MemoryValidationError(`${fieldName} must be a valid ISO-8601 timestamp string`);
  }
  return new Date(value).toISOString();
}

export function assertBoundedContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new MemoryValidationError("Memory content must be a string");
  }
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_MEMORY_CONTENT_BYTES) {
    throw new MemoryValidationError(
      `Memory content size (${byteLength} bytes) exceeds maximum limit (${MAX_MEMORY_CONTENT_BYTES} bytes)`
    );
  }
  return content;
}

export function serializeMemoryMetadata(metadata: unknown): string | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new MemoryValidationError("Memory metadata must be a plain key-value object");
  }
  let serialized: string;
  try {
    serialized = canonicalJsonStringify(metadata);
  } catch (err) {
    throw new MemoryValidationError(
      `Failed to serialize memory metadata: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_MEMORY_METADATA_BYTES) {
    throw new MemoryValidationError(
      `Memory metadata size (${byteLength} bytes) exceeds limit (${MAX_MEMORY_METADATA_BYTES} bytes)`
    );
  }
  return serialized;
}

export function computeMemoryPayloadFingerprint(params: {
  scope: MemoryScope;
  source: string;
  contentHash: string;
  isModelGenerated: boolean;
  isIndependentlyVerified: boolean;
  runId: string | null;
  agentId: string | null;
}): string {
  return sha256Hex(
    canonicalJsonStringify({
      scope: params.scope,
      source: params.source,
      contentHash: params.contentHash,
      isModelGenerated: params.isModelGenerated,
      isIndependentlyVerified: params.isIndependentlyVerified,
      runId: params.runId,
      agentId: params.agentId,
    })
  );
}

/**
 * Classifies an entry cleanly for prompt compilation without blurring provenance boundaries.
 * Model-generated entries can NEVER produce VERIFIED_FACT.
 */
export function classifyMemoryProvenance(entry: Pick<MemoryEntry, "isModelGenerated" | "isIndependentlyVerified" | "scope">): MemoryProvenanceClassification {
  if (entry.isModelGenerated) {
    return "MODEL_HYPOTHESIS";
  }
  if (entry.isIndependentlyVerified && entry.scope === "VERIFIED_EVIDENCE") {
    return "VERIFIED_FACT";
  }
  return "UNVERIFIED_OBSERVATION";
}

/**
 * Truth Firewall invariant check.
 * Model-generated records can NEVER become VERIFIED_EVIDENCE or claim isIndependentlyVerified=true.
 */
export function assertTruthFirewallInvariant(params: {
  entryId?: string;
  scope: MemoryScope;
  isModelGenerated: boolean;
  isIndependentlyVerified: boolean;
}): void {
  if (params.isModelGenerated && params.isIndependentlyVerified) {
    throw new TruthFirewallViolationError(
      `Truth Firewall violation${params.entryId ? ` on entry '${params.entryId}'` : ""}: model-generated memory cannot claim independent verification`
    );
  }
  if (params.isModelGenerated && params.scope === "VERIFIED_EVIDENCE") {
    throw new TruthFirewallViolationError(
      `Truth Firewall violation${params.entryId ? ` on entry '${params.entryId}'` : ""}: model-generated memory cannot occupy VERIFIED_EVIDENCE scope`
    );
  }
}
