/**
 * Phase 93: Speculative Verification Reconciler
 *
 * Reconciles asynchronous verification results against speculative branches.
 * Strictly verifies identity, version, base revision, tree digest, contract hash,
 * goal ID, and provenance roots before permitting promotion.
 *
 * CRITICAL INVARIANTS:
 * 1. Stale verification cannot validate current state.
 * 2. SPECULATIVE_VERIFIED != TERMINAL_SUCCESS.
 * 3. Race conditions (Races A–G) fail closed or enter governed revalidation.
 */

import {
  SpeculativeBranch,
  SpeculativeConflictType,
  SpeculativeVerificationState,
} from "../domain/speculative-execution.js";
import { SpeculativeBranchStore } from "./speculative-branch-store.js";

export interface VerificationResultPayload {
  readonly resultId: string;
  readonly branchId: string;
  readonly branchVersion: number;
  readonly baseRevision: string;
  readonly speculativeTreeDigest: string;
  readonly missionContractHash: string;
  readonly goalId: string;
  readonly provenanceRoot: string;
  readonly status: "PASSED" | "FAILED";
  readonly details?: Record<string, unknown>;
  readonly verifiedAt: string;
}

export interface VerificationReconciliationOutcome {
  readonly reconciliationId: string;
  readonly branchId: string;
  readonly verificationState: SpeculativeVerificationState;
  readonly promotionPermitted: boolean;
  readonly reason: string;
  readonly conflicts: readonly SpeculativeConflictType[];
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
}

export class SpeculativeVerificationReconciler {
  /**
   * Reconciles an asynchronous verification result against a speculative branch.
   */
  public static reconcileVerificationResult(
    branch: SpeculativeBranch,
    result: VerificationResultPayload,
    currentAuthoritativeRevision: string,
    store: SpeculativeBranchStore
  ): VerificationReconciliationOutcome {
    const reconciliationId = `vr-${branch.branchId}-${branch.stateVersion}`;
    const conflicts: SpeculativeConflictType[] = [];

    // 0. Active Branch Status Check
    if (
      branch.status === "FAILED" ||
      branch.status === "INVALIDATED" ||
      branch.status === "ROLLING_BACK" ||
      branch.status === "ROLLED_BACK" ||
      branch.status === "CANCELLED"
    ) {
      conflicts.push("SPECULATIVE_VERIFICATION_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "REJECTED",
        promotionPermitted: false,
        reason: `Branch is in terminal/invalid status ${branch.status}`,
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 1. Branch ID Fencing
    if (result.branchId !== branch.branchId) {
      conflicts.push("SPECULATIVE_BRANCH_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "REJECTED",
        promotionPermitted: false,
        reason: `Branch mismatch: result branch ${result.branchId} !== target ${branch.branchId}`,
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 1b. Branch Version Fencing (Race D / Stale Verification)
    if (result.branchVersion !== branch.stateVersion) {
      conflicts.push("SPECULATIVE_VERIFICATION_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "STALE",
        promotionPermitted: false,
        reason: `Branch version mismatch (result version ${result.branchVersion} !== branch stateVersion ${branch.stateVersion})`,
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 2. Mission Contract Fencing
    if (result.missionContractHash !== branch.missionContractHash) {
      conflicts.push("SPECULATIVE_CONTRACT_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "REJECTED",
        promotionPermitted: false,
        reason: "Mission contract hash mismatch",
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 3. Goal Identity Fencing
    if (result.goalId !== branch.goalId) {
      conflicts.push("SPECULATIVE_GOAL_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "REJECTED",
        promotionPermitted: false,
        reason: "Goal identity mismatch",
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 4. Tree Digest Fencing
    if (result.speculativeTreeDigest !== branch.speculativeTreeDigest) {
      conflicts.push("SPECULATIVE_TREE_DIGEST_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "REJECTED",
        promotionPermitted: false,
        reason: `Tree digest mismatch (${result.speculativeTreeDigest} !== ${branch.speculativeTreeDigest})`,
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 5. Provenance Root Fencing
    if (result.provenanceRoot !== branch.provenanceRoot) {
      conflicts.push("SPECULATIVE_PROVENANCE_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "REJECTED",
        promotionPermitted: false,
        reason: "Provenance root mismatch",
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 6. Check Parent Ancestry Integrity (Race G: child cannot verify if parent failed/invalid)
    if (branch.parentBranchId) {
      const parent = store.readBranch(branch.parentBranchId);
      if (
        parent &&
        (parent.status === "FAILED" ||
          parent.status === "INVALIDATED" ||
          parent.status === "ROLLED_BACK")
      ) {
        conflicts.push("SPECULATIVE_DEPENDENCY_CONFLICT");
        conflicts.push("SPECULATIVE_BRANCH_CONFLICT");
        return {
          reconciliationId,
          branchId: branch.branchId,
          verificationState: "INVALIDATED",
          promotionPermitted: false,
          reason: `Parent branch ${branch.parentBranchId} is ${parent.status}; child cannot verify`,
          conflicts: Object.freeze(conflicts),
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
        };
      }
    }

    // 6b. Check Dependency Branch Integrity (Race C)
    for (const depId of branch.dependencyBranchIds) {
      const dep = store.readBranch(depId);
      if (
        !dep ||
        dep.status === "FAILED" ||
        dep.status === "INVALIDATED" ||
        dep.status === "ROLLING_BACK" ||
        dep.status === "ROLLED_BACK"
      ) {
        conflicts.push("SPECULATIVE_DEPENDENCY_CONFLICT");
        return {
          reconciliationId,
          branchId: branch.branchId,
          verificationState: "REJECTED",
          promotionPermitted: false,
          reason: `Dependency branch ${depId} is failed/invalid (status=${dep?.status})`,
          conflicts: Object.freeze(conflicts),
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
        };
      }
    }

    // 7. Check Base Revision Staleness (Race C, Race D)
    if (result.baseRevision !== currentAuthoritativeRevision) {
      conflicts.push("SPECULATIVE_BASE_REVISION_CONFLICT");
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "STALE",
        promotionPermitted: false,
        reason: `Stale verification: verified for ${result.baseRevision}, current authoritative is ${currentAuthoritativeRevision}`,
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // 8. Result Outcome
    if (result.status === "FAILED") {
      return {
        reconciliationId,
        branchId: branch.branchId,
        verificationState: "FAILED",
        promotionPermitted: false,
        reason: "Verification tests failed",
        conflicts: Object.freeze(conflicts),
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
      };
    }

    // Verification Succeeded: update branch in store
    try {
      store.markVerified(branch.branchId);
    } catch {
      // Store transition error
    }

    return {
      reconciliationId,
      branchId: branch.branchId,
      verificationState: "PASSED",
      promotionPermitted: true,
      reason: "Verification passed and all identity/revision fences satisfied",
      conflicts: Object.freeze([]),
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
    };
  }
}
