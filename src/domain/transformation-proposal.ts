/**
 * Phase 79 — Governed Human-in-the-Loop Transformation Discovery
 *
 * Domain types and schema for immutable, untrusted transformation proposals.
 * Proposers (human, local model, collaborative) are strictly untrusted sources of candidate edits.
 * Emerald execution, clean-room verification, fourfold gate, and evidence authority remain sovereign.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

// ============================================================================
// 1. Proposer Types & Limits
// ============================================================================

export type ProposerType =
  | "HUMAN"
  | "LOCAL_MODEL"
  | "HUMAN_MODEL_COLLABORATION"
  | "AUTONOMOUS_AGENT";

export type EditAction = "REPLACE" | "INSERT" | "DELETE";

export interface CandidateEdit {
  readonly path: string;
  readonly action: EditAction;
  readonly oldText?: string;
  readonly newText: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ProposalValidationLimits {
  readonly maxProposalBytes: number;
  readonly maxTargetFiles: number;
  readonly maxEdits: number;
  readonly maxProposalRevisions: number;
}

export const DEFAULT_PROPOSAL_VALIDATION_LIMITS: ProposalValidationLimits = {
  maxProposalBytes: 65536,
  maxTargetFiles: 8,
  maxEdits: 64,
  maxProposalRevisions: 3,
};

// ============================================================================
// 2. Transformation Proposal Contract
// ============================================================================

export interface TransformationProposal {
  readonly proposalId: string;
  readonly taskId: string;
  readonly proposerType: ProposerType;
  readonly sourceRevision: string;
  readonly targetFiles: readonly string[];
  readonly candidateEdits: readonly CandidateEdit[];
  readonly transformationIntent: string;
  readonly expectedBehavior: string;
  readonly rationale: string;
  readonly proposalDigest: string;
  readonly submittedAt: string;
  readonly parentProposalId?: string;
  readonly revisionIndex?: number;
  // Metadata fields for proposer identity, audit trail
  readonly proposerIdentity?: {
    readonly id: string;
    readonly name?: string;
    readonly modelTag?: string;
    readonly modelDigest?: string;
  };
}

export interface TransformationProposalValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly validatedDigest?: string;
}

export type ProposalValidationResult = TransformationProposalValidationResult;

export interface ProposalEvidenceAttribution {
  readonly proposerType: ProposerType;
  readonly proposalDigest: string;
  readonly sourceRevision: string;
  readonly candidatePatchDigest: string;
  readonly verificationDigest: string;
  readonly cleanRoomDigest: string;
  readonly evidenceBundleId: string;
  readonly terminalAuthority: boolean;
}

// ============================================================================
// 3. Digest Computation
// ============================================================================

/**
 * Computes deterministic SHA-256 digest of a proposal excluding its proposalDigest field.
 */
export function computeProposalDigest(
  proposal: Omit<TransformationProposal, "proposalDigest">
): string {
  const normalized = {
    proposalId: proposal.proposalId,
    taskId: proposal.taskId,
    proposerType: proposal.proposerType,
    sourceRevision: proposal.sourceRevision,
    targetFiles: [...proposal.targetFiles].sort(),
    candidateEdits: proposal.candidateEdits.map((e) => ({
      path: e.path,
      action: e.action,
      oldText: e.oldText ?? "",
      newText: e.newText,
      startLine: e.startLine ?? 0,
      endLine: e.endLine ?? 0,
    })),
    transformationIntent: proposal.transformationIntent,
    expectedBehavior: proposal.expectedBehavior,
    rationale: proposal.rationale,
    submittedAt: proposal.submittedAt,
    parentProposalId: proposal.parentProposalId ?? null,
    revisionIndex: proposal.revisionIndex ?? 0,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}
