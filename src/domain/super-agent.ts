/**
 * Super Agent Domain Model & Multi-Agent Contracts (Phase 2).
 *
 * Core Architectural Invariants:
 * 1. Decomposition may reduce reasoning complexity. It must NEVER increase authority:
 *    - ChildAuthority ⊆ ParentAuthority
 *    - ChildCapabilities ⊆ ParentCapabilities
 *    - ChildScope ⊆ ParentScope
 *    - ChildResources ≤ ParentRemainingResources
 * 2. Specialized Roles:
 *    - RESEARCHER: Read-only codebase exploration, symbol search, and repository inspection.
 *    - CODER: Targeted code implementation, file editing, and test authoring.
 *    - TESTER: Deterministic test execution and regression evaluation.
 *    - REVIEWER: Read-only code review, invariant verification, and diff auditing.
 * 3. Topological Integrity:
 *    - Subtasks form a strict Directed Acyclic Graph (DAG).
 *    - Cycles, self-dependencies, duplicate IDs, and invalid references are strictly rejected.
 * 4. Independent Verification & Synthesis:
 *    - Local or worker completion does NOT grant verification.
 *    - Independent verification classifies each child into:
 *      VERIFIED, REJECTED, BLOCKED, or UNVERIFIABLE.
 *    - Zero self-approval: missions cannot complete if any child is not VERIFIED.
 *    - No hiding failed or unverifiable children.
 */

import type { ResourceLimits } from "./mission-contract.js";
import { TOOL_CAPABILITY_MAP } from "./tool.js";

// ============================================================================
// Specialized Roles & Narrow Capability Contracts
// ============================================================================

export type SuperAgentRole = "RESEARCHER" | "CODER" | "TESTER" | "REVIEWER";

export interface RoleCapabilityContract {
  readonly role: SuperAgentRole;
  readonly allowedCapabilities: readonly string[];
  readonly allowedTools: readonly string[];
  readonly description: string;
}

export const ROLE_CAPABILITY_CONTRACTS: Readonly<Record<SuperAgentRole, RoleCapabilityContract>> = Object.freeze({
  RESEARCHER: Object.freeze({
    role: "RESEARCHER",
    allowedCapabilities: Object.freeze(["workspace.file.read", "workspace.code.search", "git.read"]),
    allowedTools: Object.freeze(["read_file", "search_code", "git_status", "git_diff"]),
    description: "Read-only exploration, symbol lookup, and repository analysis",
  }),
  CODER: Object.freeze({
    role: "CODER",
    allowedCapabilities: Object.freeze(["workspace.file.read", "workspace.file.write", "git.read"]),
    allowedTools: Object.freeze(["read_file", "write_file", "edit_file", "git_status", "git_diff"]),
    description: "Targeted code implementation, modification, and file writes",
  }),
  TESTER: Object.freeze({
    role: "TESTER",
    allowedCapabilities: Object.freeze(["workspace.file.read", "process.execute"]),
    allowedTools: Object.freeze(["read_file", "run_command"]),
    description: "Test execution and regression validation under server-owned verification policy",
  }),
  REVIEWER: Object.freeze({
    role: "REVIEWER",
    allowedCapabilities: Object.freeze(["workspace.file.read", "git.read"]),
    allowedTools: Object.freeze(["read_file", "git_status", "git_diff"]),
    description: "Read-only code review, diff inspection, and invariant auditing",
  }),
});

/**
 * Validates that every role contract references only real mapped tools, every allowed tool's
 * required capability is present in that role's allowedCapabilities, and (when provided) every
 * role tool is registered in the active ToolAdapterRegistry. Fails closed on any drift.
 */
export function validateRoleToolAlignment(
  registeredToolNames?: readonly string[],
  options?: { readonly allowMissingTools?: readonly string[] }
): void {
  const registeredSet = registeredToolNames ? new Set(registeredToolNames) : null;
  const allowMissing = new Set(options?.allowMissingTools ?? []);
  for (const contract of Object.values(ROLE_CAPABILITY_CONTRACTS)) {
    const capSet = new Set(contract.allowedCapabilities);
    for (const toolName of contract.allowedTools) {
      const mappedCap = TOOL_CAPABILITY_MAP[toolName as keyof typeof TOOL_CAPABILITY_MAP];
      if (!mappedCap) {
        throw new CapabilityEscalationError(
          `Role '${contract.role}' references unmapped tool '${toolName}' absent from TOOL_CAPABILITY_MAP`
        );
      }
      if (!capSet.has(mappedCap)) {
        throw new CapabilityEscalationError(
          `Role '${contract.role}' allows tool '${toolName}' requiring capability '${mappedCap}' absent from role.allowedCapabilities`
        );
      }
      if (registeredSet && !registeredSet.has(toolName) && !allowMissing.has(toolName)) {
        throw new CapabilityEscalationError(
          `Role '${contract.role}' allows tool '${toolName}' which is missing from ToolAdapterRegistry`
        );
      }
    }
  }
}

// ============================================================================
// Error Taxonomy
// ============================================================================

