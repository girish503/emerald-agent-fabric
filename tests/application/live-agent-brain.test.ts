/**
 * Phase 6.2 — LiveAgentBrain Tests
 *
 * Verifies the provider-neutral LiveAgentBrain bridge connecting the governed
 * reasoning loop (AgentBrainPort) to the provider-neutral inference boundary (ModelProviderPort).
 *
 * Test Sections:
 * 1. Request Construction (Tests 1–12)
 * 2. Output Handling (Tests 13–20)
 * 3. Provider Failure Propagation (Tests 21–25)
 * 4. Single-Attempt & Retry Invariants (Tests 26–29)
 * 5. Security Invariants (Tests 30–38)
 * 6. Cancellation Propagation (Tests 39–40)
 * 7. End-to-End Governed Step Controller Integration (Test 41)
 * 8. Adversarial Authority Rejection Negative Test (Test 42)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
} from "../../src/application/agent-step-controller.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION,
  LiveAgentBrain,
} from "../../src/application/live-agent-brain.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import {
  ActionProposal,
  MAX_PROPOSAL_BYTES,
} from "../../src/domain/action-proposal.js";
import {
  computeContextHash,
  ContextSnapshot,
  DEFAULT_CONTEXT_BUDGET,
  Observation,
} from "../../src/domain/context.js";
import {
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRateLimitedError,
  ModelRequestCancelledError,
  ModelRequestTimeoutError,
} from "../../src/domain/errors.js";
import {
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../src/domain/model-provider.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { AgentBrainRequest } from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { ModelProviderPort } from "../../src/ports/model-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Test Doubles
// ============================================================================

class FakeModelProvider implements ModelProviderPort {
  readonly providerName: string;
  readonly calls: ModelProviderRequest[] = [];
  responseToReturn?: ModelProviderResponse;
  errorToThrow?: Error;
  customHandler?: (request: ModelProviderRequest) => Promise<ModelProviderResponse>;

  constructor(providerName = "fake-model-provider") {
    this.providerName = providerName;
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);

    if (request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError("Request was aborted prior to inference", {
        providerName: this.providerName,
        requestId: request.requestId,
      });
    }

    if (this.customHandler) {
      return this.customHandler(request);
    }

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    if (this.responseToReturn) {
      return this.responseToReturn;
    }

    return {
      requestId: request.requestId,
      model: request.model,
      outputText: JSON.stringify({
        isGoalReached: false,
        proposalId: "prop-default-1",
        toolName: "read_file",
        inputPayload: { path: "test.txt" },
        contextSnapshotHash: "0".repeat(64),
        rationale: "Default proposal",
      }),
      finishReason: "STOP",
      durationMs: 15,
    };
  }
}

function createMockSnapshot(overrides?: Partial<ContextSnapshot>): ContextSnapshot {
  const budget = DEFAULT_CONTEXT_BUDGET;
  const observations: Observation[] = [
    {
      observationId: "obs-1",
      category: "RUN_STATE",
      provenance: {
        entityKind: "Run",
        entityId: "run-test-1",
        runId: "run-test-1",
        timestamp: "2026-10-13T12:00:00.000Z",
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 100,
      content: { status: "RUNNING", taskId: "task-test-1" },
      contentHash: "a".repeat(64),
      estimatedTokens: 10,
      estimatedBytes: 40,
      isMandatory: true,
    },
    {
      observationId: "obs-2",
      category: "WORKSPACE_STATE",
      provenance: {
        entityKind: "Workspace",
        entityId: "ws-test-1",
        runId: "run-test-1",
        timestamp: "2026-10-13T12:00:01.000Z",
        isAuthoritativeRuntimeFact: true,
      },
      freshness: "CURRENT",
      priority: 70,
      content: { files: ["index.ts", "package.json"] },
      contentHash: "b".repeat(64),
      estimatedTokens: 8,
      estimatedBytes: 32,
      isMandatory: false,
    },
  ];

  const contextHash = computeContextHash({
    runId: "run-test-1",
    taskId: "task-test-1",
    policyVersion: "context-policy-v1",
    budget,
    observations,
  });

  return {
    snapshotId: "snap-test-1",
    runId: "run-test-1",
    taskId: "task-test-1",
    policyVersion: "context-policy-v1",
    createdAt: "2026-10-13T12:00:00.000Z",
    budget,
    observations,
    omittedObservationsCount: 0,
    omittedObservationsSummary: [],
    totalEstimatedTokens: 18,
    totalBytes: 72,
    contextHash,
    ...overrides,
  };
}

function createTestBrainRequest(overrides?: Partial<AgentBrainRequest>): AgentBrainRequest {
  const contextSnapshot = overrides?.contextSnapshot ?? createMockSnapshot();
  return {
    runId: "run-test-1",
    contextSnapshot,
    availableTools: staticToolRegistry.listTools(),
    sequenceNumber: 1,
    ...overrides,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("LiveAgentBrain — Provider-Neutral Agent Brain Bridge (Phase 6.2)", () => {
  // --------------------------------------------------------------------------
  // 1. Request Construction
  // --------------------------------------------------------------------------
  describe("1. Request Construction", () => {
    it("1. creates provider request from AgentBrainRequest", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
        timeoutMs: 15000,
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      expect(modelReq.model).toBe("test-model-1");
      expect(modelReq.timeoutMs).toBe(15000);
      expect(modelReq.requestId).toBeDefined();
      expect(modelReq.input.length).toBe(2);
      expect(modelReq.input[0]!.role).toBe("system");
      expect(modelReq.input[1]!.role).toBe("user");
    });

    it("2. includes ContextSnapshot observations", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      const userContent = modelReq.input[1]!.content;
      expect(userContent).toContain("RUN_STATE");
      expect(userContent).toContain("WORKSPACE_STATE");
      expect(userContent).toContain("task-test-1");
    });

    it("3. preserves context identity/hash", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      const userContent = modelReq.input[1]!.content;
      expect(userContent).toContain(`Context Snapshot Hash: ${brainReq.contextSnapshot.contextHash}`);
      expect(userContent).toContain(`Set contextSnapshotHash to "${brainReq.contextSnapshot.contextHash}"`);
    });

    it("4. deterministic request construction", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
        requestIdGenerator: () => "fixed-request-id",
      });

      const brainReq = createTestBrainRequest();
      const req1 = brain.buildModelRequest(brainReq);
      const req2 = brain.buildModelRequest(brainReq);

      expect(req1.requestId).toBe("fixed-request-id");
      expect(req2.requestId).toBe("fixed-request-id");
      expect(req1.input).toEqual(req2.input);
      expect(req1.generation).toEqual(req2.generation);
      expect(req1.timeoutMs).toBe(req2.timeoutMs);
    });

    it("5. system instruction present", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      expect(modelReq.input[0]!.content).toBe(DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION);
      expect(modelReq.input[0]!.content).toContain("You are a reasoning component");
      expect(modelReq.input[0]!.content).toContain("Your output is untrusted");
    });

    it("6. provider-neutral message roles", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      expect(modelReq.input.map((m) => m.role)).toEqual(["system", "user"]);
    });

    it("7. structured output requested", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      expect(modelReq.generation?.structuredOutput).toBeDefined();
      expect(modelReq.generation?.structuredOutput?.name).toBe("action_proposal");
      expect(modelReq.generation?.structuredOutput?.strict).toBe(true);
      expect(modelReq.generation?.structuredOutput?.jsonSchema).toBe(
        ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema
      );
    });

    it("8. generation limits bounded", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
        generationOptions: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          topP: 0.9,
          stopSequences: ["### END"],
        },
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      expect(modelReq.generation?.temperature).toBe(0.2);
      expect(modelReq.generation?.maxOutputTokens).toBe(1024);
      expect(modelReq.generation?.topP).toBe(0.9);
      expect(modelReq.generation?.stopSequences).toEqual(["### END"]);
    });

    it("9. no workerId in model authority", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      const userContent = modelReq.input[1]!.content;
      expect(userContent).not.toContain("worker-step");
      expect(userContent).not.toContain("currentWorkerId");
      expect(userContent).not.toContain("workerId");
    });

    it("10. no leaseId in model authority", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      const userContent = modelReq.input[1]!.content;
      expect(userContent).not.toContain("lease-");
      expect(userContent).not.toContain("leaseId");
    });

    it("11. no MissionContract authority exposed", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      const serialized = JSON.stringify(modelReq);
      expect(serialized).not.toContain("contractHash");
      expect(serialized).not.toContain("contractBinding");
    });

    it("12. no credentials exposed", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);

      const serialized = JSON.stringify(modelReq);
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("apiKey");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("credentialScopes");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Output Handling
  // --------------------------------------------------------------------------
  describe("2. Output Handling", () => {
    it("13. valid provider response becomes ActionProposal", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          proposalId: "prop-valid-1",
          toolName: "read_file",
          inputPayload: { path: "src/main.ts" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          rationale: "Reading entry point to understand code",
        }),
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ACTION_PROPOSED");
      expect(result.proposal).toBeDefined();
      const prop = result.proposal as ActionProposal;
      expect(prop.proposalId).toBe("prop-valid-1");
      expect(prop.toolName).toBe("read_file");
      expect(prop.inputPayload).toEqual({ path: "src/main.ts" });
      expect(prop.contextSnapshotHash).toBe(brainReq.contextSnapshot.contextHash);
      expect(prop.rationale).toBe("Reading entry point to understand code");
    });

    it("14. malformed JSON rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: "{ not valid json ...",
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("Failed to parse model output as JSON");
    });

    it("15. empty output rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: "   ",
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("Model returned empty output text");
    });

    it("16. invalid proposal shape rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "non_existent_tool_xyz",
          inputPayload: {},
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("not a registered tool name");
    });

    it("17. oversized proposal rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const hugeString = "x".repeat(MAX_PROPOSAL_BYTES + 1000);
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "read_file",
          inputPayload: { path: hugeString },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("exceeds maximum limit");
    });

    it("18. forbidden authority fields rejected/isolated", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "run_command",
          inputPayload: { command: "echo hi" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          capability: "COMMAND_EXECUTION", // FORBIDDEN!
          workerId: "rogue-worker", // FORBIDDEN!
        }),
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("forbidden authority field");
    });

    it("19. provider invalid response handled", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      // Invalid response: negative durationMs
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: "hello",
        finishReason: "STOP",
        durationMs: -50,
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(result.error).toContain("durationMs must be a non-negative finite number");
    });

    it("20. response usage metadata does not affect authority", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "read_file",
          inputPayload: { path: "test.txt" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 25,
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
        },
        providerMetadata: {
          systemFingerprint: "fp-12345",
          httpStatus: 200,
        },
      };

      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ACTION_PROPOSED");
      expect(result.modelMetadata?.promptTokens).toBe(120);
      expect(result.modelMetadata?.completionTokens).toBe(45);
      expect(result.modelMetadata?.totalTokens).toBe(165);
      // Authority fields are completely uninfluenced by metadata
      const prop = result.proposal as any;
      expect(prop.systemFingerprint).toBeUndefined();
      expect(prop.httpStatus).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Provider Failure Propagation
  // --------------------------------------------------------------------------
  describe("3. Provider Failure Propagation", () => {
    it("21. timeout propagates", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelRequestTimeoutError("Inference timed out after 10000ms", {
        timeoutMs: 10000,
        providerName: "fake-provider",
      });

      const brainReq = createTestBrainRequest();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow(ModelRequestTimeoutError);
    });

    it("22. cancellation propagates", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelRequestCancelledError("Inference request cancelled", {
        providerName: "fake-provider",
      });

      const brainReq = createTestBrainRequest();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow(ModelRequestCancelledError);
    });

    it("23. rate limit propagates", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelRateLimitedError("Provider rate limit reached", {
        retryAfterMs: 5000,
        providerName: "fake-provider",
      });

      const brainReq = createTestBrainRequest();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow(ModelRateLimitedError);
    });

    it("24. provider unavailable propagates", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelProviderUnavailableError("503 Service Unavailable", {
        providerName: "fake-provider",
      });

      const brainReq = createTestBrainRequest();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow(ModelProviderUnavailableError);
    });

    it("25. provider failure propagates", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelProviderError(
        "MODEL_PROVIDER_ERROR",
        "Internal upstream model failure",
        { providerName: "fake-provider" }
      );

      const brainReq = createTestBrainRequest();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow(ModelProviderError);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Retry Invariants
  // --------------------------------------------------------------------------
  describe("4. Retry Invariants", () => {
    it("26. exactly one provider invocation per propose() call", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      expect(provider.calls.length).toBe(0);

      await brain.proposeAction(brainReq);
      expect(provider.calls.length).toBe(1);
    });

    it("27. no internal retry on failure", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelProviderUnavailableError("Unavailable");

      const brainReq = createTestBrainRequest();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow();
      expect(provider.calls.length).toBe(1); // exactly one attempt, no retry
    });

    it("28. no backoff", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.errorToThrow = new ModelRateLimitedError("Rate limit");

      const brainReq = createTestBrainRequest();
      const start = Date.now();
      await expect(brain.proposeAction(brainReq)).rejects.toThrow();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500); // fails fast, zero sleep or backoff
      expect(provider.calls.length).toBe(1);
    });

    it("29. no hidden second model call on malformed output", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: "Not json",
        finishReason: "STOP",
        durationMs: 10,
      };

      const brainReq = createTestBrainRequest();
      const result = await brain.proposeAction(brainReq);

      expect(result.finishReason).toBe("ERROR");
      expect(provider.calls.length).toBe(1); // zero correction attempts
    });
  });

  // --------------------------------------------------------------------------
  // 5. Security Invariants
  // --------------------------------------------------------------------------
  describe("5. Security Invariants", () => {
    it("30. LiveAgentBrain never invokes ToolExecutionGateway", () => {
      // LiveAgentBrain does not accept or import ToolExecutionGateway
      const brain = new LiveAgentBrain({
        modelProvider: new FakeModelProvider(),
        model: "test-model",
      });
      expect((brain as any).toolGateway).toBeUndefined();
    });

    it("31. LiveAgentBrain never invokes WorkerRuntime", () => {
      const brain = new LiveAgentBrain({
        modelProvider: new FakeModelProvider(),
        model: "test-model",
      });
      expect((brain as any).workerRuntime).toBeUndefined();
    });

    it("32. LiveAgentBrain never creates Action", () => {
      const brain = new LiveAgentBrain({
        modelProvider: new FakeModelProvider(),
        model: "test-model",
      });
      expect((brain as any).createAction).toBeUndefined();
    });

    it("33. LiveAgentBrain never creates Attempt", () => {
      const brain = new LiveAgentBrain({
        modelProvider: new FakeModelProvider(),
        model: "test-model",
      });
      expect((brain as any).createAttempt).toBeUndefined();
    });

    it("34. LiveAgentBrain never mutates persistence", () => {
      const brain = new LiveAgentBrain({
        modelProvider: new FakeModelProvider(),
        model: "test-model",
      });
      expect((brain as any).stateStore).toBeUndefined();
      expect((brain as any).database).toBeUndefined();
    });

    it("35. LiveAgentBrain cannot modify MissionContract", () => {
      const brain = new LiveAgentBrain({
        modelProvider: new FakeModelProvider(),
        model: "test-model",
      });
      expect((brain as any).contractStore).toBeUndefined();
    });

    it("36. model output cannot grant capabilities", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "run_command",
          inputPayload: { command: "ls" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          capability: "ALL_CAPABILITIES_GRANTED",
        }),
        finishReason: "STOP",
        durationMs: 10,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
    });

    it("37. model output cannot change workspace", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "write_file",
          inputPayload: { path: "test.txt", content: "hi" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          workspaceRoot: "/etc/root",
        }),
        finishReason: "STOP",
        durationMs: 10,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
    });

    it("38. model output cannot change resource limits", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "run_command",
          inputPayload: { command: "ls" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          timeoutMs: 9999999,
          maxAttempts: 100,
        }),
        finishReason: "STOP",
        durationMs: 10,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Cancellation Propagation
  // --------------------------------------------------------------------------
  describe("6. Cancellation Propagation", () => {
    it("39. AbortSignal reaches ModelProviderPort", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const abortController = new AbortController();
      const brainReq = createTestBrainRequest({
        abortSignal: abortController.signal,
      });

      await brain.proposeAction(brainReq);

      expect(provider.calls.length).toBe(1);
      expect(provider.calls[0]!.abortSignal).toBe(abortController.signal);
    });

    it("40. cancellation does not become successful proposal", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const abortController = new AbortController();
      abortController.abort(); // already cancelled

      const brainReq = createTestBrainRequest({
        abortSignal: abortController.signal,
      });

      await expect(brain.proposeAction(brainReq)).rejects.toThrow(ModelRequestCancelledError);
      expect(provider.calls.length).toBe(0); // cancelled prior to dispatch
    });
  });

  // --------------------------------------------------------------------------
  // 7. End-to-End Governed Step Controller Integration (Test 41)
  // --------------------------------------------------------------------------
  describe("7. End-to-End Governed Step Controller Integration", () => {
    it("41. AgentStepController + LiveAgentBrain + FakeModelProvider completes a governed action end-to-end", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-live-brain-step-"));
      const store = new SqliteStateStore();
      const clock = new SettableClock(new Date("2026-10-13T16:00:00Z"));
      const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
      const coordinator = new RunCoordinator(store, clock);
      const workerId = "worker-live-brain-1";

      const workerRuntime = new WorkerRuntime({
        workerId,
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
      });

      const fakeProvider = new FakeModelProvider();
      const liveBrain = new LiveAgentBrain({
        modelProvider: fakeProvider,
        model: "test-reasoning-model",
      });

      const stepController = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: liveBrain,
        clock,
      });

      try {
        const task = coordinator.createTask({
          title: "Live Brain E2E Task",
          description: "Testing end to end step loop with LiveAgentBrain",
          inputPayload: { target: "test" },
        });

        createAndActivateContract(store, task.taskId, {
          contractId: "contract-live-brain",
          policy: createExecutionPolicy({
            policyId: `policy-${task.taskId}`,
            allowedCapabilities: [
              "workspace.file.read",
              "workspace.file.write",
              "workspace.code.search",
              "process.execute",
            ],
            isolationRequirement: "ISOLATED",
          }),
        });

        coordinator.registerWorker({
          workerId,
          hostname: "localhost",
          pid: 1001,
          status: "ACTIVE",
          createdAt: clock.nowIso(),
          lastHeartbeatAt: clock.nowIso(),
        });

        const { run } = coordinator.createRun({ taskId: task.taskId });
        coordinator.queueRun(run.runId);
        const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
        coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

        // Provision workspace
        const wsHandle = await workspaceAdapter.provisionWorkspace({
          workspaceId: "ws-live-brain-e2e",
          runId: run.runId,
          taskId: task.taskId,
          maxWorkspaceBytes: 10 * 1024 * 1024,
          maxFileSizeBytes: 1024 * 1024,
        });

        let stepIndex = 0;
        fakeProvider.customHandler = async (modelReq) => {
          stepIndex++;
          if (stepIndex === 1) {
            // Step 1: Model proposes write_file
            // Must bind to active contextHash from user prompt
            const prompt = modelReq.input[1]!.content;
            const hashMatch = prompt.match(/Context Snapshot Hash: ([a-f0-9]{64})/);
            const contextHash = hashMatch ? hashMatch[1] : "0".repeat(64);

            return {
              requestId: modelReq.requestId,
              model: modelReq.model,
              outputText: JSON.stringify({
                isGoalReached: false,
                proposalId: "prop-step-1",
                toolName: "write_file",
                inputPayload: { path: "hello.txt", content: "Governed Live Brain Output" },
                contextSnapshotHash: contextHash,
                rationale: "Creating target file to satisfy goal",
              }),
              finishReason: "STOP",
              durationMs: 25,
            };
          } else {
            // Step 2: Model indicates task complete
            return {
              requestId: modelReq.requestId,
              model: modelReq.model,
              outputText: JSON.stringify({
                isGoalReached: true,
              }),
              finishReason: "STOP",
              durationMs: 15,
            };
          }
        };

        const result = await stepController.runStepLoop({
          runId: run.runId,
          workerId,
          leaseId: claimResult.lease.leaseId,
          workspace: wsHandle,
          budget: { maxSteps: 5, maxActions: 5 },
        });

        expect(result.terminalReason).toBe("COMPLETED");
        expect(result.totalSteps).toBe(2);
        expect(result.totalActions).toBe(1);
        expect(result.transcript.length).toBe(2);

        // Verify physical file was created in governed workspace
        const targetFile = await workspaceAdapter.resolvePath(wsHandle.workspaceId, "hello.txt");
        expect(fs.existsSync(targetFile)).toBe(true);
        expect(fs.readFileSync(targetFile, "utf8")).toBe("Governed Live Brain Output");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // 8. Adversarial Authority Rejection Negative Test (Test 42)
  // --------------------------------------------------------------------------
  describe("8. Adversarial Authority Rejection Negative Test", () => {
    it("42. proposal with injected authority fields rejected without becoming trusted execution state", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-adversarial-1",
        model: "test-model-1",
        outputText: JSON.stringify({
          toolName: "run_command",
          input: { argv: ["echo", "hello"] },
          capability: "COMMAND_EXECUTION",
          workspaceRoot: "/",
          contractId: "attacker-controlled",
          workerId: "attacker-controlled",
          retryCount: 999,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      // 1. LiveAgentBrain rejects the forbidden authority fields
      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("forbidden authority field");

      // 2. ProposalValidator also independently rejects the payload at Stage 2
      const rawAdversarialPayload = JSON.parse(provider.responseToReturn.outputText);
      const validator = new ProposalValidator();
      const validationResult = validator.validate(rawAdversarialPayload, {
        runId: brainReq.runId,
        contextSnapshot: brainReq.contextSnapshot,
      });

      expect(validationResult.valid).toBe(false);
      if (!validationResult.valid) {
        expect(validationResult.reason).toBe("FORBIDDEN_AUTHORITY_FIELD");
        expect(validationResult.violations).toBeDefined();
        expect(validationResult.violations).toContain("capability");
        expect(validationResult.violations).toContain("workspaceRoot");
        expect(validationResult.violations).toContain("contractId");
        expect(validationResult.violations).toContain("workerId");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 9. Phase 10D Discriminated Union Structured-Output Verification
  // --------------------------------------------------------------------------
  describe("9. Phase 10D Discriminated Union Structured-Output Verification", () => {
    it("43. ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA defines strict anyOf discriminated union", () => {
      const schema = ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA.jsonSchema as any;
      expect(schema.anyOf).toBeDefined();
      expect(Array.isArray(schema.anyOf)).toBe(true);
      expect(schema.anyOf.length).toBe(7);

      // Branch 1: GoalReachedProposal
      const goalBranch = schema.anyOf[0];
      expect(goalBranch.type).toBe("object");
      expect(goalBranch.properties.isGoalReached.enum).toEqual([true]);
      expect(goalBranch.required).toEqual([
        "isGoalReached",
        "proposalId",
        "contextSnapshotHash",
      ]);
      expect(goalBranch.additionalProperties).toBe(false);
      expect(goalBranch.properties.toolName).toBeUndefined();
      expect(goalBranch.properties.inputPayload).toBeUndefined();

      // Branches 2-7: ToolActionProposals per tool
      const toolBranches = schema.anyOf.slice(1);
      expect(toolBranches.length).toBe(6);

      for (const branch of toolBranches) {
        expect(branch.type).toBe("object");
        expect(branch.properties.isGoalReached.enum).toEqual([false]);
        expect(branch.required).toEqual([
          "isGoalReached",
          "proposalId",
          "toolName",
          "inputPayload",
          "contextSnapshotHash",
        ]);
        expect(branch.additionalProperties).toBe(false);
        expect(branch.properties.toolName.enum).toBeDefined();
        expect(branch.properties.inputPayload.type).toBe("object");
        expect(branch.properties.inputPayload.additionalProperties).toBe(false);
      }

      // Check specific tool constraints
      const readBranch = toolBranches.find((b: any) => b.properties.toolName.enum[0] === "read_file");
      expect(readBranch).toBeDefined();
      expect(readBranch.properties.inputPayload.properties.path).toBeDefined();
      expect(readBranch.properties.inputPayload.properties.filePath).toBeUndefined();
      expect(readBranch.properties.inputPayload.required).toEqual(["path"]);

      const writeBranch = toolBranches.find((b: any) => b.properties.toolName.enum[0] === "write_file");
      expect(writeBranch).toBeDefined();
      expect(writeBranch.properties.inputPayload.properties.content).toBeDefined();
      expect(writeBranch.properties.inputPayload.required).toEqual(["path", "content"]);
    });

    it("44. valid goal-completion proposal returns GOAL_REACHED", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-goal-valid",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: true,
          proposalId: "prop-goal-1",
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          rationale: "Task objective has been fully satisfied.",
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("GOAL_REACHED");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("45. valid tool-action proposal returns ACTION_PROPOSED with candidate proposal", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-tool-valid",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          proposalId: "prop-tool-1",
          toolName: "read_file",
          inputPayload: { path: "src/main.ts" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          rationale: "Inspecting entry point",
        }),
        finishReason: "STOP",
        durationMs: 20,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ACTION_PROPOSED");
      expect(result.proposal).toBeDefined();
      const prop = result.proposal as ActionProposal;
      expect(prop.toolName).toBe("read_file");
      expect(prop.inputPayload).toEqual({ path: "src/main.ts" });
    });

    it("46. contaminated goal proposal (isGoalReached: true with toolName) rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-goal-contam-toolname",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: true,
          proposalId: "prop-goal-contam-1",
          toolName: "read_file",
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain(
        "Goal-reached proposal cannot contain tool action fields"
      );
    });

    it("47. contaminated goal proposal (isGoalReached: true with inputPayload) rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-goal-contam-payload",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: true,
          proposalId: "prop-goal-contam-2",
          inputPayload: { path: "test.txt" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain(
        "Goal-reached proposal cannot contain tool action fields"
      );
    });

    it("48. incomplete tool proposal (isGoalReached: false without toolName) rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-tool-missing-name",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          proposalId: "prop-tool-incomp-1",
          inputPayload: { path: "src/index.ts" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("missing or not a registered tool name");
    });

    it("49. incomplete tool proposal (isGoalReached: false without inputPayload) rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-tool-missing-input",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          proposalId: "prop-tool-incomp-2",
          toolName: "read_file",
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("Proposal inputPayload must be a non-null object");
    });

    it("50. authority injection attempt on goal branch rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-goal-auth-injection",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: true,
          proposalId: "prop-goal-auth-1",
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          workerId: "attacker-worker",
          contractId: "unauthorized-contract",
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("forbidden authority field");
    });

    it("51. authority injection attempt on tool branch rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-tool-auth-injection",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          proposalId: "prop-tool-auth-1",
          toolName: "read_file",
          inputPayload: { path: "test.txt" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          capability: "COMMAND_EXECUTION",
          workspaceRoot: "/root",
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("forbidden authority field");
    });

    it("52. oversized payload on goal branch rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-goal-oversized",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: true,
          proposalId: "prop-goal-huge",
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
          extraPadding: "x".repeat(MAX_PROPOSAL_BYTES + 100),
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("exceeds maximum limit");
    });

    it("53. oversized payload on tool branch rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-tool-oversized",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: false,
          proposalId: "prop-tool-huge",
          toolName: "read_file",
          inputPayload: { path: "x".repeat(MAX_PROPOSAL_BYTES + 100) },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain("exceeds maximum limit");
    });

    it("54. missing isGoalReached discriminator rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-missing-discrim",
        model: "test-model-1",
        outputText: JSON.stringify({
          proposalId: "prop-no-discrim",
          toolName: "read_file",
          inputPayload: { path: "src/index.ts" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain(
        "missing required boolean discriminator 'isGoalReached'"
      );
    });

    it("55. non-boolean isGoalReached discriminator rejected", async () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      provider.responseToReturn = {
        requestId: "req-non-bool-discrim",
        model: "test-model-1",
        outputText: JSON.stringify({
          isGoalReached: "true",
          proposalId: "prop-str-discrim",
          toolName: "read_file",
          inputPayload: { path: "src/index.ts" },
          contextSnapshotHash: brainReq.contextSnapshot.contextHash,
        }),
        finishReason: "STOP",
        durationMs: 15,
      };

      const result = await brain.proposeAction(brainReq);
      expect(result.finishReason).toBe("ERROR");
      expect(result.proposal).toBeUndefined();
      expect(result.error).toContain(
        "missing required boolean discriminator 'isGoalReached'"
      );
    });
  });

  // --------------------------------------------------------------------------
  // 13. Task-Context Contract & Progression Guidance (Phase 45B)
  // --------------------------------------------------------------------------
  describe("13. Task-Context Contract & Progression Guidance (Phase 45B)", () => {
    it("56. includes Task Title and Task Objective & Criteria in prompt when MISSION_CONTEXT contains taskDetails", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const missionObs = {
        observationId: "obs-mission-contract",
        category: "MISSION_CONTEXT" as const,
        provenance: {
          entityKind: "MissionContract" as const,
          entityId: "contract-eaf-bm-01",
          runId: "run-test-1",
          timestamp: "2026-10-26T12:00:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        freshness: "CURRENT" as const,
        priority: 90,
        content: {
          contractId: "contract-eaf-bm-01",
          taskDetails: {
            title: "Core Arithmetic Off-by-One Fix",
            description: [
              "Task: Core Arithmetic Off-by-One Fix",
              "Category: CODE_NAVIGATION",
              "Target File: src/calc.js",
              "Allowed Modification Scope: src/calc.js",
              "Objective: Repair the defect in 'src/calc.js'.",
              "Verification Criteria:",
              "- Verification test 'node test/f2p.test.js' must pass with exit code 0.",
              "- Regression test 'node test/p2p.test.js' must pass with exit code 0.",
            ].join("\n"),
            inputPayload: {
              taskId: "EAF-BM-01",
              targetFile: "src/calc.js",
            },
          },
        },
        contentHash: "c".repeat(64),
        estimatedTokens: 60,
        estimatedBytes: 240,
        isMandatory: true,
      };

      const baseReq = createTestBrainRequest();
      const brainReq: AgentBrainRequest = {
        ...baseReq,
        contextSnapshot: {
          ...baseReq.contextSnapshot,
          observations: [...baseReq.contextSnapshot.observations, missionObs],
        },
      };

      const modelReq = brain.buildModelRequest(brainReq);
      const userContent = modelReq.input[1]!.content;

      expect(userContent).toContain("- Task Title: Core Arithmetic Off-by-One Fix");
      expect(userContent).toContain("### Task Objective & Criteria");
      expect(userContent).toContain("Target File: src/calc.js");
      expect(userContent).toContain("Verification test 'node test/f2p.test.js' must pass with exit code 0.");
      expect(userContent).toContain("Regression test 'node test/p2p.test.js' must pass with exit code 0.");
    });

    it("57. preserves baseline prompt structure when MISSION_CONTEXT has generic navigation task without description", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const missionObs = {
        observationId: "obs-mission-generic",
        category: "MISSION_CONTEXT" as const,
        provenance: {
          entityKind: "MissionContract" as const,
          entityId: "contract-generic",
          runId: "run-test-1",
          timestamp: "2026-10-26T12:00:00.000Z",
          isAuthoritativeRuntimeFact: true,
        },
        freshness: "CURRENT" as const,
        priority: 90,
        content: {
          contractId: "contract-generic",
          taskDetails: {
            title: "Generic Navigation Task",
            description: "",
          },
        },
        contentHash: "d".repeat(64),
        estimatedTokens: 20,
        estimatedBytes: 80,
        isMandatory: true,
      };

      const baseReq = createTestBrainRequest();
      const brainReq: AgentBrainRequest = {
        ...baseReq,
        contextSnapshot: {
          ...baseReq.contextSnapshot,
          observations: [...baseReq.contextSnapshot.observations, missionObs],
        },
      };

      const modelReq = brain.buildModelRequest(brainReq);
      const userContent = modelReq.input[1]!.content;

      expect(userContent).toContain("- Task Title: Generic Navigation Task");
      expect(userContent).not.toContain("### Task Objective & Criteria");
      expect(userContent).not.toContain("Repair the defect");
    });

    it("58. preserves baseline prompt structure when MISSION_CONTEXT is absent", () => {
      const provider = new FakeModelProvider();
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "test-model-1",
      });

      const brainReq = createTestBrainRequest();
      const modelReq = brain.buildModelRequest(brainReq);
      const userContent = modelReq.input[1]!.content;

      expect(userContent).not.toContain("Task Title:");
      expect(userContent).not.toContain("### Task Objective & Criteria");
      expect(modelReq.generation?.structuredOutput?.name).toBe("action_proposal");
    });
  });
});
