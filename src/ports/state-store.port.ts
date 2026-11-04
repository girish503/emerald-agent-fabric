import { AnyActionEvent, AnyAttemptEvent, DomainEvent } from "../domain/events.js";
import { ContractBinding, RunSnapshot } from "../domain/invariants.js";
import { ActionCommand, ActionSnapshot } from "../domain/action.js";
import { AttemptCommand, AttemptSnapshot } from "../domain/attempt.js";
import { MissionContractStorePort } from "./mission-contract-store.port.js";
import { MutationIntentStorePort } from "./mutation-intent-store.port.js";
import { TaskRouterStorePort } from "./task-router-store.port.js";
import type { TenantLaunchGate } from "./tenant-launch-coordinator.port.js";

export interface TaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly inputPayload: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkerStatus = "ACTIVE" | "DRAINING" | "STOPPED";

export interface WorkerRecord {
  readonly workerId: string;
  readonly hostname: string;
  readonly pid: number;
  readonly status: WorkerStatus;
  readonly lastHeartbeatAt: string;
  readonly createdAt: string;
}

export type LeaseState = "ACTIVE" | "EXPIRED" | "RELEASED" | "REVOKED";

export interface LeaseRecord {
  readonly leaseId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly state: LeaseState;
}

export interface SupervisorLease {
  readonly leaseId: string;
  readonly runId: string;
  readonly supervisorId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly state: "ACTIVE" | "EXPIRED" | "RELEASED";
  readonly ownerPid?: number | null;
}

export interface SupervisorFencingCheck {
  readonly supervisorId: string;
  readonly leaseId: string;
  readonly nowIso?: string;
}

