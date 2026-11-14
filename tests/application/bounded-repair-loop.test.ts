import { describe, expect, it } from "vitest";
import { BoundedRepairLoopController } from "../../src/application/bounded-repair-loop.js";

describe("Bounded Autonomous Repair Loop Controller", () => {
  const controller = new BoundedRepairLoopController({
    maxRepairIterations: 3,
    maxCumulativeActions: 6,
    maxCumulativeTimeMs: 30_000,
  });

  it("classifies syntax errors and test failures accurately", () => {
    const state = controller.initCycle("task-400", "run-400");

    const cat1 = controller.diagnoseFeedback(
      state,
      "SyntaxError: Unexpected token '{' at index.js:10",
      "",
      1
    );
    expect(cat1).toBe("SYNTAX_ERROR");
    expect(state.lastDiagnosis?.category).toBe("SYNTAX_ERROR");

    const cat2 = controller.diagnoseFeedback(
      state,
      "",
      "FAIL tests/solver.test.ts > AssertionError: expected 42 to be 43",
      1
    );
    expect(cat2).toBe("TEST_ASSERTION_FAILURE");
  });

  it("enforces stagnation detection on identical repeated repair patches", () => {
    const state = controller.initCycle("task-401", "run-401");

    const patch1 = "export function solve() { return 42; }";
    const res1 = controller.evaluateProposedRepair(state, patch1, 2000);
    expect(res1.canProceed).toBe(true);
    expect(state.iterationCount).toBe(1);

    // Agent proposes identical patch again
    const res2 = controller.evaluateProposedRepair(state, patch1, 2000);
    expect(res2.canProceed).toBe(false);
    expect(res2.haltReason).toContain("Stagnation detected");
    expect(state.currentStage).toBe("TERMINAL_FAILED");
  });

  it("enforces iteration ceiling and concludes verification correctly", () => {
    const state = controller.initCycle("task-402", "run-402");

    // Iteration 1 fails
    controller.evaluateProposedRepair(state, "patch 1", 1000);
    controller.concludeVerification(state, 1);
    expect(state.currentStage).toBe("OBSERVE");

    // Iteration 2 fails
    controller.evaluateProposedRepair(state, "patch 2", 1000);
    controller.concludeVerification(state, 1);
    expect(state.currentStage).toBe("OBSERVE");

    // Iteration 3 fails -> reaches iteration limit
    controller.evaluateProposedRepair(state, "patch 3", 1000);
    controller.concludeVerification(state, 1);
    expect(state.currentStage).toBe("TERMINAL_EXHAUSTED");
    expect(state.terminalReason).toContain("iteration budget exhausted");
  });

  it("concludes with TERMINAL_SUCCESS on independent verification exit code 0", () => {
    const state = controller.initCycle("task-403", "run-403");

    controller.evaluateProposedRepair(state, "correct patch", 1500);
    const finalStage = controller.concludeVerification(state, 0);

    expect(finalStage).toBe("TERMINAL_SUCCESS");
    expect(state.terminalReason).toContain("exit code 0");
  });
});
