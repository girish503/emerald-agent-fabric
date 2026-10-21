/**
 * Phase 89 — Governed Hierarchical Goal Decomposition and Multi-Agent Plan Reconciliation
 *
 * Domain types, lifecycle models, DAG dependency graphs, authority derivation rules,
 * goal atomicity metrics, and cryptographic provenance structures for hierarchical goal trees.
 *
 * CENTRAL ARCHITECTURAL INVARIANT:
 * "Decomposition may reduce reasoning complexity. It must never increase authority."
 * "GoalAuthority ⊆ ParentAuthority"
 * "GoalCapabilities ⊆ ParentCapabilities"
 * "GoalScope ⊆ ParentScope"
 * "GoalResources ≤ ParentRemainingResources"
 * "Local verification establishes SubGoalVerified; it never establishes MissionTerminalSuccess."
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import type { AllowedToolCapability } from "./dynamic-tool.js";

export type GoalLifecycleState =
  | "PROPOSED"
  | "VALIDATING"
  | "AUTHORIZED_FOR_PLANNING"
  | "DECOMPOSED"
  | "READY"
  | "IN_PROGRESS"
  | "SUBGOAL_COMPLETE"
  | "RECONCILIATION_PENDING"
  | "RECONCILED"
  | "VERIFICATION_PENDING"
  | "VERIFIED"
  | "FAILED"
  | "BLOCKED"
  | "PRUNED"
  | "QUARANTINED"
  | "REVOKED"
  | "EXPIRED";

export type GoalFailureClass =
  | "LOCAL_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "RECONCILIATION_FAILURE"
  | "GLOBAL_INVARIANT_FAILURE"
  | "VERIFICATION_FAILURE"
  | "RESOURCE_FAILURE"
  | "AUTHORITY_FAILURE"
  | "VALIDATION_FAILED"
  | "CYCLE_DETECTED"
  | "SCOPE_VIOLATION"
  | "CAPABILITY_VIOLATION"
  | "REVOKED_TOOL"
  | "EXPIRED_TOOL"
  | "ORACLE_LEAKAGE";

export interface GoalResourceLimits {
  readonly maxDepth: number;
  readonly maxChildrenPerNode: number;
  readonly maxTotalGoals: number;
  readonly maxDependencyEdges: number;
  readonly maxPlanningCalls: number;
  readonly maxPlanAlternativesPerGoal: number;
  readonly maxReconciliationRounds: number;
  readonly maxTotalToolCalls: number;
  readonly maxTotalWallTimeMs: number;
  readonly maxContextBytes: number;
  readonly maxPlanPayloadBytes: number;
}

export const DEFAULT_GOAL_RESOURCE_LIMITS: GoalResourceLimits = {
  maxDepth: 4,
  maxChildrenPerNode: 4,
  maxTotalGoals: 16,
  maxDependencyEdges: 32,
  maxPlanningCalls: 32,
  maxPlanAlternativesPerGoal: 4,
  maxReconciliationRounds: 4,
  maxTotalToolCalls: 64,
  maxTotalWallTimeMs: 180_000, // 180 seconds
  maxContextBytes: 128 * 1024, // 128 KB
  maxPlanPayloadBytes: 64 * 1024, // 64 KB
};

export interface GoalScope {
  readonly workspaceScopes: readonly string[];
  readonly repositoryScopes: readonly string[];
  readonly targetFiles: readonly string[];
}

export interface GoalAtomicity {
  readonly affectedScopeBounded: boolean;
  readonly acceptanceCriteriaTestable: boolean;
  readonly evidenceExplicit: boolean;
  readonly dependenciesKnown: boolean;
  readonly atomicityScore: number; // 0 to 100
}

export interface GoalNode {
  readonly goalId: string;
  readonly parentGoalId?: string;
  readonly rootGoalId: string;
  readonly depth: number;
  readonly sequenceNumber: number;
  readonly goalDigest: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[]; // goalIds that must be VERIFIED before this goal can execute
  readonly affectedScope: GoalScope;
  readonly requiredCapabilities: readonly AllowedToolCapability[];
  readonly requiredEvidence: readonly string[];
  readonly resourceBudget: Partial<GoalResourceLimits>;
  readonly status: GoalLifecycleState;
  readonly provenance: string;
  readonly failureClass?: GoalFailureClass;
  readonly failureReason?: string;
  readonly atomicity?: GoalAtomicity;
  readonly createdAt: string;
}

export interface GoalDependencyEdge {
  readonly fromGoalId: string; // Prerequisite goal
  readonly toGoalId: string; // Dependent goal
}

export interface GoalTree {
  readonly rootGoalId: string;
  readonly workflowId: string;
  readonly nodes: Record<string, GoalNode>;
  readonly edges: readonly { readonly parentId: string; readonly childId: string }[];
  readonly depth: number;
  readonly width: number;
  readonly dependencyEdges: readonly GoalDependencyEdge[];
  readonly treeDigest: string;
  readonly provenanceRoot: string;
  readonly status:
    | "INITIALIZED"
    | "DECOMPOSED"
    | "IN_PROGRESS"
    | "RECONCILED"
    | "VERIFIED"
    | "FAILED"
    | "BLOCKED"
    | "PRUNED";
}

export interface SubGoalContract {
  readonly goalId: string;
  readonly parentGoalId: string;
  readonly rootGoalId: string;
  readonly objective: string;
  readonly scope: GoalScope;
  readonly expectedArtifacts: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly resourceLimits: Partial<GoalResourceLimits>;
  readonly verificationRequirements: readonly string[];
  readonly parentContractDigest: string;
  readonly contractDigest: string;
}

export interface SubGoalLocalVerificationResult {
  readonly goalId: string;
  readonly passed: boolean;
  readonly testResults: readonly {
    readonly testName: string;
    readonly passed: boolean;
    readonly durationMs: number;
  }[];
  readonly verificationType: "UNIT_TEST" | "AST_INVARIANT" | "API_CONTRACT" | "SCHEMA_INVARIANT";
  readonly executionMs: number;
  readonly evidenceDigest: string;
  readonly authoritative: false; // ALWAYS FALSE: Local verification never grants terminal authority
  readonly fullSuiteRequired: true;
}

// ----------------------------------------------------------------------------
// Canonical Digest Helpers
// ----------------------------------------------------------------------------

export function computeGoalDigest(raw: {
  readonly goalId: string;
  readonly parentGoalId?: string;
  readonly rootGoalId: string;
  readonly depth: number;
  readonly sequenceNumber: number;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly affectedScope: GoalScope;
  readonly requiredCapabilities: readonly string[];
  readonly requiredEvidence: readonly string[];
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeSubGoalContractDigest(raw: {
  readonly goalId: string;
  readonly parentGoalId: string;
  readonly rootGoalId: string;
  readonly objective: string;
  readonly scope: GoalScope;
  readonly expectedArtifacts: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly verificationRequirements: readonly string[];
  readonly parentContractDigest: string;
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeGoalTreeDigest(raw: {
  readonly rootGoalId: string;
  readonly workflowId: string;
  readonly depth: number;
  readonly width: number;
  readonly nodeDigests: readonly string[];
  readonly dependencyEdgeDigests: readonly string[];
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeGoalProvenanceRoot(elements: readonly string[]): string {
  return sha256Hex(canonicalJsonStringify([...elements].sort()));
}