export interface MissionCheckpoint {
  readonly checkpointId: string;
  readonly runId: string;
  readonly checkpointVersion: number;
  readonly contractBinding: ContractBinding;
  readonly actionId?: string | null;
  readonly attemptNumber?: number | null;
  readonly durableState: Record<string, unknown>;
  readonly eventSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedEvent<T = unknown> {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly producer: string;
  readonly payload: T;
}

export interface LeaseFencingCheck {
  readonly workerId: string;
  readonly leaseId: string;
  readonly nowIso?: string;
}

/**
 * StorageTransaction encapsulates operations executed within an atomic database transaction.
 * Guarantee: state mutations and event appends commit or roll back together.
 */
export interface StorageTransaction
  extends MissionContractStorePort,
    MutationIntentStorePort,
    TaskRouterStorePort {
  insertTask(task: TaskRecord): void;
  getTask(taskId: string): TaskRecord | null;

  insertRun(snapshot: RunSnapshot, event: DomainEvent): PersistedEvent;
  updateRun(
    runId: string,
    expectedVersion: number,
    nextSnapshot: RunSnapshot,
    event: DomainEvent,
    fencing?: LeaseFencingCheck
  ): PersistedEvent;

  getRun(runId: string): RunSnapshot | null;
  getRunRaw?(runId: string): RunSnapshot | null;
  getRunByIdempotencyKey(key: string): RunSnapshot | null;
  findQueuedRuns(limit?: number): readonly RunSnapshot[];
  findExpiredRuns(nowIso: string): readonly RunSnapshot[];
  findRecoveringRuns?(limit?: number): readonly RunSnapshot[];
  findRunIdForWorkspace?(workspaceId: string): string | null;

  // Action Operations
  insertAction(snapshot: ActionSnapshot, event: AnyActionEvent, fencing?: LeaseFencingCheck): PersistedEvent;
  updateAction(
    actionId: string,
    nextSnapshot: ActionSnapshot,
    event: AnyActionEvent,
    fencing?: LeaseFencingCheck
  ): PersistedEvent;
  getAction(actionId: string): ActionSnapshot | null;
  getActionsForRun(runId: string): readonly ActionSnapshot[];
  getActionBySequence(runId: string, sequenceNumber: number): ActionSnapshot | null;
  transitionAction(
    actionId: string,
    command: ActionCommand,
    eventIdGenerator: () => string,
    fencing?: LeaseFencingCheck
  ): { snapshot: ActionSnapshot; event: PersistedEvent };

  // Attempt Operations
  insertAttempt(snapshot: AttemptSnapshot, event: AnyAttemptEvent, fencing?: LeaseFencingCheck): PersistedEvent;
  updateAttempt(
    attemptId: string,
    nextSnapshot: AttemptSnapshot,
    event: AnyAttemptEvent,
    fencing?: LeaseFencingCheck
  ): PersistedEvent;
  getAttempt(attemptId: string): AttemptSnapshot | null;
  getAttemptsForAction(actionId: string): readonly AttemptSnapshot[];
  getAttemptByNumber(actionId: string, attemptNumber: number): AttemptSnapshot | null;
  getAttemptByIdempotencyToken(token: string): AttemptSnapshot | null;
  getActiveAttemptForAction(actionId: string): AttemptSnapshot | null;
  findInFlightAttempts?(limit?: number): readonly AttemptSnapshot[];
  findInFlightActions?(limit?: number): readonly ActionSnapshot[];
  transitionAttempt(
    attemptId: string,
    command: AttemptCommand,
    eventIdGenerator: () => string,
    fencing?: LeaseFencingCheck
  ): { snapshot: AttemptSnapshot; event: PersistedEvent };

  appendEvent(event: DomainEvent): PersistedEvent;
  getEventsForRun(runId: string): readonly PersistedEvent[];

  insertWorker(worker: WorkerRecord): void;
  getWorker(workerId: string): WorkerRecord | null;
  updateWorkerHeartbeat(workerId: string, heartbeatAt: string): void;

  insertLease(lease: LeaseRecord): void;
  getLease(leaseId: string): LeaseRecord | null;
  updateLeaseState(leaseId: string, state: LeaseState, releasedAt?: string): void;
  updateLeaseExpiresAt(leaseId: string, expiresAt: string): void;
  updateRunLeaseExpiresAt(runId: string, leaseExpiresAt: string): void;

  // Supervisor Lease Operations
  acquireSupervisorLease(params: {
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
    ownerPid?: number;
  }): SupervisorLease;
  renewSupervisorLease(params: {
    leaseId: string;
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
  }): SupervisorLease;
  validateSupervisorFencing(runId: string, fencing: SupervisorFencingCheck): void;
  releaseSupervisorLease(leaseId: string, nowIso: string, fencing?: SupervisorFencingCheck): void;
  expireSupervisorLease(leaseId: string, nowIso: string): void;
  getSupervisorLease(leaseId: string): SupervisorLease | null;
  findActiveSupervisorLease(runId: string, nowIso?: string): SupervisorLease | null;
  getSupervisorLeasesForRun(runId: string): readonly SupervisorLease[];

  // Checkpoint Operations
  insertCheckpoint(checkpoint: MissionCheckpoint): void;
  getLatestCheckpoint(runId: string): MissionCheckpoint | null;
  getCheckpoints(runId: string): readonly MissionCheckpoint[];

  // Tenant Launch Gate Operations (ADR-0038)
  acquireTenantLaunchGate(params: {
    runId: string;
    holderType: "WORKER" | "RECOVERY" | "QUARANTINE";
    holderId: string;
    leaseId: string;
    nowIso: string;
    ttlMs?: number;
    ownerPid?: number;
  }): TenantLaunchGate;
  releaseTenantLaunchGate(params: {
    runId: string;
    token: string;
    nowIso: string;
  }): void;
  quarantineTenantLaunchGate?(params: {
    runId: string;
    token?: string;
    nowIso: string;
    reason?: string;
  }): void;
  markQuiescentTenantLaunchGate?(params: {
    runId: string;
    token: string;
    nowIso: string;
  }): void;
  getTenantLaunchGate(runId: string): TenantLaunchGate | null;
  listTenantLaunchGates?(): readonly TenantLaunchGate[];
}

/**
 * StateStorePort defines the persistence contract for runtime state and event streams.
 * Free of any infrastructure or SQLite details.
 */
export interface StateStorePort extends MissionContractStorePort, MutationIntentStorePort {
  /**
   * Executes a series of operations atomically inside a single ACID transaction.
   */
  transaction<T>(operation: (tx: StorageTransaction) => T): T;

