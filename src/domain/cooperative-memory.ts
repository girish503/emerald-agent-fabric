/**
 * Phase 92: Governed Multi-Agent Cooperative Memory Domain Model
 *
 * Encapsulates shared memory observations exchanged between agents in a governed workflow.
 *
 * CRITICAL INVARIANTS:
 * 1. Agents may share knowledge. They must never share authority implicitly.
 * 2. Every memory record is UNTRUSTED_OBSERVATION unless backed by sovereign evidence.
 * 3. No memory trust class or lifecycle state grants executive, policy, verification, or terminal authority.
 * 4. Memory history is append-only; silent deletion or in-place overwriting is prohibited.
 * 5. Memory scope is strictly bounded by goal, repository, and workspace envelopes.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type MemoryType =
  | "OBSERVATION"
  | "HYPOTHESIS"
  | "DEPENDENCY_FINDING"
  | "TEST_RESULT"
  | "CONTEXT_SUMMARY"
  | "FAILURE_EVIDENCE"
  | "REPAIR_CANDIDATE"
  | "VERIFICATION_OBSERVATION"
  | "WORKSPACE_STATE"
  | "REPOSITORY_STATE"
  | "CONFLICT_REPORT"
  | "RESOURCE_OBSERVATION";

export type MemoryFreshness = "FRESH" | "STALE" | "EXPIRED" | "REVOKED";

export type MemoryTrustClass =
  | "UNTRUSTED_OBSERVATION"
  | "PROVENANCE_VERIFIED_OBSERVATION"
  | "LOCALLY_VERIFIED_OBSERVATION"
  | "SOVEREIGN_VERIFIED_EVIDENCE";

export type MemoryStatus =
  | "PROPOSED"
  | "VALIDATING"
  | "ACTIVE"
  | "SUPERSEDED"
  | "EXPIRED"
  | "REJECTED"
  | "QUARANTINED"
  | "REVOKED";

export type MemoryConflictType =
  | "STALE_MEMORY"
  | "VERSION_CONFLICT"
  | "CONTENT_CONFLICT"
  | "PROVENANCE_CONFLICT"
  | "SCOPE_CONFLICT"
  | "REPOSITORY_CONFLICT"
  | "WORKSPACE_CONFLICT"
  | "DEPENDENCY_CONFLICT"
  | "TEST_RESULT_CONFLICT"
  | "HYPOTHESIS_CONFLICT"
  | "REPAIR_CANDIDATE_CONFLICT"
  | "VERIFICATION_CONFLICT"
  | "RESOURCE_OBSERVATION_CONFLICT"
  | "AUTHORITY_INJECTION"
  | "DUPLICATE_MEMORY"
  | "MEMORY_RECONCILIATION_BLOCKED";

export interface MemoryRecord {
  readonly memoryId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly memoryType: MemoryType;
  readonly content: unknown;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly sourceEvidenceDigest: string;
  readonly parentMemoryId?: string;
  readonly version: number;
  readonly freshness: MemoryFreshness;
  readonly confidence: number;
  readonly provenanceRoot: string;
  readonly authorityClassification: MemoryTrustClass;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly status: MemoryStatus;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
  readonly referencedFiles?: readonly string[];
  readonly referencedSymbols?: readonly string[];
  readonly baseRevision?: string;
}

export const VALID_MEMORY_STATUS_TRANSITIONS: ReadonlyMap<
  MemoryStatus,
  readonly MemoryStatus[]
> = new Map([
  ["PROPOSED", ["VALIDATING", "REJECTED", "QUARANTINED"]],
  ["VALIDATING", ["ACTIVE", "REJECTED", "QUARANTINED"]],
  ["ACTIVE", ["SUPERSEDED", "EXPIRED", "REVOKED", "QUARANTINED"]],
  ["SUPERSEDED", ["EXPIRED", "REVOKED"]],
  ["EXPIRED", []],
  ["REJECTED", []],
  ["QUARANTINED", ["ACTIVE", "REVOKED"]],
  ["REVOKED", []],
]);

export function canTransitionMemoryStatus(
  from: MemoryStatus,
  to: MemoryStatus
): boolean {
  const allowed = VALID_MEMORY_STATUS_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.includes(to);
}

export function computeMemoryContentDigest(content: unknown): string {
  const canonical = canonicalJsonStringify(content);
  return sha256Hex(canonical);
}

export function computeMemoryRecordDigest(
  record: Omit<MemoryRecord, "content">
): string {
  const payload = {
    memoryId: record.memoryId,
    agentId: record.agentId,
    goalId: record.goalId,
    repositoryId: record.repositoryId,
    workspaceId: record.workspaceId,
    memoryType: record.memoryType,
    contentDigest: record.contentDigest,
    contentSize: record.contentSize,
    sourceEvidenceDigest: record.sourceEvidenceDigest,
    parentMemoryId: record.parentMemoryId,
    version: record.version,
    freshness: record.freshness,
    confidence: record.confidence,
    provenanceRoot: record.provenanceRoot,
    authorityClassification: record.authorityClassification,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export interface CreateMemoryRecordParams {
  readonly memoryId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly memoryType: MemoryType;
  readonly content: unknown;
  readonly sourceEvidenceDigest: string;
  readonly parentMemoryId?: string;
  readonly version?: number;
  readonly freshness?: MemoryFreshness;
  readonly confidence?: number;
  readonly provenanceRoot: string;
  readonly authorityClassification?: MemoryTrustClass;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly referencedFiles?: readonly string[];
  readonly referencedSymbols?: readonly string[];
  readonly baseRevision?: string;
}

export function createMemoryRecord(params: CreateMemoryRecordParams): MemoryRecord {
  const contentDigest = computeMemoryContentDigest(params.content);
  const serialized = canonicalJsonStringify(params.content);
  const contentSize = Buffer.byteLength(serialized, "utf8");

  const confidence = params.confidence ?? 0.8;
  if (confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence score ${confidence}; must be in range [0, 1]`);
  }

  return {
    memoryId: params.memoryId,
    agentId: params.agentId,
    goalId: params.goalId,
    repositoryId: params.repositoryId,
    workspaceId: params.workspaceId,
    memoryType: params.memoryType,
    content: params.content,
    contentDigest,
    contentSize,
    sourceEvidenceDigest: params.sourceEvidenceDigest,
    parentMemoryId: params.parentMemoryId,
    version: params.version ?? 1,
    freshness: params.freshness ?? "FRESH",
    confidence,
    provenanceRoot: params.provenanceRoot,
    authorityClassification:
      params.authorityClassification ?? "UNTRUSTED_OBSERVATION",
    createdAt: params.createdAt ?? new Date().toISOString(),
    expiresAt: params.expiresAt,
    status: "ACTIVE",
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
    referencedFiles: params.referencedFiles ? [...params.referencedFiles] : undefined,
    referencedSymbols: params.referencedSymbols
      ? [...params.referencedSymbols]
      : undefined,
    baseRevision: params.baseRevision,
  };
}

export function validateMemoryRecordIntegrity(record: MemoryRecord): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  if (!record.memoryId || typeof record.memoryId !== "string") {
    errors.push("Missing or invalid memoryId");
  }
  if (!record.agentId || typeof record.agentId !== "string") {
    errors.push("Missing or invalid agentId");
  }
  if (!record.goalId || typeof record.goalId !== "string") {
    errors.push("Missing or invalid goalId");
  }
  if (!record.repositoryId || typeof record.repositoryId !== "string") {
    errors.push("Missing or invalid repositoryId");
  }
  if (!record.workspaceId || typeof record.workspaceId !== "string") {
    errors.push("Missing or invalid workspaceId");
  }
  if (!record.sourceEvidenceDigest || typeof record.sourceEvidenceDigest !== "string") {
    errors.push("Missing sourceEvidenceDigest");
  }
  if (!record.provenanceRoot || typeof record.provenanceRoot !== "string") {
    errors.push("Missing provenanceRoot");
  }

  // Authority invariants: MUST NEVER be true
  if (record.authoritative !== false) {
    errors.push("Invariant violation: memory cannot have authoritative = true");
  }
  if (record.terminalAuthority !== false) {
    errors.push("Invariant violation: memory cannot have terminalAuthority = true");
  }
  if (record.verificationAuthority !== false) {
    errors.push("Invariant violation: memory cannot have verificationAuthority = true");
  }
  if (record.policyAuthority !== false) {
    errors.push("Invariant violation: memory cannot have policyAuthority = true");
  }

  // Digest verification
  const computedContentDigest = computeMemoryContentDigest(record.content);
  if (computedContentDigest !== record.contentDigest) {
    errors.push(
      `Content digest mismatch: expected ${record.contentDigest}, got ${computedContentDigest}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
