/**
 * Phase 7.2 — Evaluation Trial Runner Application Integration Test Suite
 *
 * Verifies executeEvaluationTrial across runner invariants (Tests 23–35):
 * 23. trial executes through existing Evaluation Runner
 * 24. trial executes through AgentStepController
 * 25. MissionContract remains enforced
 * 26. unauthorized capability remains blocked
 * 27. fresh workspace is created per trial
 * 28. objective criteria determine outcome
 * 29. agent claim does not override objective outcome
 * 30. underlying runId is retained
 * 31. metrics are copied without changing zero/undefined semantics
 * 32. model/provider failure maps correctly
 * 33. cancellation maps correctly
 * 34. timeout maps correctly
 * 35. blocked governance maps correctly
 */

import { describe, expect, it } from "vitest";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  executeEvaluationTrial,
} from "../../src/application/evaluation/evaluation-runner.js";
import {
  EvaluationTaskDefinition,
} from "../../src/domain/evaluation.js";

// ============================================================================
// Helpers & Test Doubles
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
    taskId: "trial-eval-task",
    version: 1,
    description: "Read greeting and update greeting.txt with Emerald greeting",
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

describe("Phase 7.2 — Evaluation Trial Runner Integration", () => {
  // 23 & 24. executes through existing runner and step controller
  it("23 & 24. trial executes through existing Evaluation Runner and AgentStepController", async () => {
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
        };
      } else {
        return {
          content: JSON.stringify({ isGoalReached: true }),
        };
      }
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.trialOrdinal).toBe(1);
    expect(trial.outcome).toBe("PASSED");
    expect(trial.verificationPassed).toBe(true);
    expect(trial.metrics.steps).toBe(3);
    expect(trial.metrics.actions).toBe(2);
    expect(trial.metrics.modelCalls).toBe(3);
    expect(trial.evidenceReferences.length).toBeGreaterThan(0);
    expect(trial.trialIdentityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // 25. MissionContract remains enforced
  it("25. MissionContract resource limits remain enforced during trial execution", async () => {
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

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask({
      budget: {
        maxSteps: 10,
        maxActions: 1, // Contract restricts to 1 action max
        maxWallClockMs: 60000,
      },
    });

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.outcome).toBe("TIMED_OUT");
    expect(trial.metrics.actions).toBe(1);
  });

  // 26. unauthorized capability remains blocked
  it("26. unauthorized capability proposal remains blocked by governance policy", async () => {
    const { fetch } = createMockOllamaFetch(async (body) => {
      const contextHash = extractContextHash(body);
      return {
        content: JSON.stringify({
          isGoalReached: false,
          proposalId: "p1",
          toolName: "write_file",
          inputPayload: { path: "src/greeting.txt", content: "Unauthorized write" },
          contextSnapshotHash: contextHash,
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask({
      mission: {
        // Only grant read, do NOT grant write
        requiredCapabilities: ["workspace.file.read"],
      },
    });

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    // Write proposal was rejected by governance policy
    expect(trial.outcome).not.toBe("PASSED");
    expect(trial.verificationPassed).toBe(false);
  });

  // 27. fresh workspace is created per trial
  it("27. independent trials receive pristine workspaces without cross-trial contamination", async () => {
    let stepCount = 0;
    const { fetch } = createMockOllamaFetch(async (body) => {
      stepCount++;
      const contextHash = extractContextHash(body);

      // In step 1: write an extra side-effect file "src/side_effect.txt"
      if (stepCount === 1) {
        return {
          content: JSON.stringify({
            isGoalReached: false,
            proposalId: `p-${stepCount}`,
            toolName: "write_file",
            inputPayload: { path: "src/side_effect.txt", content: "Artifact from trial 1\n" },
            contextSnapshotHash: contextHash,
          }),
        };
      }
      return { content: JSON.stringify({ isGoalReached: true }) };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    // Require that side_effect.txt is ABSENT as a success criterion
    const task = createSampleTask({
      successCriteria: [
        {
          criterionId: "c-clean",
          kind: "FILE_ABSENT",
          path: "src/side_effect.txt",
          description: "side_effect.txt must not exist in a pristine workspace",
        },
      ],
    });

    // Trial 1 writes the side_effect file
    const trial1 = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });
    // Trial 1 fails because it wrote the file
    expect(trial1.outcome).toBe("FAILED");

    // Reset stepCount and run Trial 2
    stepCount = 1; // Agent immediately claims goal without writing side_effect
    const trial2 = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 2,
    });

    // Trial 2 succeeds because side_effect.txt does NOT carry over from Trial 1
    expect(trial2.outcome).toBe("PASSED");
    expect(trial2.verificationPassed).toBe(true);
  });

  // 28. objective criteria determine outcome
  it("28. objective workspace criteria dictate PASSED vs FAILED outcome", async () => {
    const { fetch } = createMockOllamaFetch(async () => {
      // Agent does nothing and finishes
      return { content: JSON.stringify({ isGoalReached: true }) };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.outcome).toBe("FAILED");
    expect(trial.verificationPassed).toBe(false);
  });

  // 29. agent claim does not override objective outcome
  it("29. agent self-claim ('isGoalReached: true') does not override failing objective criteria", async () => {
    const { fetch } = createMockOllamaFetch(async () => {
      return { content: JSON.stringify({ isGoalReached: true }) };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.agentClaimedGoal).toBe(true);
    expect(trial.verificationPassed).toBe(false);
    expect(trial.outcome).toBe("FAILED");
  });

  // 30. underlying runId is retained
  it("30. underlying runtime runId is retained in the trial record", async () => {
    const { fetch } = createMockOllamaFetch(async () => {
      return { content: JSON.stringify({ isGoalReached: true }) };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });
    expect(trial.runtimeRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(trial.runtimeRunId.length).toBe(36);
  });

  // 31. metrics are copied without changing zero/undefined semantics
  it("31. metric semantics faithfully preserve observed zero vs undefined tokens", async () => {
    const { fetch } = createMockOllamaFetch(async () => {
      return {
        content: JSON.stringify({ isGoalReached: true }),
        promptEvalCount: 75,
        evalCount: 30,
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.metrics.inputTokens).toBe(75);
    expect(trial.metrics.outputTokens).toBe(30);
    expect(trial.metrics.totalTokens).toBe(105);
    expect(trial.metrics.proposalRejections).toBe(0); // Observed zero
    expect(trial.metrics.executionFailures).toBe(0); // Observed zero
  });

  // 32. model/provider failure maps correctly
  it("32. model provider network failure maps to outcome ERROR", async () => {
    const fetchImpl: OllamaFetchLike = async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    };

    const provider = new OllamaModelProvider({ fetch: fetchImpl, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.outcome).toBe("ERROR");
    expect(trial.metrics.modelFailures).toBe(1);
  });

  // 33. cancellation maps correctly
  it("33. AbortSignal cancellation maps to outcome CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();

    const { fetch } = createMockOllamaFetch(async () => {
      return { content: JSON.stringify({ isGoalReached: true }) };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask();

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
      abortSignal: controller.signal,
    });

    expect(trial.outcome).toBe("CANCELLED");
  });

  // 34. timeout maps correctly
  it("34. step budget ceiling exhaustion maps to outcome TIMED_OUT", async () => {
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

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask({
      budget: {
        maxSteps: 2,
        maxActions: 5,
        maxWallClockMs: 60000,
      },
    });

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.outcome).toBe("TIMED_OUT");
    expect(trial.metrics.steps).toBe(2);
  });

  // 35. blocked governance maps correctly
  it("35. governance rejection ceiling exhaustion maps to outcome BLOCKED", async () => {
    let stepCount = 0;
    const { fetch } = createMockOllamaFetch(async (body) => {
      stepCount++;
      const contextHash = extractContextHash(body);
      return {
        content: JSON.stringify({
          isGoalReached: false,
          proposalId: `traversal-${stepCount}`,
          toolName: "read_file",
          inputPayload: { path: "../../forbidden.txt" },
          contextSnapshotHash: contextHash,
        }),
      };
    });

    const provider = new OllamaModelProvider({ fetch, defaultModel: "test-trial-model" });
    const task = createSampleTask({
      budget: {
        maxSteps: 10,
        maxActions: 5,
        maxWallClockMs: 60000,
        maxProposalRejections: 2,
      },
    });

    const trial = await executeEvaluationTrial({
      task,
      modelProvider: provider,
      model: "test-trial-model",
      trialOrdinal: 1,
    });

    expect(trial.outcome).toBe("BLOCKED");
    expect(trial.metrics.proposalRejections).toBe(2);
  });
});
