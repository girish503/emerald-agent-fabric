/**
 * Emerald Agent Fabric — Verification Evidence Viewer (Milestone 2.27 / Phase 4)
 *
 * Implements pure functional HTML rendering for:
 * - Authoritative run finalOutcome badge and diagnostic summary
 * - Distinct verification events: verification.completed, verification.rejected, verification.unverified_completion_authorized
 * - Raw independent evidence entries: evidence.recorded (distinguishing INDEPENDENT_OBSERVER vs PROVIDER_REPORTED)
 * - Completion rejection notices with outstanding requirement checklists
 * - Explicit boundary disclaimer: Artifact presence is never proof of verification success
 *
 * Architectural Invariants:
 * 1. Claims != Evidence: Self-reported completions by an agent model are strictly
 *    distinguished from independently verified verdicts.
 * 2. Immutable Truth: Authoritative verdicts originate from durable coordinator state and verifier events.
 * 3. Safe Escaping: All verifier IDs, spec IDs, messages, and payloads are escaped via escapeHtml().
 */

import type { TrialFinalOutcome } from "../types/api.js";
import { escapeHtml } from "./dashboard-view.js";
import { formatOutcomeBadge } from "./workspace-views.js";

export interface VerificationCompletedView {
  readonly verifierId: string;
  readonly specId: string;
  readonly status: "VERIFIED" | "FAILED";
  readonly evidenceIds: readonly string[];
  readonly reasonCode?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly verifiedAt: string;
}

export interface VerificationRejectedView {
  readonly status: "COMPLETION_REJECTED";
  readonly reason: "UNVERIFIED_COMPLETION_CLAIM";
  readonly message: string;
  readonly requirements: Record<string, string>;
  readonly outstandingRequirements: readonly string[];
  readonly rejectedAt: string;
}

export interface UnverifiedCompletionAuthorizedView {
  readonly authorizedAt: string;
  readonly operatorNote?: string;
}

export interface RecordedEvidenceView {
  readonly evidenceId: string;
  readonly runId: string;
  readonly source: "PROVIDER_REPORTED" | "INDEPENDENT_OBSERVER";
  readonly kind: string;
  readonly contentHash: string;
  readonly summary?: Record<string, unknown>;
  readonly observedAt: string;
}

export interface EvidenceViewerState {
  readonly finalOutcome: TrialFinalOutcome | null;
  readonly isTerminal: boolean;
  readonly completedVerifications?: readonly VerificationCompletedView[];
  readonly rejections?: readonly VerificationRejectedView[];
  readonly unverifiedOverrides?: readonly UnverifiedCompletionAuthorizedView[];
  readonly recordedEvidence?: readonly RecordedEvidenceView[];
}

/**
 * Renders the authoritative verification evidence inspector card.
 */
