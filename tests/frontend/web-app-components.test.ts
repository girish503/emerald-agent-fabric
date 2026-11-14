/**
 * Tests for Frontend Component Logic and View Transformers (Track C)
 */

import { describe, expect, it } from "vitest";
import {
  buildTimelineSteps,
  formatOutcomeBadge,
  computeDashboardSummary,
} from "../../apps/web/src/components/workspace-views.js";
import {
  MOCK_EVENTS,
  MOCK_TASKS,
  MOCK_RUNS,
  MOCK_MODEL_EVALUATIONS,
} from "../../apps/web/src/mocks/mock-data.js";
import { TRIAL_FINAL_OUTCOMES } from "../../src/domain/evaluation.js";

describe("Track C — Frontend Component Logic", () => {
  describe("buildTimelineSteps", () => {
    it("transforms raw SSE event stream into structured agent timeline steps", () => {
      const steps = buildTimelineSteps(MOCK_EVENTS);
      expect(steps.length).toBeGreaterThanOrEqual(1);

      const firstStep = steps[0];
      expect(firstStep).toBeDefined();
      if (!firstStep) return;

      expect(firstStep.stepIndex).toBe(1);
      expect(firstStep.thought).toContain("inspect parser.ts");
      expect(firstStep.toolCalls.length).toBe(1);

      const toolCall = firstStep.toolCalls[0];
      expect(toolCall).toBeDefined();
      if (!toolCall) return;

      expect(toolCall.toolName).toBe("read_file");
      expect(toolCall.approved).toBe(true);
      expect(toolCall.durationMs).toBe(45);
    });
  });

  describe("formatOutcomeBadge", () => {
    it("maps all 7 canonical outcomes to distinct, user-friendly badges", () => {
      for (const outcome of TRIAL_FINAL_OUTCOMES) {
        const badge = formatOutcomeBadge(outcome);
        expect(badge.label).toBeDefined();
        expect(badge.color).toBeDefined();
        expect(badge.description).toBeDefined();
      }

      const successBadge = formatOutcomeBadge("VERIFIED_SUCCESS");
      expect(successBadge.color).toBe("green");
      expect(successBadge.label).toBe("Verified Success");

      const falseCompletionBadge = formatOutcomeBadge("FALSE_COMPLETION");
      expect(falseCompletionBadge.color).toBe("red");
      expect(falseCompletionBadge.label).toBe("False Completion");
    });
  });

  describe("computeDashboardSummary", () => {
    it("computes accurate summary statistics from task and run records", () => {
      const summary = computeDashboardSummary(MOCK_TASKS, MOCK_RUNS);
      expect(summary.totalTasks).toBe(2);
      expect(summary.completedRuns).toBe(1);
      expect(summary.verifiedSuccesses).toBe(1);
      expect(summary.falseCompletions).toBe(0);
      expect(summary.verifiedRate).toBe(1.0);
    });
  });

  describe("MOCK_MODEL_EVALUATIONS", () => {
    it("provides valid comparison data across multiple candidate models", () => {
      expect(MOCK_MODEL_EVALUATIONS.length).toBe(2);
      const qwen = MOCK_MODEL_EVALUATIONS[0];
      expect(qwen).toBeDefined();
      if (!qwen) return;

      expect(qwen.modelId).toBe("qwen2.5-coder:7b");
      expect(qwen.verifiedSuccessRate).toBeGreaterThan(0.8);
      expect(qwen.falseCompletionRate_Claims).toBeLessThan(0.1);
    });
  });
});
