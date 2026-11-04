import { computeCanonicalHash } from "../domain/canonical-hash.js";
import {
  AmbiguousContractAuthorityError,
  ContractIntegrityError,
  InvalidMissionContractError,
  InvalidRunError,
  LeaseExpiredError,
  LeaseLostError,
  MissionContractTaskMismatchError,
  NoActiveMissionContractError,
  ResourceLimitExceededError,
  MissingBoundContractError,
  SupervisorLeaseExpiredError,
  TenantQuiescenceRequiredError,
} from "../domain/errors.js";
import {
  DomainEvent,
  EvidenceRecordedPayload,
  PolicyEvaluatedPayload,
  VerificationCompletedPayload,
} from "../domain/events.js";
import { Evidence } from "../domain/evidence.js";
import { VerificationResult } from "../domain/verification.js";
import {
  ActionSnapshot,
  ActionStatus,
  evaluateRetryEligibility,
  isTerminalActionStatus,
} from "../domain/action.js";
import {
  Attempt,
  AttemptSnapshot,
  createAttemptIdempotencyToken,
  isTerminalAttemptStatus,
} from "../domain/attempt.js";
import { Run } from "../domain/run.js";
import {
  ContractBinding,
  createContractBinding,
  RunSnapshot,
} from "../domain/invariants.js";
import { MissionContract } from "../domain/mission-contract.js";
import { ClockPort, SystemClock, resolveAuthorityNowIso } from "../ports/clock.port.js";
import {
  LeaseFencingCheck,
  LeaseRecord,
  SupervisorLease,
  SupervisorFencingCheck,
  MissionCheckpoint,
  PersistedEvent,
  StateStorePort,
  StorageTransaction,
  TaskRecord,
  WorkerRecord,
} from "../ports/state-store.port.js";
import { OrphanSweepOptions, WorkspaceHandle, WorkspacePort } from "../ports/workspace.port.js";
import { isRollbackPendingStatus } from "../domain/mutation-intent.js";
import { LeaseManager } from "./lease-manager.js";
import {
  SUPERVISOR_EVIDENCE,
  SWEEPER_EVIDENCE,
  decideRecovery,
  decideVerifiedRunRecovery,
  isStartedAttemptRowMissing,
} from "./recovery-decision-policy.js";

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
  readonly maxOutputBytes?: number;
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
  /**
   * Runs left untouched because they hold unreconciled workspace mutations. They are retried
   * only after the RecoverySupervisor has durably rolled back (or failed closed on) the workspace.
   */
  readonly heldForRollbackRunIds?: readonly string[];
  /** Runs requeued/failed although discarding their crashed workspace failed (operator attention). */
  readonly workspaceCleanupFailedRunIds?: readonly string[];
  /**
   * Runs left untouched because they require isolated tenant execution and tenant quiescence
   * has not been affirmatively established (ADR-0037 / ADR-0038 / Milestone 2.4A.9).
   */
  readonly heldForQuiescenceRunIds?: readonly string[];
}

export interface RecoverMissionParams {
  readonly runId: string;
  readonly supervisorId: string;
  readonly supervisorLeaseId: string;
  readonly newWorkerId?: string;
  readonly newWorkerLeaseId?: string;
  readonly nowIso?: string;
  /** Gate generation (token) from the acquisition that established quiescence; required for isolated runs. */
  readonly gateToken?: string;
}

export interface RecoverMissionResult {
  readonly run: RunSnapshot;
  readonly checkpoint: MissionCheckpoint;
  readonly previousAttempt: AttemptSnapshot | null;
  readonly newAttempt: AttemptSnapshot | null;
  readonly events: readonly PersistedEvent[];
}

export interface SaveCheckpointParams {
  readonly runId: string;
  readonly checkpointVersion: number;
  readonly contractBinding?: ContractBinding;
  readonly actionId?: string | null;
  readonly attemptNumber?: number | null;
  readonly durableState: Record<string, unknown>;
  readonly eventSequence?: number;
  readonly supervisorFencing?: SupervisorFencingCheck;
  /**
   * Worker authority proof (2.16-D). When present, the write is rejected inside the same
   * transaction unless the caller still holds the run's current, ACTIVE, unexpired worker lease.
   * A worker that lost authority between its last lease check and this write cannot persist.
   */
  readonly workerFencing?: LeaseFencingCheck;
  readonly nowIso?: string;
}

export interface StaleExecutionRecoveryOptions {
  readonly runId?: string;
  readonly nowIso?: string;
  readonly maxRuns?: number;
  readonly workerId?: string;
  readonly leaseId?: string;
}

export interface ReconciledExecutionDetail {
  readonly runId: string;
  readonly actionId: string;
  readonly attemptId?: string;
  readonly priorAttemptStatus?: string;
  readonly resultingAttemptStatus?: string;
  readonly priorActionStatus: string;
  readonly resultingActionStatus: string;
  readonly retryEligible: boolean;
  readonly reason: string;
}