export function renderEvidenceViewer(state: EvidenceViewerState): string {
  const {
    finalOutcome,
    isTerminal,
    completedVerifications = [],
    rejections = [],
    unverifiedOverrides = [],
    recordedEvidence = [],
  } = state;

  const outcomeBadge = formatOutcomeBadge(finalOutcome);

  // 1. Authoritative Verdict Banner
  let verdictStatusHtml = "";
  if (finalOutcome === "VERIFIED_SUCCESS") {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-green" id="verdict-banner-verified">
        <span class="verdict-title">&#10003; Independently Verified Task Completion</span>
        <p class="verdict-description">Objective verification criteria executed against physical workspace evidence passed all tests.</p>
      </div>
    `.trim();
  } else if (finalOutcome === "FALSE_COMPLETION") {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-red" id="verdict-banner-false-completion">
        <span class="verdict-title">&#10007; False Completion Claim Detected</span>
        <p class="verdict-description">Agent asserted task completion, but independent verification specifications rejected the claim or required tests failed.</p>
      </div>
    `.trim();
  } else if (finalOutcome === "COMPLETION_UNVERIFIABLE") {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-yellow" id="verdict-banner-unverifiable">
        <span class="verdict-title">&#9888; Completion Unverifiable</span>
        <p class="verdict-description">Task reached completion without verifiable specifications, or verifier environment was not provisioned.</p>
      </div>
    `.trim();
  } else if (finalOutcome === "BLOCKED") {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-purple" id="verdict-banner-blocked">
        <span class="verdict-title">&#9940; Execution Blocked by Policy</span>
        <p class="verdict-description">Safety or capability policy denied action execution during the run.</p>
      </div>
    `.trim();
  } else if (finalOutcome === "TIMEOUT") {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-yellow" id="verdict-banner-timeout">
        <span class="verdict-title">&#9200; Execution Timed Out</span>
        <p class="verdict-description">Execution exceeded wall-clock or step resource limits before verification succeeded.</p>
      </div>
    `.trim();
  } else if (finalOutcome === "LOOP_DETECTED" || finalOutcome === "EXECUTION_FAILURE") {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-red" id="verdict-banner-failure">
        <span class="verdict-title">&#9888; Execution Failure (${escapeHtml(finalOutcome)})</span>
        <p class="verdict-description">Run failed due to unrecoverable worker or tool errors.</p>
      </div>
    `.trim();
  } else if (!isTerminal) {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-gray" id="verdict-banner-pending">
        <span class="verdict-title">&#8987; Verification Pending</span>
        <p class="verdict-description">Run is currently active. Verification specifications will be evaluated upon task completion.</p>
      </div>
    `.trim();
  } else {
    verdictStatusHtml = `
      <div class="evidence-verdict-banner banner-gray" id="verdict-banner-none">
        <span class="verdict-title">No Authoritative Outcome Recorded</span>
        <p class="verdict-description">Run terminated without an authoritative evaluation outcome.</p>
      </div>
    `.trim();
  }

  // 2. Operator Override Notice (if unverified completion was granted by operator)
  let overrideHtml = "";
  if (unverifiedOverrides.length > 0) {
    overrideHtml = `
      <div class="evidence-override-alert" id="evidence-override-alert">
        <span class="override-badge badge-yellow">Operator Override Active</span>
        <p><strong>Notice:</strong> Unverified completion was authorized by manual operator policy. This is an administrative bypass and does NOT represent objective verification of correctness.</p>
      </div>
    `.trim();
  }

  // 3. Rejection Details (if completion was rejected)
  let rejectionsHtml = "";
  if (rejections.length > 0) {
    const listHtml = rejections
      .map((rej, idx) => {
        const outstandingHtml = rej.outstandingRequirements
          .map((req) => `<li class="outstanding-item font-mono">${escapeHtml(req)}</li>`)
          .join("\n");

        return `
          <div class="rejection-card" id="rejection-card-${idx}">
            <div class="rejection-header">
              <span class="badge badge-red">${escapeHtml(rej.reason)}</span>
              <span class="rejection-time">${escapeHtml(rej.rejectedAt)}</span>
            </div>
            <p class="rejection-message">${escapeHtml(rej.message)}</p>
            <div class="outstanding-requirements-box">
              <strong>Outstanding Requirements:</strong>
              <ul class="outstanding-list">
                ${outstandingHtml}
              </ul>
            </div>
          </div>
        `.trim();
      })
      .join("\n");

    rejectionsHtml = `
      <div class="evidence-section" id="evidence-rejections-section">
        <h5>Completion Rejections (${rejections.length})</h5>
        ${listHtml}
      </div>
    `.trim();
  }

  // 4. Verification Checkpoint Results (verification.completed events)
  let verificationsHtml = "";
  if (completedVerifications.length > 0) {
    const itemsHtml = completedVerifications
      .map((v, idx) => {
        const isVerified = v.status === "VERIFIED";
        const badgeColor = isVerified ? "green" : "red";
        const evidenceList = v.evidenceIds.length > 0
          ? v.evidenceIds.map((id) => `<span class="badge badge-gray font-mono">${escapeHtml(id)}</span>`).join(" ")
          : '<span class="text-muted">None referenced</span>';

        return `
          <li class="verification-item" id="verification-item-${idx}">
            <div class="verification-item-header">
              <span class="spec-id font-mono">Spec: ${escapeHtml(v.specId)}</span>
              <span class="badge badge-${badgeColor}">${escapeHtml(v.status)}</span>
            </div>
            <p class="verification-message">${escapeHtml(v.message)}</p>
            <div class="verification-meta">
              <span class="verifier-id font-mono">Verifier: ${escapeHtml(v.verifierId)}</span>
              ${v.reasonCode ? `<span class="reason-code font-mono">Reason: ${escapeHtml(v.reasonCode)}</span>` : ""}
              <span class="verified-time">${escapeHtml(v.verifiedAt)}</span>
            </div>
            <div class="verification-evidence-refs">
              <span class="evidence-ref-label">Referenced Evidence:</span>
              ${evidenceList}
            </div>
          </li>
        `.trim();
      })
      .join("\n");

    verificationsHtml = `
      <div class="evidence-section" id="evidence-verifications-section">
        <h5>Verifier Evaluations (${completedVerifications.length})</h5>
        <ul class="verifications-list" role="list">
          ${itemsHtml}
        </ul>
      </div>
    `.trim();
  }

  // 5. Recorded Evidence Items (evidence.recorded events)
  let recordedHtml = "";
  if (recordedEvidence.length > 0) {
    const itemsHtml = recordedEvidence
      .map((rec) => {
        const isObserver = rec.source === "INDEPENDENT_OBSERVER";
        const badgeColor = isObserver ? "blue" : "gray";
        const sourceLabel = isObserver ? "Provenance: Independent Observer" : "Provenance: Provider Reported";

        return `
          <li class="recorded-evidence-item" data-evidence-id="${escapeHtml(rec.evidenceId)}">
            <div class="recorded-header">
              <span class="evidence-id font-mono">${escapeHtml(rec.evidenceId)}</span>
              <span class="badge badge-${badgeColor}" title="Data provenance only; does not imply a passing or failing verification verdict">
                ${escapeHtml(sourceLabel)}
              </span>
              <span class="evidence-kind font-mono">${escapeHtml(rec.kind)}</span>
            </div>
            <div class="recorded-meta">
              <span class="content-hash font-mono" title="Hash: ${escapeHtml(rec.contentHash)}">
                Hash: ${escapeHtml(rec.contentHash.slice(0, 16))}...
              </span>
              <span class="observed-time">${escapeHtml(rec.observedAt)}</span>
            </div>
          </li>
        `.trim();
      })
      .join("\n");

    recordedHtml = `
      <div class="evidence-section" id="evidence-recorded-section">
        <h5>Independent Evidence Log (${recordedEvidence.length})</h5>
        <ul class="recorded-evidence-list" role="list">
          ${itemsHtml}
        </ul>
      </div>
    `.trim();
  }

  // 6. Disclaimer: Artifact Presence != Verification Success
  const disclaimerHtml = `
    <div class="evidence-disclaimer-box" id="evidence-disclaimer-box">
      <span class="disclaimer-title">&#9432; Verification &amp; Evidence Invariant</span>
      <p>Artifact creation does NOT prove task correctness. Workspace artifacts capture modifications made during execution; only independent verification specifications evaluated by the verifier establish an authoritative verdict.</p>
    </div>
  `.trim();

  // Empty state when no events exist yet
  let bodyContent = "";
  if (
    completedVerifications.length === 0 &&
    rejections.length === 0 &&
    recordedEvidence.length === 0 &&
    unverifiedOverrides.length === 0
  ) {
    bodyContent = `
      <div class="evidence-empty-state" id="evidence-empty-state">
        <p>No verification evidence recorded for this run yet.</p>
        <span class="artifact-subtext">Evidence is collected during independent verification checks and checkpoint evaluations.</span>
      </div>
    `.trim();
  } else {
    bodyContent = `
      ${rejectionsHtml}
      ${verificationsHtml}
      ${recordedHtml}
    `.trim();
  }

  return `
    <div class="evidence-viewer-card" id="evidence-viewer-card">
      <div class="evidence-card-header">
        <h4>Verification &amp; Evidence</h4>
        <span class="badge badge-${outcomeBadge.color}">${escapeHtml(outcomeBadge.label)}</span>
      </div>
      <div class="evidence-card-body">
        ${verdictStatusHtml}
        ${overrideHtml}
        ${bodyContent}
        ${disclaimerHtml}
      </div>
    </div>
  `.trim();
}
