/**
 * Phase 81 — Governed Repair Workflow and Production Readiness Evaluation
 *
 * Domain types and schema for the application-level governed repair workflow.
 * Manages proposal queueing, workflow lifecycle transitions, approval models,
 * risk escalation, retry boundaries, and deterministic audit trail.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

// ============================================================================
// 1. Workflow States & Transitions
// ============================================================================

export type WorkflowState =
  | "DRAFT"
  | "PROPOSED"
  | "UNDER_REVIEW"
  | "REVISION_REQUIRED"
  | "READY_FOR_EXECUTION"
  | "EXECUTING"
  | "VERIFYING"
  | "VERIFIED"
  | "REJECTED"
  | "ABORTED"
  | "EXPIRED"
  | "TERMINAL";

export type WorkflowMode =
  | "MODE_A_HUMAN_ONLY"
  | "MODE_B_HUMAN_MODEL"
  | "MODE_C_HUMAN_MULTI_AGENT"
  | "MODE_D_AUTONOMOUS_ADVISORY";

export type ApprovalState =
  | "PENDING"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "REQUEST_REVISION"
  | "EXPIRED";

export type RiskLevel =
  | "LOW_RISK"
  | "MEDIUM_RISK"
  | "HIGH_RISK"
  | "CRITICAL_SECURITY";

export type ActorType =
  | "HUMAN"
  | "LOCAL_MODEL"
  | "REVIEWER"
  | "PANEL"
  | "GOVERNING_AUTHORITY";

export interface WorkflowActor {
  readonly actorType: ActorType;
  readonly actorId: string;
}

export type WorkflowFailureClass =
  | "PROPOSAL_INVALID"
  | "POLICY_DENIED"
  | "SOURCE_REVISION_MISMATCH"
  | "EXECUTION_FAILURE"
  | "TEST_FAILURE"
  | "REGRESSION_FAILURE"
  | "CLEAN_ROOM_FAILURE"
  | "EVIDENCE_FAILURE"
  | "AUTHORITY_FAILURE"
  | "TIMEOUT"
  | "CANCELLED"
  | "WORKFLOW_EXPIRED"
  | "DUPLICATE_PROPOSAL"
  | "UNKNOWN";

export interface WorkflowTransition {
  readonly workflowId: string;
  readonly sequenceNumber: number;
  readonly previousState: WorkflowState;
  readonly fromState?: WorkflowState;
  readonly newState: WorkflowState;
  readonly toState?: WorkflowState;
  readonly actor: WorkflowActor;
  readonly reason: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly timestamp: string;
}

// ============================================================================
// 2. Proposal Queue & Workflow Record
// ============================================================================

export interface WorkflowMetrics {
  readonly proposalLatencyMs: number;
  readonly reviewLatencyMs: number;
  readonly executionLatencyMs: number;
  readonly verificationLatencyMs: number;
  readonly humanWallClockMs: number;
  readonly modelCalls: number;
  readonly cpuTimeMs: number;
  readonly memoryPeakBytes: number;
  readonly queueDepth: number;
  readonly retryCount: number;
  readonly revisionCount: number;
}

export interface GovernedRepairWorkflow {
  readonly workflowId: string;
  readonly taskId: string;
  readonly mode: WorkflowMode;
  readonly sourceRevision: string;
  readonly protocolDigest: string;
  readonly currentProposalId: string;
  readonly currentProposalDigest: string;
  readonly proposerIdentity: WorkflowActor;
  readonly state: WorkflowState;
  readonly currentState?: WorkflowState;
  readonly approvalState: ApprovalState;
  readonly riskLevel: RiskLevel;
  readonly transitions: readonly WorkflowTransition[];
  readonly retryCount: number;
  readonly revisionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalEvidenceId?: string;
  readonly failureClass?: WorkflowFailureClass;
}

export interface WorkflowQueueLimits {
  readonly maxPendingProposals: number;
  readonly workflowTimeoutMs: number;
  readonly maxWorkflowRetries: number;
  readonly maxWorkflowRevisions: number;
  readonly MAX_PENDING_PROPOSALS: number;
  readonly MAX_REVISIONS: number;
  readonly MAX_RETRIES: number;
  readonly PROPOSAL_TIMEOUT_MS: number;
  readonly REVIEW_TIMEOUT_MS: number;
  readonly EXECUTION_TIMEOUT_MS: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowQueueLimits = {
  maxPendingProposals: 8,
  workflowTimeoutMs: 300000, // 5 minutes
  maxWorkflowRetries: 3,
  maxWorkflowRevisions: 3,
  MAX_PENDING_PROPOSALS: 8,
  MAX_REVISIONS: 3,
  MAX_RETRIES: 3,
  PROPOSAL_TIMEOUT_MS: 300000,
  REVIEW_TIMEOUT_MS: 300000,
  EXECUTION_TIMEOUT_MS: 600000,
};

// ============================================================================
// 3. Digest Computation
// ============================================================================

export function computeWorkflowDigest(
  workflow: Omit<GovernedRepairWorkflow, "transitions" | "updatedAt">
): string {
  const normalized = {
    workflowId: workflow.workflowId,
    taskId: workflow.taskId,
    mode: workflow.mode,
    sourceRevision: workflow.sourceRevision,
    protocolDigest: workflow.protocolDigest,
    currentProposalId: workflow.currentProposalId,
    currentProposalDigest: workflow.currentProposalDigest,
    proposerIdentity: workflow.proposerIdentity,
    state: workflow.state,
    approvalState: workflow.approvalState,
    riskLevel: workflow.riskLevel,
    retryCount: workflow.retryCount,
    revisionCount: workflow.revisionCount,
    createdAt: workflow.createdAt,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeTransitionDigest(
  transition: Omit<WorkflowTransition, "outputDigest">
): string {
  const normalized = {
    workflowId: transition.workflowId,
    sequenceNumber: transition.sequenceNumber,
    previousState: transition.previousState,
    newState: transition.newState,
    actor: transition.actor,
    reason: transition.reason,
    inputDigest: transition.inputDigest,
    timestamp: transition.timestamp,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}
