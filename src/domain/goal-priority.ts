/**
 * Phase 96: Governed Hierarchical Goal Priority Domain Model
 *
 * Implements deterministic goal priority classes, priority scoring,
 * hierarchical goal dependency ordering, negative security controls N601-N630,
 * and goal priority invariants P1-P20.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Work priority may change. Goal authority must not.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

/**
 * Governed priority classes.
 * Priority class indicates scheduling preference; NEVER confers authority.
 */
export type GoalPriorityClass =
  | "CRITICAL"
  | "HIGH"
  | "NORMAL"
  | "LOW"
  | "DEFERRED";

export const PRIORITY_CLASS_WEIGHTS: Readonly<Record<GoalPriorityClass, number>> = {
  CRITICAL: 1000,
  HIGH: 750,
  NORMAL: 500,
  LOW: 250,
  DEFERRED: 100,
};

/**
 * Goal priority lifecycle states.
 * Append-oriented lifecycle; historical priority states are immutable.
 */
export type GoalPriorityStatus =
  | "PROPOSED"
  | "EVALUATING"
  | "AUTHORIZED_FOR_SCHEDULING"
  | "ACTIVE"
  | "SUPERSEDED"
  | "REJECTED"
  | "EXPIRED"
  | "REVOKED";

/**
 * Dependency relationships between hierarchical goals.
 */
export type GoalDependencyType =
  | "REQUIRED_BEFORE"
  | "REQUIRED_AFTER"
  | "OPTIONAL"
  | "INFORMATIONAL"
  | "VERIFICATION_DEPENDENCY"
  | "RESOURCE_DEPENDENCY"
  | "WORKING_TREE_DEPENDENCY"
  | "SPECULATIVE_DEPENDENCY";

/**
 * Goal Priority Entity.
 * Represents governed scheduling ordering.
 * Invariant P1: Priority cannot grant authority.
 */
export interface GoalPriority {
  readonly priorityId: string;
  readonly goalId: string;
  readonly parentGoalId?: string;
  readonly taskId: string;
  readonly workflowId: string;
  readonly agentId?: string;
  readonly priorityClass: GoalPriorityClass;
  readonly priorityScore: number; // 0 to 1000, deterministic
  readonly criticality: number; // 0 to 100
  readonly urgency: number; // 0 to 100
  readonly dependencyCriticality: number; // 0 to 100
  readonly verificationCriticality: number; // 0 to 100
  readonly resourcePressure: number; // 0 to 100
  readonly starvationAge: number; // ms or ticks waiting
  readonly priorityVersion: number; // monotonic sequence per goal
  readonly reason: string;
  readonly scopeDigest: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot: string;
  readonly createdSequence: number;
  readonly status: GoalPriorityStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly verificationAuthority: false;
  readonly policyAuthority: false;
}

/**
 * Parameters for computing a deterministic priority score.
 */
export interface PriorityScoreInput {
  readonly priorityClass: GoalPriorityClass;
  readonly criticality: number; // 0 - 100
  readonly dependencyCriticality: number; // 0 - 100
  readonly verificationCriticality: number; // 0 - 100
  readonly resourcePressure: number; // 0 - 100
  readonly starvationAge: number; // ms elapsed without service
  readonly remainingWorkEstimate?: number; // 0 - 100
  readonly recoveryCost?: number; // 0 - 100
  readonly speculativeBranchDependency?: boolean;
  readonly workingTreeConflictRisk?: number; // 0 - 100
}

/**
 * Computes deterministic priority score (0 - 1000).
 * Scoring is mathematical and purely derived from governed metrics.
 * Model self-reported urgency is explicitly NOT authoritative.
 */
export function computePriorityScore(input: PriorityScoreInput): number {
  const baseWeight = PRIORITY_CLASS_WEIGHTS[input.priorityClass];
  const critComponent = Math.min(100, Math.max(0, input.criticality)) * 2.5; // up to 250
  const depComponent = Math.min(100, Math.max(0, input.dependencyCriticality)) * 1.5; // up to 150
  const verifComponent = Math.min(100, Math.max(0, input.verificationCriticality)) * 1.0; // up to 100

  // Bounded starvation boost: up to +150 points for aging
  const starvationBoost = Math.min(150, Math.floor(input.starvationAge / 1000) * 10);

  // Pressure adjustment: under elevated pressure, prioritize high-efficiency goals
  const pressureAdj = (input.resourcePressure / 100) * 50;

  // Conflict risk penalty: goals with high working-tree conflict risk lose precedence
  const conflictPenalty = ((input.workingTreeConflictRisk ?? 0) / 100) * 60;

  // Speculative dependency boost: verification of speculative branches is prioritized
  const speculativeBoost = input.speculativeBranchDependency ? 40 : 0;

  const rawScore =
    (baseWeight * 0.4) +
    critComponent +
    depComponent +
    verifComponent +
    starvationBoost +
    speculativeBoost -
    pressureAdj -
    conflictPenalty;

  return Math.min(1000, Math.max(0, Math.round(rawScore)));
}

/**
 * Computes deterministic SHA-256 digest of GoalPriority.
 */
