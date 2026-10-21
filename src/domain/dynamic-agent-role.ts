/**
 * Phase 95: Governed Dynamic Cross-Agent Role Rebalancing Domain Model
 *
 * Encapsulates advisory agent roles, capability profiles, role assignments,
 * transition lifecycles, role negotiation types, anti-thrashing rules,
 * role authority invariants T1-T20, and negative security controls N571-N600.
 *
 * ABSOLUTE PRINCIPLE:
 * Role authority may change. Sovereign authority must not.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Advisory agent roles describing work responsibilities (NOT sovereign authority).
 */
export type AdvisoryAgentRole =
  | "ANALYZER"
  | "IMPLEMENTER"
  | "REVIEWER"
  | "TESTER"
  | "CONTEXT_ANALYST"
  | "DEPENDENCY_ANALYST"
  | "VERIFICATION_ASSISTANT"
  | "RESOURCE_ADVISOR";

/**
 * Lifecycle states of an AgentRoleAssignment.
 */
export type AgentRoleAssignmentStatus =
  | "PROPOSED"
  | "VALIDATING"
  | "AUTHORIZED_FOR_ROLE_ASSIGNMENT"
  | "ACTIVE"
  | "SUPERSEDED"
  | "REJECTED"
  | "EXPIRED"
  | "REVOKED";

/**
 * Rebalancing policy identifiers.
 */
export type RoleRebalancingPolicyType =
  | "STATIC"
  | "LOAD_BASED"
  | "NEED_AWARE"
  | "FAIR_SHARE"
  | "GOVERNED_ADAPTIVE";

/**
 * Negotiation proposal types.
 */
export type RoleNegotiationProposalType =
  | "ROLE_TRANSFER"
  | "ROLE_SWAP"
  | "TEMPORARY_BORROW"
  | "WORKLOAD_HANDOFF"
  | "ADVISORY_SPECIALIZATION";

/**
 * Role capability profile defining bounded advisory capabilities.
 * Invariant: RoleCapability ⊆ ExistingWorkflowCapability.
 */
export interface RoleCapabilityProfile {
  readonly permittedObservationClasses: readonly string[];
  readonly permittedAdvisoryActions: readonly string[];
  readonly toolCategories: readonly string[];
  readonly contextRequirements: readonly string[];
  readonly resourcePreferences: Readonly<Record<string, number>>;
  readonly verificationDependencies: readonly string[];
}

/**
 * Role assignment entity.
 * Represents metadata about advisory responsibility; never confers sovereign authority.
 */
export interface AgentRoleAssignment {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly goalId: string;
  readonly role: AdvisoryAgentRole;
  readonly previousRole?: AdvisoryAgentRole;
  readonly assignmentVersion: number;
  readonly effectiveSequence: number;
  readonly reason: string;
  readonly capabilityProfile: RoleCapabilityProfile;
  readonly resourceProfile: Readonly<Record<string, number>>;
  readonly scopeDigest: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly status: AgentRoleAssignmentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
}

/**
 * Valid transitions between role assignment lifecycle states.
 */
export const VALID_ROLE_STATUS_TRANSITIONS: ReadonlyMap<
  AgentRoleAssignmentStatus,
  readonly AgentRoleAssignmentStatus[]
> = new Map([
  ["PROPOSED", ["VALIDATING", "REJECTED", "REVOKED"]],
  ["VALIDATING", ["AUTHORIZED_FOR_ROLE_ASSIGNMENT", "REJECTED", "REVOKED"]],
  ["AUTHORIZED_FOR_ROLE_ASSIGNMENT", ["ACTIVE", "REJECTED", "REVOKED", "EXPIRED"]],
  ["ACTIVE", ["SUPERSEDED", "REVOKED", "EXPIRED"]],
  ["SUPERSEDED", []],
  ["REJECTED", []],
  ["EXPIRED", []],
  ["REVOKED", []],
]);

export function canTransitionRoleStatus(
  from: AgentRoleAssignmentStatus,
  to: AgentRoleAssignmentStatus
): boolean {
  const allowed = VALID_ROLE_STATUS_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.includes(to);
}

/**
 * Standard default capability profiles for advisory roles.
 */
