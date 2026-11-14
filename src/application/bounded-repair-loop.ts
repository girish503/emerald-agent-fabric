/**
 * Bounded Autonomous Repair Loop Controller for Emerald Agent Fabric.
 *
 * Implements the governed 8-stage repair cycle:
 * OBSERVE → PLAN → ACT → CAPTURE_FEEDBACK → DIAGNOSE → REPAIR → RETEST → INDEPENDENTLY_VERIFY
 *
 * Invariants:
 * 1. Bounded Iterations: Enforces strict iteration ceilings (`maxRepairIterations`),
 *    cumulative time budgets (`maxCumulativeTimeMs`), and action budgets (`maxCumulativeActions`).
 * 2. Stagnation-Aware: Halts immediately if repeated ineffective repairs or identical patches
 *    are detected.
 * 3. Zero Self-Approval: Repair success is authorized exclusively by independent verification
 *    evidence (DeterministicVerifier exit code 0 matching contract specs).
 * 4. Structured Failure Diagnosis: Categorizes errors into explicit diagnostic taxonomy
 *    (SYNTAX_ERROR, TEST_FAILURE, RUNTIME_EXCEPTION, TIMEOUT, POLICY_DENIAL).
 */

import { sha256Hex } from "../domain/canonical-hash.js";

export type RepairStage =
  | "OBSERVE"
  | "PLAN"
  | "ACT"
  | "CAPTURE_FEEDBACK"
  | "DIAGNOSE"
  | "REPAIR"
  | "RETEST"
  | "INDEPENDENTLY_VERIFY"
  | "TERMINAL_SUCCESS"
  | "TERMINAL_FAILED"
  | "TERMINAL_EXHAUSTED";

export type DiagnosticCategory =
  | "SYNTAX_ERROR"
  | "TEST_ASSERTION_FAILURE"
  | "RUNTIME_EXCEPTION"
  | "TIMEOUT_EXHAUSTION"
  | "POLICY_DENIAL"
  | "UNKNOWN_ERROR";

export interface RepairLimits {
  readonly maxRepairIterations: number;
  readonly maxCumulativeTimeMs: number;
  readonly maxCumulativeActions: number;
}

export interface RepairCycleState {
  readonly taskId: string;
  readonly runId: string;
  currentStage: RepairStage;
  iterationCount: number;
  cumulativeActions: number;
  cumulativeTimeMs: number;
  lastDiagnosis?: {
    category: DiagnosticCategory;
    summary: string;
    targetFile?: string;
  };
  previousPatchHashes: Set<string>;
  terminalReason?: string;
}

export interface BoundedRepairLoop {
  initCycle(taskId: string, runId: string): RepairCycleState;
  diagnoseFeedback(
    state: RepairCycleState,
    testStderr: string,
    testStdout: string,
    exitCode: number
  ): DiagnosticCategory;
  shouldContinueRepair(state: RepairCycleState): { canContinue: boolean; reason?: string };
  recordPatchHash(state: RepairCycleState, patchDiffText: string): { isStagnant: boolean; patchHash: string };
}

export class BoundedRepairLoopController implements BoundedRepairLoop {
  private readonly limits: RepairLimits;

  constructor(limits: Partial<RepairLimits> = {}) {
    this.limits = {
      maxRepairIterations: limits.maxRepairIterations ?? 3,
      maxCumulativeTimeMs: limits.maxCumulativeTimeMs ?? 180_000,
      maxCumulativeActions: limits.maxCumulativeActions ?? 15,
    };
  }

  /**
   * Initializes a fresh repair cycle.
   */
  public initCycle(taskId: string, runId: string): RepairCycleState {
    return {
      taskId,
      runId,
      currentStage: "OBSERVE",
      iterationCount: 0,
      cumulativeActions: 0,
      cumulativeTimeMs: 0,
      previousPatchHashes: new Set<string>(),
    };
  }

  /**
   * Evaluates diagnostic feedback from a failed test or execution.
   */
  public diagnoseFeedback(
    state: RepairCycleState,
    testStderr: string,
    testStdout: string,
    exitCode: number
  ): DiagnosticCategory {
    state.currentStage = "DIAGNOSE";

    let category: DiagnosticCategory = "UNKNOWN_ERROR";
    const combinedOutput = `${testStderr}\n${testStdout}`;

    if (/SyntaxError|ParseError|unexpected token/i.test(combinedOutput)) {
      category = "SYNTAX_ERROR";
    } else if (/AssertionError|assert|expect|FAIL/i.test(combinedOutput) || exitCode !== 0) {
      category = "TEST_ASSERTION_FAILURE";
    } else if (/timed out|ETIMEDOUT|deadline exceeded/i.test(combinedOutput)) {
      category = "TIMEOUT_EXHAUSTION";
    } else if (/permission denied|EACCES|unauthorized|forbidden/i.test(combinedOutput)) {
      category = "POLICY_DENIAL";
    } else if (/Error|TypeError|ReferenceError/i.test(combinedOutput)) {
      category = "RUNTIME_EXCEPTION";
    }

    state.lastDiagnosis = {
      category,
      summary: combinedOutput.slice(0, 500),
    };

    return category;
  }

