/**
 * Phase 91: Agent Resource Contract Domain Model
 *
 * Encapsulates the execution resource contract for an individual agent,
 * binding mutable resource allocations to an immutable authority envelope.
 *
 * CRITICAL INVARIANTS:
 * 1. Resources may be renegotiated within a fixed safety envelope.
 * 2. Authority may NEVER be renegotiated upward.
 * 3. Allocation changes do NOT mutate the Mission Contract or its hash.
 * 4. Contract lifecycle state transitions are monotonic and strictly enforced.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import {
  ImmutableAuthorityEnvelope,
  ResourceAllocation,
  computeAllocationDigest,
  computeAuthorityEnvelopeDigest,
  validateResourceAllocation,
} from "./resource-allocation.js";

export type AgentResourceContractStatus =
  | "PROPOSED"
  | "VALIDATING"
  | "ACTIVE"
  | "RENEGOTIATION_REQUESTED"
  | "RENEGOTIATING"
  | "RENEGOTIATED"
  | "SUSPENDED"
  | "COMPLETED"
  | "REJECTED"
  | "REVOKED"
  | "EXPIRED"
  | "QUARANTINED";

export interface AgentResourceContract {
  readonly contractId: string;
  readonly missionContractId: string;
  readonly missionContractVersion: number;
  readonly missionContractHash: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly parentGoalId?: string;
  readonly immutableAuthorityEnvelope: ImmutableAuthorityEnvelope;
  readonly resourceAllocation: ResourceAllocation;
  readonly allocationVersion: number;
  readonly allocationDigest: string;
  readonly remainingBudget: ResourceAllocation;
  readonly provenanceRoot: string;
  readonly status: AgentResourceContractStatus;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const VALID_CONTRACT_TRANSITIONS: ReadonlyMap<
  AgentResourceContractStatus,
  readonly AgentResourceContractStatus[]
> = new Map([
  ["PROPOSED", ["VALIDATING", "REJECTED", "QUARANTINED"]],
  ["VALIDATING", ["ACTIVE", "REJECTED", "QUARANTINED"]],
  [
    "ACTIVE",
    [
      "RENEGOTIATION_REQUESTED",
      "SUSPENDED",
      "COMPLETED",
      "REVOKED",
      "EXPIRED",
      "QUARANTINED",
    ],
  ],
  [
    "RENEGOTIATION_REQUESTED",
    ["RENEGOTIATING", "ACTIVE", "REJECTED", "EXPIRED", "QUARANTINED"],
  ],
  [
    "RENEGOTIATING",
    ["RENEGOTIATED", "ACTIVE", "REJECTED", "EXPIRED", "QUARANTINED"],
  ],
  [
    "RENEGOTIATED",
    [
      "ACTIVE",
      "RENEGOTIATION_REQUESTED",
      "SUSPENDED",
      "COMPLETED",
      "REVOKED",
      "EXPIRED",
      "QUARANTINED",
    ],
  ],
  ["SUSPENDED", ["ACTIVE", "REVOKED", "EXPIRED", "QUARANTINED"]],
  ["COMPLETED", []],
  ["REJECTED", []],
  ["REVOKED", []],
  ["EXPIRED", []],
  ["QUARANTINED", []],
]);

/**
 * Validates state transition according to the contract lifecycle state machine.
 */
export function canTransitionContract(
  current: AgentResourceContractStatus,
  target: AgentResourceContractStatus
): boolean {
  const allowed = VALID_CONTRACT_TRANSITIONS.get(current);
  return allowed ? allowed.includes(target) : false;
}

/**
 * Computes a deterministic SHA-256 digest of an agent resource contract.
 */
export function computeContractDigest(contract: AgentResourceContract): string {
  const canonical = canonicalJsonStringify({
    contractId: contract.contractId,
    missionContractId: contract.missionContractId,
    missionContractVersion: contract.missionContractVersion,
    missionContractHash: contract.missionContractHash,
    agentId: contract.agentId,
    goalId: contract.goalId,
    parentGoalId: contract.parentGoalId ?? null,
    envelopeDigest: computeAuthorityEnvelopeDigest(
      contract.immutableAuthorityEnvelope
    ),
    allocationDigest: contract.allocationDigest,
    allocationVersion: contract.allocationVersion,
    status: contract.status,
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
  });
  return sha256Hex(canonical);
}

/**
 * Factory for creating a new agent resource contract.
 */
export function createAgentResourceContract(params: {
  readonly contractId: string;
  readonly missionContractId: string;
  readonly missionContractVersion: number;
  readonly missionContractHash: string;
  readonly agentId: string;
  readonly goalId: string;
  readonly parentGoalId?: string;
  readonly immutableAuthorityEnvelope: ImmutableAuthorityEnvelope;
  readonly resourceAllocation: ResourceAllocation;
  readonly provenanceRoot?: string;
  readonly createdAt?: string;
}): AgentResourceContract {
  const allocValidation = validateResourceAllocation(params.resourceAllocation);
  if (!allocValidation.valid) {
    throw new Error(
      `Invalid resource allocation for contract ${params.contractId}: ${allocValidation.errors.join(
        "; "
      )}`
    );
  }

  const allocationVersion = 1;
  const allocationDigest = computeAllocationDigest(
    params.resourceAllocation,
    allocationVersion
  );
  const now = params.createdAt ?? new Date().toISOString();
  const provenanceRoot = params.provenanceRoot ?? allocationDigest;

  return {
    contractId: params.contractId,
    missionContractId: params.missionContractId,
    missionContractVersion: params.missionContractVersion,
    missionContractHash: params.missionContractHash,
    agentId: params.agentId,
    goalId: params.goalId,
    parentGoalId: params.parentGoalId,
    immutableAuthorityEnvelope: params.immutableAuthorityEnvelope,
    resourceAllocation: params.resourceAllocation,
    allocationVersion,
    allocationDigest,
    remainingBudget: { ...params.resourceAllocation },
    provenanceRoot,
    status: "PROPOSED",
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
    createdAt: now,
    updatedAt: now,
  };
}
