/**
 * Phase 90: Dynamic Sub-Goal Context Distillation & AST Call-Graph Centrality Clustering
 *
 * Domain model for ContextCluster, lifecycle states, completeness classifications,
 * resource budgets, and canonical cryptographic hashing.
 *
 * Invariant: Context data is UNTRUSTED_OBSERVATION.
 * It must never grant terminal authority, policy approval, or verification authority.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type ContextClusterLifecycleState =
  | "PROPOSED"
  | "ANALYZING"
  | "SCORING"
  | "VALIDATING"
  | "AUTHORIZED_FOR_OBSERVATION"
  | "MATERIALIZED"
  | "VERIFIED"
  | "REJECTED"
  | "STALE"
  | "QUARANTINED";

export type ContextCompletenessStatus =
  | "COMPLETE"
  | "PARTIALLY_COMPLETE"
  | "INCOMPLETE"
  | "CONTRADICTORY"
  | "STALE";

export interface ContextResourceBudget {
  readonly maxTotalContextBytes: number;        // default: 128KB (131072)
  readonly maxPerStageContextBytes: number;     // default: 64KB (65536)
  readonly maxGraphNodes: number;               // default: 256
  readonly maxGraphEdges: number;               // default: 512
  readonly maxExpansionRounds: number;          // default: 4
  readonly maxNodesAddedPerRound: number;       // default: 32
  readonly maxContextRequestsPerSubGoal: number;// default: 8
  readonly maxRepositoriesPerContext: number;   // default: 8
  readonly maxUnresolvedReferences: number;     // default: 32
}

export const DEFAULT_CONTEXT_RESOURCE_LIMITS: ContextResourceBudget = {
  maxTotalContextBytes: 131072,
  maxPerStageContextBytes: 65536,
  maxGraphNodes: 256,
  maxGraphEdges: 512,
  maxExpansionRounds: 4,
  maxNodesAddedPerRound: 32,
  maxContextRequestsPerSubGoal: 8,
  maxRepositoriesPerContext: 8,
  maxUnresolvedReferences: 32,
};

export interface ContextCluster {
  readonly clusterId: string;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly rootNodes: readonly string[];
  readonly memberNodes: readonly string[];
  readonly centralityScore: number;
  readonly semanticRelevanceScore: number;
  readonly dependencyRelevanceScore: number;
  readonly testRelevanceScore: number;
  readonly crossRepositoryRelevanceScore: number;
  readonly freshness: string;
  readonly contextDigest: string;
  readonly provenanceRoot: string;
  readonly estimatedTokens: number;
  readonly estimatedBytes: number;
  readonly completenessStatus: ContextCompletenessStatus;
  readonly lifecycleState: ContextClusterLifecycleState;
  // Strict non-authority invariants (K1)
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly policyApproval: false;
  readonly verificationAuthority: false;
  readonly createdAt: string;
}

export function computeClusterDigest(
  cluster: Omit<
    ContextCluster,
    "contextDigest" | "provenanceRoot" | "authoritative" | "terminalAuthority" | "policyApproval" | "verificationAuthority"
  >
): string {
  return sha256Hex(
    canonicalJsonStringify({
      clusterId: cluster.clusterId,
      goalId: cluster.goalId,
      repositoryId: cluster.repositoryId,
      rootNodes: [...cluster.rootNodes].sort(),
      memberNodes: [...cluster.memberNodes].sort(),
      centralityScore: cluster.centralityScore,
      semanticRelevanceScore: cluster.semanticRelevanceScore,
      dependencyRelevanceScore: cluster.dependencyRelevanceScore,
      testRelevanceScore: cluster.testRelevanceScore,
      crossRepositoryRelevanceScore: cluster.crossRepositoryRelevanceScore,
      freshness: cluster.freshness,
      estimatedTokens: cluster.estimatedTokens,
      estimatedBytes: cluster.estimatedBytes,
      completenessStatus: cluster.completenessStatus,
      lifecycleState: cluster.lifecycleState,
      createdAt: cluster.createdAt,
    })
  );
}

export function computeContextProvenanceRoot(
  clusterDigest: string,
  nodeDigests: readonly string[],
  edgeDigests: readonly string[]
): string {
  const sortedNodes = [...nodeDigests].sort();
  const sortedEdges = [...edgeDigests].sort();
  return sha256Hex(
    canonicalJsonStringify({
      clusterDigest,
      nodesRoot: sha256Hex(canonicalJsonStringify(sortedNodes)),
      edgesRoot: sha256Hex(canonicalJsonStringify(sortedEdges)),
    })
  );
}
