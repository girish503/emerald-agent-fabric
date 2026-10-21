/**
 * Phase 93: Speculative Branch Store
 *
 * Append-oriented store managing speculative branches, parent-child fork relationships,
 * dependency tracking, and transition state validation.
 *
 * INVARIANTS:
 * - Silent deletion or in-place erasure of branches is prohibited.
 * - Transitions follow monotonic lifecycle rules.
 * - Fork ancestry and dependency graphs are cryptographically recorded.
 */

import {
  SpeculativeBranch,
  SpeculativeBranchStatus,
  canTransitionSpeculativeStatus,
  computeSpeculativeBranchDigest,
  validateSpeculativeBranchIntegrity,
} from "../domain/speculative-execution.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

export interface BranchTransitionEvent {
  readonly eventId: string;
  readonly branchId: string;
  readonly fromStatus: SpeculativeBranchStatus;
  readonly toStatus: SpeculativeBranchStatus;
  readonly reason?: string;
  readonly details?: Record<string, unknown>;
  readonly timestamp: string;
}

export function computeBranchStoreMerkleRoot(entryHashes: readonly string[]): string {
  if (entryHashes.length === 0) {
    return sha256Hex("EMPTY_SPECULATIVE_BRANCH_STORE");
  }

  let currentLevel = [...entryHashes];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i] ?? "";
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] ?? left : left;
      const combined = canonicalJsonStringify([left, right]);
      nextLevel.push(sha256Hex(combined));
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0] ?? sha256Hex("EMPTY_SPECULATIVE_BRANCH_STORE");
}

export class SpeculativeBranchStore {
  private readonly branches: Map<string, SpeculativeBranch> = new Map();
  private readonly transitionHistory: BranchTransitionEvent[] = [];
  private readonly creationOrder: string[] = [];

