/**
 * Controlled Baseline vs Reflex Evaluation Tasks for Emerald Agent Fabric.
 *
 * Establishes four deterministic, reproducible evaluation tasks designed to
 * empirically measure differences between unassisted BASELINE and REFLEX execution:
 *
 * 1. TASK_A_NORMAL_WORK: Normal productive sequence (read -> write -> complete).
 *    Baseline: PASSES. Reflex: PASSES without intervention (no false positives).
 *
 * 2. TASK_B_REPEATED_FAILURE: Agent loops on failing action (e.g. reading missing file).
 *    Baseline: Runs until budget ceiling; fails repeatedly against gateway.
 *    Reflex: Detects repeated failures via reflex.failure-loop.v1, halts wasted tool dispatch.
 *
 * 3. TASK_C_REDUNDANT_ACTION: Agent loops on identical successful action without progress.
 *    Baseline: Runs until step/action ceiling repeating identical reads.
 *    Reflex: Detects redundant repetition via reflex.redundant-action.v1, intervenes.
 *
 * 4. TASK_D_BUDGET_PRESSURE: Agent operates near resource ceiling.
 *    Baseline: Runs until MAX_STEPS exhaustion (TIMED_OUT).
 *    Reflex: Detects budget threshold via reflex.budget-pressure.v1, defers safely (BLOCKED).
 *
 * Principles:
 * - Provider-independent: tasks define physical workspace fixtures and objective criteria only.
 * - Deterministic: zero random seeds, zero external network requirements.
 * - Immutable: frozen task definitions validated via createEvaluationTask.
 */

import {
  createEvaluationTask,
  EvaluationTaskDefinition,
} from "../../domain/evaluation.js";

// ============================================================================
// Task A: Normal Productive Work
// ============================================================================

export const TASK_A_NORMAL_WORK: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-normal",
  version: 1,
  description:
    "Clean sequential workflow: reads input.txt, transforms content to uppercase, and writes output.txt.",
  fixture: {
    initialFiles: {
      "input.txt": "emerald agent fabric test",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 3,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "output-file-exists",
      kind: "FILE_EXISTS",
      path: "output.txt",
      description: "Output file must be created",
    },
    {
      criterionId: "output-content-correct",
      kind: "FILE_CONTENT_EQUALS",
      path: "output.txt",
      expectedContent: "EMERALD AGENT FABRIC TEST",
      description: "Output file must contain uppercase transformed content",
    },
  ],
  budget: {
    maxSteps: 5,
    maxActions: 5,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task B: Repeated Failure Loop
// ============================================================================

export const TASK_B_REPEATED_FAILURE: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-failure-loop",
  version: 1,
  description:
    "Repeated failure scenario: agent loops attempting to read a nonexistent file, testing Reflex failure-loop intervention.",
  fixture: {
    initialFiles: {
      "existing.txt": "file exists in workspace",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 5,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "missing-file-must-exist",
      kind: "FILE_EXISTS",
      path: "missing.txt",
      description: "missing.txt does not exist unless created by agent",
    },
  ],
  budget: {
    maxSteps: 10,
    maxActions: 10,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 10,
    maxProposalRejections: 10,
  },
});

// ============================================================================
// Task C: Redundant Action Loop
// ============================================================================

export const TASK_C_REDUNDANT_ACTION: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-redundant-action",
  version: 1,
  description:
    "Redundant action scenario: agent loops reading an unchanged file repeatedly without progress, testing Reflex redundant-action intervention.",
  fixture: {
    initialFiles: {
      "readme.txt": "static documentation content",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 5,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "target-output-written",
      kind: "FILE_CONTENT_EQUALS",
      path: "output.txt",
      expectedContent: "completed",
      description: "output.txt must contain 'completed'",
    },
  ],
  budget: {
    maxSteps: 10,
    maxActions: 10,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 5,
    maxProposalRejections: 5,
  },
});

