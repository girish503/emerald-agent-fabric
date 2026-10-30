/**
 * Emerald Agent Fabric — Recovery Sweeper
 *
 * The single supported entry point for crash recovery. One sweep runs, in this order:
 *
 *   1. RecoverySupervisor.scanAndRecover — rolls back workspace mutations of crashed runs under
 *      supervisor authority and hands clean runs over (left RECOVERING) or fails them closed.
 *   2. RunCoordinator.recoverExpiredRuns — applies retry semantics (contract checks, workspace
 *      cleanup, requeue). Its retry gate holds any run whose mutations are not yet reconciled.
 *
 * Running the coordinator sweep without step 1 leaves every run that holds workspace mutations
 * held forever; running step 1 alone leaves handed-off runs RECOVERING. Hosts must therefore call
 * sweepOnce()/start() and not the two halves separately.
 */

import type { RecoverExpiredResult } from "../application/run-coordinator.js";
import type { RecoverySupervisor, ScanAndRecoverResult } from "./recovery-supervisor.js";

/** The retry half of recovery (satisfied by RunCoordinator). */
export interface RetryCoordinator {
  recoverExpiredRuns(): RecoverExpiredResult;
}

export interface RecoverySweepResult {
  readonly startedAtIso: string;
  readonly scan: ScanAndRecoverResult;
  readonly retry: RecoverExpiredResult;
  /** Runs still waiting on a workspace rollback after this sweep (need operator attention if they persist). */
  readonly heldForRollbackRunIds: readonly string[];
  /** Supervisor outcomes that failed closed and need attention (unresolved workspace, conflicts, errors). */
  readonly needsAttention: ReadonlyArray<{ readonly runId: string; readonly status: string; readonly details: string }>;
}

export interface RecoverySweeperConfig {
  readonly supervisor: RecoverySupervisor;
  readonly coordinator: RetryCoordinator;
  /** Called after every completed sweep started by start(). */
  readonly onSweep?: (result: RecoverySweepResult) => void;
  /** Called when a sweep throws (the loop keeps running). */
  readonly onError?: (error: unknown) => void;
}

export class RecoverySweeper {
  private readonly supervisor: RecoverySupervisor;
  private readonly coordinator: RetryCoordinator;
  private readonly onSweep?: (result: RecoverySweepResult) => void;
  private readonly onError?: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;
  private inFlight: Promise<unknown> | null = null;

  constructor(config: RecoverySweeperConfig) {
    this.supervisor = config.supervisor;
    this.coordinator = config.coordinator;
    this.onSweep = config.onSweep;
    this.onError = config.onError;
  }

  /** Runs one full sweep. Overlapping calls are rejected: sweeps never run concurrently. */
  public async sweepOnce(): Promise<RecoverySweepResult> {
    if (this.running) {
      throw new Error("RecoverySweeper: a sweep is already in progress");
    }
    this.running = true;
    try {
      const startedAtIso = this.supervisor.getClock().nowIso();
      // Supervisor first: it reconciles workspaces so the coordinator's retry gate can admit the runs.
      const scan = await this.supervisor.scanAndRecover();
      const retry = this.coordinator.recoverExpiredRuns();
      // A supervisor outcome that failed closed is only an attention item if the coordinator did not
      // go on to retry the run (e.g. a crashed run that never had a workspace or any mutation).
      const retried = new Set(retry.runs.map((r) => r.runId));
      const cleanupFailures = (retry.workspaceCleanupFailedRunIds ?? []).map((runId) => ({
        runId,
        status: "WORKSPACE_CLEANUP_FAILED",
        details: "Crashed workspace could not be discarded; the retry may fail provisioning until it is removed",
      }));
      return {
        startedAtIso,
        scan,
        retry,
        heldForRollbackRunIds: retry.heldForRollbackRunIds ?? [],
        needsAttention: [
          ...scan.outcomes
            .filter((o) => (o.status === "FAILED" || o.status === "ROLLBACK_CONFLICT") && !retried.has(o.runId))
            .map((o) => ({ runId: o.runId, status: o.status as string, details: o.details })),
          ...cleanupFailures,
        ],
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Starts a non-overlapping periodic sweep (the next sweep is scheduled only after the previous
   * one finished). The timer is unref'd so it never keeps the process alive on its own.
   */
  public start(intervalMs: number): void {
    // setTimeout clamps delays above 2^31-1 ms to 1 ms, which would turn the loop into a spin
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
      throw new Error("RecoverySweeper.start requires an integer intervalMs between 1 and 2147483647");
    }
    if (!this.stopped) return;
    this.stopped = false;

    const tick = (): void => {
      if (this.stopped) return;
      this.inFlight = this.sweepOnce()
        .then((result) => this.onSweep?.(result))
        .catch((err: unknown) => this.onError?.(err))
        .finally(() => {
          this.inFlight = null;
          if (!this.stopped) {
            this.timer = setTimeout(tick, intervalMs);
            this.timer.unref?.();
          }
        });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }

  /** Stops scheduling and waits for an in-flight sweep to finish. */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }
}
