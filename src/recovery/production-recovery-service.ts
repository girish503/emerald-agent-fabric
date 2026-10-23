/**
 * Emerald Agent Fabric — Production Recovery Service
 *
 * Implements crash-safe recovery for runs, worker leases, interrupted actions/attempts,
 * and checkpoint state.
 *
 * Invariant:
 * Never assume process restarted = operation succeeded.
 * Stale or interrupted executions must be fenced and audited.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { RunControl } from "../control-plane/run-control.js";
import { CapabilityFenceEnforcer } from "../application/capability-fence-enforcer.js";

export interface RecoveryOutcome {
  readonly runId: string;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly leasesFenced: number;
  readonly actionsRecovered: number;
  readonly safeToResume: boolean;
  readonly details: string;
}

const TERMINAL_RUN_STATUSES: readonly string[] = [
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "QUARANTINED",
];

export class ProductionRecoveryService {
  constructor(
    private readonly runControl: RunControl,
    private readonly fenceEnforcer?: CapabilityFenceEnforcer,
    private readonly clock: ClockPort = new SystemClock(),
  ) {}

  public getClock(): ClockPort {
    return this.clock;
  }

  /**
   * Scan and recover all active runs that may have been interrupted by a process restart.
   */
  public recoverInterruptedRuns(): readonly RecoveryOutcome[] {
    const outcomes: RecoveryOutcome[] = [];
    const allRuns = this.runControl.listRuns();

    for (const run of allRuns) {
      if (["ACTIVE", "PLANNING", "EXECUTING", "VERIFYING", "RECOVERING"].includes(run.status)) {
        const outcome = this.recoverRun(run.runId);
        outcomes.push(outcome);
      }
    }

    return outcomes;
  }

  /**
   * Safely recover a single run following a crash or lease expiration.
   */
  public recoverRun(runId: string): RecoveryOutcome {
    const run = this.runControl.getRun(runId);
    if (!run) throw new Error(`Run not found for recovery: ${runId}`);

    const statusBefore = run.status;

    // Terminal state immutability guard: terminal runs must never be reopened or mutated
    if (TERMINAL_RUN_STATUSES.includes(statusBefore)) {
      return {
        runId,
        statusBefore,
        statusAfter: statusBefore,
        leasesFenced: 0,
        actionsRecovered: run.actionsCount,
        safeToResume: false,
        details: `Run is in terminal state ${statusBefore}; recovery is an idempotent no-op.`,
      };
    }

    // Transition run to RECOVERING first (skip if already RECOVERING)
    if (statusBefore !== "RECOVERING") {
      this.runControl.transitionStatus(runId, "RECOVERING", "Crash or lease loss recovery initiated");
    }

    // Revoke any stale capability fences associated with this run's worker
    let leasesFenced = run.leaseId ? 1 : 0;
    if (this.fenceEnforcer) {
      const candidates = new Set<string>();
      if (run.currentWorkerId) {
        candidates.add(run.currentWorkerId);
      }
      candidates.add("repair-orchestrator");

      for (const subjectId of candidates) {
        const activeFence = this.fenceEnforcer.getActiveFenceForSubject(subjectId);
        if (activeFence) {
          this.fenceEnforcer.revokeFence(activeFence.fenceId, "Interrupted by process crash");
          leasesFenced++;
        }
      }
    }

    // In local-first zero-cost execution, there is no automatic checkpoint resume engine for interrupted runs.
    // Interrupted execution is fenced and transitioned to terminal FAILED.
    const safeToResume = false;
    const statusAfter = "FAILED";
    this.runControl.transitionStatus(runId, statusAfter, "Interrupted execution fenced; run marked FAILED (no safe in-flight resume path)");

    return {
      runId,
      statusBefore,
      statusAfter,
      leasesFenced,
      actionsRecovered: run.actionsCount,
      safeToResume,
      details: `Run recovered from ${statusBefore} to ${statusAfter}. Fenced ${leasesFenced} stale leases.`,
    };
  }
}
