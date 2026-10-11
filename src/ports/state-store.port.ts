import { DomainEvent } from "../domain/events.js";
import { RunSnapshot } from "../domain/invariants.js";
import { MissionContractStorePort } from "./mission-contract-store.port.js";

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
}

/**
 * StorageTransaction encapsulates operations executed within an atomic database transaction.
 * Guarantee: state mutations and event appends commit or roll back together.
 */
export interface StorageTransaction extends MissionContractStorePort {
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
  findRunIdForWorkspace?(workspaceId: string): string | null;

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
}

/**
 * StateStorePort defines the persistence contract for runtime state and event streams.
 * Free of any infrastructure or SQLite details.
 */
export interface StateStorePort extends MissionContractStorePort {
  /**
   * Executes a series of operations atomically inside a single ACID transaction.
   */
  transaction<T>(operation: (tx: StorageTransaction) => T): T;

  getRun(runId: string): RunSnapshot | null;
  getRunRaw?(runId: string): RunSnapshot | null;
  getRunByIdempotencyKey(key: string): RunSnapshot | null;
  findQueuedRuns(limit?: number): readonly RunSnapshot[];
  findExpiredRuns(nowIso: string): readonly RunSnapshot[];
  findRunIdForWorkspace?(workspaceId: string): string | null;
  getEventsForRun(runId: string): readonly PersistedEvent[];
  getTask(taskId: string): TaskRecord | null;
  getWorker(workerId: string): WorkerRecord | null;
  getLease(leaseId: string): LeaseRecord | null;
  close(): void;
}
