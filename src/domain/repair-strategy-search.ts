/**
 * Phase 88: Autonomous Multi-Tool Repair Strategy Synthesis and Governed Backtracking Exploration
 *
 * Core Domain Model:
 * 1. RepairStrategy definition and immutable lifecycle transitions
 * 2. StrategySearchNode and search-tree DAG representation
 * 3. BacktrackPoint representation preserving immutable historical evidence
 * 4. RepairCandidate model with explicit delta screening and full verification boundaries
 * 5. Cumulative search resource constraints preventing amplification
 * 6. Deterministic failure classifications
 * 7. Canonical hashing and provenance root computation
 *
 * Absolute Invariant:
 * "Strategy search may increase exploration. It must never increase authority."
 * ComposedAuthority ⊆ ExistingAuthority
 * ExplorationOutput = UNTRUSTED_OBSERVATION
 * TerminalAuthority = 0
 */

import { ToolCompositionSpec } from "./dynamic-tool-composition.js";
import { sha256Hex, canonicalJsonStringify } from "./canonical-hash.js";

export type StrategyLifecycleState =
  | "PROPOSED"
  | "VALIDATING"
  | "AUTHORIZED_FOR_EXPLORATION"
  | "EXPLORING"
  | "ANALYZING"
  | "REPAIR_CANDIDATE"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "PRUNED"
  | "BACKTRACKED"
  | "QUARANTINED"
  | "EXPIRED"
  | "REVOKED";

export type StrategySearchFailureClass =
  | "INVALID_STRATEGY"
  | "TOOL_UNAVAILABLE"
  | "TOOL_SCOPE_REJECTED"
  | "COMPOSITION_REJECTED"
  | "EVIDENCE_INSUFFICIENT"
  | "HYPOTHESIS_CONTRADICTED"
  | "REPAIR_CANDIDATE_REJECTED"
  | "DELTA_SCREEN_REJECTED"
  | "FULL_VERIFICATION_FAILED"
  | "RESOURCE_LIMIT"
  | "TIMEOUT"
  | "REVOCATION"
  | "EXPIRATION"
  | "BRANCH_CONTAMINATION"
  | "PROVENANCE_FAILURE"
  | "UNKNOWN_FAILURE";

export type CandidateStatus =
  | "GENERATED"
  | "SCREENED"
  | "REJECTED"
  | "ACCEPTED_FOR_VERIFICATION"
  | "VERIFIED"
  | "FAILED_VERIFICATION"
  | "QUARANTINED";

export type SearchPolicyType =
  | "POLICY_A_FIRST_VALID"
  | "POLICY_B_BOUNDED_BEST_FIRST"
  | "POLICY_C_FAILURE_AWARE_BACKTRACK"
  | "POLICY_D_GOVERNED_ADAPTIVE";

export interface SearchResourceLimits {
  readonly maxSearchWallTimeMs: number;
  readonly maxStrategyNodes: number;
  readonly maxDepth: number;
  readonly maxBranchesPerNode: number;
  readonly maxRepairAttempts: number;
  readonly maxToolInvocations: number;
  readonly maxCandidatePatches: number;
  readonly maxCompositionInvocations: number;
  readonly maxContextBytes: number;
  readonly maxStrategyPayloadBytes: number;
}

export const DEFAULT_SEARCH_RESOURCE_LIMITS: SearchResourceLimits = {
  maxSearchWallTimeMs: 120_000,
  maxStrategyNodes: 16,
  maxDepth: 4,
  maxBranchesPerNode: 4,
  maxRepairAttempts: 12,
  maxToolInvocations: 32,
  maxCandidatePatches: 12,
  maxCompositionInvocations: 16,
  maxContextBytes: 128 * 1024,
  maxStrategyPayloadBytes: 64 * 1024,
};

export interface StrategyTargetScope {
  readonly workspaceScopes: readonly string[];
  readonly repositoryScopes: readonly string[];
  readonly targetFiles: readonly string[];
}

export interface StrategyExpectedChange {
  readonly affectedFiles: readonly string[];
  readonly expectedTestImpact: readonly string[];
  readonly expectedContractImpact?: readonly string[];
}

export interface RepairStrategy {
  readonly strategyId: string;
  readonly searchId: string;
  readonly parentStrategyId?: string;
  readonly depth: number;
  readonly sequenceNumber: number;
  readonly strategyDigest: string;
  readonly toolCompositionDigest: string;
  readonly compositionSpec: ToolCompositionSpec;
  readonly targetScope: StrategyTargetScope;
  readonly hypothesis: string;
  readonly expectedChange: StrategyExpectedChange;
  readonly requiredEvidence: readonly string[];
  readonly resourceBudget: Partial<SearchResourceLimits>;
  readonly status: StrategyLifecycleState;
  readonly failureClass?: StrategySearchFailureClass;
  readonly failureReason?: string;
  readonly advisoryScore?: number;
  readonly provenance: string;
  readonly createdAt: string;
}

