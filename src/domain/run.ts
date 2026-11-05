import {
  LeaseExpiredEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunCreatedEvent,
  RunFailedEvent,
  RunQueuedEvent,
  RunRecoveredEvent,
  RunStartedEvent,
  RunTimedOutEvent,
  WorkerClaimedEvent,
} from "./events.js";
import {
  ContractBinding,
  createContractBinding,
  RunSnapshot,
  validateRunInvariants,
} from "./invariants.js";
import { applyTransition, RunCommand } from "./state-machine.js";

export type { ContractBinding } from "./invariants.js";
export { createContractBinding } from "./invariants.js";

export interface CreateRunParams {
  readonly runId: string;
  readonly taskId: string;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string | null;
  readonly now?: string;
  readonly eventIdGenerator?: () => string;
  readonly contractBinding?: ContractBinding | null;
  readonly maxOutputBytes?: number | null;
}

/**
 * Run Aggregate Root.
 * Encapsulates run state and enforces domain transitions, version increments,
 * and invariant validation.
 */
export class Run {
  private _snapshot: RunSnapshot;
  private readonly _eventIdGenerator: () => string;

  private constructor(snapshot: RunSnapshot, eventIdGenerator: () => string) {
    validateRunInvariants(snapshot);
    this._snapshot = Object.freeze({
      ...snapshot,
      contractBinding: snapshot.contractBinding
        ? Object.freeze({ ...snapshot.contractBinding })
        : null,
      maxOutputBytes: snapshot.maxOutputBytes ?? null,
    });
    this._eventIdGenerator = eventIdGenerator;
  }

  /**
   * Factory method to create a new Run aggregate in CREATED state.
   */
  static create(params: CreateRunParams): { run: Run; event: RunCreatedEvent } {
    const now = params.now ?? new Date().toISOString();
    const eventIdGenerator = params.eventIdGenerator ?? (() => crypto.randomUUID());
    const maxAttempts = params.maxAttempts ?? 3;
    const timeoutMs = params.timeoutMs ?? 30000;
    const idempotencyKey = params.idempotencyKey ?? null;

    let contractBinding: ContractBinding | null = null;
    if (params.contractBinding !== undefined && params.contractBinding !== null) {
      contractBinding = createContractBinding(params.contractBinding);
    }
    const maxOutputBytes = params.maxOutputBytes ?? null;

    const snapshot: RunSnapshot = {
      runId: params.runId,
      taskId: params.taskId,
      status: "CREATED",
      version: 1,
      attemptCount: 0,
      maxAttempts,
      timeoutMs,
      idempotencyKey,
      currentWorkerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      resultPayload: null,
      errorPayload: null,
      createdAt: now,
      updatedAt: now,
      contractBinding,
      maxOutputBytes,
    };

    validateRunInvariants(snapshot);

    const event: RunCreatedEvent = {
      eventId: eventIdGenerator(),
      runId: params.runId,
      timestamp: now,
      eventType: "run.created",
      schemaVersion: 1,
      producer: "domain.run_aggregate",
      payload: {
        taskId: params.taskId,
        maxAttempts,
        timeoutMs,
        idempotencyKey,
        ...(contractBinding ? { contractBinding: { ...contractBinding } } : {}),
        ...(maxOutputBytes !== null ? { maxOutputBytes } : {}),
      },
    };

    const run = new Run(snapshot, eventIdGenerator);
    return { run, event };
  }

  /**
   * Reconstitutes an existing Run aggregate from a persisted snapshot.
   */
  static reconstitute(
    snapshot: RunSnapshot,
    eventIdGenerator: () => string = () => crypto.randomUUID()
  ): Run {
    return new Run(snapshot, eventIdGenerator);
  }

  get snapshot(): RunSnapshot {
    return this._snapshot;
  }

  get runId(): string {
    return this._snapshot.runId;
  }

  get taskId(): string {
    return this._snapshot.taskId;
  }

