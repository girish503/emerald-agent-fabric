/**
 * Phase 91: Resource Renegotiation Domain Model
 *
 * Types and structures for untrusted agent renegotiation requests,
 * explicit negotiation conflict classification, and governed policy decisions.
 *
 * INVARIANTS:
 * 1. An agent renegotiation request is UNTRUSTED_OBSERVATION.
 * 2. An agent cannot self-grant or approve its own requested resources.
 * 3. Every request must be fenced with the current allocation version.
 * 4. Stale allocation versions fail closed immediately.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import { ResourceAllocation } from "./resource-allocation.js";

export type RenegotiationUrgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RenegotiationRequestStatus =
  | "REQUESTED"
  | "EVALUATING"
  | "APPROVED"
  | "PARTIALLY_APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "QUARANTINED";

export type NegotiationPolicyType =
  | "STATIC_FIFO"
  | "FAIR_SHARE"
  | "PRIORITY_AWARE"
  | "NEED_AWARE"
  | "GOVERNED_ADAPTIVE";

export type NegotiationConflictType =
  | "STALE_ALLOCATION"
  | "POOL_EXHAUSTION"
  | "CEILING_EXCEEDED"
  | "IMMUTABLE_FIELD_CHANGE"
  | "SCOPE_CONFLICT"
  | "CAPABILITY_CONFLICT"
  | "PRIORITY_CONFLICT"
  | "FAIRNESS_CONFLICT"
  | "DEPENDENCY_CONFLICT"
  | "DUPLICATE_REQUEST"
  | "RESOURCE_ACCOUNTING_CONFLICT"
  | "PROVENANCE_CONFLICT"
  | "NEGOTIATION_BLOCKED";

export interface RenegotiationRequest {
  readonly requestId: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly contractId: string;
  readonly currentAllocationVersion: number;
  readonly requestedDelta: Partial<ResourceAllocation>;
  readonly reason: string;
  readonly urgency: RenegotiationUrgency;
  readonly expectedBenefit: number;
  readonly expectedCost: number;
  readonly evidenceDigest: string;
  readonly parentRequestId?: string;
  readonly status: RenegotiationRequestStatus;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly policyAuthority: false;
  readonly submittedAt: string;
}

export interface RenegotiationDecision {
  readonly decisionId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly contractId: string;
  readonly status: "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED";
  readonly policyUsed: NegotiationPolicyType;
  readonly previousAllocationVersion: number;
  readonly newAllocationVersion: number;
  readonly grantedDelta: Partial<ResourceAllocation>;
  readonly reason: string;
  readonly conflictType?: NegotiationConflictType;
  readonly allocationDigest: string;
  readonly decidedAt: string;
}

/**
 * Computes a deterministic SHA-256 digest of a renegotiation request.
 */
export function computeRequestDigest(request: RenegotiationRequest): string {
  const canonical = canonicalJsonStringify({
    requestId: request.requestId,
    agentId: request.agentId,
    goalId: request.goalId,
    contractId: request.contractId,
    currentAllocationVersion: request.currentAllocationVersion,
    requestedDelta: request.requestedDelta,
    reason: request.reason,
    urgency: request.urgency,
    expectedBenefit: request.expectedBenefit,
    expectedCost: request.expectedCost,
    evidenceDigest: request.evidenceDigest,
    parentRequestId: request.parentRequestId ?? null,
  });
  return sha256Hex(canonical);
}

/**
 * Computes a deterministic SHA-256 digest of a renegotiation decision.
 */
export function computeDecisionDigest(decision: RenegotiationDecision): string {
  const canonical = canonicalJsonStringify({
    decisionId: decision.decisionId,
    requestId: decision.requestId,
    agentId: decision.agentId,
    contractId: decision.contractId,
    status: decision.status,
    policyUsed: decision.policyUsed,
    previousAllocationVersion: decision.previousAllocationVersion,
    newAllocationVersion: decision.newAllocationVersion,
    grantedDelta: decision.grantedDelta,
    conflictType: decision.conflictType ?? null,
    allocationDigest: decision.allocationDigest,
    decidedAt: decision.decidedAt,
  });
  return sha256Hex(canonical);
}
