/**
 * Phase 98: Governed Autonomous Multi-Agent Fault Injection and Dynamic Byzantine Agreement
 *
 * Domain Model for communication messages, delivery states, agreement proposals,
 * quorum policies, quorum decisions, equivocation evidence, and partition topologies.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Agreement may be reconstructed. Authority may never be fabricated.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Governed delivery states for local simulated message channels.
 */
export type MessageDeliveryState =
  | "CREATED"
  | "QUEUED"
  | "DELIVERED"
  | "DELAYED"
  | "DROPPED"
  | "DUPLICATED"
  | "REJECTED"
  | "QUARANTINED";

/**
 * Governed local message passed between logical agents and workers.
 * Messages represent untrusted observations and cannot grant sovereign authority.
 */
export interface GovernedMessage {
  readonly messageId: string;
  readonly senderId: string;
  readonly receiverId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly creationSequence: number;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly deliveryState: MessageDeliveryState;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
  readonly isByzantine?: boolean;
  readonly isEquivocating?: boolean;
  readonly isStale?: boolean;
  readonly sentAt: string;
  readonly deliveredAt?: string;
  readonly hash: string;
}

/**
 * Governed agreement lifecycle status.
 */
export type AgreementStatus =
  | "PROPOSED"
  | "COLLECTING"
  | "QUORUM_REACHED"
  | "VERIFYING"
  | "AGREED"
  | "REJECTED"
  | "CONFLICTED"
  | "PARTITIONED"
  | "STALE"
  | "QUARANTINED"
  | "EXPIRED";

/**
 * 5 distinct quorum evaluation policies evaluated in Phase 98.
 */
export type QuorumPolicy =
  | "FIRST_OBSERVATION"       // Policy A: Control baseline only
  | "MAJORITY_OBSERVATION"    // Policy B: Simple majority of eligible votes
  | "PROVENANCE_WEIGHTED"     // Policy C: Weighted by evidence quality and provenance
  | "QUORUM_WITH_VERIFICATION"// Policy D: Quorum plus sovereign verification proof
  | "GOVERNED_ADAPTIVE";      // Policy E: Risk/partition-aware adaptive policy selection

/**
 * Governed agreement proposal submitted by an agent.
 */
export interface AgreementProposal {
  readonly proposalId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly proposerId: string;
  readonly subject: string;
  readonly candidateValue: Record<string, unknown>;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly quorumPolicy: QuorumPolicy;
  readonly membershipVersion: number;
  readonly createdAt: string;
  readonly createdSequence: number;
  readonly hash: string;
}

/**
 * Governed Agreement Entity.
 * Represents a consensus conclusion reached across participants.
 * Invariant B9: Agreement is not verification.
 * Invariant B10: Agreement is not terminal success.
 */
export interface GovernedAgreement {
  readonly agreementId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly proposalId: string;
  readonly subject: string;
  readonly candidateValue: Record<string, unknown>;
  readonly status: AgreementStatus;
  readonly quorumPolicy: QuorumPolicy;
  readonly membershipVersion: number;
  readonly participantSet: readonly string[];
  readonly agreeingParticipants: readonly string[];
  readonly dissentingParticipants: readonly string[];
  readonly evidenceSet: readonly string[];
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
  readonly confidence: number;
  readonly quorumReached: boolean;
  readonly verified: boolean;
  readonly splitBrainDetected: boolean;
  readonly equivocationDetected: boolean;
  readonly partitionBlocked: boolean;
  readonly createdSequence: number;
  readonly agreedAt?: string;
  readonly hash: string;
}

/**
 * Evidence generated when an agent is detected making contradictory claims.
 * Invariant B16: Equivocation is detectable.
 */
export interface EquivocationEvidence {
  readonly evidenceId: string;
  readonly agentId: string;
  readonly subject: string;
  readonly conflictingMessageIds: readonly [string, string];
  readonly conflictingMessageHashes: readonly [string, string];
  readonly observedContradiction: string;
  readonly sequence: number;
  readonly provenanceRoot: string;
  readonly detectedAt: string;
  readonly hash: string;
}

/**
 * Partition topology classes P1–P10.
 */
export type PartitionTopologyType =
  | "P1"  // A/B separated from C/D
  | "P2"  // Single-agent isolation
  | "P3"  // Two independent partitions
  | "P4"  // Temporary partition followed by recovery
  | "P5"  // Repeated partition/rejoin
  | "P6"  // Partition during active mutation
  | "P7"  // Partition during verification
  | "P8"  // Partition during pre-emption
  | "P9"  // Partition during deadlock resolution
  | "P10"; // Partition during speculative promotion

/**
 * Snapshot of a simulated network partition.
 */
export interface PartitionSnapshot {
  readonly partitionId: string;
  readonly topologyType: PartitionTopologyType;
  readonly groups: readonly (readonly string[])[];
  readonly isolatedAgents: readonly string[];
  readonly isRecovered: boolean;
  readonly epoch: number;
  readonly membershipVersion: number;
  readonly createdAt: string;
  readonly recoveredAt?: string;
  readonly hash: string;
}

/**
 * Governed Quorum Decision evaluated by the coordinator.
 */
