/**
 * Phase 92: Memory Reconciler
 *
 * Implements deterministic conflict detection and reconciliation policies across
 * divergent cooperative memory observations.
 *
 * POLICIES:
 * - POLICY A: LATEST_VALID (newest valid timestamp/version)
 * - POLICY B: PROVENANCE_PRIORITY (sovereign > locally verified > provenance verified > untrusted)
 * - POLICY C: MULTI_SOURCE_CONSENSUS (independent corroboration across agents)
 * - POLICY D: CONSERVATIVE_CONFLICT (preserve conflict, refuse arbitrary selection)
 * - POLICY E: GOVERNED_ADAPTIVE (multi-factor score combining freshness, provenance, corroboration)
 *
 * CRITICAL INVARIANT:
 * Reconciliation outputs are purely observations. No policy can grant authority.
 */

import {
  MemoryConflictType,
  MemoryRecord,
  MemoryTrustClass,
} from "../domain/cooperative-memory.js";

export type MemoryReconciliationPolicy =
  | "LATEST_VALID"
  | "PROVENANCE_PRIORITY"
  | "MULTI_SOURCE_CONSENSUS"
  | "CONSERVATIVE_CONFLICT"
  | "GOVERNED_ADAPTIVE";

export interface MemoryConflictItem {
  readonly conflictType: MemoryConflictType;
  readonly recordAId: string;
  readonly recordBId: string;
  readonly reason: string;
  readonly detectedAt: string;
}

export interface MemoryReconciliationResult {
  readonly reconciliationId: string;
  readonly policy: MemoryReconciliationPolicy;
  readonly reconciledRecord?: MemoryRecord;
  readonly status: "RECONCILED" | "CONFLICT_PRESERVED" | "BLOCKED" | "REJECTED";
  readonly conflicts: readonly MemoryConflictItem[];
  readonly candidateCount: number;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly reconciledAt: string;
}

const TRUST_CLASS_RANKS: Readonly<Record<MemoryTrustClass, number>> = {
  SOVEREIGN_VERIFIED_EVIDENCE: 4,
  LOCALLY_VERIFIED_OBSERVATION: 3,
  PROVENANCE_VERIFIED_OBSERVATION: 2,
  UNTRUSTED_OBSERVATION: 1,
};

export class MemoryReconciler {
  /**
   * Detects conflicts between two memory records that reference the same key or subject.
   */
  public static detectConflicts(
    recordA: MemoryRecord,
    recordB: MemoryRecord
  ): readonly MemoryConflictItem[] {
    const conflicts: MemoryConflictItem[] = [];
    const now = new Date().toISOString();

    // Check for authority injection attempts
    if (
      (recordA as unknown as { authoritative?: boolean }).authoritative === true ||
      (recordB as unknown as { authoritative?: boolean }).authoritative === true ||
      (recordA as unknown as { terminalAuthority?: boolean }).terminalAuthority === true ||
      (recordB as unknown as { terminalAuthority?: boolean }).terminalAuthority === true
    ) {
      conflicts.push({
        conflictType: "AUTHORITY_INJECTION",
        recordAId: recordA.memoryId,
        recordBId: recordB.memoryId,
        reason: "Detected forbidden authority flag on memory record",
        detectedAt: now,
      });
    }

    // Repository mismatch
    if (recordA.repositoryId !== recordB.repositoryId) {
      conflicts.push({
        conflictType: "REPOSITORY_CONFLICT",
        recordAId: recordA.memoryId,
        recordBId: recordB.memoryId,
        reason: `Mismatched repositories: ${recordA.repositoryId} vs ${recordB.repositoryId}`,
        detectedAt: now,
      });
    }

    // Workspace mismatch
    if (recordA.workspaceId !== recordB.workspaceId) {
      conflicts.push({
        conflictType: "WORKSPACE_CONFLICT",
        recordAId: recordA.memoryId,
        recordBId: recordB.memoryId,
        reason: `Mismatched workspaces: ${recordA.workspaceId} vs ${recordB.workspaceId}`,
        detectedAt: now,
      });
    }

    // Freshness check: Stale memories
    if (recordA.freshness === "STALE" || recordB.freshness === "STALE") {
      conflicts.push({
        conflictType: "STALE_MEMORY",
        recordAId: recordA.memoryId,
        recordBId: recordB.memoryId,
        reason: `Stale memory detected: A is ${recordA.freshness}, B is ${recordB.freshness}`,
        detectedAt: now,
      });
    }

    // Same memoryId but differing version/digest
    if (recordA.memoryId === recordB.memoryId) {
      if (recordA.version === recordB.version && recordA.contentDigest !== recordB.contentDigest) {
        conflicts.push({
          conflictType: "CONTENT_CONFLICT",
          recordAId: recordA.memoryId,
          recordBId: recordB.memoryId,
          reason: `Same memoryId and version with diverging content digests: ${recordA.contentDigest} vs ${recordB.contentDigest}`,
          detectedAt: now,
        });
      } else if (recordA.version !== recordB.version) {
        conflicts.push({
          conflictType: "VERSION_CONFLICT",
          recordAId: recordA.memoryId,
          recordBId: recordB.memoryId,
          reason: `Version divergence: v${recordA.version} vs v${recordB.version}`,
          detectedAt: now,
        });
      }
    }

    // Provenance divergence
    if (recordA.provenanceRoot !== recordB.provenanceRoot && recordA.contentDigest === recordB.contentDigest) {
      conflicts.push({
        conflictType: "PROVENANCE_CONFLICT",
        recordAId: recordA.memoryId,
        recordBId: recordB.memoryId,
        reason: `Content identical but provenance roots differ: ${recordA.provenanceRoot} vs ${recordB.provenanceRoot}`,
        detectedAt: now,
      });
    }

    // Type-specific semantic conflicts
    if (recordA.memoryType === "TEST_RESULT" && recordB.memoryType === "TEST_RESULT") {
      if (recordA.contentDigest !== recordB.contentDigest) {
        conflicts.push({
          conflictType: "TEST_RESULT_CONFLICT",
          recordAId: recordA.memoryId,
          recordBId: recordB.memoryId,
          reason: "Contradictory test result observations",
          detectedAt: now,
        });
      }
    } else if (recordA.memoryType === "HYPOTHESIS" && recordB.memoryType === "HYPOTHESIS") {
      if (recordA.contentDigest !== recordB.contentDigest) {
        conflicts.push({
          conflictType: "HYPOTHESIS_CONFLICT",
          recordAId: recordA.memoryId,
          recordBId: recordB.memoryId,
          reason: "Competing hypotheses for same target",
          detectedAt: now,
        });
      }
    } else if (recordA.memoryType === "REPAIR_CANDIDATE" && recordB.memoryType === "REPAIR_CANDIDATE") {
      if (recordA.contentDigest !== recordB.contentDigest) {
        conflicts.push({
          conflictType: "REPAIR_CANDIDATE_CONFLICT",
          recordAId: recordA.memoryId,
          recordBId: recordB.memoryId,
          reason: "Divergent repair candidates proposed",
          detectedAt: now,
        });
      }
    } else if (recordA.memoryType === "RESOURCE_OBSERVATION" && recordB.memoryType === "RESOURCE_OBSERVATION") {
      if (recordA.contentDigest !== recordB.contentDigest) {
        conflicts.push({
          conflictType: "RESOURCE_OBSERVATION_CONFLICT",
          recordAId: recordA.memoryId,
          recordBId: recordB.memoryId,
          reason: "Divergent resource observations",
          detectedAt: now,
        });
      }
    }

    return Object.freeze(conflicts);
  }

