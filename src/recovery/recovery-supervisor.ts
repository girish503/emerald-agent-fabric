/**
 * Emerald Agent Fabric — Recovery Supervisor
 *
 * Implements durable crash recovery coordination, worker lease expiration handling,
 * supervisor lease acquisition and fencing, and run lifecycle transitions
 * per ADR-0036 and Phase 48AG.2 authority fencing.
 *
 * Core Responsibilities:
 * 1. Identify runs eligible for recovery using persisted state.
 * 2. Strictly enforce worker lease fencing (active worker leases must never be reclaimed).
 * 3. Acquire supervisor leases via store API (preventing concurrent recovery by multiple supervisors).
 * 4. Transition eligible runs from LEASED/RUNNING -> RECOVERING with domain events.
 * 5. Coordinate DurableRollbackEngine under supervisor authority.
 * 6. Commit terminal run outcomes justified by rollback progress (RECOVERING -> FAILED).
 * 7. Release or renew supervisor leases idempotently.
 * 8. Resume interrupted recoveries cleanly across supervisor process restarts.
 */

import { ClockPort, SystemClock, resolveAuthorityNowIso } from "../ports/clock.port.js";
import {
  MutationAuthorityContext,
  StateStorePort,
  StorageTransaction,
  SupervisorLease,
} from "../ports/index.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Run } from "../domain/run.js";
import { isTerminalState, RunSnapshot } from "../domain/invariants.js";
import {
  ActiveWorkerLeaseFencingError,
  MissingMutationAuthorityError,
  SupervisorLeaseLostError,
  WorkspaceBindingConflictError,
  WorkspaceResolutionError,
} from "../domain/errors.js";
import {
  DurableRollbackEngine,
  RollbackExecutionResult,
} from "./durable-rollback-engine.js";
import { RunRollbackStatus } from "../domain/mutation-intent.js";

export interface RecoverySupervisorConfig {
  readonly stateStore: StateStorePort;
  readonly rollbackEngine: DurableRollbackEngine;
  readonly clock?: ClockPort;
  readonly supervisorId?: string;
  readonly supervisorPid?: number;
  readonly leaseTtlMs?: number;
  readonly workspaceResolver?: (runId: string) => string | undefined | Promise<string | undefined>;
}

export type RecoveryRunOutcomeStatus =
  | "RECOVERED"
  /** Run was closed out, but zero mutation intents were on record: workspace state is unverified. */
  | "RECOVERED_UNVERIFIED"
  | "SKIPPED_INELIGIBLE"
  | "SKIPPED_TERMINAL"
  | "SKIPPED_ACTIVE_WORKER_LEASE"
  | "SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR"
  | "SKIPPED_TENANTS_NOT_QUIESCED"
  | "ROLLBACK_CONFLICT"
  | "FAILED";

export interface RecoveryRunOutcome {
  readonly runId: string;
  readonly status: RecoveryRunOutcomeStatus;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly rollbackStatus?: RunRollbackStatus;
  readonly supervisorLeaseId?: string;
  readonly details: string;
  readonly error?: string;
  /**
   * True when the run was recovered with zero mutation intents on record. Recovery then
   * has no evidence about workspace state; "RECOVERED" means only "nothing to roll back".
   */
  readonly noMutationIntentsRecorded?: boolean;
}

export interface ScanAndRecoverResult {
  readonly scannedCount: number;
  readonly recoveredCount: number;
  /** Runs closed out with no mutation evidence; NOT counted as recovered. */
  readonly unverifiedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly outcomes: readonly RecoveryRunOutcome[];
}

export class RecoverySupervisor {
  private readonly stateStore: StateStorePort;
  private readonly rollbackEngine: DurableRollbackEngine;
  private readonly clock: ClockPort;
  private readonly supervisorId: string;
  private readonly supervisorPid: number;
  private readonly leaseTtlMs: number;
  private readonly workspaceResolver?: (runId: string) => string | undefined | Promise<string | undefined>;