export interface QuorumDecision {
  readonly decisionId: string;
  readonly agreementId: string;
  readonly quorumPolicy: QuorumPolicy;
  readonly requiredVotes: number;
  readonly totalEligible: number;
  readonly votesCast: number;
  readonly affirmativeVotes: number;
  readonly negativeVotes: number;
  readonly quorumReached: boolean;
  readonly partitionRestricted: boolean;
  readonly staleVotesRejected: number;
  readonly byzantineVotesExcluded: number;
  readonly decision: "ACCEPT" | "REJECT" | "SPLIT_BRAIN_BLOCKED" | "PARTITION_BLOCKED" | "QUARANTINE";
  readonly timestamp: string;
  readonly hash: string;
}

/**
 * Computes deterministic hash for a GovernedMessage.
 */
export function computeGovernedMessageHash(msg: Omit<GovernedMessage, "hash">): string {
  const content = {
    messageId: msg.messageId,
    senderId: msg.senderId,
    receiverId: msg.receiverId,
    runId: msg.runId,
    taskId: msg.taskId,
    sequence: msg.sequence,
    creationSequence: msg.creationSequence,
    payloadHash: msg.payloadHash,
    missionContractId: msg.missionContractId,
    missionContractHash: msg.missionContractHash,
    provenanceRoot: msg.provenanceRoot,
    deliveryState: msg.deliveryState,
    authoritative: msg.authoritative,
    terminalAuthority: msg.terminalAuthority,
    verificationAuthority: msg.verificationAuthority,
    policyAuthority: msg.policyAuthority,
    sentAt: msg.sentAt,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for an AgreementProposal.
 */
export function computeAgreementProposalHash(proposal: Omit<AgreementProposal, "hash">): string {
  const content = {
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    taskId: proposal.taskId,
    proposerId: proposal.proposerId,
    subject: proposal.subject,
    candidateValue: proposal.candidateValue,
    missionContractId: proposal.missionContractId,
    missionContractHash: proposal.missionContractHash,
    provenanceRoot: proposal.provenanceRoot,
    quorumPolicy: proposal.quorumPolicy,
    membershipVersion: proposal.membershipVersion,
    createdAt: proposal.createdAt,
    createdSequence: proposal.createdSequence,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for a GovernedAgreement.
 */
export function computeGovernedAgreementHash(agreement: Omit<GovernedAgreement, "hash">): string {
  const content = {
    agreementId: agreement.agreementId,
    runId: agreement.runId,
    taskId: agreement.taskId,
    proposalId: agreement.proposalId,
    subject: agreement.subject,
    candidateValue: agreement.candidateValue,
    status: agreement.status,
    quorumPolicy: agreement.quorumPolicy,
    membershipVersion: agreement.membershipVersion,
    participantSet: agreement.participantSet,
    agreeingParticipants: agreement.agreeingParticipants,
    dissentingParticipants: agreement.dissentingParticipants,
    evidenceSet: agreement.evidenceSet,
    missionContractId: agreement.missionContractId,
    missionContractHash: agreement.missionContractHash,
    provenanceRoot: agreement.provenanceRoot,
    authoritative: agreement.authoritative,
    terminalAuthority: agreement.terminalAuthority,
    verificationAuthority: agreement.verificationAuthority,
    policyAuthority: agreement.policyAuthority,
    confidence: agreement.confidence,
    quorumReached: agreement.quorumReached,
    verified: agreement.verified,
    splitBrainDetected: agreement.splitBrainDetected,
    equivocationDetected: agreement.equivocationDetected,
    partitionBlocked: agreement.partitionBlocked,
    createdSequence: agreement.createdSequence,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for EquivocationEvidence.
 */
export function computeEquivocationEvidenceHash(evidence: Omit<EquivocationEvidence, "hash">): string {
  const content = {
    evidenceId: evidence.evidenceId,
    agentId: evidence.agentId,
    subject: evidence.subject,
    conflictingMessageIds: evidence.conflictingMessageIds,
    conflictingMessageHashes: evidence.conflictingMessageHashes,
    observedContradiction: evidence.observedContradiction,
    sequence: evidence.sequence,
    provenanceRoot: evidence.provenanceRoot,
    detectedAt: evidence.detectedAt,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for a PartitionSnapshot.
 */
export function computePartitionSnapshotHash(partition: Omit<PartitionSnapshot, "hash">): string {
  const content = {
    partitionId: partition.partitionId,
    topologyType: partition.topologyType,
    groups: partition.groups,
    isolatedAgents: partition.isolatedAgents,
    isRecovered: partition.isRecovered,
    epoch: partition.epoch,
    membershipVersion: partition.membershipVersion,
    createdAt: partition.createdAt,
    recoveredAt: partition.recoveredAt ?? null,
  };
  return sha256Hex(canonicalJsonStringify(content));
}

/**
 * Computes deterministic hash for a QuorumDecision.
 */
export function computeQuorumDecisionHash(decision: Omit<QuorumDecision, "hash">): string {
  const content = {
    decisionId: decision.decisionId,
    agreementId: decision.agreementId,
    quorumPolicy: decision.quorumPolicy,
    requiredVotes: decision.requiredVotes,
    totalEligible: decision.totalEligible,
    votesCast: decision.votesCast,
    affirmativeVotes: decision.affirmativeVotes,
    negativeVotes: decision.negativeVotes,
    quorumReached: decision.quorumReached,
    partitionRestricted: decision.partitionRestricted,
    staleVotesRejected: decision.staleVotesRejected,
    byzantineVotesExcluded: decision.byzantineVotesExcluded,
    decision: decision.decision,
    timestamp: decision.timestamp,
  };
  return sha256Hex(canonicalJsonStringify(content));
}
