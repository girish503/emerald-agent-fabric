/**
 * Phase 7.1 — Evaluation Runner Application Integration Test Suite
 *
 * Verifies executeEvaluationRun with EvaluationTaskDefinition:
 * 1. Successful execution with objective verification (status: PASSED)
 * 2. Agent goal claim without objective verification (status: FAILED)
 * 3. Resource budget ceiling exhaustion (status: TIMED_OUT)
 * 4. Cancellation via AbortSignal (status: CANCELLED)
 * 5. Governance fencing / rejection (status: BLOCKED)
 * 6. Model provider failure (status: ERROR)
 */

import { describe, expect, it } from "vitest";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  executeEvaluationRun,
} from "../../src/application/evaluation/evaluation-runner.js";
import { EvaluationTaskDefinition } from "../../src/domain/evaluation.js";

// ============================================================================
// Helpers & Doubles
// ============================================================================

function createMockOllamaFetch(
  handler: (body: any, url: string) => Promise<{ content: string; evalCount?: number; promptEvalCount?: number }>
): { fetch: OllamaFetchLike } {
  const fetchImpl: OllamaFetchLike = async (url, init) => {
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
    const result = await handler(parsedBody, String(url));
    const responsePayload = {
      model: parsedBody.model || "test-model",
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: result.content,
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: result.promptEvalCount ?? 50,
      eval_count: result.evalCount ?? 40,
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch: fetchImpl };
}

function extractContextHash(parsedBody: any): string {
  const messages = parsedBody?.messages ?? [];
  const lastMsg = messages[messages.length - 1]?.content ?? "";
  const match = lastMsg.match(/Context Snapshot Hash: ([a-f0-9]{64})/);
  return match ? match[1] : "0".repeat(64);
}

function createSampleTask(overrides: Partial<EvaluationTaskDefinition> = {}): EvaluationTaskDefinition {
  return {
    taskId: "greeting-eval-task",
    version: 1,
    description: "Inspect workspace greeting.txt and update it to expected greeting",
    fixture: {
      initialFiles: {
        "src/greeting.txt": "Hello, World!\n",
      },
    },
    mission: {
      requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
      resourceLimits: {
        timeoutMs: 60000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      },
    },
    successCriteria: [
      {
        criterionId: "c1",
        kind: "FILE_CONTENT_EQUALS",
        path: "src/greeting.txt",
        expectedContent: "Hello, Emerald!\n",
        description: "greeting.txt must contain 'Hello, Emerald!'",
      },
    ],
    budget: {
      maxSteps: 5,
      maxActions: 3,
      maxWallClockMs: 60000,
      maxConsecutiveFailures: 2,
      maxProposalRejections: 2,
    },
    ...overrides,
  };
}

describe("Phase 7.1 — Evaluation Runner Application Integration", () => {
  it("1. executes evaluation task and produces PASSED result when objective criteria match", async () => {
    let stepCount = 0;
    const { fetch } = createMockOllamaFetch(async (body) => {
      stepCount++;
      const contextHash = extractContextHash(body);

      if (stepCount === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p1",
            toolName: "read_file",
            inputPayload: { path: "src/greeting.txt" },
            contextSnapshotHash: contextHash,
            rationale: "Inspecting greeting",
          }),
          evalCount: 25,
        };
      } else if (stepCount === 2) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: "p2",
            toolName: "write_file",
            inputPayload: { path: "src/greeting.txt", content: "Hello, Emerald!\n" },
            contextSnapshotHash: contextHash,
            rationale: "Writing new greeting",
          }),
          evalCount: 30,
        };
      } else {
        return {
          content: JSON.stringify({
            isGoalReached: true,
          }),
          evalCount: 10,
        };
      }
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const task = createSampleTask();

    const result = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
      trialNumber: 1,
    });

    expect(result.status).toBe("PASSED");
    expect(result.verificationPassed).toBe(true);
    expect(result.agentClaimedGoal).toBe(true);
    expect(result.taskId).toBe("greeting-eval-task");
    expect(result.taskVersion).toBe(1);
    expect(result.trialNumber).toBe(1);
    expect(result.taskContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.configFingerprint.fingerprintHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.criteriaResults).toHaveLength(1);
    expect(result.criteriaResults[0]!.passed).toBe(true);
    expect(result.metrics.steps).toBe(3);
    expect(result.metrics.actions).toBe(2);
    expect(result.metrics.modelCalls).toBe(3);
    expect(result.metrics.toolCalls).toBe(2);
    expect(result.metrics.inputTokens).toBe(150); // 3 * 50
    expect(result.metrics.outputTokens).toBe(65); // 25 + 30 + 10
    expect(result.evidenceReferences.length).toBeGreaterThan(0);
  });

  it("2. produces FAILED result when agent claims success but objective criteria fail", async () => {
    const { fetch } = createMockOllamaFetch(async () => {
      // Agent claims goal achieved without modifying file
      return {
        content: JSON.stringify({ isGoalReached: true }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const task = createSampleTask();

    const result = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
    });

    expect(result.status).toBe("FAILED");
    expect(result.verificationPassed).toBe(false);
    expect(result.agentClaimedGoal).toBe(true);
    expect(result.criteriaResults[0]!.passed).toBe(false);
    expect(result.criteriaResults[0]!.message).toContain("File content mismatch");
  });

  it("3. produces TIMED_OUT result when step budget is exhausted", async () => {
    let stepCount = 0;
    const { fetch } = createMockOllamaFetch(async (body) => {
      stepCount++;
      const contextHash = extractContextHash(body);
      return {
        content: JSON.stringify({
          isGoalReached: false,
          proposalId: `p-${stepCount}`,
          toolName: "read_file",
          inputPayload: { path: "src/greeting.txt" },
          contextSnapshotHash: contextHash,
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const task = createSampleTask({
      budget: {
        maxSteps: 2, // Budget = 2 steps
        maxActions: 5,
        maxWallClockMs: 60000,
      },
    });

    const result = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
    });

    expect(result.status).toBe("TIMED_OUT");
    expect(result.metrics.steps).toBe(2);
  });

  it("4. produces CANCELLED result when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const { fetch } = createMockOllamaFetch(async () => {
      return { content: JSON.stringify({ isGoalReached: true }) };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const task = createSampleTask();

    const result = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("CANCELLED");
    expect(result.metrics.actions).toBe(0);
  });

  it("5. produces BLOCKED result when proposal exceeds proposal rejections ceiling", async () => {
    let stepCount = 0;
    const { fetch } = createMockOllamaFetch(async (body) => {
      stepCount++;
      const contextHash = extractContextHash(body);
      // Continuous path traversal invalid proposals
      return {
        content: JSON.stringify({
          isGoalReached: false,
          proposalId: `bad-prop-${stepCount}`,
          toolName: "read_file",
          inputPayload: { path: "../../outside.txt" },
          contextSnapshotHash: contextHash,
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-eval-model" });
    const task = createSampleTask({
      budget: {
        maxSteps: 10,
        maxActions: 5,
        maxWallClockMs: 60000,
        maxProposalRejections: 2,
      },
    });

    const result = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.metrics.proposalRejections).toBe(2);
    expect(result.metrics.actions).toBe(0);
  });

  it("6. produces ERROR result when model provider is unavailable", async () => {
    const fetchImpl: OllamaFetchLike = async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    };

    const provider = new OllamaModelProvider({ fetch: fetchImpl, defaultModel: "test-eval-model" });
    const task = createSampleTask();

    const result = await executeEvaluationRun({
      task,
      modelProvider: provider,
      model: "test-eval-model",
    });

    expect(result.status).toBe("ERROR");
    expect(result.metrics.modelFailures).toBe(1);
    expect(result.metrics.actions).toBe(0);
  });
});
