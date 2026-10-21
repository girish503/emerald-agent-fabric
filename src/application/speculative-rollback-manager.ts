/**
 * Phase 93: Speculative Rollback Manager
 *
 * Implements deterministic rollback and cascading rollback for failed speculative branches.
 *
 * POLICIES:
 * - POLICY A: STRICT_CASCADE (invalidates all descendants)
 * - POLICY B: DEPENDENCY_CASCADE (invalidates only branches depending on failed branch)
 * - POLICY C: INDEPENDENT_SURVIVAL (preserves unrelated branches)
 * - POLICY D: GOVERNED_ADAPTIVE (evaluates dependencies, overlaps, and verification state)
 *
 * CRITICAL INVARIANTS:
 * 1. Rollback is idempotent (calling rollback twice returns identical state/evidence).
 * 2. Rollback preserves all historical evidence; branches are never silently erased.
 * 3. Rollback does not grant authority.
 */

import { SpeculativeBranchStore } from "./speculative-branch-store.js";

export type RollbackPolicy =
  | "STRICT_CASCADE"
  | "DEPENDENCY_CASCADE"
  | "INDEPENDENT_SURVIVAL"
  | "GOVERNED_ADAPTIVE";

export interface RollbackEvent {
  readonly rollbackId: string;
  readonly targetBranchId: string;
  readonly policy: RollbackPolicy;
  readonly reason: string;
  readonly rolledBackBranchIds: readonly string[];
  readonly preservedBranchIds: readonly string[];
  readonly previousTreeDigest: string;
  readonly resultingTreeDigest: string;
  readonly rollbackSequence: number;
  readonly timestamp: string;
}

export interface RollbackExecutionResult {
  readonly rollbackId: string;
  readonly event: RollbackEvent;
  readonly isIdempotentReplay: boolean;
  readonly authoritative: false;
  readonly terminalAuthority: false;
}

export class SpeculativeRollbackManager {
  private readonly rollbackHistory: RollbackEvent[] = [];
  private readonly branchRollbackIndex: Map<string, RollbackEvent> = new Map();

  constructor(private readonly store: SpeculativeBranchStore) {}

  /**
   * Executes a rollback on targetBranchId using the chosen RollbackPolicy.
   */
  public executeRollback(
    targetBranchId: string,
    policy: RollbackPolicy,
    reason: string
  ): RollbackExecutionResult {
    // 1. Idempotency Check
    const existing = this.branchRollbackIndex.get(targetBranchId);
    if (existing) {
      return {
        rollbackId: existing.rollbackId,
        event: existing,
        isIdempotentReplay: true,
        authoritative: false,
        terminalAuthority: false,
      };
    }

    const targetBranch = this.store.readBranch(targetBranchId);
    if (!targetBranch) {
      throw new Error(`Cannot rollback non-existent branch ${targetBranchId}`);
    }

    const allBranches = this.store.listBranches();
    const rolledBackSet = new Set<string>();
    const preservedSet = new Set<string>();

    rolledBackSet.add(targetBranchId);

    // Compute which branches must be rolled back based on policy
    switch (policy) {
      case "STRICT_CASCADE": {
        // Rollback target and all direct/indirect descendants
        const descendants = this.store.getDescendants(targetBranchId);
        for (const d of descendants) {
          rolledBackSet.add(d.branchId);
        }
        for (const b of allBranches) {
          if (!rolledBackSet.has(b.branchId)) {
            preservedSet.add(b.branchId);
          }
        }
        break;
      }

      case "DEPENDENCY_CASCADE": {
        // Rollback target and branches that explicitly list target in dependencyBranchIds
        const queue = [targetBranchId];
        while (queue.length > 0) {
          const curr = queue.shift();
          if (!curr) break;
          for (const b of allBranches) {
            if (b.dependencyBranchIds.includes(curr) && !rolledBackSet.has(b.branchId)) {
              rolledBackSet.add(b.branchId);
              queue.push(b.branchId);
            }
          }
        }
        for (const b of allBranches) {
          if (!rolledBackSet.has(b.branchId)) {
            preservedSet.add(b.branchId);
          }
        }
        break;
      }

      case "INDEPENDENT_SURVIVAL": {
        // Only target branch itself is rolled back; independent branches preserved
        for (const b of allBranches) {
          if (!rolledBackSet.has(b.branchId)) {
            preservedSet.add(b.branchId);
          }
        }
        break;
      }

      case "GOVERNED_ADAPTIVE": {
        // Adaptively checks dependencies and file overlap
        const targetFiles = new Set(targetBranch.affectedFiles);
        const queue = [targetBranchId];

        while (queue.length > 0) {
          const curr = queue.shift();
          if (!curr) break;

          for (const b of allBranches) {
            if (!rolledBackSet.has(b.branchId)) {
              if (b.status === "VERIFIED" || b.verificationState === "PASSED") {
                continue;
              }
              const hasExplicitDep = b.dependencyBranchIds.includes(curr);
              const hasFileOverlap = b.affectedFiles.some((f) => targetFiles.has(f));

              if (hasExplicitDep || (b.parentBranchId === curr && hasFileOverlap)) {
                rolledBackSet.add(b.branchId);
                queue.push(b.branchId);
              }
            }
          }
        }

        for (const b of allBranches) {
          if (!rolledBackSet.has(b.branchId)) {
            preservedSet.add(b.branchId);
          }
        }
        break;
      }
    }

    // Apply state transitions to rolled back branches
    for (const bId of rolledBackSet) {
      const b = this.store.readBranch(bId);
      if (b && b.status !== "ROLLED_BACK") {
        this.store.beginRollback(bId, `Rollback cascade from ${targetBranchId}: ${reason}`);
        this.store.completeRollback(bId);
      }
    }

    const previousTreeDigest = targetBranch.speculativeTreeDigest;
    const resultingTreeDigest = targetBranch.baseTreeDigest; // Reverts back to base tree digest

    const event: RollbackEvent = {
      rollbackId: `rb-${targetBranchId}-${this.rollbackHistory.length + 1}`,
      targetBranchId,
      policy,
      reason,
      rolledBackBranchIds: Object.freeze(Array.from(rolledBackSet)),
      preservedBranchIds: Object.freeze(Array.from(preservedSet)),
      previousTreeDigest,
      resultingTreeDigest,
      rollbackSequence: this.rollbackHistory.length + 1,
      timestamp: "2026-10-21T12:00:00.000Z",
    };

    this.rollbackHistory.push(event);
    this.branchRollbackIndex.set(targetBranchId, event);

    return {
      rollbackId: event.rollbackId,
      event,
      isIdempotentReplay: false,
      authoritative: false,
      terminalAuthority: false,
    };
  }

  public getRollbackHistory(): readonly RollbackEvent[] {
    return Object.freeze([...this.rollbackHistory]);
  }
}