export const ROLE_DEFAULT_CAPABILITY_PROFILES: Readonly<
  Record<AdvisoryAgentRole, RoleCapabilityProfile>
> = Object.freeze({
  ANALYZER: {
    permittedObservationClasses: ["CODE_STRUCTURE", "DEPENDENCY_GRAPH", "FAILURE_DIAGNOSTICS"],
    permittedAdvisoryActions: ["PROPOSE_DIAGNOSTIC", "PROPOSE_DECOMPOSITION"],
    toolCategories: ["READ_ONLY", "AST_INSPECTION"],
    contextRequirements: ["CENTRALITY_GRAPH", "CALL_HIERARCHY"],
    resourcePreferences: { cpuWeight: 1, memoryWeight: 2, toolCallWeight: 1 },
    verificationDependencies: ["NONE"],
  },
  IMPLEMENTER: {
    permittedObservationClasses: ["CODE_STRUCTURE", "COMPILATION_OUTPUT", "LOCAL_TEST_RESULTS"],
    permittedAdvisoryActions: ["PROPOSE_PATCH", "REQUEST_SPECULATION"],
    toolCategories: ["READ_WRITE_WORKSPACE", "EXECUTE_TESTS"],
    contextRequirements: ["FOCUSED_SYMBOLS", "REPAIR_DIFFS"],
    resourcePreferences: { cpuWeight: 3, memoryWeight: 3, toolCallWeight: 3 },
    verificationDependencies: ["CLEAN_ROOM_VERIFIER"],
  },
  REVIEWER: {
    permittedObservationClasses: ["DIFF_PATCH", "SECURITY_POLICY", "SPEC_INVARIANTS"],
    permittedAdvisoryActions: ["PROPOSE_REVIEW_CRITIQUE", "ADVISE_REJECTION"],
    toolCategories: ["READ_ONLY", "DIFF_INSPECTION"],
    contextRequirements: ["DIFF_VIEW", "POLICY_RULES"],
    resourcePreferences: { cpuWeight: 1, memoryWeight: 1, toolCallWeight: 1 },
    verificationDependencies: ["SOVEREIGN_GATE"],
  },
  TESTER: {
    permittedObservationClasses: ["LOCAL_TEST_RESULTS", "COVERAGE_METRICS", "CRASH_DIAGNOSTICS"],
    permittedAdvisoryActions: ["PROPOSE_TEST_CASE", "REQUEST_LOCAL_VERIFICATION"],
    toolCategories: ["EXECUTE_TESTS", "READ_ONLY"],
    contextRequirements: ["TEST_SUITES", "SYMBOL_SPECS"],
    resourcePreferences: { cpuWeight: 2, memoryWeight: 2, toolCallWeight: 2 },
    verificationDependencies: ["LOCAL_RUNNER"],
  },
  CONTEXT_ANALYST: {
    permittedObservationClasses: ["AST_GRAPH", "CENTRALITY_SCORES", "TOKEN_BUDGETS"],
    permittedAdvisoryActions: ["PROPOSE_CONTEXT_PRUNING", "REQUEST_EXPANSION"],
    toolCategories: ["AST_INSPECTION", "READ_ONLY"],
    contextRequirements: ["FULL_GRAPH"],
    resourcePreferences: { cpuWeight: 2, memoryWeight: 3, toolCallWeight: 1 },
    verificationDependencies: ["NONE"],
  },
  DEPENDENCY_ANALYST: {
    permittedObservationClasses: ["IMPORT_GRAPH", "MODULE_BOUNDARIES", "CONFLICT_MATRIX"],
    permittedAdvisoryActions: ["PROPOSE_ORDERING", "FLAG_CIRCULARITY"],
    toolCategories: ["READ_ONLY", "AST_INSPECTION"],
    contextRequirements: ["MODULE_TREE"],
    resourcePreferences: { cpuWeight: 1, memoryWeight: 2, toolCallWeight: 1 },
    verificationDependencies: ["NONE"],
  },
  VERIFICATION_ASSISTANT: {
    permittedObservationClasses: ["VERIFICATION_SPEC", "CLEAN_ROOM_OUTPUT", "FOURFOLD_EVIDENCE"],
    permittedAdvisoryActions: ["SUBMIT_CLEAN_ROOM_REQUEST", "MONITOR_VERIFICATION"],
    toolCategories: ["VERIFIER_PORT", "READ_ONLY"],
    contextRequirements: ["VERIFICATION_CONTRACT"],
    resourcePreferences: { cpuWeight: 2, memoryWeight: 2, toolCallWeight: 2 },
    verificationDependencies: ["FOURFOLD_GATEKEEPER"],
  },
  RESOURCE_ADVISOR: {
    permittedObservationClasses: ["ALLOCATION_PRESSURE", "POOL_METRICS", "STARVATION_FLAGS"],
    permittedAdvisoryActions: ["PROPOSE_RENEGOTIATION", "ADVISE_REALLOCATION"],
    toolCategories: ["RESOURCE_PORT", "READ_ONLY"],
    contextRequirements: ["RESOURCE_TELEMETRY"],
    resourcePreferences: { cpuWeight: 1, memoryWeight: 1, toolCallWeight: 1 },
    verificationDependencies: ["NONE"],
  },
});