  get status(): RunSnapshot["status"] {
    return this._snapshot.status;
  }

  get version(): number {
    return this._snapshot.version;
  }

  get attemptCount(): number {
    return this._snapshot.attemptCount;
  }

  get maxAttempts(): number {
    return this._snapshot.maxAttempts;
  }

  get timeoutMs(): number {
    return this._snapshot.timeoutMs;
  }

  get currentWorkerId(): string | null {
    return this._snapshot.currentWorkerId;
  }

  get leaseId(): string | null {
    return this._snapshot.leaseId;
  }

  get leaseExpiresAt(): string | null {
    return this._snapshot.leaseExpiresAt;
  }

  get resultPayload(): unknown | null {
    return this._snapshot.resultPayload;
  }

  get errorPayload(): unknown | null {
    return this._snapshot.errorPayload;
  }

  get contractBinding(): ContractBinding | null {
    return this._snapshot.contractBinding ?? null;
  }

  get maxOutputBytes(): number | null {
    return this._snapshot.maxOutputBytes ?? null;
  }

  private executeCommand<TEvent>(command: RunCommand): TEvent {
    const result = applyTransition(this._snapshot, command, this._eventIdGenerator);
    this._snapshot = Object.freeze(result.nextSnapshot);
    return result.event as unknown as TEvent;
  }

  queue(now?: string): RunQueuedEvent {
    return this.executeCommand<RunQueuedEvent>({
      type: "QUEUE",
      now: now ?? new Date().toISOString(),
    });
  }

  claim(
    workerId: string,
    leaseId: string,
    leaseExpiresAt: string,
    now?: string
  ): WorkerClaimedEvent {
    return this.executeCommand<WorkerClaimedEvent>({
      type: "CLAIM",
      workerId,
      leaseId,
      leaseExpiresAt,
      now: now ?? new Date().toISOString(),
    });
  }

  start(workerId: string, leaseId: string, now?: string): RunStartedEvent {
    return this.executeCommand<RunStartedEvent>({
      type: "START",
      workerId,
      leaseId,
      now: now ?? new Date().toISOString(),
    });
  }

  complete(
    workerId: string,
    leaseId: string,
    result: unknown,
    now?: string
  ): RunCompletedEvent {
    return this.executeCommand<RunCompletedEvent>({
      type: "COMPLETE",
      workerId,
      leaseId,
      result,
      now: now ?? new Date().toISOString(),
    });
  }

  fail(error: unknown, workerId?: string, leaseId?: string, now?: string): RunFailedEvent {
    return this.executeCommand<RunFailedEvent>({
      type: "FAIL",
      workerId,
      leaseId,
      error,
      now: now ?? new Date().toISOString(),
    });
  }

  timeout(reason?: string, workerId?: string, leaseId?: string, now?: string): RunTimedOutEvent {
    return this.executeCommand<RunTimedOutEvent>({
      type: "TIMEOUT",
      workerId,
      leaseId,
      reason,
      now: now ?? new Date().toISOString(),
    });
  }

  cancel(reason?: string, now?: string): RunCancelledEvent {
    return this.executeCommand<RunCancelledEvent>({
      type: "CANCEL",
      reason,
      now: now ?? new Date().toISOString(),
    });
  }

  expireLease(now?: string): LeaseExpiredEvent {
    return this.executeCommand<LeaseExpiredEvent>({
      type: "EXPIRE_LEASE",
      now: now ?? new Date().toISOString(),
    });
  }

  retry(now?: string): RunRecoveredEvent {
    return this.executeCommand<RunRecoveredEvent>({
      type: "RETRY",
      now: now ?? new Date().toISOString(),
    });
  }

  failExhausted(error?: unknown, now?: string): RunFailedEvent {
    return this.executeCommand<RunFailedEvent>({
      type: "FAIL_EXHAUSTED",
      error,
      now: now ?? new Date().toISOString(),
    });
  }
}