  /**
   * Reconciles a list of candidate records according to the selected policy.
   */
  public static reconcile(
    candidates: readonly MemoryRecord[],
    policy: MemoryReconciliationPolicy
  ): MemoryReconciliationResult {
    const reconciliationId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    if (candidates.length === 0) {
      return {
        reconciliationId,
        policy,
        status: "REJECTED",
        conflicts: Object.freeze([]),
        candidateCount: 0,
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
        reconciledAt: now,
      };
    }

    if (candidates.length === 1) {
      const single = candidates[0];
      if (!single) {
        return {
          reconciliationId,
          policy,
          status: "REJECTED",
          conflicts: Object.freeze([]),
          candidateCount: 0,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }
      return {
        reconciliationId,
        policy,
        reconciledRecord: single,
        status: "RECONCILED",
        conflicts: Object.freeze([]),
        candidateCount: 1,
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
        reconciledAt: now,
      };
    }

    // Collect all pairwise conflicts
    const allConflicts: MemoryConflictItem[] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (a && b) {
          const c = this.detectConflicts(a, b);
          allConflicts.push(...c);
        }
      }
    }

    // If authority injection detected, immediately fail-closed with BLOCKED
    if (allConflicts.some((c) => c.conflictType === "AUTHORITY_INJECTION")) {
      return {
        reconciliationId,
        policy,
        status: "BLOCKED",
        conflicts: Object.freeze(allConflicts),
        candidateCount: candidates.length,
        authoritative: false,
        terminalAuthority: false,
        verificationAuthority: false,
        reconciledAt: now,
      };
    }