export class SuperAgentDecompositionError extends Error {
  constructor(message: string) {
    super(`SuperAgent decomposition rejected: ${message}`);
    this.name = "SuperAgentDecompositionError";
  }
}

export class CapabilityEscalationError extends Error {
  constructor(message: string) {
    super(`Capability escalation rejected: ${message}`);
    this.name = "CapabilityEscalationError";
  }
}

export class ResourceBudgetExceededError extends Error {
  constructor(message: string) {
    super(`Resource budget exceeded: ${message}`);
    this.name = "ResourceBudgetExceededError";
  }
}

export class SynthesisVerificationError extends Error {
  constructor(message: string) {
    super(`Mission synthesis verification failed: ${message}`);
    this.name = "SynthesisVerificationError";
  }
}

// ============================================================================
// Subtask & Decomposition Specifications
// ============================================================================

export interface SubtaskContractSpecInput {
  readonly subtaskId: string;
  readonly role: SuperAgentRole;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly verificationSpecs?: readonly any[];
  readonly resourceLimits?: {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly maxOutputBytes?: number;
  };
  readonly customCapabilities?: readonly string[];
  readonly inputPayload?: Record<string, unknown>;
}

export interface SubtaskContractSpec {
  readonly subtaskId: string;
  readonly role: SuperAgentRole;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly verificationSpecs: readonly any[];
  readonly resourceLimits: {
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly maxOutputBytes: number;
  };
  readonly allowedCapabilities: readonly string[];
  readonly allowedTools: readonly string[];
  readonly inputPayload: Record<string, unknown>;
}

export interface DecompositionPlanInput {
  readonly missionTaskId: string;
  readonly subtasks: readonly SubtaskContractSpecInput[];
  readonly maxDepth?: number;
  readonly maxChildrenPerParent?: number;
}

export interface DecompositionPlan {
  readonly missionTaskId: string;
  readonly subtasks: readonly SubtaskContractSpec[];
  readonly contentHash: string;
  readonly maxDepth: number;
  readonly maxChildrenPerParent: number;
  readonly createdAt: string;
}

// ============================================================================
// Child Verification & Synthesis Types
// ============================================================================

export type ChildVerificationStatus = "VERIFIED" | "REJECTED" | "BLOCKED" | "UNVERIFIABLE";

export interface SubtaskVerificationReport {
  readonly subtaskId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly role: SuperAgentRole;
  readonly runStatus: string | null;
  readonly status: ChildVerificationStatus;
  readonly verifiedAt: string;
  readonly reason: string;
  readonly verificationPassed: boolean;
  readonly evidenceCount: number;
}

export type MissionSynthesisVerdict = "SUCCESS" | "FAILED" | "BLOCKED" | "IN_PROGRESS";

export interface MissionSynthesisReport {
  readonly missionTaskId: string;
  readonly missionRunId: string | null;
  readonly verdict: MissionSynthesisVerdict;
  readonly totalSubtasks: number;
  readonly verifiedCount: number;
  readonly rejectedCount: number;
  readonly blockedCount: number;
  readonly unverifiableCount: number;
  readonly subtaskReports: readonly SubtaskVerificationReport[];
  readonly synthesizedAt: string;
  readonly summary: string;
  readonly canCompleteMission: boolean;
}

// ============================================================================
// Validation & DAG Algorithms
// ============================================================================

/**
 * Validates DAG dependency constraints and returns the subtasks sorted in topological order.
 * Rejects duplicate IDs, missing dependency references, self-loops, and dependency cycles.
 */
export function validateDecompositionDAG(
  subtasks: readonly SubtaskContractSpecInput[]
): readonly SubtaskContractSpecInput[] {
  if (!subtasks || subtasks.length === 0) {
    throw new SuperAgentDecompositionError("Decomposition must contain at least one subtask.");
  }

  const seenIds = new Set<string>();
  const subtaskMap = new Map<string, SubtaskContractSpecInput>();

  for (const s of subtasks) {
    if (!s.subtaskId || typeof s.subtaskId !== "string" || s.subtaskId.trim().length === 0) {
      throw new SuperAgentDecompositionError("Each subtask must possess a non-empty string subtaskId.");
    }
    const cleanId = s.subtaskId.trim();
    if (seenIds.has(cleanId)) {
      throw new SuperAgentDecompositionError(`Duplicate subtask ID '${cleanId}' detected in decomposition plan.`);
    }
    seenIds.add(cleanId);
    subtaskMap.set(cleanId, s);
  }

  // Validate dependencies exist, no self-dependency, and no duplicate dependencies
  for (const s of subtasks) {
    const cleanSubtaskId = s.subtaskId.trim();
    const deps = s.dependencies ?? [];
    const seenDeps = new Set<string>();
    for (const rawDep of deps) {
      const dep = typeof rawDep === "string" ? rawDep.trim() : rawDep;
      if (dep === cleanSubtaskId) {
        throw new SuperAgentDecompositionError(`Self-dependency detected in subtask '${s.subtaskId}'.`);
      }
      if (seenDeps.has(dep)) {
        throw new SuperAgentDecompositionError(`Duplicate dependency '${dep}' detected in subtask '${s.subtaskId}'.`);
      }
      seenDeps.add(dep);
      if (!subtaskMap.has(dep)) {
        throw new SuperAgentDecompositionError(
          `Subtask '${s.subtaskId}' depends on non-existent subtask '${dep}'.`
        );
      }
    }
  }

  // Topological sort via DFS (3-state coloring: 0=unvisited, 1=visiting, 2=visited)
  const state = new Map<string, 0 | 1 | 2>();
  for (const id of seenIds) {
    state.set(id, 0);
  }

  const sorted: SubtaskContractSpecInput[] = [];

  function visit(id: string, path: string[]): void {
    const s = state.get(id);
    if (s === 1) {
      const cyclePath = [...path, id].join(" -> ");
      throw new SuperAgentDecompositionError(`Cycle detected in subtask dependencies: ${cyclePath}`);
    }
    if (s === 2) {
      return;
    }

    state.set(id, 1);
    const subtask = subtaskMap.get(id)!;
    const deps = subtask.dependencies ?? [];

    for (const rawDep of deps) {
      const dep = typeof rawDep === "string" ? rawDep.trim() : rawDep;
      visit(dep, [...path, id]);
    }

    state.set(id, 2);
    sorted.push(subtask);
  }

  for (const id of seenIds) {
    if (state.get(id) === 0) {
      visit(id, []);
    }
  }

  return Object.freeze(sorted);
}