  constructor(config: RecoverySupervisorConfig) {
    if (!config.stateStore) {
      throw new Error("RecoverySupervisor requires a valid StateStorePort");
    }
    if (!config.rollbackEngine) {
      throw new Error("RecoverySupervisor requires a valid DurableRollbackEngine");
    }

    this.stateStore = config.stateStore;
    this.rollbackEngine = config.rollbackEngine;
    this.clock = config.clock ?? new SystemClock();
    this.supervisorId = config.supervisorId && config.supervisorId.trim().length > 0
      ? config.supervisorId.trim()
      : `recovery-supervisor-${randomUUID()}`;
    this.supervisorPid = config.supervisorPid ?? (typeof process !== "undefined" && process.pid ? process.pid : 1);
    this.leaseTtlMs = config.leaseTtlMs && config.leaseTtlMs > 0 ? config.leaseTtlMs : 30000;
    this.workspaceResolver = config.workspaceResolver;
  }

  /**
   * Validates live supervisor authority. Fails closed when the store cannot validate
   * fencing instead of silently skipping the check.
   */
  private assertSupervisorFenced(runId: string, leaseId: string, nowIso?: string): void {
    if (typeof this.stateStore.validateSupervisorFencing !== "function") {
      throw new MissingMutationAuthorityError(
        runId,
        "State store cannot validate supervisor fencing; refusing recovery transition"
      );
    }
    this.stateStore.validateSupervisorFencing(runId, {
      supervisorId: this.supervisorId,
      leaseId,
      ...(nowIso !== undefined ? { nowIso } : {}),
    });
  }

  /**
   * Determines the single workspace this run owns. The persisted run binding is
   * authoritative; an explicit or resolver-supplied root must match it. An unbound
   * run accepts an explicitly supplied root once (first bind wins). There is no
   * implicit fallback to process.cwd().
   */
  private async resolveAuthorizedWorkspace(
    runId: string,
    explicitRoot: string | undefined
  ): Promise<{ readonly root: string; readonly needsBind: boolean }> {
    const bound = this.stateStore.getRunWorkspaceBinding(runId);

    let supplied = explicitRoot;
    if (!supplied && this.workspaceResolver) {
      supplied = (await this.workspaceResolver(runId)) ?? undefined;
    }

    if (!bound && !supplied) {
      throw new WorkspaceResolutionError(
        runId,
        "no persisted workspace binding and no explicit workspaceRoot or resolver result"
      );
    }

    const canonicalBound = bound ? canonicalizeWorkspaceRoot(runId, bound) : undefined;
    const canonicalSupplied = supplied ? canonicalizeWorkspaceRoot(runId, supplied) : undefined;

    if (canonicalBound) {
      if (bound && !sameWorkspacePath(canonicalBound, bound)) {
        // The stored root no longer resolves to itself (replaced by a link/junction or renamed).
        throw new WorkspaceBindingConflictError(runId, bound, canonicalBound);
      }
      if (canonicalSupplied && !sameWorkspacePath(canonicalBound, canonicalSupplied)) {
        throw new WorkspaceBindingConflictError(runId, canonicalBound, canonicalSupplied);
      }
      return { root: canonicalBound, needsBind: false };
    }

    // Unbound run: the root is validated here but NOT persisted. The binding is authoritative (first bind wins), so it
    // is written by recoverRun only after this supervisor holds the run's supervisor lease.
    return { root: canonicalSupplied as string, needsBind: true };
  }

  public getSupervisorId(): string {
    return this.supervisorId;
  }

  public getSupervisorPid(): number {
    return this.supervisorPid;
  }

  public getClock(): ClockPort {
    return this.clock;
  }

  public getStateStore(): StateStorePort {
    return this.stateStore;
  }