export interface StaleExecutionRecoveryResult {
  readonly recoveredRuns: number;
  readonly reconciledAttempts: number;
  readonly reconciledActions: number;
  readonly details: readonly ReconciledExecutionDetail[];
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
    leaseManager?: LeaseManager,
    private readonly workspacePort?: WorkspacePort
  ) {
    this.leaseManager = leaseManager ?? new LeaseManager(this.clock);
  }

  private readonly activeWorkspaceIds = new Set<string>();

  /**
   * Binds the run to the canonical workspace root it owns for its whole lifetime (all attempts).
   * Requires the caller to hold the run's current worker lease. Idempotent for the same root;
   * throws WorkspaceBindingConflictError if the run is already bound to a different root.
   */
  bindRunWorkspace(runId: string, workspaceRoot: string, fencing: LeaseFencingCheck): string {
    const run = this.stateStore.getRun(runId);
    if (!run || run.leaseId !== fencing.leaseId || run.currentWorkerId !== fencing.workerId) {
      throw new LeaseLostError(runId, fencing.leaseId, run?.leaseId ?? null);
    }
    return this.stateStore.bindRunWorkspace(runId, workspaceRoot, this.clock.nowIso());
  }

  /**
   * Records a workspace lifecycle event transactionally into the event stream.
   * If fencing is provided, verifies that the worker and lease still hold current authority.
   */
  recordWorkspaceEvent(event: DomainEvent, fencing?: LeaseFencingCheck): PersistedEvent {
    const wsId = (event.payload as { workspaceId?: string })?.workspaceId;
    if (wsId) {
      if (
        event.eventType === "workspace.provisioning" ||
        event.eventType === "workspace.ready" ||
        event.eventType === "workspace.leased"
      ) {
        this.activeWorkspaceIds.add(wsId);
      } else if (
        event.eventType === "workspace.disposed" ||
        event.eventType === "workspace.failed"
      ) {
        this.activeWorkspaceIds.delete(wsId);
      }
    }
    return this.stateStore.transaction((tx) => {
      if (fencing && event.runId) {
        const run = tx.getRun(event.runId);
        if (run && (run.leaseId !== fencing.leaseId || run.currentWorkerId !== fencing.workerId)) {
          throw new LeaseLostError(event.runId, fencing.leaseId, run.leaseId);
        }
      }
      return tx.appendEvent(event);
    });
  }

  /**
   * Asserts that a specific lease is currently held by the specified worker for the run.
   */
  assertLeaseHeld(runId: string, workerId: string, leaseId: string): void {
    const run = this.stateStore.getRun(runId);
    if (!run || run.leaseId !== leaseId || run.currentWorkerId !== workerId) {
      throw new LeaseLostError(runId, leaseId, run?.leaseId ?? null);
    }
    const lease = this.stateStore.getLease(leaseId);
    if (!lease || lease.state !== "ACTIVE" || lease.expiresAt <= this.clock.nowIso()) {
      throw new LeaseLostError(runId, leaseId, run?.leaseId ?? null);
    }
  }

  /**
   * Returns true if the lease is currently active and held by the specified worker.
   */
  isLeaseActive(runId: string, workerId: string, leaseId: string): boolean {
    try {
      this.assertLeaseHeld(runId, workerId, leaseId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Safely disposes of a workspace owned by an active run with lease fencing check.
   */
  disposeRunWorkspace(params: {
    runId: string;
    workerId: string;
    leaseId: string;
    workspaceId: string;
    reason?: string;
  }): void {
    this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(params.runId);
      if (!snapshot) {
        throw new Error(`Run '${params.runId}' not found`);
      }
      if (snapshot.leaseId !== params.leaseId || snapshot.currentWorkerId !== params.workerId) {
        throw new LeaseLostError(params.runId, params.leaseId, snapshot.leaseId);
      }
      if (this.workspacePort) {
        if (this.workspacePort.disposeWorkspaceSync) {
          this.workspacePort.disposeWorkspaceSync(params.workspaceId, {
            runId: params.runId,
            leaseId: params.leaseId,
            tolerateMissingMarker: true,
          });
        }
      }
      const disposedEvent: DomainEvent = {
        eventId: crypto.randomUUID(),
        runId: params.runId,
        timestamp: this.clock.nowIso(),
        eventType: "workspace.disposed",
        schemaVersion: 1,
        producer: `worker.${params.workerId}`,
        payload: { workspaceId: params.workspaceId, runId: params.runId, reason: params.reason },
      };
      tx.appendEvent(disposedEvent);
    });
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

      // 1. Resolve ACTIVE MissionContracts for task
      const activeContracts = tx.findContractsByTaskId(params.taskId, "ACTIVE");
      if (activeContracts.length === 0) {
        throw new NoActiveMissionContractError(params.taskId);
      }
      if (activeContracts.length > 1) {
        throw new AmbiguousContractAuthorityError(
          params.taskId,
          activeContracts.map((c) => c.spec.contractId)
        );
      }

      const contract = activeContracts[0]!;

      // 2. Task association check
      if (contract.spec.taskId !== params.taskId) {
        throw new MissionContractTaskMismatchError(
          params.taskId,
          contract.spec.taskId,
          contract.spec.contractId
        );
      }

      // 3. Contract integrity verification
      if (
        typeof contract.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(contract.contentHash)
      ) {
        throw new InvalidMissionContractError(
          `Corrupted or invalid content hash for contract '${contract.spec.contractId}'`
        );
      }

      const runId = params.runId ?? crypto.randomUUID();
      const now = this.clock.nowIso();

      // 4. Validate requested resource limits against contract ceilings
      const limits = contract.spec.resourceLimits;

      if (params.timeoutMs !== undefined) {
        if (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1) {
          throw new InvalidRunError(runId, [
            `timeoutMs must be an integer >= 1, received ${params.timeoutMs}`,
          ]);
        }
        if (params.timeoutMs > limits.timeoutMs) {
          throw new ResourceLimitExceededError(
            "timeoutMs",
            params.timeoutMs,
            limits.timeoutMs
          );
        }
      }

      if (params.maxAttempts !== undefined) {
        if (!Number.isInteger(params.maxAttempts) || params.maxAttempts < 1) {
          throw new InvalidRunError(runId, [
            `maxAttempts must be an integer >= 1, received ${params.maxAttempts}`,
          ]);
        }
        if (params.maxAttempts > limits.maxAttempts) {
          throw new ResourceLimitExceededError(
            "maxAttempts",
            params.maxAttempts,
            limits.maxAttempts
          );
        }
      }

      if (params.maxOutputBytes !== undefined) {
        if (!Number.isInteger(params.maxOutputBytes) || params.maxOutputBytes < 1) {
          throw new InvalidRunError(runId, [
            `maxOutputBytes must be an integer >= 1, received ${params.maxOutputBytes}`,
          ]);
        }
        if (params.maxOutputBytes > limits.maxOutputBytes) {
          throw new ResourceLimitExceededError(
            "maxOutputBytes",
            params.maxOutputBytes,
            limits.maxOutputBytes
          );
        }
      }

      const timeoutMs = params.timeoutMs ?? limits.timeoutMs;
      const maxAttempts = params.maxAttempts ?? limits.maxAttempts;
      const maxOutputBytes = params.maxOutputBytes ?? limits.maxOutputBytes;

      // 5. Bind exact contract identity
      const contractBinding = createContractBinding({
        contractId: contract.spec.contractId,
        version: contract.spec.version,
        contentHash: contract.contentHash,
      });

      // 6. Construct Run aggregate
      const { run, event } = Run.create({
        runId,
        taskId: params.taskId,
        maxAttempts,
        timeoutMs,
        contractBinding,
        maxOutputBytes,
        idempotencyKey: params.idempotencyKey,
        now,
      });

      // 7. Persist Run and run.created event atomically
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
   * When `fencing` is given (a worker reporting its own provider's cancellation) the caller must
   * still hold the run's lease; otherwise LeaseLostError is thrown and nothing is written, so a
   * stale worker can never cancel a newer attempt or release its lease.
   */
  cancelRun(runId: string, reason?: string, fencing?: LeaseFencingCheck): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }
      if (fencing && (snapshot.leaseId !== fencing.leaseId || snapshot.currentWorkerId !== fencing.workerId)) {
        throw new LeaseLostError(runId, fencing.leaseId, snapshot.leaseId ?? null);
      }

      const now = this.clock.nowIso();
      const run = Run.reconstitute(snapshot);
      const event = run.cancel(reason, now);
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event, fencing);

      if (snapshot.leaseId) {
        this.leaseManager.release(tx, snapshot.leaseId, now);
      }

      return { run: run.snapshot, event: persistedEvent };
    });
  }

  /**
   * Transitions an active run to terminal TIMED_OUT state.
   * When `fencing` is given (a worker reporting its own provider's timeout) the caller must still
   * hold the run's lease; otherwise LeaseLostError is thrown and nothing is written. Without it the
   * transition is authorised by the run's current holder (operator/sweeper use).
   */
  timeoutRun(runId: string, reason?: string, fencing?: LeaseFencingCheck): TransitionResult {
    return this.stateStore.transaction((tx) => {
      const snapshot = tx.getRun(runId);
      if (!snapshot) {
        throw new Error(`Run '${runId}' not found`);
      }
      if (fencing && (snapshot.leaseId !== fencing.leaseId || snapshot.currentWorkerId !== fencing.workerId)) {
        throw new LeaseLostError(runId, fencing.leaseId, snapshot.leaseId ?? null);
      }

      const now = this.clock.nowIso();
      const run = Run.reconstitute(snapshot);
      const event = run.timeout(
        reason,
        snapshot.currentWorkerId ?? undefined,
        snapshot.leaseId ?? undefined,
        now
      );
      const persistedEvent = tx.updateRun(runId, snapshot.version, run.snapshot, event, fencing);

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
   * Returns true if the run may have isolated tenant processes (fail closed)
   * requiring verified tenant quiescence before workspace disposal or retry requeue.
   */
  public runRequiresTenantQuiescence(runSnapshot: RunSnapshot): boolean {
    const binding = runSnapshot.contractBinding;
    if (!binding) return true;
    let contract: MissionContract | null;
    try {
      contract = this.getContract(binding.contractId, binding.version);
    } catch {
      // A corrupt or tampered contract cannot prove IN_PROCESS isolation; fail closed without aborting the sweep.
      return true;
    }
    if (!contract) return true;
    return contract.spec.policy.isolationRequirement !== "IN_PROCESS";
  }

  /**
   * Recovers runs whose leases have expired while in LEASED or RUNNING status.
   * If retry attempts remain, the run is re-queued.
   * If retry attempts are exhausted, the run is transitioned to FAILED.
   */
  recoverExpiredRuns(options?: {
    excludeRunIds?: ReadonlySet<string>;
    quiescedRunIds?: ReadonlySet<string>;
    /**
     * Gate generation (token) per run from the acquisition that established quiescence. An isolated run is retried only
     * while its durable gate still carries exactly this token; a missing or different token holds the run.
     */
    quiescedGateTokens?: ReadonlyMap<string, string>;
    /**
     * Recovery supervisor on whose authority this sweep runs. Isolated runs are retried only when their durable
     * gate is QUIESCED under this exact supervisor; omitting it holds every isolated run (fail closed).
     */
    supervisorId?: string;
  }): RecoverExpiredResult {
    const nowIso = this.clock.nowIso();
    const expiredCandidates = this.stateStore.findExpiredRuns(nowIso);
    // Runs the supervisor has rolled back and handed over (left RECOVERING) are retried here too.
    const recoveringCandidates = this.stateStore.findRecoveringRuns ? this.stateStore.findRecoveringRuns() : [];
    const seenCandidateIds = new Set<string>();
    const candidates = [...expiredCandidates, ...recoveringCandidates].filter((c) => {
      // Held back by the caller (e.g. tenant processes not proven gone, ADR-0037): untouched, no event, no cleanup.
      if (options?.excludeRunIds?.has(c.runId)) return false;
      if (seenCandidateIds.has(c.runId)) return false;
      seenCandidateIds.add(c.runId);
      return true;
    });
    const recoveredRuns: RunSnapshot[] = [];
    const heldForRollback: string[] = [];
    const heldForQuiescence: string[] = [];
    const cleanupFailed = new Set<string>();

    for (const candidate of candidates) {
      this.stateStore.transaction((tx) => {
        let snapshot: RunSnapshot | null = null;
        let reconstitutionError: Error | null = null;
        try {
          snapshot = tx.getRun(candidate.runId);
        } catch (err: unknown) {
          if (err instanceof Error) {
            reconstitutionError = err;
          } else {
            throw err;
          }
        }

        if (!snapshot && reconstitutionError) {
          snapshot = tx.getRunRaw ? tx.getRunRaw(candidate.runId) : null;
        }

        const workerLeaseExpired =
          !!snapshot &&
          (snapshot.status === "RUNNING" || snapshot.status === "LEASED") &&
          !!snapshot.leaseExpiresAt &&
          snapshot.leaseExpiresAt <= nowIso;
        if (!snapshot || !(workerLeaseExpired || snapshot.status === "RECOVERING")) {
          // Changed concurrently or lease renewed
          return;
        }

        // Tenant Quiescence Gate (Invariant A / F-03 Remediation): An isolated run must NOT have its workspace discarded
        // or attempt advanced without verified affirmative tenant quiescence in durable state (state === 'QUIESCED' under RECOVERY).
        if (this.runRequiresTenantQuiescence(snapshot)) {
          const gate =
            typeof (tx as any).getTenantLaunchGate === "function"
              ? (tx as any).getTenantLaunchGate(snapshot.runId)
              : typeof this.stateStore.getTenantLaunchGate === "function"
                ? this.stateStore.getTenantLaunchGate(snapshot.runId)
                : null;
          const isQuiesced =
            (options?.quiescedRunIds === undefined || options.quiescedRunIds.has(snapshot.runId)) &&
            gate !== null &&
            gate.state === "QUIESCED" &&
            gate.holderType === "RECOVERY" &&
            options?.supervisorId !== undefined &&
            gate.holderId === options.supervisorId &&
            // An expired gate is not current authority to dispose a workspace or requeue; quiescence must be re-verified.
            Number.isFinite(Date.parse(gate.expiresAt)) &&
            Date.parse(nowIso) < Date.parse(gate.expiresAt) &&
            options?.quiescedGateTokens?.get(snapshot.runId) !== undefined &&
            gate.token === options.quiescedGateTokens.get(snapshot.runId);
          if (!isQuiesced) {
            heldForQuiescence.push(snapshot.runId);
            return;
          }
        }

        if (typeof this.stateStore.getTenantLaunchGate === "function") {
          const gate = this.stateStore.getTenantLaunchGate(snapshot.runId);
          if (gate && gate.state === "QUARANTINED") {
            heldForQuiescence.push(snapshot.runId);
            return;
          }
        }

        // Retry gate: a run holding unreconciled workspace mutations must not be requeued (and its
        // workspace must not be discarded) until the RecoverySupervisor has rolled it back.
        if (this.requiresRollbackBeforeRetry(tx, snapshot.runId)) {
          heldForRollback.push(snapshot.runId);
          return;
        }

        if (workerLeaseExpired && snapshot.leaseId) {
          this.leaseManager.expire(tx, snapshot.leaseId, nowIso);
        }

        const run = Run.reconstitute(snapshot);

        if (workerLeaseExpired) {
          // Transition: LEASED/RUNNING -> RECOVERING
          const versionBeforeExpire = snapshot.version;
          const expireEvent = run.expireLease(nowIso);
          tx.updateRun(snapshot.runId, versionBeforeExpire, run.snapshot, expireEvent);
        }

        // Reconcile in-flight actions and attempts for this crashed run atomically
        this.reconcileStaleActionsAndAttemptsForRun(tx, snapshot.runId, nowIso);

        const cleanupCrashedWorkspace = (): void => {
          if (!this.workspacePort) return;
          try {
            const events = tx.getEventsForRun(snapshot.runId);
            const wsEvents = events.filter((e) => e.eventType.startsWith("workspace."));
            const lastWs = wsEvents[wsEvents.length - 1];
            let wsId: string | undefined;
            if (
              lastWs &&
              lastWs.eventType !== "workspace.disposed" &&
              lastWs.eventType !== "workspace.failed"
            ) {
              wsId = (lastWs.payload as { workspaceId?: string })?.workspaceId;
            }

            if (!wsId && (this.workspacePort as any)?.workspaces instanceof Map) {
              for (const [id, ws] of (this.workspacePort as any).workspaces.entries()) {
                if (
                  ws?.spec?.runId === snapshot.runId &&
                  ws?.lifecycle?.status !== "DISPOSED" &&
                  ws?.lifecycle?.status !== "FAILED"
                ) {
                  wsId = id;
                  break;
                }
              }
            }

            if (wsId && this.workspacePort.disposeWorkspaceSync) {
                try {
                  // The crashed attempt's lease: a marker naming ANOTHER lease (a newer attempt) is refused. If the lease
                  // is unknown, `unknownLease` makes every marker-bearing directory refused (cleanup is then reported
                  // as failed) instead of being deleted by an unowned fallback; only a marker-less directory is cleaned.
                  this.workspacePort.disposeWorkspaceSync(wsId, {
                    runId: snapshot.runId,
                    leaseId: snapshot.leaseId ?? "",
                    unknownLease: !snapshot.leaseId,
                    tolerateMissingMarker: true,
                  });
                  const disposedEvent: DomainEvent = {
                    eventId: crypto.randomUUID(),
                    runId: snapshot.runId,
                    timestamp: nowIso,
                    eventType: "workspace.disposed",
                    schemaVersion: 1,
                    producer: "coordinator.sweeper",
                    payload: { workspaceId: wsId, runId: snapshot.runId },
                  };
                  tx.appendEvent(disposedEvent);
                } catch (err: unknown) {
                  const failedEvent: DomainEvent = {
                    eventId: crypto.randomUUID(),
                    runId: snapshot.runId,
                    timestamp: nowIso,
                    eventType: "workspace.failed",
                    schemaVersion: 1,
                    producer: "coordinator.sweeper",
                    payload: {
                      workspaceId: wsId,
                      runId: snapshot.runId,
                      error: err instanceof Error ? err.message : String(err),
                    },
                  };
                  tx.appendEvent(failedEvent);
                  cleanupFailed.add(snapshot.runId);
                }
              }
            } catch {
            // Quarantine / log
            cleanupFailed.add(snapshot.runId);
          }
        };

        const failGovernanceClosed = (errorPayload: {
          code: string;
          message: string;
          details?: unknown;
        }): void => {
          cleanupCrashedWorkspace();
          const versionBeforeFail = run.version;
          const failEvent = run.fail(errorPayload, undefined, undefined, nowIso);
          tx.updateRun(snapshot.runId, versionBeforeFail, run.snapshot, failEvent);
          recoveredRuns.push(run.snapshot);
        };

        // If reconstitution threw an integrity or missing error
        if (reconstitutionError) {
          const isMissing = reconstitutionError.message.includes("not found");
          failGovernanceClosed({
            code: isMissing ? "MISSING_BOUND_CONTRACT" : "CONTRACT_INTEGRITY_MISMATCH",
            message: reconstitutionError.message,
            details: {
              runId: snapshot.runId,
              contractId: snapshot.contractBinding?.contractId,
              version: snapshot.contractBinding?.version,
            },
          });
          return;
        }

        // 1. Unbound Legacy Run Check (Section 7)
        if (!snapshot.contractBinding) {
          failGovernanceClosed({
            code: "UNBOUND_RUN_EXECUTION_DISALLOWED",
            message: `Recovery of unbound legacy Run '${snapshot.runId}' is disallowed. Governed execution requires an authoritative MissionContract binding.`,
            details: { runId: snapshot.runId },
          });
          return;
        }

        const binding = snapshot.contractBinding;

        // 2. Exact Contract Resolution (Section 1, 2, 4, 11)
        let contract: MissionContract | null = null;
        let contractFetchError: Error | null = null;
        try {
          contract = tx.getContract(binding.contractId, binding.version);
        } catch (err: unknown) {
          if (
            err instanceof ContractIntegrityError ||
            err instanceof InvalidMissionContractError
          ) {
            contractFetchError = err as Error;
          } else {
            throw err;
          }
        }

        if (contractFetchError) {
          failGovernanceClosed({
            code: "CONTRACT_INTEGRITY_MISMATCH",
            message: contractFetchError.message,
            details: {
              contractId: binding.contractId,
              version: binding.version,
              runId: snapshot.runId,
            },
          });
          return;
        }

        if (!contract) {
          failGovernanceClosed({
            code: "MISSING_BOUND_CONTRACT",
            message: `Exact bound MissionContract ('${binding.contractId}', v${binding.version}) not found during recovery`,
            details: {
              contractId: binding.contractId,
              version: binding.version,
              runId: snapshot.runId,
            },
          });
          return;
        }

        // 3. Contract Integrity Verification (Section 5)
        const { contentHash: recomputedHash } = computeCanonicalHash(contract.spec);
        if (
          recomputedHash !== contract.contentHash ||
          contract.contentHash !== binding.contentHash
        ) {
          failGovernanceClosed({
            code: "CONTRACT_INTEGRITY_MISMATCH",
            message: `Contract content hash integrity mismatch during recovery: run bound '${binding.contentHash}', contract hash '${contract.contentHash}', recomputed hash '${recomputedHash}'`,
            details: {
              contractId: binding.contractId,
              version: binding.version,
              boundHash: binding.contentHash,
              contractHash: contract.contentHash,
              recomputedHash,
              runId: snapshot.runId,
            },
          });
          return;
        }

        // 4. Task Association Verification (Section 6)
        if (contract.spec.taskId !== snapshot.taskId) {
          failGovernanceClosed({
            code: "MISSION_CONTRACT_TASK_MISMATCH",
            message: `Mission contract '${contract.spec.contractId}' belongs to task '${contract.spec.taskId}', not run task '${snapshot.taskId}'`,
            details: {
              expectedTaskId: snapshot.taskId,
              actualTaskId: contract.spec.taskId,
              contractId: contract.spec.contractId,
              runId: snapshot.runId,
            },
          });
          return;
        }

        // 5. Lifecycle Authorization Verification (Section 3, 14)
        if (contract.lifecycle.status === "REVOKED") {
          failGovernanceClosed({
            code: "CONTRACT_REVOKED",
            message: `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} has been REVOKED${
              contract.lifecycle.revocationReason ? `: ${contract.lifecycle.revocationReason}` : ""
            }`,
            details: {
              contractId: contract.spec.contractId,
              version: contract.spec.version,
              status: contract.lifecycle.status,
              revocationReason: contract.lifecycle.revocationReason,
              runId: snapshot.runId,
            },
          });
          return;
        }

        if (contract.lifecycle.status !== "ACTIVE") {
          failGovernanceClosed({
            code: "CONTRACT_NOT_ACTIVE",
            message: `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} is not ACTIVE (status: '${contract.lifecycle.status}')`,
            details: {
              contractId: contract.spec.contractId,
              version: contract.spec.version,
              status: contract.lifecycle.status,
              runId: snapshot.runId,
            },
          });
          return;
        }

        // 6. Valid Active Contract: Check Scenario 12 Verified Run Recovery
        const runEvents = tx.getEventsForRun(snapshot.runId);
        const actions = tx.getActionsForRun(snapshot.runId);
        const attempts = actions.flatMap((a) => tx.getAttemptsForAction(a.actionId));
        const recoveryDecision = decideVerifiedRunRecovery({
          runSnapshot: run.snapshot,
          events: runEvents,
          actions,
          attempts,
        });

        if (recoveryDecision.action === "FAIL_CLOSED") {
          failGovernanceClosed({
            code: recoveryDecision.reasonCode,
            message: recoveryDecision.message,
            details: recoveryDecision.details,
          });
          return;
        }

        if (recoveryDecision.action === "COMPLETE_FROM_VERIFIED_EVENT") {
          cleanupCrashedWorkspace();
          const versionBeforeComplete = run.version;
          const completeEvent = run.complete(
            "recovery",
            "recovery",
            recoveryDecision.resultPayload,
            nowIso
          );
          tx.updateRun(snapshot.runId, versionBeforeComplete, run.snapshot, completeEvent);
          recoveredRuns.push(run.snapshot);
          return;
        }

        // 7. Valid Active Contract: Existing Retry Semantics (Section 2, 9)
        cleanupCrashedWorkspace();
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
      ...(heldForRollback.length > 0 ? { heldForRollbackRunIds: heldForRollback } : {}),
      ...(heldForQuiescence.length > 0 ? { heldForQuiescenceRunIds: heldForQuiescence } : {}),
      ...(cleanupFailed.size > 0 ? { workspaceCleanupFailedRunIds: Array.from(cleanupFailed) } : {}),
    };
  }

  /**
   * True when the run recorded workspace mutations that have not been durably reconciled:
   * any non-terminal mutation intent, or a rollback aggregate that did not complete.
   */
  private requiresRollbackBeforeRetry(tx: StorageTransaction, runId: string): boolean {
    const intents = tx.getIntentsForRun(runId);
    if (intents.length === 0) return false;
    if (intents.some((i) => isRollbackPendingStatus(i.lifecycleStatus))) return true;
    const rollback = tx.getRunRollback(runId);
    return rollback !== null && rollback.status !== "COMPLETED";
  }

  /**
   * Reconciles in-flight Actions and Attempts for a specific run whose worker lease expired or crashed.
   * Guarantees:
   * 1. Stale in-flight Attempts (CREATED, DISPATCHED, RUNNING) transition safely:
   *    - CREATED -> CANCELLED (never dispatched, no physical side effects)
   *    - DISPATCHED / RUNNING -> UNKNOWN (fail-closed execution uncertainty)
   * 2. Action states reconcile deterministically:
   *    - UNKNOWN attempt + NON_IDEMPOTENT tool -> Action FAILED (NO AUTOMATIC RETRY)
   *    - UNKNOWN attempt + IDEMPOTENT tool -> Action FAILED (fail-closed on execution uncertainty)
   *    - FAILED attempt + IDEMPOTENT tool + attemptsRemaining -> Action RETRYING
   *    - Terminal attempt + RUNNING Action (Window G) -> Action reconciles to match attempt outcome
   * 3. Completely idempotent: repeated calls produce no duplicate transitions or events.
   */
  private reconcileStaleActionsAndAttemptsForRun(
    tx: StorageTransaction,
    runId: string,
    nowIso: string,
    fencing?: LeaseFencingCheck
  ): ReconciledExecutionDetail[] {
    const details: ReconciledExecutionDetail[] = [];
    const actions = tx.getActionsForRun(runId);

    for (const action of actions) {
      if (isTerminalActionStatus(action.status)) {
        continue;
      }

      const attempts = tx.getAttemptsForAction(action.actionId);
      const activeAttempt =
        tx.getActiveAttemptForAction(action.actionId) ??
        attempts.find((a: AttemptSnapshot) => !isTerminalAttemptStatus(a.status));
      const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
      const subject = activeAttempt ?? latestAttempt;

      // verifiedEventAfterAction is intentionally false here: this method is only reached via the
      // PROCEED_TO_RETRY path, meaning decideVerifiedRunRecovery already determined that any
      // verification event in run_events is not authoritative for this recovery operation (stale
      // attempt, action.started after verification, or no event). Passing true would incorrectly
      // allow an uncertain DISPATCHED/RUNNING/UNKNOWN attempt to be reconciled as SUCCEEDED.
      const verifiedEventAfterAction = false;

      // Shared recovery policy (see recovery-decision-policy.ts). The sweeper holds no supervisor
      // lease and no quiescence proof, so an uncertain Attempt is never retried here.
      const decision = decideRecovery({
        idempotency: action.idempotency,
        actionStatus: action.status,
        attemptStatus: subject?.status ?? null,
        totalAttempts: action.totalAttempts,
        maxAttempts: action.maxAttempts,
        evidence: SWEEPER_EVIDENCE,
        startedAttemptRowMissing: isStartedAttemptRowMissing(action, latestAttempt?.attemptNumber ?? null),
        verifiedEventAfterAction,
      });

      if (!subject || (decision.attemptTransition === "NONE" && decision.actionTransition === "NONE")) {
        if (action.status === "RETRYING") {
          // Window H: Action already RETRYING; report eligibility against the actual last Attempt.
          const eligibility = evaluateRetryEligibility(action, latestAttempt);
          details.push({
            runId,
            actionId: action.actionId,
            priorActionStatus: action.status,
            resultingActionStatus: action.status,
            retryEligible: eligibility.eligible,
            reason: "Action is awaiting retry attempt creation",
          });
        }
        continue;
      }

      let reconciledAttemptStatus = subject.status;
      if (decision.attemptTransition === "CANCEL") {
        // Window C: Attempt created but never dispatched -> CANCEL
        reconciledAttemptStatus = tx.transitionAttempt(
          subject.attemptId,
          { type: "CANCEL", reason: "Worker crashed before dispatch", now: nowIso },
          () => crypto.randomUUID(),
          fencing
        ).snapshot.status;
      } else if (decision.attemptTransition === "MARK_UNKNOWN") {
        // Windows D, E, F: physical outcome uncertain -> MARK_UNKNOWN
        reconciledAttemptStatus = tx.transitionAttempt(
          subject.attemptId,
          {
            type: "MARK_UNKNOWN",
            reason: "Worker crashed or lease expired during execution",
            reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
            now: nowIso,
          },
          () => crypto.randomUUID(),
          fencing
        ).snapshot.status;
      }

      let resultingActionStatus: ActionStatus = action.status;
      const gen = () => crypto.randomUUID();
      switch (decision.actionTransition) {
        case "SUCCEED":
          resultingActionStatus = tx.transitionAction(
            action.actionId,
            { type: "SUCCEED", resultPayload: subject.outputPayload, now: nowIso },
            gen,
            fencing
          ).snapshot.status;
          break;
        case "PREPARE_RETRY":
          resultingActionStatus = tx.transitionAction(
            action.actionId,
            {
              type: "PREPARE_RETRY",
              errorPayload:
                subject.status === "CREATED" ? "Worker crashed before dispatch" : subject.errorPayload,
              now: nowIso,
            },
            gen,
            fencing
          ).snapshot.status;
          break;
        case "FAIL": {
          // UNKNOWN is fail-closed: it is recorded as uncertainty, never as proof of failure or of no effect.
          const errorPayload =
            decision.failureKind === "NOT_DISPATCHED"
              ? { code: "WORKER_CRASHED", message: "Worker crashed before dispatch" }
              : decision.failureKind === "UNCERTAIN" && decision.attemptTransition === "MARK_UNKNOWN"
                ? {
                    code: "EXECUTION_UNCERTAIN",
                    reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
                    message: "Physical execution uncertain: worker crashed or lease expired during execution",
                  }
                : subject.errorPayload;
          resultingActionStatus = tx.transitionAction(
            action.actionId,
            { type: "FAIL", errorPayload, now: nowIso },
            gen,
            fencing
          ).snapshot.status;
          break;
        }
        case "TIMEOUT":
          resultingActionStatus = tx.transitionAction(
            action.actionId,
            { type: "TIMEOUT", reason: subject.errorPayload, now: nowIso },
            gen,
            fencing
          ).snapshot.status;
          break;
        case "CANCEL":
          resultingActionStatus = tx.transitionAction(
            action.actionId,
            { type: "CANCEL", reason: subject.errorPayload, now: nowIso },
            gen,
            fencing
          ).snapshot.status;
          break;
        default:
          break;
      }

      details.push({
        runId,
        actionId: action.actionId,
        attemptId: subject.attemptId,
        priorAttemptStatus: subject.status,
        resultingAttemptStatus: reconciledAttemptStatus,
        priorActionStatus: action.status,
        resultingActionStatus,
        retryEligible: resultingActionStatus === "RETRYING",
        reason:
          decision.attemptTransition === "CANCEL"
            ? "Attempt cancelled before dispatch"
            : decision.attemptTransition === "MARK_UNKNOWN"
              ? "Attempt marked UNKNOWN due to lease expiration during execution; action failed closed"
              : "Action reconciled from durable terminal attempt state",
      });
    }

    return details;
  }

  /**
   * Deterministic sweeper/reconciliation operation for stale Actions and Attempts.
   * Can be called periodically or on recovery to ensure all orphaned or uncertain
   * in-flight executions reach durable, safe terminal/retry states.
   */
  recoverStaleExecutions(options: StaleExecutionRecoveryOptions = {}): StaleExecutionRecoveryResult {
    const nowIso = options.nowIso ?? this.clock.nowIso();
    const candidateRunIds = new Set<string>();

    if (options.runId) {
      candidateRunIds.add(options.runId);
    } else {
      const expiredRuns = this.stateStore.findExpiredRuns(nowIso);
      for (const r of expiredRuns) {
        candidateRunIds.add(r.runId);
      }
      if (this.stateStore.findInFlightAttempts) {
        const inFlightAttempts = this.stateStore.findInFlightAttempts(options.maxRuns ?? 100);
        for (const att of inFlightAttempts) {
          candidateRunIds.add(att.runId);
        }
      }
      if (this.stateStore.findInFlightActions) {
        const inFlightActions = this.stateStore.findInFlightActions(options.maxRuns ?? 100);
        for (const act of inFlightActions) {
          candidateRunIds.add(act.runId);
        }
      }
    }

    let recoveredRuns = 0;
    let reconciledAttempts = 0;
    let reconciledActions = 0;
    const allDetails: ReconciledExecutionDetail[] = [];

    const fencing: LeaseFencingCheck | undefined =
      options.workerId && options.leaseId ? { workerId: options.workerId, leaseId: options.leaseId } : undefined;

    for (const runId of candidateRunIds) {
      this.stateStore.transaction((tx) => {
        const runSnapshot = tx.getRun(runId);
        if (!runSnapshot) return;

        // Fencing check if caller supplied workerId and leaseId
        if (fencing) {
          if (runSnapshot.currentWorkerId !== fencing.workerId || runSnapshot.leaseId !== fencing.leaseId) {
            throw new LeaseLostError(runId, fencing.leaseId, runSnapshot.leaseId);
          }
        }

        const details = this.reconcileStaleActionsAndAttemptsForRun(tx, runId, nowIso, fencing);
        if (details.length > 0) {
          recoveredRuns++;
          for (const d of details) {
            if (d.priorAttemptStatus && d.priorAttemptStatus !== d.resultingAttemptStatus) {
              reconciledAttempts++;
            }
            if (d.priorActionStatus !== d.resultingActionStatus) {
              reconciledActions++;
            }
            allDetails.push(d);
          }
        }
      });
    }

    return {
      recoveredRuns,
      reconciledAttempts,
      reconciledActions,
      details: allDetails,
    };
  }

  /**
   * Resolves the owning Run for a discovered workspace.
   * Checks adapter tracking, disk metadata, and state store queries.
   */
  resolveOwningRunForWorkspace(workspaceId: string): RunSnapshot | null {
    // 1. Adapter in-memory handle
    if (this.workspacePort && "getWorkspaceHandle" in this.workspacePort) {
      const handle = (this.workspacePort as any).getWorkspaceHandle(workspaceId) as WorkspaceHandle | null;
      if (handle?.runId) {
        const run = this.stateStore.getRun(handle.runId);
        if (run) return run;
      }
    }
    // 2. Adapter disk metadata
    if (this.workspacePort && "getWorkspaceMetadataSync" in this.workspacePort) {
      const meta = (this.workspacePort as any).getWorkspaceMetadataSync(workspaceId);
      if (meta?.runId) {
        const run = this.stateStore.getRun(meta.runId);
        if (run) return run;
      }
    }
    // 3. State store query
    if (this.stateStore.findRunIdForWorkspace) {
      const runId = this.stateStore.findRunIdForWorkspace(workspaceId);
      if (runId) {
        const run = this.stateStore.getRun(runId);
        if (run) return run;
      }
    }
    return null;
  }

  /**
   * Authoritatively determines whether a workspace is currently active based on
   * current durable run state, lease validity, and workspace ownership.
   *
   * Invariant: Audit history ≠ Current authority.
   * A workspace is active IF AND ONLY IF:
   * 1. A valid owning Run exists in durable state.
   * 2. The owning Run is in an active (non-terminal) state.
   * 3. If in LEASED or RUNNING state, the Run holds an unexpired, ACTIVE lease.
   * 4. A non-terminal run in RECOVERING, or holding unreconciled workspace mutations (rollback pending), is always active.
   *    Must not be called from inside a state-store transaction.
   */
  isWorkspaceAuthoritativelyActive(workspaceId: string, owner?: { readonly runId: string; readonly leaseId: string }): boolean {
    // Tied to the ownership marker's own lease: a workspace whose recorded lease is still ACTIVE and unexpired is live
    // regardless of how (or whether) the workspace id resolves to a run.
    if (owner) {
      const markerLease = this.stateStore.getLease(owner.leaseId);
      if (markerLease && markerLease.runId === owner.runId && markerLease.state === "ACTIVE" && markerLease.expiresAt > this.clock.nowIso()) {
        return true;
      }
    }
    const owningRun = this.resolveOwningRunForWorkspace(workspaceId);
    if (!owningRun) {
      // Unknown workspace or unlinked
      return false;
    }

    // Terminal runs never have active workspaces
    const terminalStatuses = new Set([
      "COMPLETED",
      "FAILED",
      "TIMED_OUT",
      "CANCELLED",
      "CONTRACT_REVOKED",
    ]);
    if (terminalStatuses.has(owningRun.status)) {
      return false;
    }

    // A run whose workspace mutations are not yet reconciled (held by the retry gate, or being recovered) still owns its
    // workspace even though its lease expired: the supervisor's rollback needs it, so it must never be treated as an orphan.
    if (
      owningRun.status === "RECOVERING" ||
      this.stateStore.transaction((tx) => this.requiresRollbackBeforeRetry(tx, owningRun.runId))
    ) {
      return true;
    }

    // Queued or Created runs have valid pending ownership
    if (owningRun.status === "CREATED" || owningRun.status === "QUEUED") {
      return true;
    }

    // Leased or Running runs must hold a valid, unexpired active lease
    if (owningRun.status === "LEASED" || owningRun.status === "RUNNING") {
      const nowIso = this.clock.nowIso();
      if (!owningRun.leaseId || !owningRun.leaseExpiresAt || owningRun.leaseExpiresAt <= nowIso) {
        // Lease has expired
        return false;
      }
      const lease = this.stateStore.getLease(owningRun.leaseId);
      if (!lease || lease.state !== "ACTIVE" || lease.expiresAt <= nowIso) {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Safely cleans up orphaned workspaces using authoritative state store ownership.
   * Evaluates each discovered workspace on disk against current durable run and lease state.
   */
  async cleanupOrphanedWorkspacesSafely(options?: OrphanSweepOptions): Promise<readonly string[]> {
    if (!this.workspacePort) {
      return [];
    }
    return this.workspacePort.cleanupOrphanedWorkspaces((wsId, owner) => {
      return this.isWorkspaceAuthoritativelyActive(wsId, owner);
    }, options);
  }

  /**
   * Computes the authoritative set of active workspace IDs across all active runs.
   */
  getAuthoritativeActiveWorkspaceIds(): ReadonlySet<string> {
    const activeWsIds = new Set<string>();
    for (const wsId of this.activeWorkspaceIds) {
      if (this.isWorkspaceAuthoritativelyActive(wsId)) {
        activeWsIds.add(wsId);
      }
    }
    return activeWsIds;
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

  getRunRaw(runId: string): RunSnapshot | null {
    return this.stateStore.getRunRaw ? this.stateStore.getRunRaw(runId) : this.stateStore.getRun(runId);
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

  getContract(contractId: string, version: number): MissionContract | null {
    return this.stateStore.getContract(contractId, version);
  }

  get store(): StateStorePort {
    return this.stateStore;
  }

  getAction(actionId: string): ActionSnapshot | null {
    return this.stateStore.getAction(actionId);
  }

  getAttempt(attemptId: string): AttemptSnapshot | null {
    return this.stateStore.getAttempt(attemptId);
  }

  getActionsForRun(runId: string): readonly ActionSnapshot[] {
    return this.stateStore.getActionsForRun(runId);
  }

  getAttemptsForAction(actionId: string): readonly AttemptSnapshot[] {
    return this.stateStore.getAttemptsForAction(actionId);
  }

  // ---------------------------------------------------------------------------
  // Phase 32 Supervisor Lease & Checkpoint Operations
  // ---------------------------------------------------------------------------

  claimSupervisorLease(params: {
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso?: string;
  }): SupervisorLease {
    const nowIso = params.nowIso ?? this.clock.nowIso();
    return this.stateStore.transaction((tx) => {
      return tx.acquireSupervisorLease({
        runId: params.runId,
        supervisorId: params.supervisorId,
        ttlMs: params.ttlMs,
        nowIso,
      });
    });
  }

  renewSupervisorLease(params: {
    leaseId: string;
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso?: string;
  }): SupervisorLease {
    const nowIso = params.nowIso ?? this.clock.nowIso();
    return this.stateStore.transaction((tx) => {
      return tx.renewSupervisorLease({
        leaseId: params.leaseId,
        runId: params.runId,
        supervisorId: params.supervisorId,
        ttlMs: params.ttlMs,
        nowIso,
      });
    });
  }

  heartbeatSupervisor(params: {
    runId: string;
    supervisorId: string;
    leaseId: string;
    ttlMs?: number;
    nowIso?: string;
  }): SupervisorLease {
    const nowIso = params.nowIso ?? this.clock.nowIso();
    const ttlMs = params.ttlMs ?? 10000;
    try {
      return this.stateStore.transaction((tx) => {
        return tx.renewSupervisorLease({
          leaseId: params.leaseId,
          runId: params.runId,
          supervisorId: params.supervisorId,
          ttlMs,
          nowIso,
        });
      });
    } catch (err: unknown) {
      if (err instanceof SupervisorLeaseExpiredError) {
        this.stateStore.expireSupervisorLease(params.leaseId, nowIso);
      }
      throw err;
    }
  }

  releaseSupervisorLease(leaseId: string, nowIso?: string): void {
    const ts = nowIso ?? this.clock.nowIso();
    this.stateStore.transaction((tx) => {
      tx.releaseSupervisorLease(leaseId, ts);
    });
  }

  getSupervisorLease(leaseId: string): SupervisorLease | null {
    return this.stateStore.getSupervisorLease(leaseId);
  }

  findActiveSupervisorLease(runId: string, nowIso?: string): SupervisorLease | null {
    return this.stateStore.findActiveSupervisorLease(runId, nowIso ?? this.clock.nowIso());
  }

  saveCheckpoint(params: SaveCheckpointParams): MissionCheckpoint {
    const nowIso = params.nowIso ?? this.clock.nowIso();
    return this.stateStore.transaction((tx) => {
      if (params.supervisorFencing) {
        (tx as any).validateSupervisorFencing(params.runId, {
          ...params.supervisorFencing,
          nowIso,
        });
      }

      const run = tx.getRun(params.runId);
      if (!run) {
        throw new Error(`Run '${params.runId}' not found`);
      }

      if (params.workerFencing) {
        const wf = params.workerFencing;
        if (run.leaseId !== wf.leaseId || run.currentWorkerId !== wf.workerId) {
          throw new LeaseLostError(params.runId, wf.leaseId, run.leaseId ?? null);
        }
        const lease = tx.getLease(wf.leaseId);
        if (!lease || lease.state !== "ACTIVE") {
          throw new LeaseLostError(params.runId, wf.leaseId, run.leaseId ?? null);
        }
        if (lease.expiresAt <= nowIso) {
          throw new LeaseExpiredError(wf.leaseId, lease.expiresAt, nowIso);
        }
      }

      const contractBinding = params.contractBinding ?? run.contractBinding;
      if (!contractBinding) {
        throw new MissingBoundContractError(params.runId);
      }

      const events = tx.getEventsForRun(params.runId);
      const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
      const eventSequence = params.eventSequence ?? (lastEvent ? lastEvent.sequence : 1);

      const checkpoint: MissionCheckpoint = {
        checkpointId: crypto.randomUUID(),
        runId: params.runId,
        checkpointVersion: params.checkpointVersion,
        contractBinding,
        actionId: params.actionId ?? null,
        attemptNumber: params.attemptNumber ?? null,
        durableState: params.durableState,
        eventSequence,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      tx.insertCheckpoint(checkpoint);
      return checkpoint;
    });
  }

  getLatestCheckpoint(runId: string): MissionCheckpoint | null {
    return this.stateStore.getLatestCheckpoint(runId);
  }

  getCheckpoints(runId: string): readonly MissionCheckpoint[] {
    return this.stateStore.getCheckpoints(runId);
  }

  recoverMission(params: RecoverMissionParams): RecoverMissionResult {
    // Authority time is the injected clock; params.nowIso is validated but cannot backdate or advance it.
    const nowIso = resolveAuthorityNowIso(this.clock, params.nowIso, params.runId);

    return this.stateStore.transaction((tx) => {
      // 1. Validate supervisor lease and fencing
      (tx as any).validateSupervisorFencing(params.runId, {
        supervisorId: params.supervisorId,
        leaseId: params.supervisorLeaseId,
        nowIso,
      });

      // 2. Validate run exists
      let runSnapshot: RunSnapshot | null = null;
      try {
        runSnapshot = tx.getRun(params.runId);
      } catch (err: unknown) {
        if (
          err instanceof InvalidMissionContractError &&
          err.message.includes("Content hash mismatch") &&
          tx.getRunRaw
        ) {
          runSnapshot = tx.getRunRaw(params.runId);
        } else {
          throw err;
        }
      }
      if (!runSnapshot) {
        throw new Error(`Run '${params.runId}' not found`);
      }

      // 3. Validate contract binding
      if (!runSnapshot.contractBinding) {
        throw new MissingBoundContractError(runSnapshot.runId);
      }
      const binding = runSnapshot.contractBinding;

      let contract: MissionContract;
      try {
        const found = tx.getContract(binding.contractId, binding.version);
        if (!found) {
          throw new MissingBoundContractError(binding.contractId, binding.version);
        }
        contract = found;
      } catch (err: unknown) {
        if (
          err instanceof InvalidMissionContractError &&
          err.message.includes("Content hash mismatch")
        ) {
          throw new ContractIntegrityError(
            runSnapshot.runId,
            binding.contentHash,
            "corrupted_content_hash"
          );
        }
        throw err;
      }

      // 4. Validate contract content hash integrity
      const { contentHash: recomputedHash } = computeCanonicalHash(contract.spec);
      if (
        recomputedHash !== contract.contentHash ||
        contract.contentHash !== binding.contentHash
      ) {
        throw new ContractIntegrityError(
          runSnapshot.runId,
          binding.contentHash,
          contract.contentHash
        );
      }

      // 5. Validate contract lifecycle
      if (contract.lifecycle.status === "REVOKED") {
        throw new InvalidMissionContractError(
          `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} has been REVOKED`
        );
      }
      if (contract.lifecycle.status !== "ACTIVE") {
        throw new InvalidMissionContractError(
          `Bound MissionContract '${contract.spec.contractId}' v${contract.spec.version} is not ACTIVE (status: '${contract.lifecycle.status}')`
        );
      }

      // 5.5 Validate Tenant Quiescence (F-02 Remediation)
      // An isolated run must NOT undergo mission recovery without affirmative durable tenant quiescence proof.
      if (this.runRequiresTenantQuiescence(runSnapshot)) {
        const gate =
          typeof (tx as any).getTenantLaunchGate === "function"
            ? (tx as any).getTenantLaunchGate(params.runId)
            : typeof this.stateStore.getTenantLaunchGate === "function"
              ? this.stateStore.getTenantLaunchGate(params.runId)
              : null;
        const gateExpiresMs = gate ? Date.parse(gate.expiresAt) : Number.NaN;
        const gateFresh = Number.isFinite(gateExpiresMs) && Date.parse(nowIso) < gateExpiresMs;
        if (!gate || gate.state !== "QUIESCED" || gate.holderType !== "RECOVERY" || gate.holderId !== params.supervisorId || !gateFresh || params.gateToken === undefined || gate.token !== params.gateToken) {
          throw new TenantQuiescenceRequiredError(
            params.runId,
            `Mission recovery for run '${params.runId}' requires affirmative, unexpired tenant quiescence verification under supervisor '${params.supervisorId}' for the exact gate generation supplied in gateToken (${params.gateToken === undefined ? "none supplied" : "stale or mismatched"}); gate is '${gate?.state ?? "NONE"}' held by '${gate?.holderId ?? "NONE"}' expiring '${gate?.expiresAt ?? "n/a"}' (expected QUIESCED under '${params.supervisorId}', not expired at '${nowIso}').`
          );
        }
      }

      // 6. Inspect current checkpoint
      const latestCheckpoint = tx.getLatestCheckpoint(params.runId);

      // 7. Inspect actions & attempts
      const actions = tx.getActionsForRun(params.runId);
      const targetAction = actions.length > 0 ? actions[actions.length - 1] : null;

      let previousAttempt: AttemptSnapshot | null = null;
      let newAttempt: AttemptSnapshot | null = null;

      if (targetAction) {
        const attempts = tx.getAttemptsForAction(targetAction.actionId);
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

        // Check for duplicate recovery (idempotency check):
        if (
          latestAttempt &&
          !isTerminalAttemptStatus(latestAttempt.status) &&
          latestAttempt.attemptNumber > 1
        ) {
          const prevAtt: AttemptSnapshot | null = attempts.length > 1 ? (attempts[attempts.length - 2] ?? null) : null;
          const currentCheckpoint = latestCheckpoint ?? {
            checkpointId: crypto.randomUUID(),
            runId: params.runId,
            checkpointVersion: 1,
            contractBinding: binding,
            actionId: targetAction.actionId,
            attemptNumber: latestAttempt.attemptNumber,
            durableState: { status: "RECOVERED", recoveryTimestamp: nowIso, supervisorId: params.supervisorId },
            eventSequence: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          return {
            run: runSnapshot,
            checkpoint: currentCheckpoint,
            previousAttempt: prevAtt,
            newAttempt: latestAttempt,
            events: tx.getEventsForRun(params.runId),
          };
        }

        // Shared recovery policy (see recovery-decision-policy.ts). recoverMission has already validated
        // supervisor fencing and any required tenant quiescence, so those count as evidence here.
        const decision = decideRecovery({
          idempotency: targetAction.idempotency,
          actionStatus: targetAction.status,
          attemptStatus: latestAttempt?.status ?? null,
          totalAttempts: targetAction.totalAttempts,
          maxAttempts: targetAction.maxAttempts,
          evidence: SUPERVISOR_EVIDENCE,
          startedAttemptRowMissing: isStartedAttemptRowMissing(
            targetAction,
            latestAttempt?.attemptNumber ?? null
          ),
        });
        const gen = () => crypto.randomUUID();

        // Reconcile Attempt N
        if (latestAttempt) {
          if (decision.attemptTransition === "CANCEL") {
            previousAttempt = tx.transitionAttempt(
              latestAttempt.attemptId,
              { type: "CANCEL", reason: "Supervisor recovery cancelled un-dispatched attempt", now: nowIso },
              gen
            ).snapshot;
          } else if (decision.attemptTransition === "MARK_UNKNOWN") {
            previousAttempt = tx.transitionAttempt(
              latestAttempt.attemptId,
              {
                type: "MARK_UNKNOWN",
                reason: "Supervisor recovery of crashed attempt",
                reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
                now: nowIso,
              },
              gen
            ).snapshot;
          } else {
            previousAttempt = latestAttempt;
          }
        }

        // Action transition. A terminal Action is never reopened; an uncertain NON_IDEMPOTENT Action is
        // failed closed and receives no replacement Attempt.
        switch (decision.actionTransition) {
          case "SUCCEED":
            tx.transitionAction(
              targetAction.actionId,
              { type: "SUCCEED", resultPayload: latestAttempt?.outputPayload, now: nowIso },
              gen
            );
            break;
          case "PREPARE_RETRY":
            tx.transitionAction(
              targetAction.actionId,
              {
                type: "PREPARE_RETRY",
                errorPayload: { code: "EXECUTION_UNCERTAIN", reason: "Supervisor recovery" },
                now: nowIso,
              },
              gen
            );
            break;
          case "FAIL":
            tx.transitionAction(
              targetAction.actionId,
              {
                type: "FAIL",
                errorPayload:
                  decision.failureKind === "NOT_DISPATCHED"
                    ? { code: "WORKER_CRASHED", message: "Worker crashed before dispatch" }
                    : decision.failureKind === "UNCERTAIN"
                      ? {
                          code: "EXECUTION_UNCERTAIN",
                          reasonCode: "LEASE_EXPIRED_DURING_EXECUTION",
                          message:
                            "Physical execution uncertain: worker crashed or lease expired during execution",
                        }
                      : latestAttempt?.errorPayload,
                now: nowIso,
              },
              gen
            );
            break;
          case "TIMEOUT":
            tx.transitionAction(
              targetAction.actionId,
              { type: "TIMEOUT", reason: latestAttempt?.errorPayload, now: nowIso },
              gen
            );
            break;
          case "CANCEL":
            tx.transitionAction(
              targetAction.actionId,
              { type: "CANCEL", reason: latestAttempt?.errorPayload, now: nowIso },
              gen
            );
            break;
          default:
            break;
        }

        // A replacement Attempt is created only when the shared policy permits a retry.
        const currentTotalAttempts = targetAction.totalAttempts;
        if (decision.retry) {
          const nextAttemptNumber = (previousAttempt?.attemptNumber ?? currentTotalAttempts) + 1;
          const newAttemptId = crypto.randomUUID();
          const newWorkerId = params.newWorkerId ?? "supervisor-recovery-worker";
          const newWorkerLeaseId = params.newWorkerLeaseId ?? `lease-recovery-${crypto.randomUUID()}`;

          // Ensure worker exists
          const existingWorker = tx.getWorker(newWorkerId);
          if (!existingWorker) {
            tx.insertWorker({
              workerId: newWorkerId,
              hostname: "supervisor-node",
              pid: 1000,
              status: "ACTIVE",
              lastHeartbeatAt: nowIso,
              createdAt: nowIso,
            });
          }

          // Ensure worker lease exists
          const newLeaseExpiresAt = new Date(new Date(nowIso).getTime() + 60000).toISOString();
          const existingWorkerLease = tx.getLease(newWorkerLeaseId);
          if (!existingWorkerLease) {
            tx.insertLease({
              leaseId: newWorkerLeaseId,
              runId: params.runId,
              workerId: newWorkerId,
              acquiredAt: nowIso,
              expiresAt: newLeaseExpiresAt,
              releasedAt: null,
              state: "ACTIVE",
            });
          }

          // Expire previous worker lease if active
          if (runSnapshot.leaseId && runSnapshot.leaseId !== newWorkerLeaseId) {
            const oldLease = tx.getLease(runSnapshot.leaseId);
            if (oldLease && oldLease.state === "ACTIVE") {
              tx.updateLeaseState(runSnapshot.leaseId, "EXPIRED", nowIso);
            }
          }

          // Re-bind run to the new worker and lease under supervisor authority
          const updatedRunSnapshot: RunSnapshot = {
            ...runSnapshot,
            currentWorkerId: newWorkerId,
            leaseId: newWorkerLeaseId,
            leaseExpiresAt: newLeaseExpiresAt,
            status: "RUNNING",
            version: runSnapshot.version + 1,
            updatedAt: nowIso,
          };
          tx.updateRun(
            params.runId,
            runSnapshot.version,
            updatedRunSnapshot,
            {
              eventId: crypto.randomUUID(),
              runId: params.runId,
              timestamp: nowIso,
              eventType: "run.recovered",
              schemaVersion: 1,
              producer: `supervisor.${params.supervisorId}`,
              payload: {
                previousWorkerId: runSnapshot.currentWorkerId,
                previousLeaseId: runSnapshot.leaseId,
                newWorkerId,
                newLeaseId: newWorkerLeaseId,
              },
            }
          );

          const idempotencyToken = createAttemptIdempotencyToken(
            params.runId,
            targetAction.actionId,
            nextAttemptNumber
          );

          const { attempt: attNext, event: attNextEvt } = Attempt.create({
            attemptId: newAttemptId,
            actionId: targetAction.actionId,
            runId: params.runId,
            attemptNumber: nextAttemptNumber,
            workerId: newWorkerId,
            leaseId: newWorkerLeaseId,
            idempotencyToken,
            now: nowIso,
          });

          tx.transitionAction(
            targetAction.actionId,
            { type: "START_ATTEMPT", attemptNumber: nextAttemptNumber, now: nowIso },
            () => crypto.randomUUID()
          );

          tx.insertAttempt(attNext.snapshot, attNextEvt, {
            workerId: newWorkerId,
            leaseId: newWorkerLeaseId,
          });

          newAttempt = attNext.snapshot;
        }
      }

      // Checkpoint creation
      const nextCheckpointVersion = (latestCheckpoint?.checkpointVersion ?? 0) + 1;
      const events = tx.getEventsForRun(params.runId);
      const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
      const latestSeq = lastEvent ? lastEvent.sequence : 1;

      const checkpoint: MissionCheckpoint = {
        checkpointId: crypto.randomUUID(),
        runId: params.runId,
        checkpointVersion: nextCheckpointVersion,
        contractBinding: binding,
        actionId: targetAction?.actionId ?? null,
        attemptNumber: newAttempt?.attemptNumber ?? previousAttempt?.attemptNumber ?? null,
        durableState: {
          status: "RECOVERED",
          supervisorId: params.supervisorId,
          recoveredAt: nowIso,
          actionId: targetAction?.actionId ?? null,
          previousAttemptId: previousAttempt?.attemptId ?? null,
          newAttemptId: newAttempt?.attemptId ?? null,
        },
        eventSequence: latestSeq,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      tx.insertCheckpoint(checkpoint);

      return {
        run: tx.getRun(params.runId)!,
        checkpoint,
        previousAttempt,
        newAttempt,
        events,
      };
    });
  }
}
