/**
 * Phase 92: Memory Sharing Policy
 *
 * Enforces cross-agent memory sharing governance.
 * Validates agent membership, goal observation permissions, repository scope,
 * workspace scope, freshness, and executes unconditional authority stripping.
 *
 * CRITICAL INVARIANT:
 * "Agents may share knowledge. They must never share authority implicitly."
 */

import { MemoryRecord, validateMemoryRecordIntegrity } from "../domain/cooperative-memory.js";

export interface WorkflowScopeContext {
  readonly workflowId: string;
  readonly declaredAgents: readonly string[];
  readonly declaredGoals: readonly string[];
  readonly declaredRepositories: readonly string[];
  readonly declaredWorkspaces: readonly string[];
  readonly allowCrossGoalSharing?: boolean;
}

export interface SharingPolicyEvaluation {
  readonly allowed: boolean;
  readonly sanitizedRecord?: MemoryRecord;
  readonly reason: string;
  readonly violations: readonly string[];
}

export class MemorySharingPolicy {
  /**
   * Evaluates whether a memory record can be shared with a target agent and goal.
   * If allowed, returns an authority-stripped, sanitized copy of the record.
   */
  public static evaluateSharing(
    record: MemoryRecord,
    targetAgentId: string,
    targetGoalId: string,
    context: WorkflowScopeContext
  ): SharingPolicyEvaluation {
    const violations: string[] = [];

    // 1. Target agent must be part of declared workflow
    if (!context.declaredAgents.includes(targetAgentId)) {
      violations.push(
        `Target agent ${targetAgentId} is not in declared workflow agents [${context.declaredAgents.join(", ")}]`
      );
    }

    // 2. Target goal must be in declared goals
    if (!context.declaredGoals.includes(targetGoalId)) {
      violations.push(
        `Target goal ${targetGoalId} is not in declared workflow goals [${context.declaredGoals.join(", ")}]`
      );
    }

    // 3. Goal boundary check: if cross-goal sharing is disallowed, goal IDs must match
    if (context.allowCrossGoalSharing === false && record.goalId !== targetGoalId) {
      violations.push(
        `Cross-goal sharing disabled: source goal ${record.goalId} !== target goal ${targetGoalId}`
      );
    }

    // 4. Repository scope check
    if (!context.declaredRepositories.includes(record.repositoryId)) {
      violations.push(
        `Repository ${record.repositoryId} is outside declared repositories [${context.declaredRepositories.join(", ")}]`
      );
    }

    // 5. Workspace scope check
    if (!context.declaredWorkspaces.includes(record.workspaceId)) {
      violations.push(
        `Workspace ${record.workspaceId} is outside declared workspaces [${context.declaredWorkspaces.join(", ")}]`
      );
    }

    // 6. Freshness checks: Expired or Revoked memories cannot be shared as current evidence
    if (record.freshness === "EXPIRED") {
      violations.push(`Cannot share EXPIRED memory ${record.memoryId}`);
    }
    if (record.freshness === "REVOKED") {
      violations.push(`Cannot share REVOKED memory ${record.memoryId}`);
    }

    // 7. Status checks
    if (record.status === "REVOKED" || record.status === "REJECTED") {
      violations.push(`Cannot share memory with status ${record.status}`);
    }

    // 8. Integrity check
    const integrity = validateMemoryRecordIntegrity(record);
    if (!integrity.valid) {
      violations.push(`Memory integrity failure: ${integrity.errors.join("; ")}`);
    }

    if (violations.length > 0) {
      return {
        allowed: false,
        reason: "SHARING_POLICY_VIOLATION",
        violations: Object.freeze(violations),
      };
    }

    // Authority stripping: sanitize to guarantee zero implicit authority transfer
    const sanitizedRecord: MemoryRecord = {
      ...record,
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
      authorityClassification:
        record.authorityClassification === "SOVEREIGN_VERIFIED_EVIDENCE"
          ? "SOVEREIGN_VERIFIED_EVIDENCE"
          : record.authorityClassification === "LOCALLY_VERIFIED_OBSERVATION"
          ? "LOCALLY_VERIFIED_OBSERVATION"
          : record.authorityClassification === "PROVENANCE_VERIFIED_OBSERVATION"
          ? "PROVENANCE_VERIFIED_OBSERVATION"
          : "UNTRUSTED_OBSERVATION",
    };

    return {
      allowed: true,
      sanitizedRecord,
      reason: "SHARING_PERMITTED",
      violations: Object.freeze([]),
    };
  }
}