  /**
   * Scans persistence for runs eligible for recovery:
   * 1. Runs in LEASED or RUNNING status whose worker lease has expired.
   * 2. Runs already in RECOVERING status (interrupted recovery resumption).
   */
  public findEligibleRuns(nowIso?: string): readonly RunSnapshot[] {
    const effectiveNow = resolveAuthorityNowIso(this.clock, nowIso, "findEligibleRuns");
    const expiredRuns = this.stateStore.findExpiredRuns(effectiveNow);
    const recoveringRuns = this.stateStore.findRecoveringRuns
      ? this.stateStore.findRecoveringRuns()
      : [];

    const seenRunIds = new Set<string>();
    const eligible: RunSnapshot[] = [];

    for (const run of [...expiredRuns, ...recoveringRuns]) {
      if (!seenRunIds.has(run.runId)) {
        seenRunIds.add(run.runId);
        eligible.push(run);
      }
    }

    return eligible;
  }

  /**
   * Returns true if the run may have isolated tenant processes (fail closed)
   * requiring verified tenant quiescence before workspace mutation/rollback.
   */
  public runRequiresTenantQuiescence(runSnapshot: RunSnapshot): boolean {
    const binding = runSnapshot.contractBinding;
    if (!binding) return true;
    let contract: ReturnType<StateStorePort["getContract"]>;
    try {
      contract = this.stateStore.getContract(binding.contractId, binding.version);
    } catch {
      // A corrupt or tampered contract cannot prove IN_PROCESS isolation; fail closed.
      return true;
    }
    if (!contract) return true;
    return contract.spec.policy.isolationRequirement !== "IN_PROCESS";
  }

  /**
   * Recovers a single run following crash or worker lease expiration.
   * Enforces supervisor lease acquisition, active worker lease fencing,
   * durable rollback execution, and terminal run state persistence.
   */
  public async recoverRun(
    runId: string,
    options?: {
      workspaceRoot?: string;
      nowIso?: string;
      quiescedRunIds?: ReadonlySet<string>;
      /**
       * Gate generation (token) from the acquisition that established quiescence. Required for isolated runs: recovery
       * is authorized only while the durable gate still carries exactly this token.
       */
      gateToken?: string;
    }
  ): Promise<RecoveryRunOutcome> {
    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new Error("RecoverySupervisor.recoverRun requires a valid runId");
    }

    // Authority time is the injected clock; options.nowIso is validated but cannot backdate or advance it.
    const effectiveNow = resolveAuthorityNowIso(this.clock, options?.nowIso, runId);

    // Step 1: Pre-acquisition candidate inspection
    const candidate = this.stateStore.getRun(runId);
    if (!candidate) {
      return {
        runId,
        status: "SKIPPED_INELIGIBLE",
        statusBefore: "NON_EXISTENT",
        statusAfter: "NON_EXISTENT",
        details: `Run '${runId}' not found`,
      };
    }

    const statusBefore = candidate.status;

    // Terminal guard: Terminal runs must never be reopened or mutated
    if (isTerminalState(statusBefore)) {
      return {
        runId,
        status: "SKIPPED_TERMINAL",
        statusBefore,
        statusAfter: statusBefore,
        details: `Run '${runId}' is in terminal state '${statusBefore}'; recovery is an idempotent no-op.`,
      };
    }

    // Ineligible status guard: CREATED or QUEUED have not started execution
    if (statusBefore === "CREATED" || statusBefore === "QUEUED") {
      return {
        runId,
        status: "SKIPPED_INELIGIBLE",
        statusBefore,
        statusAfter: statusBefore,
        details: `Run '${runId}' is in non-executable state '${statusBefore}'; recovery ineligible.`,
      };
    }

    // Worker lease fencing check: Do not reclaim or modify if worker lease is unexpired
    if (statusBefore === "RUNNING" || statusBefore === "LEASED") {
      if (candidate.leaseExpiresAt) {
        const expiresMs = new Date(candidate.leaseExpiresAt).getTime();
        const nowMs = new Date(effectiveNow).getTime();
        if (nowMs < expiresMs) {
          throw new ActiveWorkerLeaseFencingError(
            runId,
            candidate.currentWorkerId ?? "unknown",
            candidate.leaseId ?? "unknown",
            candidate.leaseExpiresAt
          );
        }
      }
    }