export function computeGoalPriorityHash(
  priority: Omit<GoalPriority, "authoritative" | "terminalAuthority" | "verificationAuthority" | "policyAuthority">
): string {
  const payload = {
    priorityId: priority.priorityId,
    goalId: priority.goalId,
    parentGoalId: priority.parentGoalId ?? null,
    taskId: priority.taskId,
    workflowId: priority.workflowId,
    agentId: priority.agentId ?? null,
    priorityClass: priority.priorityClass,
    priorityScore: priority.priorityScore,
    criticality: priority.criticality,
    urgency: priority.urgency,
    dependencyCriticality: priority.dependencyCriticality,
    verificationCriticality: priority.verificationCriticality,
    resourcePressure: priority.resourcePressure,
    starvationAge: priority.starvationAge,
    priorityVersion: priority.priorityVersion,
    reason: priority.reason,
    scopeDigest: priority.scopeDigest,
    missionContractId: priority.missionContractId,
    missionContractHash: priority.missionContractHash,
    provenanceRoot: priority.provenanceRoot,
    createdSequence: priority.createdSequence,
    status: priority.status,
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/**
 * Validates GoalPriority entity constraints and fail-closed security properties.
 */
export function validateGoalPriority(priority: GoalPriority): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];

  if (!priority.priorityId || priority.priorityId.trim() === "") {
    errors.push("Missing or invalid priorityId");
  }
  if (!priority.goalId || priority.goalId.trim() === "") {
    errors.push("Missing or invalid goalId");
  }
  if (!priority.taskId || priority.taskId.trim() === "") {
    errors.push("Missing or invalid taskId");
  }
  if (!priority.workflowId || priority.workflowId.trim() === "") {
    errors.push("Missing or invalid workflowId");
  }
  if (!priority.missionContractId || priority.missionContractId.trim() === "") {
    errors.push("Missing or invalid missionContractId (Invariant P2)");
  }
  if (!priority.missionContractHash || priority.missionContractHash.trim() === "") {
    errors.push("Missing or invalid missionContractHash (Invariant P2)");
  }
  if (!priority.provenanceRoot || priority.provenanceRoot.trim() === "") {
    errors.push("Missing or invalid provenanceRoot (Invariant P15)");
  }
  if (priority.priorityVersion < 1) {
    errors.push("priorityVersion must be >= 1 (Invariant P10)");
  }
  if (priority.priorityScore < 0 || priority.priorityScore > 1000) {
    errors.push("priorityScore must be between 0 and 1000");
  }
  if (priority.authoritative !== false) {
    errors.push("Goal priority must never be authoritative (Invariant P1)");
  }
  if (priority.terminalAuthority !== false) {
    errors.push("Goal priority must never confer terminal authority (Invariant P3)");
  }
  if (priority.verificationAuthority !== false) {
    errors.push("Goal priority must never confer verification authority (Invariant P4)");
  }
  if (priority.policyAuthority !== false) {
    errors.push("Goal priority must never confer policy authority (Invariant P5)");
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  };
}

/**
 * Cycle detection in hierarchical goal dependency graphs.
 * Returns true if a circular dependency exists (e.g., Parent -> Child -> Parent).
 */
export function detectDependencyCycle(
  edges: readonly { readonly fromGoalId: string; readonly toGoalId: string }[]
): boolean {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.fromGoalId) ?? [];
    list.push(edge.toGoalId);
    adj.set(edge.fromGoalId, list);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    recStack.add(node);

    const neighbors = adj.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true; // Cycle detected
      }
    }

    recStack.delete(node);
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }

  return false;
}

/**
 * Negative Security Controls for Phase 96 (N601-N630).
 */
export const SECURITY_CONTROLS_PHASE96 = {
  N601: "priority authority injection",
  N602: "priority-to-terminal escalation",
  N603: "priority-to-verification escalation",
  N604: "priority-to-policy escalation",
  N605: "priority-to-contract escalation",
  N606: "priority-to-credential escalation",
  N607: "priority capability expansion",
  N608: "priority goal scope expansion",
  N609: "priority repository scope expansion",
  N610: "priority workspace scope expansion",
  N611: "priority agent identity substitution",
  N612: "priority worker identity substitution",
  N613: "priority lease identity substitution",
  N614: "priority Action substitution",
  N615: "priority Attempt substitution",
  N616: "stale priority acceptance",
  N617: "priority version rollback",
  N618: "priority score manipulation",
  N619: "urgency injection",
  N620: "dependency criticality spoofing",
  N621: "pre-emption bypass",
  N622: "hidden cancellation",
  N623: "checkpoint substitution",
  N624: "stale resume",
  N625: "priority inversion bypass",
  N626: "starvation protection bypass",
  N627: "pre-emption cascade suppression",
  N628: "speculative branch priority escalation",
  N629: "resource authority escalation through priority",
  N630: "oracle/reference leakage through priority",
} as const;

export type Phase96SecurityControlKey = keyof typeof SECURITY_CONTROLS_PHASE96;

/**
 * Goal Priority Invariants for Phase 96 (P1-P20).
 */
export const GOAL_PRIORITY_INVARIANTS = {
  P1: "Priority cannot grant authority",
  P2: "Priority cannot modify mission-contract identity",
  P3: "Priority cannot issue terminal authority",
  P4: "Priority cannot issue verification authority",
  P5: "Priority cannot issue policy authority",
  P6: "Priority scope ⊆ goal scope",
  P7: "Priority repository scope ⊆ declared repository scope",
  P8: "Priority workspace scope ⊆ declared workspace scope",
  P9: "Stale priority cannot overwrite current priority",
  P10: "Priority versioning is monotonic",
  P11: "Pre-emption cannot silently become cancellation",
  P12: "Pre-emption preserves Action identity",
  P13: "Pre-emption preserves Attempt identity",
  P14: "Pre-emption preserves idempotency",
  P15: "Checkpoint provenance cannot be removed",
  P16: "Stale checkpoint cannot silently resume",
  P17: "Priority inversion cannot bypass governance",
  P18: "Starvation protection cannot create authority",
  P19: "Pre-emption cannot corrupt speculative branch identity",
  P20: "Resume cannot bypass sovereign verification",
} as const;

export type GoalPriorityInvariantKey = keyof typeof GOAL_PRIORITY_INVARIANTS;