/**
 * Validates that requested capabilities strictly adhere to:
 * 1. Role capability profile bounds (ChildCapabilities ⊆ RoleProfile)
 * 2. Parent contract allowed capabilities (ChildCapabilities ⊆ ParentCapabilities)
 * No capability escalation or privilege inheritance is permitted.
 */
export function validateSubtaskCapabilities(
  role: SuperAgentRole,
  requestedCaps: readonly string[] | undefined,
  parentCaps: readonly string[]
): readonly string[] {
  const roleContract = ROLE_CAPABILITY_CONTRACTS[role];
  if (!roleContract) {
    throw new CapabilityEscalationError(`Unknown or invalid super agent role: '${role}'.`);
  }

  const targetCaps = requestedCaps && requestedCaps.length > 0
    ? requestedCaps
    : roleContract.allowedCapabilities;

  const parentSet = new Set(parentCaps);
  const roleSet = new Set(roleContract.allowedCapabilities);

  for (const cap of targetCaps) {
    if (!roleSet.has(cap)) {
      throw new CapabilityEscalationError(
        `Role '${role}' is not authorized for capability '${cap}'. Permitted: [${roleContract.allowedCapabilities.join(", ")}].`
      );
    }
    if (!parentSet.has(cap)) {
      throw new CapabilityEscalationError(
        `Subtask requests capability '${cap}' which is NOT granted to the parent mission contract. Permitted: [${parentCaps.join(", ")}].`
      );
    }
  }

  return Object.freeze([...new Set(targetCaps)].sort());
}

/**
 * Validates aggregate and individual resource bounds against parent mission ceilings.
 */
export function validateSubtaskResourceCeilings(
  subtasks: readonly SubtaskContractSpecInput[],
  parentLimits: ResourceLimits
): void {
  let aggregateTimeoutMs = 0;
  let aggregateMaxAttempts = 0;
  const defaultTimeoutPerChild = Math.floor(parentLimits.timeoutMs / Math.max(1, subtasks.length));

  for (const s of subtasks) {
    const limits = s.resourceLimits;
    const timeout = limits?.timeoutMs ?? defaultTimeoutPerChild;
    const attempts = limits?.maxAttempts ?? Math.min(parentLimits.maxAttempts, 3);
    const outputBytes = limits?.maxOutputBytes ?? parentLimits.maxOutputBytes;

    if (timeout > parentLimits.timeoutMs) {
      throw new ResourceBudgetExceededError(
        `Subtask '${s.subtaskId}' timeout (${timeout}ms) exceeds parent mission limit (${parentLimits.timeoutMs}ms).`
      );
    }

    if (attempts > parentLimits.maxAttempts) {
      throw new ResourceBudgetExceededError(
        `Subtask '${s.subtaskId}' maxAttempts (${attempts}) exceeds parent mission limit (${parentLimits.maxAttempts}).`
      );
    }

    if (outputBytes > parentLimits.maxOutputBytes) {
      throw new ResourceBudgetExceededError(
        `Subtask '${s.subtaskId}' maxOutputBytes (${outputBytes}) exceeds parent mission limit (${parentLimits.maxOutputBytes}).`
      );
    }

    aggregateTimeoutMs += timeout;
    aggregateMaxAttempts += attempts;
  }

  // Aggregate ceilings check: sum of child timeouts should not exceed parent total timeout
  if (aggregateTimeoutMs > parentLimits.timeoutMs) {
    throw new ResourceBudgetExceededError(
      `Aggregate subtasks timeout (${aggregateTimeoutMs}ms) exceeds parent mission budget (${parentLimits.timeoutMs}ms).`
    );
  }
}