    // Tenant Quiescence Guard (Invariant A / F-03 Remediation): Runs with isolated processes cannot be rolled back
    // unless tenant quiescence has been affirmatively established in durable state (state === 'QUIESCED' under RECOVERY).
    if (this.runRequiresTenantQuiescence(candidate)) {
      const gate =
        typeof this.stateStore.getTenantLaunchGate === "function"
          ? this.stateStore.getTenantLaunchGate(runId)
          : null;
      const isQuiesced =
        (options?.quiescedRunIds === undefined || options.quiescedRunIds.has(runId)) &&
        gate !== null &&
        gate.state === "QUIESCED" &&
        gate.holderType === "RECOVERY" &&
        gate.holderId === this.supervisorId &&
        isGateUnexpired(gate.expiresAt, effectiveNow) &&
        options?.gateToken !== undefined &&
        gate.token === options.gateToken;
      if (!isQuiesced) {
        const details =
          gate && gate.state === "QUIESCED" && gate.holderType === "RECOVERY" && gate.holderId !== this.supervisorId
            ? `Run '${runId}' tenant execution is QUIESCED under supervisor '${gate.holderId}'; recovery refused for supervisor '${this.supervisorId}'.`
            : gate && gate.state === "QUIESCED" && gate.holderType === "RECOVERY" && !isGateUnexpired(gate.expiresAt, effectiveNow)
              ? `Run '${runId}' QUIESCED gate expired at '${gate.expiresAt}'; quiescence must be re-verified before recovery.`
              : gate && gate.state === "QUIESCED" && gate.holderType === "RECOVERY" && gate.holderId === this.supervisorId
                ? `Run '${runId}' recovery requires the token of the gate acquisition that established quiescence (${options?.gateToken === undefined ? "none supplied" : "stale or mismatched gate generation"}).`
                : `Run '${runId}' requires tenant isolation and affirmative quiescence was not verified in durable state (gate must be QUIESCED under RECOVERY authority '${this.supervisorId}').`;
        return {
          runId,
          status: "SKIPPED_TENANTS_NOT_QUIESCED",
          statusBefore,
          statusAfter: statusBefore,
          details,
        };
      }
    }

    if (typeof this.stateStore.getTenantLaunchGate === "function") {
      const gate = this.stateStore.getTenantLaunchGate(runId);
      if (gate && gate.state === "QUARANTINED") {
        return {
          runId,
          status: "SKIPPED_TENANTS_NOT_QUIESCED",
          statusBefore,
          statusAfter: statusBefore,
          details: `Run '${runId}' tenant execution is quarantined (prior container termination unverified).`,
        };
      }
    }

    // Step 1b: Resolve the authorized workspace BEFORE any state is touched.
    // Fails closed (throws) when identity is unresolved or conflicting; never guesses. Resolution is read-only;
    // a first-time binding is persisted below, only after the supervisor lease is held.
    const { root: resolvedWorkspaceRoot, needsBind } = await this.resolveAuthorizedWorkspace(
      runId,
      options?.workspaceRoot
    );

    // Step 2: Acquire supervisor lease
    let supervisorLease: SupervisorLease;
    try {
      supervisorLease = this.stateStore.acquireSupervisorLease({
        runId,
        supervisorId: this.supervisorId,
        ttlMs: this.leaseTtlMs,
        nowIso: effectiveNow,
        ownerPid: this.supervisorPid,
      });
    } catch (err: unknown) {
      if (err instanceof SupervisorLeaseLostError) {
        return {
          runId,
          status: "SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR",
          statusBefore,
          statusAfter: statusBefore,
          details: err.message,
          error: err.message,
        };
      }
      throw err;
    }