  /**
   * Checks whether the repair cycle can continue within bounded ceilings.
   */
  public shouldContinueRepair(state: RepairCycleState): { canContinue: boolean; reason?: string } {
    if (state.cumulativeActions >= this.limits.maxCumulativeActions) {
      state.currentStage = "TERMINAL_EXHAUSTED";
      state.terminalReason = `Action ceiling exceeded (${state.cumulativeActions} >= ${this.limits.maxCumulativeActions})`;
      return { canContinue: false, reason: state.terminalReason };
    }
    if (state.cumulativeTimeMs >= this.limits.maxCumulativeTimeMs) {
      state.currentStage = "TERMINAL_EXHAUSTED";
      state.terminalReason = `Cumulative time ceiling exceeded (${state.cumulativeTimeMs}ms >= ${this.limits.maxCumulativeTimeMs}ms)`;
      return { canContinue: false, reason: state.terminalReason };
    }
    if (state.iterationCount >= this.limits.maxRepairIterations) {
      state.currentStage = "TERMINAL_EXHAUSTED";
      state.terminalReason = `Repair iteration ceiling exceeded (${state.iterationCount} >= ${this.limits.maxRepairIterations})`;
      return { canContinue: false, reason: state.terminalReason };
    }
    return { canContinue: true };
  }

  /**
   * Records a patch hash and checks for identical patch stagnation (anti-thrashing).
   */
  public recordPatchHash(
    state: RepairCycleState,
    patchDiffText: string
  ): { isStagnant: boolean; patchHash: string } {
    const patchHash = sha256Hex(patchDiffText);
    if (state.previousPatchHashes.has(patchHash)) {
      state.currentStage = "TERMINAL_FAILED";
      state.terminalReason = "Stagnation detected: agent proposed an identical repair patch previously attempted";
      return { isStagnant: true, patchHash };
    }
    state.previousPatchHashes.add(patchHash);
    return { isStagnant: false, patchHash };
  }

  /**
   * Evaluates proposed repair patch and enforces bounded budgets and stagnation gates.
   */
  public evaluateProposedRepair(
    state: RepairCycleState,
    patchContent: string,
    actionDurationMs: number
  ): { canProceed: boolean; haltReason?: string } {
    state.cumulativeActions += 1;
    state.cumulativeTimeMs += actionDurationMs;

    // Check action ceiling
    if (state.cumulativeActions > this.limits.maxCumulativeActions) {
      state.currentStage = "TERMINAL_EXHAUSTED";
      state.terminalReason = `Action ceiling exceeded (${state.cumulativeActions} > ${this.limits.maxCumulativeActions})`;
      return { canProceed: false, haltReason: state.terminalReason };
    }

    // Check time ceiling
    if (state.cumulativeTimeMs > this.limits.maxCumulativeTimeMs) {
      state.currentStage = "TERMINAL_EXHAUSTED";
      state.terminalReason = `Cumulative time ceiling exceeded (${state.cumulativeTimeMs}ms > ${this.limits.maxCumulativeTimeMs}ms)`;
      return { canProceed: false, haltReason: state.terminalReason };
    }

    // Check iteration ceiling
    if (state.iterationCount >= this.limits.maxRepairIterations) {
      state.currentStage = "TERMINAL_EXHAUSTED";
      state.terminalReason = `Repair iteration ceiling exceeded (${state.iterationCount} >= ${this.limits.maxRepairIterations})`;
      return { canProceed: false, haltReason: state.terminalReason };
    }

    // Stagnation Detection: Check for identical repetitive patches
    const stagnation = this.recordPatchHash(state, patchContent);
    if (stagnation.isStagnant) {
      return { canProceed: false, haltReason: state.terminalReason };
    }

    state.iterationCount += 1;
    state.currentStage = "REPAIR";

    return { canProceed: true };
  }

  /**
   * Concludes verification and updates terminal state.
   */
  public concludeVerification(
    state: RepairCycleState,
    verificationExitCode: number
  ): RepairStage {
    state.currentStage = "INDEPENDENTLY_VERIFY";

    if (verificationExitCode === 0) {
      state.currentStage = "TERMINAL_SUCCESS";
      state.terminalReason = "Independent verification passed with exit code 0";
    } else {
      if (state.iterationCount >= this.limits.maxRepairIterations) {
        state.currentStage = "TERMINAL_EXHAUSTED";
        state.terminalReason = "Verification failed and repair iteration budget exhausted";
      } else {
        state.currentStage = "OBSERVE"; // Return to loop for next repair attempt
      }
    }

    return state.currentStage;
  }
}
