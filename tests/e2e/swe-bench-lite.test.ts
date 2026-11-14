/**
 * Milestone 4.2 Phase 5 — SWE-bench Lite Open Dataset E2E Benchmark Test.
 *
 * Verifies that the SWE-bench Lite harness runs against the local Ollama model (qwen2.5-coder:1.5b),
 * records verifiable outcomes, and produces structured evaluation evidence without inflation.
 */

import { describe, expect, it } from "vitest";
import { runSweBenchLiteBenchmark } from "../../src/application/evaluation/swe-bench-lite-runner.js";

describe("Phase 5 — SWE-bench Lite Benchmark Harness", { timeout: 300_000 }, () => {
  it("executes SWE-bench Lite evaluation with local model and records honest results", async () => {
    // Run 2 tasks in test harness to verify runner mechanics within Vitest timeout
    const result = await runSweBenchLiteBenchmark({
      limit: 2,
      taskTimeoutMs: 30_000,
      modelTimeoutMs: 15_000,
    });

    expect(result.totalTasks).toBe(2);
    expect(result.results.length).toBe(2);
    expect(result.passedCount + result.failedCount + result.timedOutCount).toBe(2);

    for (const r of result.results) {
      expect(["PASSED", "FAILED", "TIMED_OUT"]).toContain(r.status);
      expect(typeof r.durationMs).toBe("number");
      expect(typeof r.turnsTaken).toBe("number");
      expect(typeof r.patchGenerated).toBe("boolean");
    }
  });
});
