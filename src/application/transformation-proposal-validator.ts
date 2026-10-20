/**
 * Phase 79 — Governed Human-in-the-Loop Transformation Discovery
 *
 * TransformationProposalValidator enforces strict structural, boundary,
 * revision, and authority firewalls on untrusted candidate transformation proposals.
 */

import { canonicalJsonStringify } from "../domain/canonical-hash.js";
import {
  DEFAULT_PROPOSAL_VALIDATION_LIMITS,
  ProposalValidationLimits,
  TransformationProposalValidationResult,
  computeProposalDigest,
} from "../domain/transformation-proposal.js";

export const FROZEN_TASK_COHORT = [
  "P46-L5-01",
  "P46-L5-02",
  "P46-L5-03",
  "P46-L5-04",
  "P46-L5-05",
  "P46-L6-01",
  "P46-L6-02",
  "P46-L6-03",
  "P46-L6-04",
  "P46-L6-05",
  "P46-L7-01",
  "P46-L7-02",
  "P46-L7-03",
  "P46-L7-04",
  "P46-L7-05",
] as const;

export const FROZEN_BASELINE_REVISION = "c5e5a17";

export const FORBIDDEN_AUTHORITY_KEYS = [
  "claimedAuthority",
  "overridePolicy",
  "overrideSandbox",
  "overrideContract",
  "skipVerification",
  "grantCredentials",
  "resourceCeilingOverride",
  "terminalAuthorityClaim",
  "evidenceAuthorityClaim",
  "oracleAccess",
  "goldPatchAccess",
  "terminalAuthority",
  "executionAuthority",
] as const;

