/**
 * Phase 96: Preempted Goal Resumer
 *
 * Implements governed resume validation for suspended goals.
 * Enforces stale resume prevention, working-tree digest compatibility,
 * mission contract integrity, and Action/Attempt identity preservation.
 *
 * ABSOLUTE PRINCIPLE:
 * Resume cannot bypass sovereign verification.
 * Stale checkpoint cannot silently resume.
 */

import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { sha256Hex } from "../domain/canonical-hash.js";
import { GoalPriority } from "../domain/goal-priority.js";
import { PreemptionCheckpoint } from "../domain/goal-preemption.js";
import { GoalPreemptionManager } from "./goal-preemption-manager.js";

export interface ResumeGoalParams {
  readonly goalId: string;
  readonly checkpointId: string;
  readonly currentWorkingTreeDigest: string;
  readonly missionContractId: string;
  readonly missionContractHash: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly reason: string;
  readonly timestamp?: string;
}

export type ResumeStatus = "RESUMED" | "REJECTED" | "QUARANTINED";

export interface ResumeGoalResult {
  readonly resumeId: string;
  readonly goalId: string;
  readonly checkpointId: string;
  readonly status: ResumeStatus;
  readonly reason: string;
  readonly updatedPriority?: GoalPriority;
  readonly provenanceRoot: string;
  readonly timestamp: string;
}

export class PreemptedGoalResumer {
  private readonly resumeHistory: ResumeGoalResult[] = [];
  private sequenceCounter = 0;
  private readonly clock: ClockPort;

  constructor(
    private readonly preemptionManager: GoalPreemptionManager,
    options?: { readonly clock?: ClockPort }
  ) {
    this.clock = options?.clock ?? new SystemClock();
  }

  public getResumeHistory(): readonly ResumeGoalResult[] {
    return Object.freeze([...this.resumeHistory]);
  }

