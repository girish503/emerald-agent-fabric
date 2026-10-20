/**
 * Phase 80 — Governed Multi-Agent Interactive Code Review and Repair Verification Protocol
 *
 * Domain types and schema for immutable, untrusted multi-agent review records,
 * findings, severity taxonomy, bounded discussion, and deterministic aggregation.
 * All reviewer agents are strictly UNTRUSTED_ADVISORS.
 * Sovereign authority remains exclusively with Emerald runtime, policy, clean-room, and fourfold signing.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

// ============================================================================
// 1. Roles & Classifications
// ============================================================================

export type AgentRole =
  | "ROLE_TRANSFORMATION_PROPOSER"
  | "ROLE_INDEPENDENT_REVIEWER"
  | "ROLE_SEMANTIC_CRITIC"
  | "ROLE_VERIFICATION_ADVISOR"
  | "HUMAN_OPERATOR"
  | "GOVERNING_AUTHORITY";

export type ReviewerRole =
  | "ROLE_INDEPENDENT_REVIEWER"
  | "ROLE_SEMANTIC_CRITIC"
  | "ROLE_VERIFICATION_ADVISOR";

export type ReviewRecommendation =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_REVISION"
  | "UNCERTAIN";

export type ReviewSeverity =
  | "INFO"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type FindingTaxonomy =
  | "SYNTAX_RISK"
  | "TYPE_RISK"
  | "API_CONTRACT_RISK"
  | "STATE_INVARIANT_RISK"
  | "REGRESSION_RISK"
  | "CROSS_MODULE_RISK"
  | "TEST_COVERAGE_RISK"
  | "SECURITY_RISK"
  | "SCOPE_RISK"
  | "BEHAVIORAL_RISK"
  | "UNKNOWN";

export type DisagreementClassification =
  | "BENIGN_DISAGREEMENT"
  | "SEMANTIC_DISAGREEMENT"
  | "REGRESSION_DISAGREEMENT"
  | "SCOPE_DISAGREEMENT"
  | "SECURITY_DISAGREEMENT"
  | "UNKNOWN_DISAGREEMENT";

// ============================================================================
// 2. Review Record & Findings
// ============================================================================

export interface ReviewFinding {
  readonly findingId: string;
  readonly findingType: FindingTaxonomy;
  readonly severity: ReviewSeverity;
  readonly targetPath: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly description: string;
  readonly evidence: string;
}

export interface ReviewRecord {
  readonly reviewId: string;
  readonly proposalId: string;
  readonly reviewerRole: ReviewerRole;
  readonly reviewerModel: string;
  readonly reviewTargetDigest: string;
  readonly findings: readonly ReviewFinding[];
  readonly severity: ReviewSeverity;
  readonly recommendation: ReviewRecommendation;
  readonly confidence: number;
  readonly rationale: string;
  readonly reviewDigest: string;
  readonly timestamp: string;
}

export interface DiscussionMessage {
  readonly messageId: string;
  readonly round: number;
  readonly senderRole: AgentRole;
  readonly recipientRole: AgentRole;
  readonly proposalDigest: string;
  readonly messageDigest: string;
  readonly payload: string;
  readonly timestamp: string;
}

export interface PanelAggregation {
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly reviews: readonly ReviewRecord[];
  readonly recommendations: Record<ReviewerRole, ReviewRecommendation>;
  readonly unanimous: boolean;
  readonly aggregateRecommendation: ReviewRecommendation;
  readonly disagreement?: DisagreementClassification;
  readonly discussionMessages: readonly DiscussionMessage[];
  readonly aggregationDigest: string;
}

export interface ReviewValidationLimits {
  readonly maxReviewRounds: number;
  readonly maxReviewMessages: number;
  readonly maxRevisions: number;
  readonly maxFindingsPerReview: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewValidationLimits = {
  maxReviewRounds: 2,
  maxReviewMessages: 6,
  maxRevisions: 3,
  maxFindingsPerReview: 32,
};

// ============================================================================
// 3. Digest Computation Helpers
// ============================================================================

export function computeReviewDigest(
  review: Omit<ReviewRecord, "reviewDigest">
): string {
  const normalized = {
    reviewId: review.reviewId,
    proposalId: review.proposalId,
    reviewerRole: review.reviewerRole,
    reviewerModel: review.reviewerModel,
    reviewTargetDigest: review.reviewTargetDigest,
    findings: review.findings.map((f) => ({
      findingId: f.findingId,
      findingType: f.findingType,
      severity: f.severity,
      targetPath: f.targetPath,
      lineStart: f.lineStart ?? 0,
      lineEnd: f.lineEnd ?? 0,
      description: f.description,
      evidence: f.evidence,
    })),
    severity: review.severity,
    recommendation: review.recommendation,
    confidence: review.confidence,
    rationale: review.rationale,
    timestamp: review.timestamp,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeDiscussionMessageDigest(
  message: Omit<DiscussionMessage, "messageDigest">
): string {
  const normalized = {
    messageId: message.messageId,
    round: message.round,
    senderRole: message.senderRole,
    recipientRole: message.recipientRole,
    proposalDigest: message.proposalDigest,
    payload: message.payload,
    timestamp: message.timestamp,
  };
  return sha256Hex(canonicalJsonStringify(normalized));
}