export class TransformationProposalValidator {
  /**
   * Validates a transformation proposal fail-closed.
   */
  public static validate(
    rawProposal: unknown,
    expectedRevision = FROZEN_BASELINE_REVISION,
    limits: ProposalValidationLimits = DEFAULT_PROPOSAL_VALIDATION_LIMITS
  ): TransformationProposalValidationResult {
    const errors: string[] = [];

    if (!rawProposal || typeof rawProposal !== "object") {
      return {
        valid: false,
        errors: ["MALFORMED_PROPOSAL: Proposal must be a non-null object"],
      };
    }

    const obj = rawProposal as Record<string, unknown>;

    // 1. Proposal Payload Byte Size
    const rawJson = canonicalJsonStringify(rawProposal);
    const byteLength = Buffer.byteLength(rawJson, "utf8");
    if (byteLength > limits.maxProposalBytes) {
      errors.push(
        `PROPOSAL_SIZE_EXCEEDED: Proposal byte size ${byteLength} exceeds limit ${limits.maxProposalBytes}`
      );
    }

    // 2. Authority Firewall — Proposer must NEVER attempt authority escalation
    for (const key of FORBIDDEN_AUTHORITY_KEYS) {
      if (key in obj && obj[key] !== false && obj[key] !== undefined && obj[key] !== null) {
        errors.push(`AUTHORITY_ESCALATION_REJECTED: Forbidden authority field detected: ${key}`);
      }
    }

    // Check nested or string probes for authority escalation
    if (
      obj.claimedAuthority === "TERMINAL_AUTHORITY" ||
      obj.claimedAuthority === "EXECUTION_AUTHORITY" ||
      obj.claimedAuthority === "EVIDENCE_AUTHORITY"
    ) {
      errors.push("AUTHORITY_ESCALATION_REJECTED: Proposer cannot claim sovereign execution or terminal authority");
    }

    // 3. Proposer Type
    const validProposerTypes = [
      "HUMAN",
      "LOCAL_MODEL",
      "HUMAN_MODEL_COLLABORATION",
      "AUTONOMOUS_AGENT",
    ];
    if (
      typeof obj.proposerType !== "string" ||
      !validProposerTypes.includes(obj.proposerType)
    ) {
      errors.push(
        `INVALID_PROPOSER_TYPE: proposerType must be one of ${validProposerTypes.join(", ")}`
      );
    }

    // 4. Task Binding
    if (typeof obj.taskId !== "string" || !FROZEN_TASK_COHORT.includes(obj.taskId as any)) {
      errors.push(
        `INVALID_TASK_ID: taskId must belong to frozen cohort: ${obj.taskId}`
      );
    }

    // 5. Source Revision Binding — fail closed on mismatch
    if (obj.sourceRevision !== expectedRevision) {
      errors.push(
        `SOURCE_REVISION_MISMATCH: Proposal bound to revision '${obj.sourceRevision}', expected '${expectedRevision}'`
      );
    }

    // 6. Proposal ID & Timestamps
    if (typeof obj.proposalId !== "string" || obj.proposalId.trim() === "") {
      errors.push("INVALID_PROPOSAL_ID: proposalId is required");
    }
    if (typeof obj.submittedAt !== "string" || isNaN(Date.parse(obj.submittedAt))) {
      errors.push("INVALID_TIMESTAMP: submittedAt must be a valid ISO timestamp");
    }

    // 7. Intent & Rationale
    if (typeof obj.transformationIntent !== "string" || obj.transformationIntent.trim() === "") {
      errors.push("INVALID_INTENT: transformationIntent is required");
    }
    if (typeof obj.expectedBehavior !== "string" || obj.expectedBehavior.trim() === "") {
      errors.push("INVALID_EXPECTED_BEHAVIOR: expectedBehavior is required");
    }
    if (typeof obj.rationale !== "string") {
      errors.push("INVALID_RATIONALE: rationale must be a string");
    }

    // 8. Target Files
    if (!Array.isArray(obj.targetFiles) || obj.targetFiles.length === 0) {
      errors.push("INVALID_TARGET_FILES: targetFiles must be a non-empty array");
    } else {
      if (obj.targetFiles.length > limits.maxTargetFiles) {
        errors.push(
          `MAX_TARGET_FILES_EXCEEDED: ${obj.targetFiles.length} files exceeds limit ${limits.maxTargetFiles}`
        );
      }
      for (const f of obj.targetFiles) {
        if (typeof f !== "string" || f.trim() === "") {
          errors.push("INVALID_TARGET_FILE_PATH: Empty or non-string file path in targetFiles");
          continue;
        }
        // Path Traversal / Boundary Check
        if (
          f.includes("..") ||
          f.startsWith("/") ||
          f.startsWith("\\") ||
          /^[a-zA-Z]:/.test(f)
        ) {
          errors.push(`PATH_TRAVERSAL_DETECTED: Target path '${f}' traverses outside workspace`);
        }
        // Protected paths
        if (
          f.startsWith(".git") ||
          f.includes(".env") ||
          f.includes("credentials") ||
          f.includes("secret") ||
          f.includes("gold_patches")
        ) {
          errors.push(`PROTECTED_PATH_VIOLATION: Target path '${f}' touches protected system area`);
        }
      }
    }

    // 9. Candidate Edits
    if (!Array.isArray(obj.candidateEdits) || obj.candidateEdits.length === 0) {
      errors.push("INVALID_CANDIDATE_EDITS: candidateEdits must be a non-empty array");
    } else {
      if (obj.candidateEdits.length > limits.maxEdits) {
        errors.push(
          `MAX_EDITS_EXCEEDED: ${obj.candidateEdits.length} edits exceeds limit ${limits.maxEdits}`
        );
      }

      const editSeen = new Set<string>();
      const validActions = ["REPLACE", "INSERT", "DELETE"];

      for (let i = 0; i < obj.candidateEdits.length; i++) {
        const edit = obj.candidateEdits[i];
        if (!edit || typeof edit !== "object") {
          errors.push(`MALFORMED_EDIT: Edit at index ${i} is not an object`);
          continue;
        }

        const editObj = edit as Record<string, unknown>;
        if (typeof editObj.path !== "string" || editObj.path.trim() === "") {
          errors.push(`INVALID_EDIT_PATH: Edit at index ${i} has empty or missing path`);
          continue;
        }

        // Must be in targetFiles
        if (Array.isArray(obj.targetFiles) && !obj.targetFiles.includes(editObj.path)) {
          errors.push(
            `UNDECLARED_TARGET_FILE: Edit target '${editObj.path}' was not declared in targetFiles`
          );
        }

        // Action check
        if (typeof editObj.action !== "string" || !validActions.includes(editObj.action)) {
          errors.push(`INVALID_EDIT_ACTION: Edit action '${editObj.action}' must be REPLACE, INSERT, or DELETE`);
        }

        // NewText check
        if (typeof editObj.newText !== "string") {
          errors.push(`INVALID_EDIT_NEW_TEXT: Edit at index ${i} must provide newText string`);
        }

        // Line bounds check
        if (editObj.startLine !== undefined) {
          if (typeof editObj.startLine !== "number" || editObj.startLine < 1) {
            errors.push(`INVALID_START_LINE: startLine at edit ${i} must be positive integer`);
          }
        }
        if (editObj.endLine !== undefined) {
          if (typeof editObj.endLine !== "number" || (typeof editObj.startLine === "number" && editObj.endLine < editObj.startLine)) {
            errors.push(`INVALID_END_LINE: endLine at edit ${i} must be >= startLine`);
          }
        }

        // Duplicate and conflict check
        const editKey = `${editObj.path}:${editObj.action}:${editObj.startLine ?? ""}:${editObj.endLine ?? ""}:${editObj.oldText ?? ""}`;
        if (editSeen.has(editKey)) {
          errors.push(`DUPLICATE_EDIT_DETECTED: Identical edit repeated at index ${i} (${editKey})`);
        }
        editSeen.add(editKey);
      }
    }

    // 10. Revisions and Parent Proposal
    const revIdx = obj.revisionIndex;
    if (revIdx !== undefined && revIdx !== null) {
      if (typeof revIdx !== "number" || revIdx < 0) {
        errors.push("INVALID_REVISION_INDEX: revisionIndex must be a non-negative integer");
      } else if (revIdx > limits.maxProposalRevisions) {
        errors.push(
          `MAX_REVISIONS_EXCEEDED: revisionIndex ${revIdx} exceeds max limit ${limits.maxProposalRevisions}`
        );
      }

      if (typeof revIdx === "number" && revIdx > 0) {
        if (typeof obj.parentProposalId !== "string" || obj.parentProposalId.trim() === "") {
          errors.push("MISSING_PARENT_PROPOSAL_ID: Revision proposals must link to parentProposalId");
        }
      }
    }

    // 11. Proposal Digest Verification
    if (typeof obj.proposalDigest !== "string" || obj.proposalDigest.trim() === "") {
      errors.push("MISSING_PROPOSAL_DIGEST: proposalDigest is required");
    } else {
      const computed = computeProposalDigest(obj as any);
      if (obj.proposalDigest !== computed) {
        errors.push(
          `PROPOSAL_DIGEST_MISMATCH: Provided digest '${obj.proposalDigest}' does not match computed '${computed}'`
        );
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
      };
    }

    return {
      valid: true,
      errors: [],
      validatedDigest: (obj as any).proposalDigest,
    };
  }
}