// ============================================================================
// Task D: Budget Pressure
// ============================================================================

export const TASK_D_BUDGET_PRESSURE: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-budget-pressure",
  version: 1,
  description:
    "Budget pressure scenario: agent operates near resource step ceiling, testing Reflex budget-pressure intervention.",
  fixture: {
    initialFiles: {
      "seed.txt": "data seed content",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 5,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "target-exists",
      kind: "FILE_EXISTS",
      path: "target.txt",
      description: "target.txt does not exist",
    },
  ],
  budget: {
    maxSteps: 5,
    maxActions: 5,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 5,
    maxProposalRejections: 5,
  },
});

// ============================================================================
// Task E: Multi-Step Normal Work (Phase 8.7)
// ============================================================================

export const TASK_E_MULTI_STEP_NORMAL: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-multi-step-normal",
  version: 1,
  description:
    "Multi-step normal workflow: reads step1.txt, writes intermediate step2.txt, reads step2.txt, and writes step3.txt without failure loops or redundancy.",
  fixture: {
    initialFiles: {
      "step1.txt": "alpha",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 5,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "step3-created",
      kind: "FILE_EXISTS",
      path: "step3.txt",
      description: "step3.txt must exist",
    },
    {
      criterionId: "step3-content",
      kind: "FILE_CONTENT_EQUALS",
      path: "step3.txt",
      expectedContent: "ALPHA-BETA-GAMMA",
      description: "step3.txt contains transformed pipeline output",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task F: Long Successful Sequence (Phase 8.7)
// ============================================================================

export const TASK_F_LONG_SEQUENCE: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-long-sequence",
  version: 1,
  description:
    "Long successful sequence: deterministic multi-stage data processing pipeline measuring cumulative Reflex invocation overhead.",
  fixture: {
    initialFiles: {
      "stage0.txt": "initial-token",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 40000,
      maxAttempts: 10,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "final-stage-exists",
      kind: "FILE_EXISTS",
      path: "stage4.txt",
      description: "stage4.txt must exist",
    },
    {
      criterionId: "final-stage-content",
      kind: "FILE_CONTENT_EQUALS",
      path: "stage4.txt",
      expectedContent: "PIPELINE-COMPLETE",
      description: "Final stage must contain verified output",
    },
  ],
  budget: {
    maxSteps: 12,
    maxActions: 12,
    maxWallClockMs: 40000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Task G: Intermittent Recoverable Failure (Phase 8.7)
// ============================================================================

export const TASK_G_INTERMITTENT_FAILURE: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-intermittent-failure",
  version: 1,
  description:
    "Intermittent recoverable failure scenario: transient non-consecutive errors reset by intervening successful actions to verify failure-loop rule does not prematurely trigger.",
  fixture: {
    initialFiles: {
      "primary.txt": "primary payload",
      "secondary.txt": "secondary payload",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 6,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "recovered-output-exists",
      kind: "FILE_EXISTS",
      path: "recovered.txt",
      description: "recovered.txt must exist",
    },
    {
      criterionId: "recovered-output-content",
      kind: "FILE_CONTENT_EQUALS",
      path: "recovered.txt",
      expectedContent: "RECOVERED: primary payload + secondary payload",
      description: "recovered.txt contains aggregated data from both primary and secondary",
    },
  ],
  budget: {
    maxSteps: 8,
    maxActions: 8,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 5,
    maxProposalRejections: 5,
  },
});

// ============================================================================
// Task H: Mixed Workload (Phase 8.7)
// ============================================================================

export const TASK_H_MIXED_WORKLOAD: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-mixed-workload",
  version: 1,
  description:
    "Mixed workload scenario: deterministic sequence containing normal actions, a transient failure, a redundant action loop, and final recovery, measuring multiple Reflex decision types in a single run.",
  fixture: {
    initialFiles: {
      "dataset.txt": "base record",
      "config.txt": "mode=strict",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 8,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "summary-written",
      kind: "FILE_CONTENT_EQUALS",
      path: "summary.txt",
      expectedContent: "PROCESSED: base record",
      description: "summary.txt contains final output",
    },
  ],
  budget: {
    maxSteps: 10,
    maxActions: 10,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 5,
    maxProposalRejections: 5,
  },
});