/**
 * Checks whether role capability profile is a strict subset of workflow capability profile.
 * Enforces T2: RoleCapability ⊆ ExistingWorkflowCapability.
 */
export function isRoleCapabilitySubset(
  roleCap: Partial<RoleCapabilityProfile>,
  workflowCap: Partial<RoleCapabilityProfile>
): boolean {
  const isSubset = (subset?: readonly string[], superset?: readonly string[]) => {
    if (!subset || subset.length === 0) return true;
    if (!superset) return false;
    return subset.every((item) => superset.includes(item));
  };

  if (!isSubset(roleCap.permittedObservationClasses, workflowCap.permittedObservationClasses)) {
    return false;
  }
  if (!isSubset(roleCap.permittedAdvisoryActions, workflowCap.permittedAdvisoryActions)) {
    return false;
  }
  if (!isSubset(roleCap.toolCategories, workflowCap.toolCategories)) {
    return false;
  }
  if (!isSubset(roleCap.contextRequirements, workflowCap.contextRequirements)) {
    return false;
  }
  return true;
}

/**
 * Computes deterministic SHA-256 hash of an AgentRoleAssignment.
 */
export function computeRoleAssignmentHash(
  assignment: Omit<AgentRoleAssignment, "authoritative" | "terminalAuthority" | "verificationAuthority" | "policyAuthority">
): string {
  const payload = {
    assignmentId: assignment.assignmentId,
    agentId: assignment.agentId,
    workflowId: assignment.workflowId,
    goalId: assignment.goalId,
    role: assignment.role,
    previousRole: assignment.previousRole,
    assignmentVersion: assignment.assignmentVersion,
    effectiveSequence: assignment.effectiveSequence,
    reason: assignment.reason,
    capabilityProfile: assignment.capabilityProfile,
    resourceProfile: assignment.resourceProfile,
    scopeDigest: assignment.scopeDigest,
    missionContractId: assignment.missionContractId,
    missionContractHash: assignment.missionContractHash,
    provenanceRoot: assignment.provenanceRoot,
    status: assignment.status,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    authoritative: false,
    terminalAuthority: false,
    verificationAuthority: false,
    policyAuthority: false,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Validates the referential and structural integrity of an AgentRoleAssignment.
 */
export function validateRoleAssignment(assignment: AgentRoleAssignment): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  if (!assignment.assignmentId || typeof assignment.assignmentId !== "string" || assignment.assignmentId.trim().length === 0) {
    errors.push("Missing or invalid assignmentId");
  }
  if (!assignment.agentId || typeof assignment.agentId !== "string" || assignment.agentId.trim().length === 0) {
    errors.push("Missing or invalid agentId");
  }
  if (!assignment.workflowId || typeof assignment.workflowId !== "string" || assignment.workflowId.trim().length === 0) {
    errors.push("Missing or invalid workflowId");
  }
  if (!assignment.goalId || typeof assignment.goalId !== "string" || assignment.goalId.trim().length === 0) {
    errors.push("Missing or invalid goalId");
  }
  if (!assignment.role || typeof assignment.role !== "string") {
    errors.push("Missing or invalid role");
  }
  if (typeof assignment.assignmentVersion !== "number" || assignment.assignmentVersion < 1) {
    errors.push("Invalid assignmentVersion (must be positive integer)");
  }
  if (typeof assignment.effectiveSequence !== "number" || assignment.effectiveSequence < 1) {
    errors.push("Invalid effectiveSequence (must be positive integer)");
  }
  if (!assignment.missionContractId || typeof assignment.missionContractId !== "string") {
    errors.push("Missing or invalid missionContractId");
  }
  if (!assignment.missionContractHash || typeof assignment.missionContractHash !== "string" || assignment.missionContractHash.length !== 64) {
    errors.push("Missing or invalid missionContractHash");
  }
  if (!assignment.provenanceRoot || typeof assignment.provenanceRoot !== "string" || assignment.provenanceRoot.length !== 64) {
    errors.push("Missing or invalid provenanceRoot");
  }
  if (assignment.authoritative !== false) {
    errors.push("Role assignment authoritative flag must be strictly false");
  }
  if (assignment.terminalAuthority !== false) {
    errors.push("Role assignment terminalAuthority flag must be strictly false");
  }
  if (assignment.verificationAuthority !== false) {
    errors.push("Role assignment verificationAuthority flag must be strictly false");
  }
  if (assignment.policyAuthority !== false) {
    errors.push("Role assignment policyAuthority flag must be strictly false");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Role Authority Invariants T1-T20 definitions.
 */
export const ROLE_AUTHORITY_INVARIANTS = Object.freeze({
  T1: "Role assignment cannot grant authority",
  T2: "Role capability is a subset of workflow capability",
  T3: "Role scope is a subset of goal scope",
  T4: "Role repository scope is a subset of declared repository scope",
  T5: "Role workspace scope is a subset of declared workspace scope",
  T6: "Role transition cannot substitute agent identity",
  T7: "Role transition cannot substitute worker identity",
  T8: "Role transition cannot substitute lease identity",
  T9: "Role transition cannot substitute Action identity",
  T10: "Role transition cannot substitute Attempt identity",
  T11: "Role transition cannot modify mission-contract identity",
  T12: "Role transition cannot issue terminal authority",
  T13: "Role transition cannot issue verification authority",
  T14: "Role transition cannot issue policy authority",
  T15: "Role transfer is atomically persisted",
  T16: "Stale role assignments cannot overwrite current assignments",
  T17: "Role oscillation is bounded",
  T18: "Role transition preserves provenance",
  T19: "Role transition preserves active speculative branch identity",
  T20: "Role transition preserves working-tree identity",
} as const);

export type RoleAuthorityInvariantKey = keyof typeof ROLE_AUTHORITY_INVARIANTS;

/**
 * Negative Security Controls N571-N600 definitions.
 */
export const SECURITY_CONTROLS_PHASE95 = Object.freeze({
  N571: "role authority injection",
  N572: "role-to-terminal escalation",
  N573: "role-to-verification escalation",
  N574: "role-to-policy escalation",
  N575: "role-to-contract escalation",
  N576: "role-to-credential escalation",
  N577: "role capability expansion",
  N578: "role scope expansion",
  N579: "role repository expansion",
  N580: "role workspace expansion",
  N581: "role goal expansion",
  N582: "stale role transition",
  N583: "role version substitution",
  N584: "assignment identity substitution",
  N585: "agent identity substitution",
  N586: "worker identity substitution",
  N587: "lease identity substitution",
  N588: "Action identity substitution",
  N589: "Attempt identity substitution",
  N590: "role-transfer double assignment",
  N591: "role-transfer lost update",
  N592: "role-thrashing bypass",
  N593: "role-transition resource escalation",
  N594: "role-transition memory escalation",
  N595: "role-transition speculative escalation",
  N596: "role-transition working-tree escalation",
  N597: "role-transition provenance loss",
  N598: "role-transition rollback bypass",
  N599: "role-transition terminal escalation",
  N600: "role-transition oracle/reference leakage",
} as const);

export type Phase95SecurityControlKey = keyof typeof SECURITY_CONTROLS_PHASE95;
