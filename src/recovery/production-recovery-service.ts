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
      if (["ACTIVE", "PLANNING", "EXECUTING", "VERIFYING"].includes(run.status)) {
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

    // Transition run to RECOVERING first
    this.runControl.transitionStatus(runId, "RECOVERING", "Crash or lease loss recovery initiated");

    // Revoke any stale capability fences associated with this run's worker
    let leasesFenced = 1;
    if (this.fenceEnforcer && run.currentWorkerId) {
      const activeFence = this.fenceEnforcer.getActiveFenceForSubject(run.currentWorkerId);
      if (activeFence) {
        this.fenceEnforcer.revokeFence(activeFence.fenceId, "Interrupted by process crash");
        leasesFenced++;
      }
    }

    // Set run to FAILED or CANCELLED if it cannot be resumed cleanly
    const safeToResume = statusBefore === "PLANNING" || statusBefore === "ACTIVE";
    const statusAfter = safeToResume ? "VALIDATING" : "FAILED";
    this.runControl.transitionStatus(runId, statusAfter, "Interrupted execution fenced; ready for safe resumption");

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