// ============================================================================
// Task I: Near-Threshold Workload (Phase 8.7)
// ============================================================================

export const TASK_I_NEAR_THRESHOLD: EvaluationTaskDefinition = createEvaluationTask({
  taskId: "task-baseline-reflex-near-threshold",
  version: 1,
  description:
    "Near-threshold workload scenario: workload that approaches but does not exceed the resource pressure threshold (e.g. 60% of budget vs 80% threshold), measuring absence of false DEFER/REJECT interventions.",
  fixture: {
    initialFiles: {
      "data.txt": "threshold verification payload",
    },
  },
  mission: {
    requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
    resourceLimits: {
      timeoutMs: 30000,
      maxAttempts: 5,
      maxOutputBytes: 65536,
    },
  },
  successCriteria: [
    {
      criterionId: "verified-result",
      kind: "FILE_CONTENT_EQUALS",
      path: "result.txt",
      expectedContent: "THRESHOLD VERIFIED: threshold verification payload",
      description: "result.txt contains processed data created before budget threshold",
    },
  ],
  budget: {
    maxSteps: 5,
    maxActions: 5,
    maxWallClockMs: 30000,
    maxConsecutiveFailures: 3,
    maxProposalRejections: 3,
  },
});

// ============================================================================
// Registry & Lookup
// ============================================================================

/**
 * Canonical Phase 8.3 baseline evaluation tasks (Tasks A–D).
 */
export const BASELINE_REFLEX_TASKS: readonly EvaluationTaskDefinition[] = Object.freeze([
  TASK_A_NORMAL_WORK,
  TASK_B_REPEATED_FAILURE,
  TASK_C_REDUNDANT_ACTION,
  TASK_D_BUDGET_PRESSURE,
]);

export const BASELINE_REFLEX_TASK_IDS = Object.freeze(
  BASELINE_REFLEX_TASKS.map((t) => t.taskId)
);

/**
 * Extended Phase 8.7 baseline evaluation tasks (Tasks E–I).
 */
export const EXTENDED_BASELINE_REFLEX_TASKS: readonly EvaluationTaskDefinition[] = Object.freeze([
  TASK_E_MULTI_STEP_NORMAL,
  TASK_F_LONG_SEQUENCE,
  TASK_G_INTERMITTENT_FAILURE,
  TASK_H_MIXED_WORKLOAD,
  TASK_I_NEAR_THRESHOLD,
]);

export const EXTENDED_BASELINE_REFLEX_TASK_IDS = Object.freeze(
  EXTENDED_BASELINE_REFLEX_TASKS.map((t) => t.taskId)
);

/**
 * Complete suite of all 9 deterministic Baseline/Reflex evaluation tasks (A–I).
 */
export const ALL_BASELINE_REFLEX_TASKS: readonly EvaluationTaskDefinition[] = Object.freeze([
  ...BASELINE_REFLEX_TASKS,
  ...EXTENDED_BASELINE_REFLEX_TASKS,
]);

export const ALL_BASELINE_REFLEX_TASK_IDS = Object.freeze(
  ALL_BASELINE_REFLEX_TASKS.map((t) => t.taskId)
);

export function getBaselineReflexTask(taskId: string): EvaluationTaskDefinition {
  const task = ALL_BASELINE_REFLEX_TASKS.find((t) => t.taskId === taskId);
  if (!task) {
    throw new Error(
      `Unknown Baseline/Reflex evaluation task '${taskId}'. Available: [${ALL_BASELINE_REFLEX_TASK_IDS.join(
        ", "
      )}]`
    );
  }
  return task;
}

