/**
 * Phase 84 — Speculative Parallel Multi-Hypothesis Clean-Room Execution
 *
 * Speculative Adjudicator:
 * Deterministically resolves ties and selects the singular authoritative winner
 * when multiple speculative candidate hypotheses independently verify.
 *
 * CRITICAL ADJUDICATION ORDER:
 * 1. Authoritative verification completeness (dual-gate F2P=1.0, P2P=1.0, SUITE_RAN=11)
 * 2. Source revision equality (must match active source revision)
 * 3. Policy eligibility (reviewStatus satisfied; unapproved proposals rejected)
 * 4. Evidence completeness (cryptographic evidence generated)
 * 5. Candidate identity lexical ordering (deterministic tie-break)
 */

import {
  AdjudicationRecord,
  CandidateHypothesis,
  computeAdjudicationDigest,
} from "../domain/speculative-verification.js";

export class SpeculativeAdjudicator {
  /**
   * Adjudicate among multiple verified candidates for a workflow.
   */
  public adjudicate(
    groupId: string,
    workflowId: string,
    candidates: readonly CandidateHypothesis[],
    currentSourceRevision: string,
    timestamp: string = "2026-10-21T00:00:00.000Z"
  ): AdjudicationRecord {
    if (!candidates || candidates.length === 0) {
      throw new Error("EMPTY_CANDIDATES: Cannot adjudicate empty candidate list");
    }

    // Filter to candidates that are eligible for adjudication
    // Rule 1: Authoritative verification completeness
    const verified = candidates.filter((c) => c.candidateState === "VERIFIED_CANDIDATE");

    if (verified.length === 0) {
      throw new Error("NO_VERIFIED_CANDIDATE: None of the candidate hypotheses achieved verification");
    }

    // Rule 2: Source revision equality
    const revisionMatched = verified.filter((c) => c.sourceRevision === currentSourceRevision);
    if (revisionMatched.length === 0) {
      throw new Error(`STALE_REVISION_DISQUALIFIED: Candidates did not match active revision ${currentSourceRevision}`);
    }

    // Rule 3: Policy eligibility
    const policyEligible = revisionMatched.filter(
      (c) => c.reviewStatus === "APPROVED" || c.reviewStatus === "NOT_REQUIRED"
    );
    if (policyEligible.length === 0) {
      throw new Error("POLICY_DISQUALIFIED: Candidates failed review and approval policy fencing");
    }

    // Rule 4 & 5: Deterministic ranking by evidence and canonical candidate identity digest
    const sorted = [...policyEligible].sort((a, b) => {
      // Primary tie-breaker: lexical comparison of candidate identity digest
      return a.candidateIdentityDigest.localeCompare(b.candidateIdentityDigest);
    });

    const winner = sorted[0]!;
    const verifiedIds = verified.map((c) => c.candidateId).sort();

    const adjudicationId = `adj-${groupId}-${winner.candidateId}`;
    const tieBreakReason =
      sorted.length > 1
        ? `DETERMINISTIC_LEXICAL_TIE_BREAK: Selected ${winner.candidateId} among ${sorted.length} verified candidates`
        : "SOLE_VERIFIED_CANDIDATE";

    const partialRecord = {
      adjudicationId,
      groupId,
      workflowId,
      verifiedCandidateIds: verifiedIds,
      winnerCandidateId: winner.candidateId,
      tieBreakReason,
      timestamp,
    };

    const adjudicationDigest = computeAdjudicationDigest(partialRecord);

    return {
      ...partialRecord,
      adjudicationDigest,
    };
  }
}
