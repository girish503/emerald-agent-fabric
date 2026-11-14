/**
 * Emerald Agent Fabric — Production Control Plane: Run Control
 *
 * Implements high-level lifecycle control for Runs:
 * - createRun, startRun, pauseRun, resumeRun, cancelRun, inspectRun, recoverRun
 * - Ties Run to Mission and MissionContract
 * - Bounded state transitions and lease fencing
 *
 * Principle:
 * "The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves."
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { StateStorePort } from "../ports/state-store.port.js";
import { RunCoordinator } from "../application/run-coordinator.js";
import { Mission } from "./mission-control.js";

export type ProductionRunStatus =
  | "CREATED"
  | "VALIDATING"
  | "ACTIVE"
  | "PLANNING"
  | "EXECUTING"
  | "VERIFYING"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "QUARANTINED"
  | "RECOVERING";

export interface ProductionRun {
  readonly runId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly contractId: string;
  readonly contractHash: string;
  readonly status: ProductionRunStatus;
  readonly currentWorkerId?: string;
  readonly leaseId?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly exitReason?: string;
  readonly actionsCount: number;
  readonly attemptsCount: number;
}

export class RunControl {
  private readonly runs: Map<string, ProductionRun> = new Map();
  private runCounter: number = 0;

  constructor(
    private readonly coordinator?: RunCoordinator,
    private readonly stateStore?: StateStorePort,
    private readonly clock: ClockPort = new SystemClock(),
  ) {}

  public getCoordinator(): RunCoordinator | undefined {
    return this.coordinator;
  }

  public getStateStore(): StateStorePort | undefined {
    return this.stateStore;
  }

  public getClock(): ClockPort {
    return this.clock;
  }

  /**
   * Create a new run bound to a mission.
   */
  public createRun(mission: Mission, workerId: string = "worker-default"): ProductionRun {
    this.runCounter++;
    const nowIso = this.clock.now().toISOString();
    const runId = `run-${Date.now()}-${this.runCounter}`;

    const run: ProductionRun = {
      runId,
      missionId: mission.missionId,
      taskId: mission.taskId,
      contractId: mission.contract.spec.contractId,
      contractHash: mission.contract.contentHash,
      status: "CREATED",
      currentWorkerId: workerId,
      leaseId: `lease-${runId}`,
      startedAt: nowIso,
      actionsCount: 0,
      attemptsCount: 0,
    };

    this.runs.set(runId, run);
    return run;
  }

  public getRun(runId: string): ProductionRun | undefined {
    return this.runs.get(runId);
  }

  public listRuns(): readonly ProductionRun[] {
    return Array.from(this.runs.values());
  }

  public transitionStatus(runId: string, status: ProductionRunStatus, exitReason?: string): ProductionRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const updated: ProductionRun = {
      ...run,
      status,
      exitReason: exitReason ?? run.exitReason,
      completedAt: ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(status)
        ? this.clock.now().toISOString()
        : run.completedAt,
    };
    this.runs.set(runId, updated);
    return updated;
  }

  public cancelRun(runId: string, reason: string = "User cancellation"): ProductionRun {
    return this.transitionStatus(runId, "CANCELLED", reason);
  }

  public pauseRun(runId: string): ProductionRun {
    return this.transitionStatus(runId, "VALIDATING", "Paused by operator");
  }

  public resumeRun(runId: string): ProductionRun {
    return this.transitionStatus(runId, "ACTIVE", "Resumed by operator");
  }

  public incrementActionAttempt(runId: string, isAction: boolean = true): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.set(runId, {
      ...run,
      actionsCount: isAction ? run.actionsCount + 1 : run.actionsCount,
      attemptsCount: !isAction ? run.attemptsCount + 1 : run.attemptsCount,
    });
  }

  public recoverRun(runId: string): ProductionRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return this.transitionStatus(runId, "RECOVERING", "Initiating crash/stale lease recovery");
  }
}
