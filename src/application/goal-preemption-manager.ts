/**
 * Phase 96: Goal Pre-emption Manager
 *
 * Implements governed hierarchical goal pre-emption, durable checkpointing,
 * suspension vs cancellation separation, dependency impact auditing,
 * priority inversion detection, and bounded starvation protection.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Work priority may change. Goal authority must not.
 * Preemption != Revocation. Suspension != Cancellation.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import {
  GoalPriority,
  GoalPriorityClass,
  GoalPriorityStatus,
  GoalDependencyType,
  PRIORITY_CLASS_WEIGHTS,
  computePriorityScore,
  validateGoalPriority,
  detectDependencyCycle,
} from "../domain/goal-priority.js";
import {
  PreemptionRequest,
  PreemptionCheckpoint,
  PreemptionStatus,
  computeResourcePressureBand,
  validatePreemptionCheckpoint,
} from "../domain/goal-preemption.js";

export interface SetGoalPriorityParams {
  readonly goalId: string;
  readonly parentGoalId?: string;
  readonly taskId: string;
  readonly workflowId: string;
  readonly agentId?: string;
  readonly priorityClass: GoalPriorityClass;
  readonly criticality: number;
  readonly urgency: number;
  readonly dependencyCriticality?: number;
  readonly verificationCriticality?: number;
  readonly resourcePressure?: number;
  readonly starvationAge?: number;
  readonly expectedCurrentVersion?: number;
  readonly reason: string;
  readonly scopeDigest?: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly provenanceRoot?: string;
  readonly timestamp?: string;
}

export interface RequestPreemptionParams {
  readonly goalId: string;
  readonly taskId: string;
  readonly workflowId: string;
  readonly requestedPriority: GoalPriorityClass;
  readonly reason: string;
  readonly resourcePressure: number; // 0 - 100
  readonly dependencyImpact?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly agentId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly branchId?: string;
  readonly checkpointId?: string;
  readonly timestamp?: string;
}

export interface CreateCheckpointParams {
  readonly runId: string;
  readonly taskId: string;
  readonly goalId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly workingTreeDigest: string;
  readonly baseRevision: string;
  readonly affectedFiles: readonly string[];
  readonly speculativeBranchId?: string;
  readonly memoryReferences?: readonly string[];
  readonly contextDigest?: string;
  readonly resourceAccounting?: Readonly<Record<string, number>>;
  readonly verificationState?: string;
  readonly roleAssignment?: string;
  readonly timestamp?: string;
}

export interface GoalDependencyDeclaration {
  readonly fromGoalId: string;
  readonly toGoalId: string;
  readonly dependencyType: GoalDependencyType;
}

export class GoalPreemptionManager {
  private readonly activePriorities = new Map<string, GoalPriority>();
  private readonly historicalPriorities: GoalPriority[] = [];
  private readonly preemptionRequests = new Map<string, PreemptionRequest>();
  private readonly preemptionHistory: PreemptionRequest[] = [];
  private readonly checkpoints = new Map<string, PreemptionCheckpoint>();
  private readonly goalSuspensionMap = new Map<string, boolean>(); // goalId -> isSuspended
  private readonly dependencyGraph: GoalDependencyDeclaration[] = [];
  private sequenceCounter = 0;
  private readonly clock: ClockPort;

  constructor(options?: { readonly clock?: ClockPort }) {
    this.clock = options?.clock ?? new SystemClock();
  }

  public getActivePriority(goalId: string): GoalPriority | undefined {
    return this.activePriorities.get(goalId);
  }

  public getAllActivePriorities(): readonly GoalPriority[] {
    return Object.freeze([...this.activePriorities.values()]);
  }

  public getHistoricalPriorities(): readonly GoalPriority[] {
    return Object.freeze([...this.historicalPriorities]);
  }

  public getPreemptionRequest(preemptionId: string): PreemptionRequest | undefined {
    return this.preemptionRequests.get(preemptionId);
  }

  public getPreemptionHistory(): readonly PreemptionRequest[] {
    return Object.freeze([...this.preemptionHistory]);
  }

  public getCheckpoint(checkpointId: string): PreemptionCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  public getAllCheckpoints(): readonly PreemptionCheckpoint[] {
    return Object.freeze([...this.checkpoints.values()]);
  }

  public isGoalSuspended(goalId: string): boolean {
    return this.goalSuspensionMap.get(goalId) === true;
  }

  public registerDependencies(dependencies: readonly GoalDependencyDeclaration[]): void {
    // Check for dependency cycles fail-closed
    const allEdges = [...this.dependencyGraph, ...dependencies];
    if (detectDependencyCycle(allEdges)) {
      throw new Error("Dependency registration rejected: circular dependency cycle detected");
    }
    this.dependencyGraph.push(...dependencies);
  }

  public getDependenciesForGoal(goalId: string): readonly GoalDependencyDeclaration[] {
    return Object.freeze(this.dependencyGraph.filter((d) => d.toGoalId === goalId || d.fromGoalId === goalId));
  }

  /**
   * Sets or updates a goal priority.
   * Enforces version fencing, immutable mission contract binding, and non-authority invariants.
   */
  public setGoalPriority(params: SetGoalPriorityParams): GoalPriority {
    const nowIso = params.timestamp ?? this.clock.nowIso();
    const current = this.activePriorities.get(params.goalId);

    // 1. Mission contract validation (Invariant P2)
    if (!params.missionContractId || !params.missionContractHash) {
      throw new Error("Goal priority rejected: missing or invalid mission contract binding");
    }

    // 2. Version fencing (Invariants P9, P10)
    let nextVersion = 1;
    if (current) {
      if (
        params.expectedCurrentVersion !== undefined &&
        current.priorityVersion !== params.expectedCurrentVersion
      ) {
        throw new Error(
          `Priority version conflict: expected version ${params.expectedCurrentVersion}, current is ${current.priorityVersion}`
        );
      }
      nextVersion = current.priorityVersion + 1;
    }

    // 3. Hierarchical Goal Parent-Child Cycle Check
    if (params.parentGoalId) {
      const edges = [
        ...this.dependencyGraph,
        { fromGoalId: params.parentGoalId, toGoalId: params.goalId, dependencyType: "REQUIRED_BEFORE" as const },
      ];
      if (detectDependencyCycle(edges)) {
        throw new Error(
          `Hierarchical goal authority cycle detected between parent ${params.parentGoalId} and child ${params.goalId}`
        );
      }
    }

    this.sequenceCounter += 1;
    const priorityId = `priority-${params.goalId}-v${nextVersion}`;

    // 4. Deterministic score calculation
    const criticality = Math.min(100, Math.max(0, params.criticality));
    const urgency = Math.min(100, Math.max(0, params.urgency));
    const dependencyCriticality = Math.min(100, Math.max(0, params.dependencyCriticality ?? 50));
    const verificationCriticality = Math.min(100, Math.max(0, params.verificationCriticality ?? 50));
    const resourcePressure = Math.min(100, Math.max(0, params.resourcePressure ?? 20));
    const starvationAge = Math.max(0, params.starvationAge ?? 0);

    const priorityScore = computePriorityScore({
      priorityClass: params.priorityClass,
      criticality,
      dependencyCriticality,
      verificationCriticality,
      resourcePressure,
      starvationAge,
    });

    const scopeDigest = params.scopeDigest ?? sha256Hex(`SCOPE_${params.goalId}`);
    const provenanceRoot =
      params.provenanceRoot ??
      sha256Hex(
        `${current?.provenanceRoot ?? "ROOT"}:${priorityId}:${params.priorityClass}:${priorityScore}`
      );

    const priority: GoalPriority = {
      priorityId,
      goalId: params.goalId,
      parentGoalId: params.parentGoalId,
      taskId: params.taskId,
      workflowId: params.workflowId,
      agentId: params.agentId,
      priorityClass: params.priorityClass,
      priorityScore,
      criticality,
      urgency,
      dependencyCriticality,
      verificationCriticality,
      resourcePressure,
      starvationAge,
      priorityVersion: nextVersion,
      reason: params.reason,
      scopeDigest,
      missionContractId: params.missionContractId,
      missionContractHash: params.missionContractHash,
      provenanceRoot,
      createdSequence: this.sequenceCounter,
      status: "ACTIVE",
      createdAt: current ? current.createdAt : nowIso,
      updatedAt: nowIso,
      authoritative: false,
      terminalAuthority: false,
      verificationAuthority: false,
      policyAuthority: false,
    };

    const validation = validateGoalPriority(priority);
    if (!validation.valid) {
      throw new Error(`Invalid goal priority: ${validation.errors.join(", ")}`);
    }

    if (current) {
      const superseded: GoalPriority = {
        ...current,
        status: "SUPERSEDED",
        updatedAt: nowIso,
      };
      this.historicalPriorities.push(superseded);
    }

    this.activePriorities.set(params.goalId, priority);
    return priority;
  }

  /**
   * Evaluates and records a pre-emption request.
   * Enforces dependency-aware impact checking (cannot pre-empt prerequisite if dependent work is running).
   */
  public requestPreemption(params: RequestPreemptionParams): PreemptionRequest {
    const nowIso = params.timestamp ?? this.clock.nowIso();
    const currentPriority = this.activePriorities.get(params.goalId);
    if (!currentPriority) {
      throw new Error(`Cannot request pre-emption: goal ${params.goalId} has no active priority`);
    }

    // 1. Dependency impact analysis (Invariants P6, P11)
    const downstreamDependents = this.dependencyGraph.filter(
      (d) => d.fromGoalId === params.goalId && d.dependencyType === "REQUIRED_BEFORE"
    );
    for (const dep of downstreamDependents) {
      const dependentPriority = this.activePriorities.get(dep.toGoalId);
      if (
        dependentPriority &&
        dependentPriority.status === "ACTIVE" &&
        !this.isGoalSuspended(dep.toGoalId) &&
        (dependentPriority.priorityClass === "CRITICAL" || dependentPriority.priorityClass === "HIGH")
      ) {
        throw new Error(
          `Pre-emption rejected: goal ${params.goalId} is a REQUIRED_BEFORE prerequisite for active higher-priority goal ${dep.toGoalId}`
        );
      }
    }

    this.sequenceCounter += 1;
    const preemptionId = `preempt-${params.goalId}-${this.sequenceCounter}`;
    const pressureBand = computeResourcePressureBand(params.resourcePressure);

    const request: PreemptionRequest = {
      preemptionId,
      goalId: params.goalId,
      taskId: params.taskId,
      workflowId: params.workflowId,
      currentPriority: currentPriority.priorityClass,
      requestedPriority: params.requestedPriority,
      reason: params.reason,
      resourcePressure: params.resourcePressure,
      pressureBand,
      dependencyImpact: params.dependencyImpact ?? "NONE",
      checkpointId: params.checkpointId,
      branchId: params.branchId,
      actionId: params.actionId,
      attemptId: params.attemptId,
      agentId: params.agentId,
      workerId: params.workerId,
      leaseId: params.leaseId,
      missionContractId: params.missionContractId,
      missionContractHash: params.missionContractHash,
      provenanceRoot: sha256Hex(`PREEMPT:${currentPriority.provenanceRoot}:${preemptionId}`),
      sequenceNumber: this.sequenceCounter,
      status: "APPROVED",
      timestamp: nowIso,
      authoritative: false,
      terminalAuthority: false,
    };

    this.preemptionRequests.set(preemptionId, request);
    this.preemptionHistory.push(request);
    return request;
  }

  /**
   * Captures a durable checkpoint for a goal prior to suspension.
   */
  public checkpointGoal(params: CreateCheckpointParams): PreemptionCheckpoint {
    const nowIso = params.timestamp ?? this.clock.nowIso();
    const currentPriority = this.activePriorities.get(params.goalId);
    if (!currentPriority) {
      throw new Error(`Cannot checkpoint: goal ${params.goalId} has no active priority`);
    }

    this.sequenceCounter += 1;
    const checkpointId = `chk-${params.goalId}-${this.sequenceCounter}`;
    const provenanceRoot = sha256Hex(
      `CHECKPOINT:${currentPriority.provenanceRoot}:${checkpointId}:${params.workingTreeDigest}`
    );

    const checkpoint: PreemptionCheckpoint = {
      checkpointId,
      runId: params.runId,
      taskId: params.taskId,
      goalId: params.goalId,
      actionId: params.actionId,
      attemptId: params.attemptId,
      agentId: params.agentId,
      workerId: params.workerId,
      leaseId: params.leaseId,
      missionContractId: params.missionContractId,
      missionContractHash: params.missionContractHash,
      workingTreeDigest: params.workingTreeDigest,
      baseRevision: params.baseRevision,
      affectedFiles: Object.freeze([...params.affectedFiles]),
      speculativeBranchId: params.speculativeBranchId,
      memoryReferences: Object.freeze([...(params.memoryReferences ?? [])]),
      contextDigest: params.contextDigest ?? sha256Hex(`CTX_${params.goalId}`),
      resourceAccounting: Object.freeze({ ...(params.resourceAccounting ?? {}) }),
      verificationState: params.verificationState ?? "UNVERIFIED",
      roleAssignment: params.roleAssignment,
      priorityVersion: currentPriority.priorityVersion,
      provenanceRoot,
      status: "ACTIVE",
      createdAt: nowIso,
    };

    const validation = validatePreemptionCheckpoint(checkpoint);
    if (!validation.valid) {
      throw new Error(`Invalid checkpoint: ${validation.errors.join(", ")}`);
    }

    this.checkpoints.set(checkpointId, checkpoint);
    return checkpoint;
  }

  /**
   * Suspends a pre-empted goal.
   * Explicitly sets state to SUSPENDED. Invariant P11: Suspension is NEVER cancellation.
   */
  public suspendGoal(goalId: string, preemptionId: string): void {
    const request = this.preemptionRequests.get(preemptionId);
    if (!request || request.goalId !== goalId) {
      throw new Error(`Cannot suspend goal ${goalId}: valid pre-emption request ${preemptionId} not found`);
    }

    this.goalSuspensionMap.set(goalId, true);

    const updatedRequest: PreemptionRequest = {
      ...request,
      status: "SUSPENDED",
    };
    this.preemptionRequests.set(preemptionId, updatedRequest);
  }

  public liftGoalSuspension(goalId: string): void {
    this.goalSuspensionMap.set(goalId, false);
  }

  public updateCheckpointStatus(checkpointId: string, status: PreemptionCheckpoint["status"]): void {
    const cp = this.checkpoints.get(checkpointId);
    if (cp) {
      this.checkpoints.set(checkpointId, { ...cp, status });
    }
  }

  /**
   * Detects priority inversion across active goals.
   * Occurs when a low-priority goal holds a dependency or resource required by a high-priority goal.
   */
  public detectPriorityInversion(): readonly {
    readonly lowPriorityGoalId: string;
    readonly highPriorityGoalId: string;
    readonly dependencyType: GoalDependencyType;
    readonly recommendedAction: string;
  }[] {
    const inversions: {
      lowPriorityGoalId: string;
      highPriorityGoalId: string;
      dependencyType: GoalDependencyType;
      recommendedAction: string;
    }[] = [];

    for (const dep of this.dependencyGraph) {
      const prerequisite = this.activePriorities.get(dep.fromGoalId);
      const dependent = this.activePriorities.get(dep.toGoalId);

      if (prerequisite && dependent) {
        const prerequisiteWeight = PRIORITY_CLASS_WEIGHTS[prerequisite.priorityClass];
        const dependentWeight = PRIORITY_CLASS_WEIGHTS[dependent.priorityClass];

        // Dependent has strictly higher priority than the prerequisite it waits for
        if (dependentWeight > prerequisiteWeight && !this.isGoalSuspended(dep.toGoalId)) {
          inversions.push({
            lowPriorityGoalId: dep.fromGoalId,
            highPriorityGoalId: dep.toGoalId,
            dependencyType: dep.dependencyType,
            recommendedAction: `PRIORITY_INHERITANCE_BOOST: Elevate ${dep.fromGoalId} scheduling priority to clear path for ${dep.toGoalId}`,
          });
        }
      }
    }

    return Object.freeze(inversions);
  }

  /**
   * Evaluates cascading impact of pre-empting a parent goal on its children.
   */
  public evaluateCascadingPreemption(parentGoalId: string): readonly {
    readonly childGoalId: string;
    readonly action: "SUSPEND" | "CONTINUE" | "WAIT";
    readonly reason: string;
  }[] {
    const children = [...this.activePriorities.values()].filter((p) => p.parentGoalId === parentGoalId);
    return Object.freeze(
      children.map((child) => {
        const deps = this.dependencyGraph.filter(
          (d) => d.fromGoalId === parentGoalId && d.toGoalId === child.goalId
        );
        const isStrictPrerequisite = deps.some((d) => d.dependencyType === "REQUIRED_BEFORE");

        if (isStrictPrerequisite) {
          return {
            childGoalId: child.goalId,
            action: "SUSPEND" as const,
            reason: `Parent ${parentGoalId} is a strict REQUIRED_BEFORE prerequisite for child ${child.goalId}`,
          };
        }

        return {
          childGoalId: child.goalId,
          action: "CONTINUE" as const,
          reason: `Child ${child.goalId} has independent sub-goal scope and can safely proceed`,
        };
      })
    );
  }
}
