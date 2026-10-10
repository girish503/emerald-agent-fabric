import {
  DomainEvent,
  EvidenceRecordedPayload,
  PolicyEvaluatedPayload,
  VerificationCompletedPayload,
} from "../domain/events.js";
import { Evidence } from "../domain/evidence.js";
import { VerificationResult } from "../domain/verification.js";
import { Run } from "../domain/run.js";
import { RunSnapshot } from "../domain/invariants.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import {
  LeaseRecord,
  PersistedEvent,
  StateStorePort,
  TaskRecord,
  WorkerRecord,
} from "../ports/state-store.port.js";
import { LeaseManager } from "./lease-manager.js";

export interface CreateTaskParams {
  readonly taskId?: string;
  readonly title: string;
  readonly description?: string;
  readonly inputPayload: unknown;
}

export interface CreateRunParams {
  readonly runId?: string;
  readonly taskId: string;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string | null;
}

export interface ClaimRunResult {
  readonly run: RunSnapshot;
  readonly lease: LeaseRecord;
  readonly event: PersistedEvent;
}

export interface TransitionResult {
  readonly run: RunSnapshot;
  readonly event: PersistedEvent;
}

export interface RecoverExpiredResult {
  readonly recoveredCount: number;
  readonly runs: readonly RunSnapshot[];
}

export interface RecordPolicyDecisionParams {
  readonly capabilityName: string;
  readonly policyId: string;
  readonly allowed: boolean;
  readonly isolationRequirement: string;
  readonly reasonCode?: string;
  readonly providerName?: string;
  readonly taskId?: string;
  readonly operationName?: string;
}

/**
 * RunCoordinator is the central application-level orchestrator for task execution lifecycles.
 * It manages transactional state transitions, event emissions, lease coordination, and sweeper recovery.
 */
export class RunCoordinator {
  private readonly leaseManager: LeaseManager;

  constructor(
    private readonly stateStore: StateStorePort,
    private readonly clock: ClockPort = new SystemClock(),
    leaseManager?: LeaseManager
  ) {
    this.leaseManager = leaseManager ?? new LeaseManager(this.clock);
  }

  /**
   * Registers a task definition in the state store.
   */
  createTask(params: CreateTaskParams): TaskRecord {
    return this.stateStore.transaction((tx) => {
      const taskId = params.taskId ?? crypto.randomUUID();
      const existing = tx.getTask(taskId);
      if (existing) {
        return existing;
      }

      const now = this.clock.nowIso();
      const task: TaskRecord = {
        taskId,
        title: params.title,
        description: params.description ?? "",
        inputPayload: params.inputPayload,
        createdAt: now,
        updatedAt: now,
      };

      tx.insertTask(task);
      return task;
    });
  }