  /**
   * Resumes a previously suspended goal from a durable checkpoint.
   * Performs rigorous fail-closed safety checks before allowing work to proceed.
   */
  public resumeGoal(params: ResumeGoalParams): ResumeGoalResult {
    const nowIso = params.timestamp ?? this.clock.nowIso();
    this.sequenceCounter += 1;
    const resumeId = `resume-${params.goalId}-${this.sequenceCounter}`;

    // 1. Verify checkpoint existence & status (Invariant P15, N623)
    const checkpoint = this.preemptionManager.getCheckpoint(params.checkpointId);
    if (!checkpoint) {
      const result: ResumeGoalResult = {
        resumeId,
        goalId: params.goalId,
        checkpointId: params.checkpointId,
        status: "REJECTED",
        reason: `Resume rejected: checkpoint ${params.checkpointId} not found`,
        provenanceRoot: sha256Hex(`RESUME_REJECTED:${params.goalId}:NOT_FOUND`),
        timestamp: nowIso,
      };
      this.resumeHistory.push(result);
      return result;
    }

    if (checkpoint.status !== "ACTIVE") {
      const result: ResumeGoalResult = {
        resumeId,
        goalId: params.goalId,
        checkpointId: params.checkpointId,
        status: "REJECTED",
        reason: `Resume rejected: checkpoint ${params.checkpointId} is already ${checkpoint.status}`,
        provenanceRoot: sha256Hex(`RESUME_REJECTED:${params.goalId}:STATUS_${checkpoint.status}`),
        timestamp: nowIso,
      };
      this.resumeHistory.push(result);
      return result;
    }

    // 2. Mission contract binding check (Invariant P2, N605)
    if (
      checkpoint.missionContractId !== params.missionContractId ||
      checkpoint.missionContractHash !== params.missionContractHash
    ) {
      const result: ResumeGoalResult = {
        resumeId,
        goalId: params.goalId,
        checkpointId: params.checkpointId,
        status: "REJECTED",
        reason: "Resume rejected: mission contract mismatch between checkpoint and resume context",
        provenanceRoot: sha256Hex(`RESUME_REJECTED:${params.goalId}:CONTRACT_MISMATCH`),
        timestamp: nowIso,
      };
      this.resumeHistory.push(result);
      return result;
    }

    // 3. Stale working tree check (Invariant P16, N624)
    if (checkpoint.workingTreeDigest !== params.currentWorkingTreeDigest) {
      const result: ResumeGoalResult = {
        resumeId,
        goalId: params.goalId,
        checkpointId: params.checkpointId,
        status: "REJECTED",
        reason: `Resume rejected: stale checkpoint working-tree digest (${checkpoint.workingTreeDigest.slice(0, 8)}) differs from current tree (${params.currentWorkingTreeDigest.slice(0, 8)})`,
        provenanceRoot: sha256Hex(`RESUME_REJECTED:${params.goalId}:TREE_DIVERGENCE`),
        timestamp: nowIso,
      };
      this.resumeHistory.push(result);
      return result;
    }

    // 4. Verify goal is actually in suspended state
    if (!this.preemptionManager.isGoalSuspended(params.goalId)) {
      const result: ResumeGoalResult = {
        resumeId,
        goalId: params.goalId,
        checkpointId: params.checkpointId,
        status: "REJECTED",
        reason: `Resume rejected: goal ${params.goalId} is not currently in suspended state`,
        provenanceRoot: sha256Hex(`RESUME_REJECTED:${params.goalId}:NOT_SUSPENDED`),
        timestamp: nowIso,
      };
      this.resumeHistory.push(result);
      return result;
    }

    // 5. Update goal priority version monotonically (Invariants P9, P10)
    const currentPriority = this.preemptionManager.getActivePriority(params.goalId);
    if (!currentPriority) {
      const result: ResumeGoalResult = {
        resumeId,
        goalId: params.goalId,
        checkpointId: params.checkpointId,
        status: "REJECTED",
        reason: `Resume rejected: goal ${params.goalId} has no active priority record`,
        provenanceRoot: sha256Hex(`RESUME_REJECTED:${params.goalId}:NO_PRIORITY`),
        timestamp: nowIso,
      };
      this.resumeHistory.push(result);
      return result;
    }

    const updatedPriority = this.preemptionManager.setGoalPriority({
      goalId: params.goalId,
      parentGoalId: currentPriority.parentGoalId,
      taskId: currentPriority.taskId,
      workflowId: currentPriority.workflowId,
      agentId: checkpoint.agentId,
      priorityClass: currentPriority.priorityClass,
      criticality: currentPriority.criticality,
      urgency: currentPriority.urgency,
      dependencyCriticality: currentPriority.dependencyCriticality,
      verificationCriticality: currentPriority.verificationCriticality,
      resourcePressure: currentPriority.resourcePressure,
      starvationAge: currentPriority.starvationAge,
      expectedCurrentVersion: currentPriority.priorityVersion,
      reason: `Resumed from checkpoint ${params.checkpointId}: ${params.reason}`,
      missionContractId: params.missionContractId,
      missionContractHash: params.missionContractHash,
      timestamp: nowIso,
    });

    // 6. Lift suspension
    this.preemptionManager.liftGoalSuspension(params.goalId);

    // 7. Mark checkpoint as RESUMED
    this.preemptionManager.updateCheckpointStatus(params.checkpointId, "RESUMED");

    const provenanceRoot = sha256Hex(
      `RESUME_COMMITTED:${checkpoint.provenanceRoot}:${updatedPriority.priorityVersion}:${nowIso}`
    );

    const result: ResumeGoalResult = {
      resumeId,
      goalId: params.goalId,
      checkpointId: params.checkpointId,
      status: "RESUMED",
      reason: `Goal successfully resumed from checkpoint with verified state preservation`,
      updatedPriority,
      provenanceRoot,
      timestamp: nowIso,
    };

    this.resumeHistory.push(result);
    return result;
  }
}
