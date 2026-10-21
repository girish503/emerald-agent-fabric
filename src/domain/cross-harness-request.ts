/**
 * Phase 99: Governed Autonomous Multi-Agent Capability Fencing and Dynamic Cross-Harness Boundary Enactment
 *
 * Domain Model for cross-harness requests, delegation records, and boundary transfer protocols.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Capability may be delegated only downward within a fixed safety envelope.
 * Capability composition must never create authority ex nihilo.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import { CapabilityScope, PositiveCapability } from "./capability-fence.js";

/**
 * 8 Governed Harness Types in Emerald Agent Fabric.
 */
export type HarnessType =
  | "ANALYSIS_HARNESS"
  | "IMPLEMENTATION_HARNESS"
  | "TEST_HARNESS"
  | "REVIEW_HARNESS"
  | "VERIFICATION_HARNESS"
  | "SANDBOX_HARNESS"
  | "SPECULATION_HARNESS"
  | "RECOVERY_HARNESS";

/**
 * Governed cross-harness boundary request types.
 */
export type CrossHarnessRequestType =
  | "READ_TRANSFER"
  | "DATA_TRANSFER"
  | "TOOL_INVOCATION"
  | "WORKSPACE_ACCESS"
  | "REPOSITORY_ACCESS"
  | "RESOURCE_REQUEST"
  | "ROLE_HANDOFF"
  | "ACTION_HANDOFF"
  | "ATTEMPT_HANDOFF"
  | "VERIFICATION_REQUEST"
  | "SPECULATIVE_DATA_TRANSFER";

/**
 * Cross-harness request evaluation lifecycle states.
 */
export type CrossHarnessRequestStatus =
  | "SUBMITTED"
  | "EVALUATING"
  | "GRANTED"
  | "DENIED"
  | "QUARANTINED"
  | "EXPIRED";

/**
 * Gateway delegation/boundary decision.
 */
export type DelegationDecision = "GRANT" | "DENY" | "QUARANTINE";

/**
 * Cross-Harness Boundary Request submitted across distinct harnesses.
 * Non-authoritative observation; must be evaluated independently by gateway.
 */
export interface CrossHarnessRequest {
  readonly requestId: string;
  readonly callerSubjectId: string;
  readonly callerHarness: HarnessType;
  readonly calleeHarness: HarnessType;
  readonly requestType: CrossHarnessRequestType;
  readonly requestedCapability: string;
  readonly targetResource: string;
  readonly payload: Record<string, unknown>;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly callerFenceId: string;
  readonly status: CrossHarnessRequestStatus;
  readonly decision?: DelegationDecision;
  readonly denialReason?: string;
  readonly controlId?: string;
  readonly submittedAt: string;
  readonly evaluatedAt?: string;
  readonly authoritative: false;
  readonly hash: string;
}

/**
 * Durable record of downward capability delegation between fences.
 */
export interface DelegationRecord {
  readonly delegationId: string;
  readonly parentFenceId: string;
  readonly childFenceId: string;
  readonly parentSubjectId: string;
  readonly childSubjectId: string;
  readonly delegatedCapabilities: readonly PositiveCapability[];
  readonly remainingParentCapabilities: readonly PositiveCapability[];
  readonly delegatedScope: CapabilityScope;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly hash: string;
}

/**
 * Hash computation helper for CrossHarnessRequest.
 */
export function computeCrossHarnessRequestHash(
  request: Omit<CrossHarnessRequest, "hash">,
): string {
  return sha256Hex(canonicalJsonStringify(request));
}

/**
 * Hash computation helper for DelegationRecord.
 */
export function computeDelegationRecordHash(
  record: Omit<DelegationRecord, "hash">,
): string {
  return sha256Hex(canonicalJsonStringify(record));
}