  /**
   * Creates a new execution run associated with a task in CREATED state.
   * Respects idempotency keys if provided.
   */
  createRun(params: CreateRunParams): TransitionResult {
    return this.stateStore.transaction((tx) => {
      if (params.idempotencyKey) {
        const existing = tx.getRunByIdempotencyKey(params.idempotencyKey);
        if (existing) {
          const events = tx.getEventsForRun(existing.runId);
          const initialEvent = events[0] ?? {
            eventId: crypto.randomUUID(),
            runId: existing.runId,
            sequence: 1,
            timestamp: existing.createdAt,
            eventType: "run.created",
            schemaVersion: 1,
            producer: "domain.run_aggregate",
            payload: {},
          };
          return { run: existing, event: initialEvent };
        }
      }

      const task = tx.getTask(params.taskId);
      if (!task) {
        throw new Error(`Task '${params.taskId}' not found`);
      }

      const runId = params.runId ?? crypto.randomUUID();
      const now = this.clock.nowIso();

      const { run, event } = Run.create({
        runId,
        taskId: params.taskId,
        maxAttempts: params.maxAttempts,
        timeoutMs: params.timeoutMs,
        idempotencyKey: params.idempotencyKey,
        now,
      });

      const persistedEvent = tx.insertRun(run.snapshot, event);
      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Transitions a run from CREATED to QUEUED for worker pickup.
   */
  queueRun(runId: string): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const run = Run.reconstitute(snapshot);
      const event = run.queue(this.clock.nowIso());
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event);

      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Claims a QUEUED run for a specific worker, creating an active lease.
   */
  claimRun(runId: string, workerId: string, ttlMs: number): ClaimRunResult {
    return this.stateStore.transaction((tx) => {
      const worker = tx.getWorker(workerId);
      if (!worker) {
        throw new Error(`Worker '${workerId}' is not registered`);
      }

      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const now = this.clock.nowIso();
      const lease = this.leaseManager.acquire(tx, {
        runId,
        workerId,
        ttlMs,
        nowIso: now,
      });

      const run = Run.reconstitute(snapshot);
      const event = run.claim(workerId, lease.leaseId, lease.expiresAt, now);
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event);

      return { run: run.snapshot, lease, event: persistedEvent };
    });
  }

  /**
   * Transitions a LEASED run to RUNNING when execution starts.
   * Enforces lease fencing.
   */
  startRun(runId: string, workerId: string, leaseId: string): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const run = Run.reconstitute(snapshot);
      const event = run.start(workerId, leaseId, this.clock.nowIso());
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event, {
        workerId,
        leaseId,
      });

      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Transitions a RUNNING run to terminal COMPLETED state.
   * Enforces lease fencing and releases the lease.
   */
  completeRun(runId: string, workerId: string, leaseId: string, result: unknown): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const now = this.clock.nowIso();
      const run = Run.reconstitute(snapshot);
      const event = run.complete(workerId, leaseId, result, now);
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event, {
        workerId,
        leaseId,
      });

      this.leaseManager.release(tx, leaseId, now);
      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Transitions a RUNNING or RECOVERING run to terminal FAILED state.
   * Releases lease if active.
   */
  failRun(runId: string, error: unknown, workerId?: string, leaseId?: string): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const now = this.clock.nowIso();
      const run = Run.reconstitute(snapshot);
      const event = run.fail(error, workerId, leaseId, now);
      const fencing = workerId && leaseId ? { workerId, leaseId } : undefined;
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event, fencing);

      if (leaseId) {
        this.leaseManager.release(tx, leaseId, now);
      }

      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Transitions an active or queued run to terminal CANCELLED state.
   */
  cancelRun(runId: string, reason?: string): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const now = this.clock.nowIso();
      const run = Run.reconstitute(snapshot);
      const event = run.cancel(reason, now);
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event);

      if (snapshot.leaseId) {
        this.leaseManager.release(tx, snapshot.leaseId, now);
      }

      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Transitions an active run to terminal TIMED_OUT state.
   */
  timeoutRun(runId: string, reason?: string): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }

      const now = this.clock.nowIso();
      const run = Run.reconstitute(snapshot);
      const event = run.timeout(
        reason,
        snapshot.currentWorkerId ?? undefined,
        snapshot.leaseId ?? undefined,
        now
      );
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event);

      if (snapshot.leaseId) {
        this.leaseManager.release(tx, snapshot.leaseId, now);
      }

      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Records an auditable policy evaluation decision into the run event stream.
   */
  recordPolicyDecision(runId: string, params: RecordPolicyDecisionParams): PersistedEvent {
    return this.stateStore.transaction((tx) => {
      const event: DomainEvent<PolicyEvaluatedPayload> = {
        eventId: crypto.randomUUID(),
        runId,
        timestamp: this.clock.nowIso(),
        eventType: "policy.evaluated",
        schemaVersion: 1,
        producer: "application.policy_evaluator",
        payload: {
          runId,
          taskId: params.taskId ?? "",
          operationName: params.operationName ?? "",
          capabilityName: params.capabilityName,
          policyId: params.policyId,
          allowed: params.allowed,
          isolationRequirement: params.isolationRequirement,
          reasonCode: params.reasonCode,
          providerName: params.providerName,
        },
      };

      return tx.appendEvent(event);
    });
  }

  /**
   * Records an immutable evidence artifact into the run event stream.
   */
  recordEvidence(runId: string, evidence: Evidence): PersistedEvent {
    return this.stateStore.transaction((tx) => {
      const event: DomainEvent<EvidenceRecordedPayload> = {
        eventId: crypto.randomUUID(),
        runId,
        timestamp: this.clock.nowIso(),
        eventType: "evidence.recorded",
        schemaVersion: 1,
        producer: "application.evidence_collector",
        payload: {
          evidenceId: evidence.evidenceId,
          runId,
          source: evidence.source,
          kind: evidence.kind,
          contentHash: evidence.contentHash,
          summary: evidence.summary ? { ...evidence.summary } : undefined,
          observedAt: evidence.observedAt,
        },
      };

      return tx.appendEvent(event);
    });
  }

  /**
   * Records a deterministic verification result into the run event stream.
   */
  recordVerificationResult(runId: string, result: VerificationResult): PersistedEvent {
    return this.stateStore.transaction((tx) => {
      const event: DomainEvent<VerificationCompletedPayload> = {
        eventId: crypto.randomUUID(),
        runId,
        timestamp: this.clock.nowIso(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "application.verifier",
        payload: {
          runId,
          verifierId: result.verifierId,
          specId: result.specId,
          status: result.status,
          evidenceIds: [...result.evidenceIds],
          reasonCode: result.reasonCode,
          message: result.message,
          details: result.details ? { ...result.details } : undefined,
          verifiedAt: result.verifiedAt,
        },
      };

      return tx.appendEvent(event);
    });
  }

  /**
   * Renews an active lease.
   */
  renewLease(runId: string, leaseId: string, ttlMs: number): LeaseRecord {
    return this.stateStore.transaction((tx) => {
      return this.leaseManager.renew(tx, {
        leaseId,
        runId,
        ttlMs,
        nowIso: this.clock.nowIso(),
      });
    });
  }

  /**
   * Releases an active lease.
   */
  releaseLease(leaseId: string): void {
    this.stateStore.transaction((tx) => {
      this.leaseManager.release(tx, leaseId, this.clock.nowIso());
    });
  }

  /**
   * Recovers runs whose leases have expired while in LEASED or RUNNING status.
   * If retry attempts remain, the run is re-queued.
   * If retry attempts are exhausted, the run is transitioned to FAILED.
   */
  recoverExpiredRuns(): RecoverExpiredResult {
    const nowIso = this.clock.nowIso();
    const expiredCandidates = this.stateStore.findExpiredRuns(nowIso);
    const recoveredRuns: RunSnapshot[] = [];

    for (const candidate of expiredCandidates) {
      this.stateStore.transaction((tx) => {
        const snapshot = tx.getRun(candidate.runId);
        if (
          !snapshot ||
          (snapshot.status !== "RUNNING" && snapshot.status !== "LEASED") ||
          !snapshot.leaseExpiresAt ||
          snapshot.leaseExpiresAt > nowIso
        ) {
          // Changed concurrently or lease renewed
          return;
        }

        if (snapshot.leaseId) {
          this.leaseManager.expire(tx, snapshot.leaseId, nowIso);
        }

        const run = Run.reconstitute(snapshot);

        // Transition: LEASED/RUNNING -> RECOVERING
        const versionBeforeExpire = snapshot.version;
        const expireEvent = run.expireLease(nowIso);
        tx.updateRun(snapshot.runId, versionBeforeExpire, run.snapshot, expireEvent);

        if (run.attemptCount < run.maxAttempts) {
          // Transition: RECOVERING -> QUEUED (increments attemptCount)
          const versionBeforeRetry = run.version;
          const retryEvent = run.retry(nowIso);
          tx.updateRun(snapshot.runId, versionBeforeRetry, run.snapshot, retryEvent);
          recoveredRuns.push(run.snapshot);
        } else {
          // Retries exhausted: RECOVERING -> FAILED
          const versionBeforeFail = run.version;
          const failEvent = run.failExhausted(
            {
              code: "RETRIES_EXHAUSTED",
              message: `Run lease expired and all ${run.maxAttempts} retry attempts exhausted`,
            },
            nowIso
          );
          tx.updateRun(snapshot.runId, versionBeforeFail, run.snapshot, failEvent);
          recoveredRuns.push(run.snapshot);
        }
      });
    }

    return {
      recoveredCount: recoveredRuns.length,
      runs: recoveredRuns,
    };
  }

  /**
   * Finds the next QUEUED run ready for worker consumption.
   */
  getNextQueuedRun(): RunSnapshot | null {
    const queued = this.stateStore.findQueuedRuns(1);
    return queued[0] ?? null;
  }

  /**
   * Registers or heartbeats a worker in the database.
   */
  registerWorker(worker: WorkerRecord): void {
    this.stateStore.transaction((tx) => {
      const existing = tx.getWorker(worker.workerId);
      if (!existing) {
        tx.insertWorker(worker);
      } else {
        tx.updateWorkerHeartbeat(worker.workerId, worker.lastHeartbeatAt);
      }
    });
  }

  getRun(runId: string): RunSnapshot | null {
    return this.stateStore.getRun(runId);
  }

  getRunByIdempotencyKey(key: string): RunSnapshot | null {
    return this.stateStore.getRunByIdempotencyKey(key);
  }

  getEventsForRun(runId: string): readonly PersistedEvent[] {
    return this.stateStore.getEventsForRun(runId);
  }

  getTask(taskId: string): TaskRecord | null {
    return this.stateStore.getTask(taskId);
  }

  getWorker(workerId: string): WorkerRecord | null {
    return this.stateStore.getWorker(workerId);
  }

  getLease(leaseId: string): LeaseRecord | null {
    return this.stateStore.getLease(leaseId);
  }
}
