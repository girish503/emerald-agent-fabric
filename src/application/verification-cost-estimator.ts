/**
 * Phase 82 — Deterministic Verification Cost Estimator
 *
 * Computes predictive cost estimates based strictly on observable structural factors:
 * - Expected verification duration (ms)
 * - Expected sandbox execution duration (ms)
 * - Expected human intervention duration (ms)
 *
 * CRITICAL ARCHITECTURAL DISTINCTION:
 * This estimator provides predictive scheduling metadata ONLY.
 * It is NOT authoritative verification and MUST NEVER be used to assert test passage.
 */

import { ComplexityProfile } from "../domain/adaptive-repair-queue.js";

export interface CostEstimateResult {
  readonly estimatedVerificationCostMs: number;
  readonly estimatedExecutionCostMs: number;
  readonly estimatedHumanCostMs: number;
  readonly totalEstimatedCostMs: number;
  readonly expectedModelCalls: number;
  readonly costModelDigest: string;
}

export class VerificationCostEstimator {
  /**
   * Deterministically estimates verification and execution costs from a ComplexityProfile.
   */
  public static estimateCost(
    profile: ComplexityProfile,
    retryCount = 0
  ): CostEstimateResult {
    // 1. Verification cost: scales with test count and expected verification commands
    const baseVerificationMs = profile.testCount * 35; // 35ms per test suite run
    const commandsMs = profile.expectedVerificationCommands * 50;
    const cleanRoomMaterializationMs = profile.expectedCleanRoomCost * 0.4;
    const retryMultiplier = 1.0 + (retryCount * 0.25);

    const estimatedVerificationCostMs = Math.round(
      (baseVerificationMs + commandsMs + cleanRoomMaterializationMs) * retryMultiplier
    );

    // 2. Execution cost: scales with files touched and mutation count
    const baseExecutionMs = (profile.filesTouched * 60) + (profile.mutationCount * 25);
    const estimatedExecutionCostMs = Math.round(baseExecutionMs * retryMultiplier);

    // 3. Human cost: only for HIGH_RISK / PANEL_REVIEW (L7)
    let estimatedHumanCostMs = 0;
    let expectedModelCalls = 1;

    if (profile.reviewTier === "PANEL_REVIEW" || profile.reviewTier === "HUMAN_COORDINATED") {
      estimatedHumanCostMs = 420000; // ~420s human coordination time
      expectedModelCalls = 6;
    } else if (profile.reviewTier === "SINGLE_REVIEWER") {
      estimatedHumanCostMs = 0;
      expectedModelCalls = 2;
    } else {
      estimatedHumanCostMs = 0;
      expectedModelCalls = 1;
    }

    const totalEstimatedCostMs =
      estimatedVerificationCostMs + estimatedExecutionCostMs + (estimatedHumanCostMs > 0 ? 5000 : 0);

    const costModelDigest = `cost-v1-${profile.profileDigest.substring(0, 16)}`;

    return {
      estimatedVerificationCostMs,
      estimatedExecutionCostMs,
      estimatedHumanCostMs,
      totalEstimatedCostMs,
      expectedModelCalls,
      costModelDigest,
    };
  }
}
