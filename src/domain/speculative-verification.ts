/**
 * Phase 84 — Speculative Parallel Multi-Hypothesis Clean-Room Execution
 *
 * Domain types and canonical data models for speculative execution,
 * multi-hypothesis coordination, cancellation lifecycle, and deterministic adjudication.
 *
 * CENTRAL ARCHITECTURAL PRINCIPLE:
 * "Parallelism may race toward verification. Only independently verified evidence may win."
 * "terminalSuccessCount(workflowId) <= 1"
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type CandidateState =
  | "QUEUED"
  | "ELIGIBLE"
  | "DISPATCHED"
  | "RUNNING"
  | "DELTA_SCREENING"
  | "FULL_VERIFYING"
  | "VERIFIED_CANDIDATE"
  | "REJECTED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "FAILED"
  | "UNKNOWN";

export type GroupState =
  | "CREATED"
  | "ELIGIBILITY_CHECK"
  | "RUNNING"
  | "CANDIDATE_VERIFIED"
  | "CANCELLING_LOSERS"
  | "ADJUDICATING"
  | "COMMITTED"
  | "FAILED"
  | "ABORTED";

export type CancellationState =
  | "NOT_REQUESTED"
  | "REQUESTED"
  | "ACKNOWLEDGED"
  | "TERMINATING"
  | "TERMINATED"
  | "CANCELLED"
  | "CANCEL_TIMEOUT"
  | "UNKNOWN";

export type SpeculativeParallelismMode =
  | "SEQUENTIAL"
  | "PARALLEL_2"
  | "PARALLEL_4"
  | "ADAPTIVE_PARALLEL";

export type CandidateReviewStatus =
  | "NOT_REQUIRED"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "ESCALATED_HUMAN"
  | "REJECTED";

export type CandidateRiskClass = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface CandidateHypothesis {
  readonly candidateId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly sourceRevision: string;
  readonly baselineCommit: string;
  readonly proposalDigest: string;
  readonly candidatePatchDigest: string;
  readonly contractHash: string;
  readonly proposerIdentity: string;
  readonly reviewStatus: CandidateReviewStatus;
  readonly riskClass: CandidateRiskClass;
  readonly deltaVerificationStatus: "NOT_RUN" | "SCREENING_PASS" | "SCREENING_FAIL";
  readonly candidateState: CandidateState;
  readonly candidateIdentityDigest: string;
}

export interface SpeculativeVerificationGroup {
  readonly groupId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly sourceRevision: string;
  readonly baselineCommit: string;
  readonly candidateIds: readonly string[];
  readonly maxParallelism: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly winnerCandidateId?: string;
  readonly adjudicationDigest?: string;
  readonly groupState: GroupState;
  readonly groupDigest: string;
}

export interface CandidateResourceUsage {
  readonly candidateId: string;
  readonly cpuTimeMs: number;
  readonly wallTimeMs: number;
  readonly peakMemoryMb: number;
  readonly containerCount: number;
  readonly outputBytes: number;
  readonly testExecutionCount: number;
  readonly deltaScreeningDurationMs: number;
  readonly cleanRoomDurationMs: number;
  readonly cancellationDurationMs: number;
}

export interface GroupResourceUsage {
  readonly groupId: string;
  readonly mode: SpeculativeParallelismMode;
  readonly totalCandidateCostMs: number;
  readonly usefulVerificationCostMs: number;
  readonly speculativeCostMs: number;
  readonly wastedPostWinnerCostMs: number;
  readonly cancellationSavingsMs: number;
  readonly speculativeOverheadRatio: number;
  readonly parallelSpeedup: number;
  readonly efficiencyRatio: number;
  readonly peakMemoryMb: number;
  readonly wallClockMs: number;
}

export interface AdjudicationRecord {
  readonly adjudicationId: string;
  readonly groupId: string;
  readonly workflowId: string;
  readonly verifiedCandidateIds: readonly string[];
  readonly winnerCandidateId: string;
  readonly tieBreakReason: string;
  readonly adjudicationDigest: string;
  readonly timestamp: string;
}

export function computeCandidateIdentity(candidate: {
  readonly workflowId: string;
  readonly sourceRevision: string;
  readonly baselineCommit: string;
  readonly proposalDigest: string;
  readonly candidatePatchDigest: string;
  readonly contractHash: string;
}): string {
  const normalized = {
    workflowId: candidate.workflowId,
    sourceRevision: candidate.sourceRevision,
    baselineCommit: candidate.baselineCommit,
    proposalDigest: candidate.proposalDigest,
    candidatePatchDigest: candidate.candidatePatchDigest,
    contractHash: candidate.contractHash,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeGroupDigest(group: {
  readonly groupId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly sourceRevision: string;
  readonly baselineCommit: string;
  readonly candidateIds: readonly string[];
  readonly maxParallelism: number;
  readonly startedAt: string;
  readonly groupState: GroupState;
}): string {
  const normalized = {
    groupId: group.groupId,
    workflowId: group.workflowId,
    taskId: group.taskId,
    sourceRevision: group.sourceRevision,
    baselineCommit: group.baselineCommit,
    candidateIds: [...group.candidateIds].sort(),
    maxParallelism: group.maxParallelism,
    startedAt: group.startedAt,
    groupState: group.groupState,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeAdjudicationDigest(record: {
  readonly adjudicationId: string;
  readonly groupId: string;
  readonly workflowId: string;
  readonly verifiedCandidateIds: readonly string[];
  readonly winnerCandidateId: string;
  readonly tieBreakReason: string;
  readonly timestamp: string;
}): string {
  const normalized = {
    adjudicationId: record.adjudicationId,
    groupId: record.groupId,
    workflowId: record.workflowId,
    verifiedCandidateIds: [...record.verifiedCandidateIds].sort(),
    winnerCandidateId: record.winnerCandidateId,
    tieBreakReason: record.tieBreakReason,
    timestamp: record.timestamp,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}
