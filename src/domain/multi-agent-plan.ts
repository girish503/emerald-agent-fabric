/**
 * Phase 89: Multi-Agent Plan Domain Model
 *
 * Types for multi-agent advisory plan generation, conflict classification,
 * deterministic reconciliation policies, and non-authoritative plan representations.
 *
 * INVARIANTS:
 * 1. Multiple agents act as advisory planners, not independent authority domains.
 * 2. Agent roles (ANALYZER, IMPLEMENTER, etc.) are descriptive governance metadata;
 *    they do NOT grant additional authority.
 * 3. All plans are UNTRUSTED_OBSERVATION.
 * 4. Reconciled plans possess ZERO terminal, policy, contract, or verification authority.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type AgentRole =
  | "ANALYZER"
  | "IMPLEMENTER"
  | "TEST_ANALYST"
  | "DEPENDENCY_ANALYST"
  | "REVIEWER"
  | "RECONCILER";

export interface ProposedAction {
  readonly actionId: string;
  readonly description: string;
  readonly targetFile: string;
  readonly toolRequired?: string;
  readonly expectedDiffBytes?: number;
}

export interface AgentPlan {
  readonly planId: string;
  readonly goalId: string;
  readonly agentRole: AgentRole;
  readonly planDigest: string;
  readonly proposedActions: readonly ProposedAction[];
  readonly expectedEvidence: readonly string[];
  readonly dependencies: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly verificationPlan: readonly string[];
  readonly provenance: string;
  readonly createdAt: string;
}

export type PlanConflictType =
  | "SCOPE_CONFLICT"
  | "FILE_OWNERSHIP_CONFLICT"
  | "API_CONTRACT_CONFLICT"
  | "SCHEMA_CONFLICT"
  | "DEPENDENCY_CONFLICT"
  | "ORDERING_CONFLICT"
  | "TEST_CONFLICT"
  | "INVARIANT_CONFLICT"
  | "RESOURCE_CONFLICT"
  | "EVIDENCE_CONFLICT"
  | "ASSUMPTION_CONFLICT"
  | "PROVENANCE_CONFLICT";

export interface PlanConflict {
  readonly conflictId: string;
  readonly conflictType: PlanConflictType;
  readonly planIds: readonly string[];
  readonly description: string;
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "BLOCKING";
  readonly affectedFiles?: readonly string[];
}

export type ReconciliationPolicyType =
  | "POLICY_A_STRICT_UNION"
  | "POLICY_B_PRIORITY_ORDERED"
  | "POLICY_C_MINIMUM_CONFLICT"
  | "POLICY_D_GOVERNED_ADAPTIVE";

export interface ReconciledPlan {
  readonly reconciliationId: string;
  readonly goalId: string;
  readonly policy: ReconciliationPolicyType;
  readonly selectedPlanIds: readonly string[];
  readonly reconciledActions: readonly ProposedAction[];
  readonly mergedAssumptions: readonly string[];
  readonly resolvedConflicts: readonly PlanConflict[];
  readonly unresolvedConflicts: readonly PlanConflict[];
  readonly reconciliationDigest: string;
  readonly provenanceRoot: string;
  readonly status: "RECONCILED" | "RECONCILIATION_BLOCKED";
  readonly authoritative: false; // ALWAYS FALSE
  readonly policyAuthority: false; // ALWAYS FALSE
  readonly terminalAuthority: false; // ALWAYS FALSE
  readonly verificationAuthority: false; // ALWAYS FALSE
  readonly createdAt: string;
}

// ----------------------------------------------------------------------------
// Canonical Digest Helpers
// ----------------------------------------------------------------------------

export function computePlanDigest(raw: {
  readonly planId: string;
  readonly goalId: string;
  readonly agentRole: AgentRole;
  readonly proposedActions: readonly ProposedAction[];
  readonly expectedEvidence: readonly string[];
  readonly dependencies: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly verificationPlan: readonly string[];
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}

export function computeConflictDigest(conflict: PlanConflict): string {
  return sha256Hex(canonicalJsonStringify(conflict));
}

export function computeReconciliationDigest(raw: {
  readonly reconciliationId: string;
  readonly goalId: string;
  readonly policy: ReconciliationPolicyType;
  readonly selectedPlanIds: readonly string[];
  readonly reconciledActions: readonly ProposedAction[];
  readonly resolvedConflictDigests: readonly string[];
  readonly unresolvedConflictDigests: readonly string[];
}): string {
  return sha256Hex(canonicalJsonStringify(raw));
}