export interface StrategySearchNode {
  readonly nodeId: string;
  readonly parentNodeId?: string;
  readonly searchId: string;
  readonly strategyId: string;
  readonly depth: number;
  readonly branchIndex: number;
  readonly cumulativeAttempts: number;
  readonly cumulativeCost: {
    readonly wallTimeMs: number;
    readonly toolInvocations: number;
    readonly compositionInvocations: number;
    readonly contextBytes: number;
  };
  readonly stateDigest: string;
  readonly workspaceSnapshotDigest: string;
  readonly inputEvidenceDigest: string;
  readonly outputEvidenceDigest?: string;
  readonly compositionDigest: string;
  readonly status: StrategyLifecycleState;
  readonly childrenNodeIds: readonly string[];
}

export interface BacktrackPoint {
  readonly searchId: string;
  readonly backtrackId: string;
  readonly nodeId: string;
  readonly parentNodeId?: string;
  readonly workspaceSnapshotDigest: string;
  readonly evidenceDigest: string;
  readonly compositionDigest: string;
  readonly strategyDigest: string;
  readonly actionSequenceBoundary: number;
  readonly resourceAccounting: {
    readonly wallTimeMs: number;
    readonly attemptsUsed: number;
    readonly toolInvocations: number;
  };
  readonly provenanceRoot: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface RepairCandidate {
  readonly candidateId: string;
  readonly searchId: string;
  readonly strategyId: string;
  readonly nodeId: string;
  readonly patchDigest: string;
  readonly patchPayload: {
    readonly diff: string;
    readonly touchedFiles: readonly string[];
  };
  readonly affectedScope: {
    readonly workspaceScope: string;
    readonly repositoryScope: string;
  };
  readonly predictedImpact: {
    readonly candidateTests: readonly string[];
    readonly riskScore: number;
  };
  readonly evidenceDigest: string;
  readonly provenanceRoot: string;
  readonly status: CandidateStatus;
  readonly deltaScreeningResult?: {
    readonly passed: boolean;
    readonly screenedTests: readonly string[];
    readonly authoritative: false;
    readonly fullSuiteRequired: true;
  };
  readonly fullVerificationResult?: {
    readonly taskSatisfied: boolean;
    readonly verificationPassed: boolean;
    readonly policySatisfied: boolean;
    readonly evidenceComplete: boolean;
  };
}

export interface SearchWorkflowContext {
  readonly workflowId: string;
  readonly allowedCapabilities: readonly string[];
  readonly allowedWorkspaceScopes: readonly string[];
  readonly allowedRepositoryScopes: readonly string[];
  readonly isGovernedSystem: boolean;
  readonly callerIdentity?: string;
  readonly isDynamicToolCaller?: boolean;
}

export interface StrategySearchTree {
  readonly searchId: string;
  readonly workflowId: string;
  readonly rootNodeId: string;
  readonly policy: SearchPolicyType;
  readonly nodes: Record<string, StrategySearchNode>;
  readonly strategies: Record<string, RepairStrategy>;
  readonly backtrackPoints: readonly BacktrackPoint[];
  readonly candidates: Record<string, RepairCandidate>;
  readonly cumulativeResources: {
    wallTimeMs: number;
    nodesExplored: number;
    attemptsExecuted: number;
    toolInvocations: number;
    compositionInvocations: number;
    contextBytes: number;
  };
  readonly provenanceRoot: string;
  readonly finalStatus: "SUCCEEDED" | "FAILED" | "PRUNED" | "EXHAUSTED" | "ABORTED";
}

// ----------------------------------------------------------------------------
// Canonical Digest Helpers
// ----------------------------------------------------------------------------

export function computeStrategyDigest(raw: {
  readonly strategyId: string;
  readonly searchId: string;
  readonly parentStrategyId?: string;
  readonly depth: number;
  readonly toolCompositionDigest: string;
  readonly targetScope: StrategyTargetScope;
  readonly hypothesis: string;
  readonly expectedChange: StrategyExpectedChange;
  readonly requiredEvidence: readonly string[];
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeNodeDigest(raw: {
  readonly nodeId: string;
  readonly parentNodeId?: string;
  readonly searchId: string;
  readonly strategyId: string;
  readonly depth: number;
  readonly branchIndex: number;
  readonly workspaceSnapshotDigest: string;
  readonly inputEvidenceDigest: string;
  readonly compositionDigest: string;
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeCandidateDigest(raw: {
  readonly candidateId: string;
  readonly searchId: string;
  readonly strategyId: string;
  readonly nodeId: string;
  readonly patchDigest: string;
  readonly affectedScope: {
    readonly workspaceScope: string;
    readonly repositoryScope: string;
  };
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeBacktrackDigest(raw: {
  readonly backtrackId: string;
  readonly searchId: string;
  readonly nodeId: string;
  readonly workspaceSnapshotDigest: string;
  readonly evidenceDigest: string;
  readonly strategyDigest: string;
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeSearchTreeProvenanceRoot(nodeDigests: readonly string[]): string {
  if (nodeDigests.length === 0) {
    return sha256Hex("EMPTY_SEARCH_TREE_PROVENANCE_ROOT");
  }
  let currentLevel = [...nodeDigests].sort();
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1]! : left;
      nextLevel.push(sha256Hex(left + right));
    }
    currentLevel = nextLevel;
  }
  return currentLevel[0]!;
}