  getRun(runId: string): RunSnapshot | null;
  getRunRaw?(runId: string): RunSnapshot | null;
  getRunByIdempotencyKey(key: string): RunSnapshot | null;
  findQueuedRuns(limit?: number): readonly RunSnapshot[];
  findExpiredRuns(nowIso: string): readonly RunSnapshot[];
  findRecoveringRuns?(limit?: number): readonly RunSnapshot[];
  findRunIdForWorkspace?(workspaceId: string): string | null;

  getAction(actionId: string): ActionSnapshot | null;
  getActionsForRun(runId: string): readonly ActionSnapshot[];
  getActionBySequence(runId: string, sequenceNumber: number): ActionSnapshot | null;

  getAttempt(attemptId: string): AttemptSnapshot | null;
  getAttemptsForAction(actionId: string): readonly AttemptSnapshot[];
  getAttemptByNumber(actionId: string, attemptNumber: number): AttemptSnapshot | null;
  getAttemptByIdempotencyToken(token: string): AttemptSnapshot | null;
  getActiveAttemptForAction(actionId: string): AttemptSnapshot | null;
  findInFlightAttempts?(limit?: number): readonly AttemptSnapshot[];
  findInFlightActions?(limit?: number): readonly ActionSnapshot[];

  getEventsForRun(runId: string): readonly PersistedEvent[];
  getTask(taskId: string): TaskRecord | null;
  getWorker(workerId: string): WorkerRecord | null;
  getLease(leaseId: string): LeaseRecord | null;

  // Supervisor & Checkpoint Operations on Store Port
  acquireSupervisorLease(params: {
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
    ownerPid?: number;
  }): SupervisorLease;
  renewSupervisorLease(params: {
    leaseId: string;
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
  }): SupervisorLease;
  validateSupervisorFencing(runId: string, fencing: SupervisorFencingCheck): void;
  getSupervisorLease(leaseId: string): SupervisorLease | null;
  findActiveSupervisorLease(runId: string, nowIso?: string): SupervisorLease | null;
  getSupervisorLeasesForRun(runId: string): readonly SupervisorLease[];
  releaseSupervisorLease(leaseId: string, nowIso?: string, fencing?: SupervisorFencingCheck): void;
  expireSupervisorLease(leaseId: string, nowIso?: string): void;
  getLatestCheckpoint(runId: string): MissionCheckpoint | null;
  getCheckpoints(runId: string): readonly MissionCheckpoint[];

  // Tenant Launch Gate Operations (ADR-0038)
  acquireTenantLaunchGate(params: {
    runId: string;
    holderType: "WORKER" | "RECOVERY" | "QUARANTINE";
    holderId: string;
    leaseId: string;
    nowIso: string;
    ttlMs?: number;
    ownerPid?: number;
  }): TenantLaunchGate;
  releaseTenantLaunchGate(params: {
    runId: string;
    token: string;
    nowIso: string;
  }): void;
  quarantineTenantLaunchGate?(params: {
    runId: string;
    token?: string;
    nowIso: string;
    reason?: string;
  }): void;
  markQuiescentTenantLaunchGate?(params: {
    runId: string;
    token: string;
    nowIso: string;
  }): void;
  getTenantLaunchGate(runId: string): TenantLaunchGate | null;
  listTenantLaunchGates?(): readonly TenantLaunchGate[];

  /**
   * Binds a run to the canonical workspace root it owns. First bind wins; rebinding
   * the same run to a different root throws WorkspaceBindingConflictError.
   */
  bindRunWorkspace(runId: string, workspaceRoot: string, nowIso: string): string;
  getRunWorkspaceBinding(runId: string): string | null;

  close(): void;
}
