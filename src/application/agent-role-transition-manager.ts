/**
 * Phase 95: Agent Role Transition Manager
 *
 * Implements version-fenced atomic advisory role transitions, role transfers,
 * scope containment, and append-only transition provenance tracking.
 *
 * ABSOLUTE PRINCIPLE:
 * Role authority may change. Sovereign authority must not.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  AdvisoryAgentRole,
  AgentRoleAssignment,
  ROLE_DEFAULT_CAPABILITY_PROFILES,
  RoleCapabilityProfile,
  isRoleCapabilitySubset,
  validateRoleAssignment,
} from "../domain/dynamic-agent-role.js";

export interface RoleTransitionParams {
  readonly agentId: string;
  readonly workflowId: string;
  readonly goalId: string;
  readonly newRole: AdvisoryAgentRole;
  readonly reason: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly scopeDigest?: string;
  readonly capabilityProfile?: RoleCapabilityProfile;
  readonly resourceProfile?: Readonly<Record<string, number>>;
  readonly workflowCapabilityProfile?: RoleCapabilityProfile;
  readonly activeSpeculativeBranchIds?: readonly string[];
  readonly currentAuthoritativeTreeDigest?: string;
  readonly expectedCurrentVersion?: number;
  readonly timestamp?: string;
}

export interface RoleTransitionEvent {
  readonly eventId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly previousRole?: AdvisoryAgentRole;
  readonly newRole: AdvisoryAgentRole;
  readonly version: number;
  readonly sequence: number;
  readonly reason: string;
  readonly provenanceRoot: string;
  readonly timestamp: string;
}

export class AgentRoleTransitionManager {
  private readonly activeAssignments: Map<string, AgentRoleAssignment> = new Map();
  private readonly historicalAssignments: AgentRoleAssignment[] = [];
  private readonly transitionLog: RoleTransitionEvent[] = [];
  private readonly clock: ClockPort;
  private sequenceCounter = 0;

  // Anti-thrashing / oscillation controls
  private readonly agentTransitionTimestamps: Map<string, number[]> = new Map();
  private minDwellPeriodMs = 1000;
  private maxTransitionsPerWindow = 5;
  private windowDurationMs = 60000;

  constructor(options?: {
    readonly clock?: ClockPort;
    readonly minDwellPeriodMs?: number;
    readonly maxTransitionsPerWindow?: number;
    readonly windowDurationMs?: number;
  }) {
    this.clock = options?.clock ?? new SystemClock();
    if (options?.minDwellPeriodMs !== undefined) {
      this.minDwellPeriodMs = options.minDwellPeriodMs;
    }
    if (options?.maxTransitionsPerWindow !== undefined) {
      this.maxTransitionsPerWindow = options.maxTransitionsPerWindow;
    }
    if (options?.windowDurationMs !== undefined) {
      this.windowDurationMs = options.windowDurationMs;
    }
  }

  public getActiveAssignment(agentId: string): AgentRoleAssignment | undefined {
    return this.activeAssignments.get(agentId);
  }

  public getAllActiveAssignments(): readonly AgentRoleAssignment[] {
    return Object.freeze([...this.activeAssignments.values()]);
  }

  public getTransitionHistory(): readonly RoleTransitionEvent[] {
    return Object.freeze([...this.transitionLog]);
  }

  public getHistoricalAssignments(): readonly AgentRoleAssignment[] {
    return Object.freeze([...this.historicalAssignments]);
  }

  /**
   * Evaluates anti-thrashing rules (hysteresis and rate limiting).
   */
  public checkOscillationAllowed(agentId: string, nowMs: number): { readonly allowed: boolean; readonly reason?: string } {
    const timestamps = this.agentTransitionTimestamps.get(agentId) ?? [];
    if (timestamps.length === 0) {
      return { allowed: true };
    }

    const lastTransition = timestamps[timestamps.length - 1]!;
    if (nowMs - lastTransition < this.minDwellPeriodMs) {
      return {
        allowed: false,
        reason: `Role transition rejected: minimum dwell period (${this.minDwellPeriodMs}ms) not elapsed`,
      };
    }

    const windowStart = nowMs - this.windowDurationMs;
    const transitionsInWindow = timestamps.filter((t) => t >= windowStart);
    if (transitionsInWindow.length >= this.maxTransitionsPerWindow) {
      return {
        allowed: false,
        reason: `Role transition rejected: exceeded max transitions budget (${this.maxTransitionsPerWindow} in ${this.windowDurationMs}ms)`,
      };
    }

    return { allowed: true };
  }

  /**
   * Executes a version-fenced role transition for an agent.
   */
  public transitionRole(params: RoleTransitionParams): AgentRoleAssignment {
    const nowIso = params.timestamp ?? this.clock.nowIso();
    const nowMs = new Date(nowIso).getTime();

    // 1. Current assignment resolution & version fencing (T16)
    const current = this.activeAssignments.get(params.agentId);
    let nextVersion = 1;
    let previousRole: AdvisoryAgentRole | undefined = undefined;

    if (current) {
      if (params.expectedCurrentVersion !== undefined && current.assignmentVersion !== params.expectedCurrentVersion) {
        throw new Error(
          `Version conflict: expected version ${params.expectedCurrentVersion}, current is ${current.assignmentVersion}`
        );
      }
      nextVersion = current.assignmentVersion + 1;
      previousRole = current.role;
    }

    // 2. Anti-thrashing validation
    const oscillationCheck = this.checkOscillationAllowed(params.agentId, nowMs);
    if (!oscillationCheck.allowed) {
      throw new Error(oscillationCheck.reason);
    }

    // 3. Capability containment validation (T2: RoleCapability ⊆ WorkflowCapability)
    const capabilityProfile =
      params.capabilityProfile ?? ROLE_DEFAULT_CAPABILITY_PROFILES[params.newRole];

    if (params.workflowCapabilityProfile) {
      if (!isRoleCapabilitySubset(capabilityProfile, params.workflowCapabilityProfile)) {
        throw new Error(
          `Capability escalation rejected: role capability profile exceeds workflow boundary`
        );
      }
    }

    // 4. Mission contract integrity check (T11)
    if (!params.missionContractId || !params.missionContractHash) {
      throw new Error(`Missing mission contract binding for role assignment`);
    }

    this.sequenceCounter += 1;
    const assignmentId = `role-assign-${this.sequenceCounter}`;
    const scopeDigest = params.scopeDigest ?? sha256Hex(`SCOPE_${params.goalId}`);
    const resourceProfile = params.resourceProfile ?? { weight: 1 };

    const provenancePayload = {
      assignmentId,
      agentId: params.agentId,
      workflowId: params.workflowId,
      goalId: params.goalId,
      role: params.newRole,
      previousRole,
      assignmentVersion: nextVersion,
      effectiveSequence: this.sequenceCounter,
      missionContractHash: params.missionContractHash,
      scopeDigest,
      createdAt: nowIso,
    };
    const provenanceRoot = sha256Hex(canonicalJsonStringify(provenancePayload));

    const newAssignment: AgentRoleAssignment = {
      assignmentId,
      agentId: params.agentId,
      workflowId: params.workflowId,
      goalId: params.goalId,
      role: params.newRole,
      previousRole,
      assignmentVersion: nextVersion,
      effectiveSequence: this.sequenceCounter,
      reason: params.reason,
      capabilityProfile,
      resourceProfile,
      scopeDigest,
      missionContractId: params.missionContractId,
      missionContractHash: params.missionContractHash,
      provenanceRoot,
      status: "ACTIVE",
      createdAt: nowIso,
      updatedAt: nowIso,
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
    };

    const integrity = validateRoleAssignment(newAssignment);
    if (!integrity.valid) {
      throw new Error(`Invalid role assignment: ${integrity.errors.join(", ")}`);
    }

    // 5. Commit atomic transition
    if (current) {
      const superseded: AgentRoleAssignment = {
        ...current,
        status: "SUPERSEDED",
        updatedAt: nowIso,
      };
      this.historicalAssignments.push(superseded);
    }

    this.activeAssignments.set(params.agentId, newAssignment);

    // Record transition event
    const event: RoleTransitionEvent = {
      eventId: `role-evt-${this.sequenceCounter}`,
      assignmentId,
      agentId: params.agentId,
      previousRole,
      newRole: params.newRole,
      version: nextVersion,
      sequence: this.sequenceCounter,
      reason: params.reason,
      provenanceRoot,
      timestamp: nowIso,
    };
    this.transitionLog.push(event);

    // Update anti-thrashing history
    const timestamps = this.agentTransitionTimestamps.get(params.agentId) ?? [];
    timestamps.push(nowMs);
    this.agentTransitionTimestamps.set(params.agentId, timestamps);

    return newAssignment;
  }

  /**
   * Executes an atomic role swap between two agents (T15, N590, N591).
   * Ensures neither agent is left with a duplicate role or lost update.
   */
  public executeAtomicRoleSwap(
    agentAId: string,
    agentBId: string,
    params: {
      readonly workflowId: string;
      readonly goalId: string;
      readonly reason: string;
      readonly missionContractId: string;
      readonly missionContractHash: string;
      readonly timestamp?: string;
    }
  ): { readonly assignmentA: AgentRoleAssignment; readonly assignmentB: AgentRoleAssignment } {
    const currentA = this.activeAssignments.get(agentAId);
    const currentB = this.activeAssignments.get(agentBId);

    if (!currentA || !currentB) {
      throw new Error(`Cannot execute role swap: both agents must have active role assignments`);
    }

    const roleA = currentA.role;
    const roleB = currentB.role;

    if (roleA === roleB) {
      throw new Error(`Cannot execute role swap: both agents already hold identical role ${roleA}`);
    }

    // Snapshot state for atomic rollback on failure
    const snapshotA = { ...currentA };
    const snapshotB = { ...currentB };

    try {
      const newAssignmentA = this.transitionRole({
        agentId: agentAId,
        workflowId: params.workflowId,
        goalId: params.goalId,
        newRole: roleB,
        reason: `${params.reason} (Swap with ${agentBId})`,
        missionContractId: params.missionContractId,
        missionContractHash: params.missionContractHash,
        timestamp: params.timestamp,
      });

      const newAssignmentB = this.transitionRole({
        agentId: agentBId,
        workflowId: params.workflowId,
        goalId: params.goalId,
        newRole: roleA,
        reason: `${params.reason} (Swap with ${agentAId})`,
        missionContractId: params.missionContractId,
        missionContractHash: params.missionContractHash,
        timestamp: params.timestamp,
      });

      return {
        assignmentA: newAssignmentA,
        assignmentB: newAssignmentB,
      };
    } catch (err) {
      // Revert atomically on any failure
      this.activeAssignments.set(agentAId, snapshotA);
      this.activeAssignments.set(agentBId, snapshotB);
      throw err;
    }
  }
}