    try {
      // Step 2b: Persist the first-time workspace binding now that this supervisor owns the lease. A conflicting
      // concurrent bind throws; the catch below releases the lease and rethrows (fail closed, no recovery work done).
      if (needsBind) {
        this.stateStore.bindRunWorkspace(runId, resolvedWorkspaceRoot, effectiveNow);
      }

      // Step 3: Transition run to RECOVERING inside transaction (if not already RECOVERING)
      this.stateStore.transaction((tx: StorageTransaction) => {
        const freshSnapshot = tx.getRun(runId);
        if (!freshSnapshot) {
          throw new Error(`Run '${runId}' disappeared during recovery`);
        }

        if (isTerminalState(freshSnapshot.status)) {
          return;
        }

        if (freshSnapshot.status === "RUNNING" || freshSnapshot.status === "LEASED") {
          // Re-prove worker lease expiry atomically with the transition (closes the
          // check-then-act gap). A missing expiry cannot prove the lease is dead.
          const freshExpiresMs = freshSnapshot.leaseExpiresAt
            ? new Date(freshSnapshot.leaseExpiresAt).getTime()
            : Number.NaN;
          if (Number.isNaN(freshExpiresMs) || new Date(effectiveNow).getTime() < freshExpiresMs) {
            throw new ActiveWorkerLeaseFencingError(
              runId,
              freshSnapshot.currentWorkerId ?? "unknown",
              freshSnapshot.leaseId ?? "unknown",
              freshSnapshot.leaseExpiresAt ?? "unknown (no lease expiry recorded)"
            );
          }

          // Expire worker lease record if present
          if (freshSnapshot.leaseId) {
            tx.updateLeaseState(freshSnapshot.leaseId, "EXPIRED", effectiveNow);
          }

          const runAggregate = Run.reconstitute(freshSnapshot);
          const expireEvent = runAggregate.expireLease(effectiveNow);
          tx.updateRun(runId, freshSnapshot.version, runAggregate.snapshot, expireEvent);
        }
      });

      // Step 5: Execute or resume durable rollback under supervisor authority
      const authorityContext: MutationAuthorityContext = {
        authority: "SUPERVISOR",
        supervisorFencing: {
          supervisorId: this.supervisorId,
          leaseId: supervisorLease.leaseId,
          nowIso: effectiveNow,
        },
      };

      let rollbackResult: RollbackExecutionResult;
      try {
        rollbackResult = await this.rollbackEngine.executeRollback({
          runId,
          workspaceRoot: resolvedWorkspaceRoot,
          authorityContext,
          initiatedBy: "SUPERVISOR_RECOVERY",
          // Live fencing re-check immediately before every destructive filesystem write.
          // Fails closed when the store cannot validate supervisor authority, or if the tenant launch gate
          // authority has been invalidated, replaced, or expired during in-flight recovery (F-5.3).
          assertAuthorityActive: () => {
            if (typeof this.stateStore.validateSupervisorFencing !== "function") {
              throw new MissingMutationAuthorityError(
                runId,
                "State store cannot validate supervisor fencing; refusing filesystem mutation"
              );
            }
            this.stateStore.validateSupervisorFencing(runId, {
              supervisorId: this.supervisorId,
              leaseId: supervisorLease.leaseId,
            });

            const requiresQuiescence = this.runRequiresTenantQuiescence(candidate);
            if (requiresQuiescence || options?.gateToken) {
              if (typeof this.stateStore.getTenantLaunchGate !== "function") {
                throw new MissingMutationAuthorityError(
                  runId,
                  "State store cannot validate tenant launch gate authority; refusing destructive filesystem mutation"
                );
              }
              const currentGate = this.stateStore.getTenantLaunchGate(runId);
              const nowIso = this.clock.nowIso();
              if (
                !currentGate ||
                !options?.gateToken ||
                currentGate.token !== options.gateToken ||
                currentGate.state !== "QUIESCED" ||
                currentGate.holderType !== "RECOVERY" ||
                currentGate.holderId !== this.supervisorId ||
                !isGateUnexpired(currentGate.expiresAt, nowIso)
              ) {
                throw new MissingMutationAuthorityError(
                  runId,
                  `Tenant launch gate authority invalidated (expected QUIESCED token '${options?.gateToken}' held by '${this.supervisorId}', found '${currentGate?.state}'/'${currentGate?.token}' held by '${currentGate?.holderId}'); refusing destructive filesystem mutation`
                );
              }
            }
          },
        });
      } catch (rollbackErr: unknown) {
        // Rollback failed closed (e.g. preflight conflict or corrupt snapshot)
        const errMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        
        // Transient infrastructure errors (busy file/database) must not terminate the run:
        // leave it RECOVERING and release the lease so a later scan resumes durable rollback.
        if (isTransientInfrastructureError(rollbackErr)) {
          this.stateStore.transaction((tx: StorageTransaction) => {
            this.assertSupervisorFenced(runId, supervisorLease.leaseId, effectiveNow);
            tx.releaseSupervisorLease(supervisorLease.leaseId, effectiveNow, {
              supervisorId: this.supervisorId,
              leaseId: supervisorLease.leaseId,
              nowIso: effectiveNow,
            });
          });
          return {
            runId,
            status: "FAILED",
            statusBefore,
            statusAfter: this.stateStore.getRun(runId)?.status ?? statusBefore,
            supervisorLeaseId: supervisorLease.leaseId,
            details: `Transient recovery error; run left RECOVERING for retry: ${errMsg}`,
            error: errMsg,
          };
        }

        // Persist failure to run state
        this.stateStore.transaction((tx: StorageTransaction) => {
          this.assertSupervisorFenced(runId, supervisorLease.leaseId, effectiveNow);

          // Keep the durable rollback aggregate consistent with the terminal run state.
          const aggregate = tx.getRunRollback(runId);
          if (aggregate && aggregate.status !== "COMPLETED" && aggregate.status !== "PARTIALLY_ROLLED_BACK_CONFLICT") {
            tx.updateRunRollbackStatus(runId, "PARTIALLY_ROLLED_BACK_CONFLICT", null, errMsg);
          }

          const current = tx.getRun(runId);
          if (current && current.status === "RECOVERING") {
            const runAggregate = Run.reconstitute(current);
            const failEvent = runAggregate.fail(
              {
                reason: "Rollback execution aborted; fail-closed",
                rollbackStatus: "FAILED",
                error: errMsg,
              },
              undefined,
              undefined,
              effectiveNow
            );
            tx.updateRun(runId, current.version, runAggregate.snapshot, failEvent);
          }

          tx.releaseSupervisorLease(supervisorLease.leaseId, effectiveNow, {
            supervisorId: this.supervisorId,
            leaseId: supervisorLease.leaseId,
            nowIso: effectiveNow,
          });
        });

        return {
          runId,
          status: "FAILED",
          statusBefore,
          statusAfter: "FAILED",
          rollbackStatus: "FAILED",
          supervisorLeaseId: supervisorLease.leaseId,
          details: `Rollback aborted fail-closed: ${errMsg}`,
          error: errMsg,
        };
      }

      // Step 6: Commit terminal run transition & release supervisor lease atomically
      const finalStatus = rollbackResult.status;
      const isConflict = finalStatus === "PARTIALLY_ROLLED_BACK_CONFLICT";
      const isSuccess = finalStatus === "COMPLETED";
      let handedOffForRetry = false;

      this.stateStore.transaction((tx: StorageTransaction) => {
        // Re-validate supervisor lease fencing before terminal transition
        this.assertSupervisorFenced(runId, supervisorLease.leaseId, effectiveNow);

        const current = tx.getRun(runId);
        if (current && current.status === "RECOVERING" && isSuccess && current.attemptCount < current.maxAttempts) {
          // Clean rollback with attempts remaining: the workspace is reconciled, so leave the run
          // RECOVERING and let RunCoordinator.recoverExpiredRuns apply its retry semantics
          // (contract governance checks, requeue). The retry gate there now admits it.
          handedOffForRetry = true;
        } else if (current && current.status === "RECOVERING") {
          const runAggregate = Run.reconstitute(current);
          const failPayload = isSuccess
            ? {
                reason:
                  rollbackResult.totalPaths === 0
                    ? "Worker lease expired; no mutation intents on record, workspace state not verified"
                    : "Worker lease expired; workspace rollback completed cleanly",
                rollbackStatus: finalStatus,
                totalPaths: rollbackResult.totalPaths,
                restoredPaths: rollbackResult.restoredPaths,
              }
            : {
                reason: isConflict
                  ? "Rollback conflict detected; external modifications preserved"
                  : "Rollback failed",
                rollbackStatus: finalStatus,
                conflictDetails: rollbackResult.conflictDetails,
                conflictedPaths: rollbackResult.conflictedPaths,
                skippedPaths: rollbackResult.skippedPaths,
              };

          const failEvent = runAggregate.fail(failPayload, undefined, undefined, effectiveNow);
          tx.updateRun(runId, current.version, runAggregate.snapshot, failEvent);
        }

        // Release supervisor lease
        tx.releaseSupervisorLease(supervisorLease.leaseId, effectiveNow, {
          supervisorId: this.supervisorId,
          leaseId: supervisorLease.leaseId,
          nowIso: effectiveNow,
        });
      });

      return {
        runId,
        status: isConflict
          ? "ROLLBACK_CONFLICT"
          : isSuccess
            ? rollbackResult.totalPaths === 0
              ? "RECOVERED_UNVERIFIED"
              : "RECOVERED"
            : "FAILED",
        statusBefore,
        statusAfter: handedOffForRetry ? "RECOVERING" : "FAILED",
        rollbackStatus: finalStatus,
        supervisorLeaseId: supervisorLease.leaseId,
        ...(isSuccess && rollbackResult.totalPaths === 0 ? { noMutationIntentsRecorded: true } : {}),
        details: isSuccess
          ? rollbackResult.totalPaths === 0
            ? `Run '${runId}' recovered with no mutation intents on record; workspace state was not verified.`
            : `Recovery completed cleanly for run '${runId}'. Restored ${rollbackResult.restoredPaths.length} paths.${handedOffForRetry ? " Run left RECOVERING for coordinator retry." : ""}`
          : `Recovery finished with conflict/failure for run '${runId}': ${rollbackResult.conflictDetails ?? finalStatus}`,
        ...(isConflict ? { error: rollbackResult.conflictDetails ?? "Conflict detected" } : {}),
      };
    } catch (unexpectedErr: unknown) {
      // Release lease if possible on unexpected crash
      try {
        this.stateStore.releaseSupervisorLease(supervisorLease.leaseId, effectiveNow, {
          supervisorId: this.supervisorId,
          leaseId: supervisorLease.leaseId,
          nowIso: effectiveNow,
        });
      } catch {
        // Ignore secondary lease release failure
      }
      throw unexpectedErr;
    }
  }

  /**
   * Performs an end-to-end scan and recovery of all eligible runs.
   */
  public async scanAndRecover(options?: {
    nowIso?: string;
    excludeRunIds?: ReadonlySet<string>;
    quiescedRunIds?: ReadonlySet<string>;
    quiescedGateTokens?: ReadonlyMap<string, string>;
  }): Promise<ScanAndRecoverResult> {
    const effectiveNow = resolveAuthorityNowIso(this.clock, options?.nowIso, "scanAndRecover");
    // Runs the caller holds back (e.g. tenant processes not proven gone, ADR-0037) are not touched at all: no state, no files.
    const eligibleRuns = this.findEligibleRuns(effectiveNow).filter((r) => !options?.excludeRunIds?.has(r.runId));

    let recoveredCount = 0;
    let unverifiedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const outcomes: RecoveryRunOutcome[] = [];

    for (const run of eligibleRuns) {
      try {
        const outcome = await this.recoverRun(run.runId, {
          nowIso: effectiveNow,
          quiescedRunIds: options?.quiescedRunIds,
          gateToken: options?.quiescedGateTokens?.get(run.runId),
        });
        outcomes.push(outcome);

        if (outcome.status === "RECOVERED") {
          recoveredCount++;
        } else if (outcome.status === "RECOVERED_UNVERIFIED") {
          unverifiedCount++;
        } else if (
          outcome.status === "SKIPPED_INELIGIBLE" ||
          outcome.status === "SKIPPED_TERMINAL" ||
          outcome.status === "SKIPPED_ACTIVE_WORKER_LEASE" ||
          outcome.status === "SKIPPED_LOCKED_BY_ANOTHER_SUPERVISOR" ||
          outcome.status === "SKIPPED_TENANTS_NOT_QUIESCED"
        ) {
          skippedCount++;
        } else {
          failedCount++;
        }
      } catch (err: unknown) {
        if (err instanceof ActiveWorkerLeaseFencingError) {
          skippedCount++;
          outcomes.push({
            runId: run.runId,
            status: "SKIPPED_ACTIVE_WORKER_LEASE",
            statusBefore: run.status,
            statusAfter: run.status,
            details: err.message,
          });
        } else {
          failedCount++;
          outcomes.push({
            runId: run.runId,
            status: "FAILED",
            statusBefore: run.status,
            statusAfter: run.status,
            details: err instanceof Error ? err.message : String(err),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      scannedCount: eligibleRuns.length,
      recoveredCount,
      unverifiedCount,
      skippedCount,
      failedCount,
      outcomes,
    };
  }

  /**
   * Renews an active supervisor lease.
   */
  public renewSupervisorLease(
    leaseId: string,
    runId: string,
    nowIso?: string
  ): SupervisorLease {
    const effectiveNow = nowIso ?? this.clock.nowIso();
    return this.stateStore.renewSupervisorLease({
      leaseId,
      runId,
      supervisorId: this.supervisorId,
      ttlMs: this.leaseTtlMs,
      nowIso: effectiveNow,
    });
  }

  /**
   * Releases an active supervisor lease.
   */
  public releaseSupervisorLease(leaseId: string, nowIso?: string): void {
    const effectiveNow = nowIso ?? this.clock.nowIso();
    this.stateStore.releaseSupervisorLease(leaseId, effectiveNow);
  }
}

/** A gate is current authority only before its expiry; an unparseable expiry is never fresh (fail closed). */
function isGateUnexpired(expiresAt: string, nowIso: string): boolean {
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowIso);
  return Number.isFinite(expiresMs) && Number.isFinite(nowMs) && nowMs < expiresMs;
}

function sameWorkspacePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalizeWorkspaceRoot(runId: string, root: string): string {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new WorkspaceResolutionError(runId, "workspace root must be a non-empty string");
  }
  if (!path.isAbsolute(root)) {
    throw new WorkspaceResolutionError(runId, `workspace root must be absolute: ${root}`);
  }
  let real: string;
  try {
    real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (err: unknown) {
    throw new WorkspaceResolutionError(
      runId,
      `workspace root is not an accessible directory: ${root} (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (isForbiddenWorkspaceRoot(real)) {
    throw new WorkspaceResolutionError(runId, `workspace root is too broad or a system location: ${real}`);
  }
  return real;
}

function isInsideOrEqual(candidate: string, dir: string): boolean {
  const c = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const d = process.platform === "win32" ? dir.toLowerCase() : dir;
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** Filesystem root, the home directory and any of its ancestors, the temp root itself, and system locations. */
function isForbiddenWorkspaceRoot(real: string): boolean {
  if (path.parse(real).root === real) return true;
  const safeReal = (p: string | undefined): string | undefined => {
    if (!p) return undefined;
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const home = safeReal(os.homedir());
  if (home && isInsideOrEqual(home, real)) return true; // home itself or any ancestor of it
  const tmp = safeReal(os.tmpdir());
  if (tmp && sameWorkspacePath(tmp, real)) return true;

  const systemDirs =
    process.platform === "win32"
      ? [process.env.SystemRoot, process.env.WINDIR, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData]
      : ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var", "/sys", "/proc", "/dev", "/boot", "/opt", "/root"];
  return systemDirs.map(safeReal).some((d) => d !== undefined && isInsideOrEqual(real, d));
}

/** Busy file/database conditions that are expected to clear on their own. */
function isTransientInfrastructureError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code && ["EBUSY", "EAGAIN", "EMFILE", "ENFILE", "ETIMEDOUT"].includes(code)) return true;
  const message = err instanceof Error ? err.message : "";
  return /database is locked|SQLITE_BUSY/i.test(message);
}