    switch (policy) {
      case "CONSERVATIVE_CONFLICT": {
        if (allConflicts.length > 0) {
          return {
            reconciliationId,
            policy,
            status: "CONFLICT_PRESERVED",
            conflicts: Object.freeze(allConflicts),
            candidateCount: candidates.length,
            authoritative: false,
            terminalAuthority: false,
            verificationAuthority: false,
            reconciledAt: now,
          };
        }
        return {
          reconciliationId,
          policy,
          reconciledRecord: candidates[0],
          status: "RECONCILED",
          conflicts: Object.freeze([]),
          candidateCount: candidates.length,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }

      case "LATEST_VALID": {
        const validCandidates = candidates.filter(
          (c) => c.freshness === "FRESH" && c.status === "ACTIVE"
        );
        if (validCandidates.length === 0) {
          return {
            reconciliationId,
            policy,
            status: "BLOCKED",
            conflicts: Object.freeze(allConflicts),
            candidateCount: candidates.length,
            authoritative: false,
            terminalAuthority: false,
            verificationAuthority: false,
            reconciledAt: now,
          };
        }
        const sorted = [...validCandidates].sort((a, b) => {
          if (b.version !== a.version) return b.version - a.version;
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        });
        return {
          reconciliationId,
          policy,
          reconciledRecord: sorted[0],
          status: "RECONCILED",
          conflicts: Object.freeze(allConflicts),
          candidateCount: candidates.length,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }

      case "PROVENANCE_PRIORITY": {
        const validCandidates = candidates.filter(
          (c) => c.freshness === "FRESH" && c.status === "ACTIVE"
        );
        if (validCandidates.length === 0) {
          return {
            reconciliationId,
            policy,
            status: "BLOCKED",
            conflicts: Object.freeze(allConflicts),
            candidateCount: candidates.length,
            authoritative: false,
            terminalAuthority: false,
            verificationAuthority: false,
            reconciledAt: now,
          };
        }
        const sorted = [...validCandidates].sort((a, b) => {
          const rankA = TRUST_CLASS_RANKS[a.authorityClassification] ?? 1;
          const rankB = TRUST_CLASS_RANKS[b.authorityClassification] ?? 1;
          if (rankB !== rankA) return rankB - rankA;
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return b.version - a.version;
        });
        return {
          reconciliationId,
          policy,
          reconciledRecord: sorted[0],
          status: "RECONCILED",
          conflicts: Object.freeze(allConflicts),
          candidateCount: candidates.length,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }

      case "MULTI_SOURCE_CONSENSUS": {
        const groups = new Map<string, MemoryRecord[]>();
        for (const c of candidates) {
          const list = groups.get(c.contentDigest) ?? [];
          list.push(c);
          groups.set(c.contentDigest, list);
        }

        let bestGroup: MemoryRecord[] | undefined;
        let maxDistinctAgents = 0;

        for (const list of groups.values()) {
          const distinctAgents = new Set(list.map((r) => r.agentId)).size;
          if (distinctAgents > maxDistinctAgents) {
            maxDistinctAgents = distinctAgents;
            bestGroup = list;
          }
        }

        if (!bestGroup || maxDistinctAgents < 2) {
          return {
            reconciliationId,
            policy,
            status: "CONFLICT_PRESERVED",
            conflicts: Object.freeze(allConflicts),
            candidateCount: candidates.length,
            authoritative: false,
            terminalAuthority: false,
            verificationAuthority: false,
            reconciledAt: now,
          };
        }

        const sortedGroup = [...bestGroup].sort((a, b) => b.version - a.version);
        const winner = sortedGroup[0];
        return {
          reconciliationId,
          policy,
          reconciledRecord: winner,
          status: "RECONCILED",
          conflicts: Object.freeze(allConflicts),
          candidateCount: candidates.length,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }

      case "GOVERNED_ADAPTIVE": {
        const validCandidates = candidates.filter(
          (c) => c.freshness === "FRESH" && c.status === "ACTIVE"
        );
        if (validCandidates.length === 0) {
          return {
            reconciliationId,
            policy,
            status: "BLOCKED",
            conflicts: Object.freeze(allConflicts),
            candidateCount: candidates.length,
            authoritative: false,
            terminalAuthority: false,
            verificationAuthority: false,
            reconciledAt: now,
          };
        }

        const agentCounts = new Map<string, number>();
        for (const c of validCandidates) {
          agentCounts.set(c.contentDigest, (agentCounts.get(c.contentDigest) ?? 0) + 1);
        }

        const scored = validCandidates.map((record) => {
          const trustScore = (TRUST_CLASS_RANKS[record.authorityClassification] ?? 1) / 4;
          const confScore = record.confidence;
          const distinctAgents = agentCounts.get(record.contentDigest) ?? 1;
          const corroborationScore = Math.min(distinctAgents / 3, 1);
          const freshnessScore = record.freshness === "FRESH" ? 1.0 : 0.0;

          const totalScore =
            trustScore * 0.4 +
            confScore * 0.3 +
            corroborationScore * 0.2 +
            freshnessScore * 0.1;

          return { record, totalScore };
        });

        scored.sort((a, b) => b.totalScore - a.totalScore);
        const winner = scored[0]?.record;

        return {
          reconciliationId,
          policy,
          reconciledRecord: winner,
          status: "RECONCILED",
          conflicts: Object.freeze(allConflicts),
          candidateCount: candidates.length,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }

      default: {
        const first = candidates[0];
        const last = candidates[candidates.length - 1];
        return {
          reconciliationId,
          policy,
          status: "BLOCKED",
          conflicts: Object.freeze([
            {
              conflictType: "MEMORY_RECONCILIATION_BLOCKED",
              recordAId: first?.memoryId ?? "UNKNOWN",
              recordBId: last?.memoryId ?? "UNKNOWN",
              reason: `Unknown or unhandled policy: ${String(policy)}`,
              detectedAt: now,
            },
          ]),
          candidateCount: candidates.length,
          authoritative: false,
          terminalAuthority: false,
          verificationAuthority: false,
          reconciledAt: now,
        };
      }
    }
  }
}
