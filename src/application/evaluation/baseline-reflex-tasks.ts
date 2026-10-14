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
// Registry & Lookup
// ============================================================================

export const BASELINE_REFLEX_TASKS: readonly EvaluationTaskDefinition[] = Object.freeze([
  TASK_A_NORMAL_WORK,
  TASK_B_REPEATED_FAILURE,
  TASK_C_REDUNDANT_ACTION,
  TASK_D_BUDGET_PRESSURE,
]);

export const BASELINE_REFLEX_TASK_IDS = Object.freeze(
  BASELINE_REFLEX_TASKS.map((t) => t.taskId)
);

export function getBaselineReflexTask(taskId: string): EvaluationTaskDefinition {
  const task = BASELINE_REFLEX_TASKS.find((t) => t.taskId === taskId);
  if (!task) {
    throw new Error(
      `Unknown Baseline/Reflex evaluation task '${taskId}'. Available: [${BASELINE_REFLEX_TASK_IDS.join(
        ", "
      )}]`
    );
  }
  return task;
}