  /**
   * Registers a newly created speculative branch.
   */
  public createBranch(branch: SpeculativeBranch): SpeculativeBranch {
    const integrity = validateSpeculativeBranchIntegrity(branch);
    if (!integrity.valid) {
      throw new Error(`Invalid speculative branch: ${integrity.errors.join(", ")}`);
    }

    if (this.branches.has(branch.branchId)) {
      throw new Error(`Duplicate speculative branchId ${branch.branchId}`);
    }

    // If parent branch specified, verify parent exists and is in a valid branchable state
    if (branch.parentBranchId) {
      const parent = this.branches.get(branch.parentBranchId);
      if (!parent) {
        throw new Error(`Parent branch ${branch.parentBranchId} not found`);
      }
      if (
        parent.status === "FAILED" ||
        parent.status === "INVALIDATED" ||
        parent.status === "ROLLED_BACK" ||
        parent.status === "CANCELLED"
      ) {
        throw new Error(
          `Cannot fork from parent ${branch.parentBranchId} with terminal/invalid status ${parent.status}`
        );
      }
    }

    this.branches.set(branch.branchId, branch);
    this.creationOrder.push(branch.branchId);

    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId: branch.branchId,
      fromStatus: "PROPOSED",
      toStatus: branch.status,
      reason: "BRANCH_CREATED",
      timestamp: branch.createdAt,
    });

    return branch;
  }

  /**
   * Reads a branch by ID.
   */
  public readBranch(branchId: string): SpeculativeBranch | undefined {
    return this.branches.get(branchId);
  }

  /**
   * Lists all branches in creation order.
   */
  public listBranches(): readonly SpeculativeBranch[] {
    const list: SpeculativeBranch[] = [];
    for (const id of this.creationOrder) {
      const b = this.branches.get(id);
      if (b) {
        list.push(b);
      }
    }
    return Object.freeze(list);
  }

  /**
   * Transitions a branch to a new status according to state machine rules.
   */
  public transitionBranch(
    branchId: string,
    newStatus: SpeculativeBranchStatus,
    details?: { readonly reason?: string; readonly details?: Record<string, unknown>; readonly timestamp?: string }
  ): SpeculativeBranch {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found for transition`);
    }

    if (!canTransitionSpeculativeStatus(branch.status, newStatus)) {
      throw new Error(
        `Invalid speculative status transition from ${branch.status} to ${newStatus}`
      );
    }

    const now = details?.timestamp ?? "2026-10-21T12:00:00.000Z";
    const updated: SpeculativeBranch = {
      ...branch,
      status: newStatus,
      stateVersion: branch.stateVersion + 1,
      updatedAt: now,
    };

    this.branches.set(branchId, updated);

    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId,
      fromStatus: branch.status,
      toStatus: newStatus,
      reason: details?.reason,
      details: details?.details,
      timestamp: now,
    });

    return updated;
  }

  /**
   * Forks a child branch from an active parent branch.
   */
  public forkBranch(params: {
    readonly parentBranchId: string;
    readonly newBranchId: string;
    readonly agentId: string;
    readonly goalId: string;
    readonly speculativeTreeDigest: string;
    readonly strategyDigest: string;
    readonly goalDigest: string;
    readonly creationSequence: number;
    readonly affectedFiles?: readonly string[];
    readonly affectedSymbols?: readonly string[];
    readonly createdAt?: string;
  }): SpeculativeBranch {
    const parent = this.branches.get(params.parentBranchId);
    if (!parent) {
      throw new Error(`Parent branch ${params.parentBranchId} not found`);
    }

    const now = params.createdAt ?? "2026-10-21T12:00:00.000Z";
    const child: SpeculativeBranch = {
      branchId: params.newBranchId,
      runId: parent.runId,
      taskId: parent.taskId,
      agentId: params.agentId,
      goalId: params.goalId,
      repositoryId: parent.repositoryId,
      workspaceId: parent.workspaceId,
      parentBranchId: parent.branchId,
      baseRevision: parent.baseRevision,
      baseTreeDigest: parent.speculativeTreeDigest, // child forks from parent's speculative state
      speculativeTreeDigest: params.speculativeTreeDigest,
      strategyDigest: params.strategyDigest,
      goalDigest: params.goalDigest,
      missionContractId: parent.missionContractId,
      missionContractHash: parent.missionContractHash,
      creationSequence: params.creationSequence,
      stateVersion: 1,
      status: "AUTHORIZED_FOR_SPECULATION",
      provenanceRoot: sha256Hex(`${parent.provenanceRoot}:${params.newBranchId}`),
      verificationState: "NOT_SUBMITTED",
      rollbackState: "NONE",
      trustClass: "UNTRUSTED_SPECULATION",
      createdAt: now,
      updatedAt: now,
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
      affectedFiles: params.affectedFiles ? [...params.affectedFiles] : [],
      affectedSymbols: params.affectedSymbols ? [...params.affectedSymbols] : [],
      dependencyBranchIds: [parent.branchId],
    };

    return this.createBranch(child);
  }

  public invalidateBranch(branchId: string, reason: string): SpeculativeBranch {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }
    const updated: SpeculativeBranch = {
      ...branch,
      status: "INVALIDATED",
      verificationState: "INVALIDATED",
      updatedAt: "2026-10-21T12:00:00.000Z",
    };
    this.branches.set(branchId, updated);
    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId,
      fromStatus: branch.status,
      toStatus: "INVALIDATED",
      reason,
      timestamp: "2026-10-21T12:00:00.000Z",
    });
    return updated;
  }

  public markVerified(branchId: string): SpeculativeBranch {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }
    if (!canTransitionSpeculativeStatus(branch.status, "VERIFIED")) {
      throw new Error(`Cannot transition from ${branch.status} to VERIFIED`);
    }
    const updated: SpeculativeBranch = {
      ...branch,
      status: "VERIFIED",
      verificationState: "PASSED",
      trustClass: "SOVEREIGN_VERIFIED_RESULT",
      updatedAt: "2026-10-21T12:00:00.000Z",
    };
    this.branches.set(branchId, updated);
    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId,
      fromStatus: branch.status,
      toStatus: "VERIFIED",
      reason: "VERIFICATION_PASSED",
      timestamp: "2026-10-21T12:00:00.000Z",
    });
    return updated;
  }

  public markFailed(branchId: string, reason: string): SpeculativeBranch {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }
    const updated: SpeculativeBranch = {
      ...branch,
      status: "FAILED",
      verificationState: "FAILED",
      updatedAt: "2026-10-21T12:00:00.000Z",
    };
    this.branches.set(branchId, updated);
    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId,
      fromStatus: branch.status,
      toStatus: "FAILED",
      reason,
      timestamp: "2026-10-21T12:00:00.000Z",
    });
    return updated;
  }

  public beginRollback(branchId: string, reason = "ROLLBACK_INITIATED"): SpeculativeBranch {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }
    if (branch.status === "ROLLED_BACK" || !canTransitionSpeculativeStatus(branch.status, "ROLLING_BACK")) {
      throw new Error(`Cannot begin rollback from status ${branch.status}`);
    }
    const updated: SpeculativeBranch = {
      ...branch,
      status: "ROLLING_BACK",
      rollbackState: "ROLLING_BACK",
      updatedAt: "2026-10-21T12:00:00.000Z",
    };
    this.branches.set(branchId, updated);
    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId,
      fromStatus: branch.status,
      toStatus: "ROLLING_BACK",
      reason,
      timestamp: "2026-10-21T12:00:00.000Z",
    });
    return updated;
  }

  public completeRollback(branchId: string): SpeculativeBranch {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }
    const updated: SpeculativeBranch = {
      ...branch,
      status: "ROLLED_BACK",
      rollbackState: "ROLLED_BACK",
      updatedAt: "2026-10-21T12:00:00.000Z",
    };
    this.branches.set(branchId, updated);
    this.transitionHistory.push({
      eventId: `trans-${this.transitionHistory.length + 1}`,
      branchId,
      fromStatus: branch.status,
      toStatus: "ROLLED_BACK",
      reason: "ROLLBACK_COMPLETED",
      timestamp: "2026-10-21T12:00:00.000Z",
    });
    return updated;
  }

  /**
   * Returns ancestry chain from direct parent up to root parent.
   */
  public branchAncestryLookup(branchId: string): readonly SpeculativeBranch[] {
    const ancestry: SpeculativeBranch[] = [];
    let current = this.branches.get(branchId);

    while (current && current.parentBranchId) {
      const parent = this.branches.get(current.parentBranchId);
      if (!parent) break;
      ancestry.push(parent);
      current = parent;
    }

    return Object.freeze(ancestry);
  }

  /**
   * Returns all direct and indirect descendant branches of a given branch.
   */
  public getDescendants(branchId: string): readonly SpeculativeBranch[] {
    const descendants: SpeculativeBranch[] = [];
    const queue: string[] = [branchId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const parentId = queue.shift();
      if (!parentId) break;

      for (const [id, branch] of this.branches.entries()) {
        if (
          (branch.parentBranchId === parentId ||
            branch.dependencyBranchIds.includes(parentId)) &&
          !visited.has(id)
        ) {
          visited.add(id);
          descendants.push(branch);
          queue.push(id);
        }
      }
    }

    return Object.freeze(descendants);
  }

  /**
   * Returns transition history events.
   */
  public getTransitionHistory(): readonly BranchTransitionEvent[] {
    return Object.freeze([...this.transitionHistory]);
  }

  /**
   * Computes the Merkle provenance root across all historical speculative branches.
   */
  public computeStoreMerkleRoot(): string {
    if (this.creationOrder.length === 0) {
      return sha256Hex("EMPTY_SPECULATIVE_BRANCH_STORE");
    }
    const digests: string[] = [];
    for (const id of this.creationOrder) {
      const b = this.branches.get(id);
      if (b) {
        digests.push(computeSpeculativeBranchDigest(b));
      }
    }
    return computeBranchStoreMerkleRoot(digests);
  }
}
