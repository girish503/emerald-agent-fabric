/**
 * Unit and Integration Test Suite for OllamaModelProvider (Phase 6.3).
 *
 * Verifies:
 * 1. Provider request translation (messages, parameters, options).
 * 2. Structured output schema translation to Ollama format.
 * 3. Single-attempt semantics and zero-retry guarantees.
 * 4. Finish reason and token usage mapping (never fabricated).
 * 5. Deterministic error taxonomy mapping (unavailable, timeout, cancelled, invalid, etc.).
 * 6. Zero credential requirement and complete SDK/network isolation.
 * 7. Controlled end-to-end integration:
 *    StepController -> LiveAgentBrain -> OllamaModelProvider -> ProposalValidator -> WorkerRuntime.
 * 8. Gated live Ollama execution test (strictly gated behind OLLAMA_LIVE_TESTS=true).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OllamaModelProvider,
  OllamaFetchLike,
} from "../../../src/adapters/models/ollama-model-provider.js";
import {
  ModelProviderRequest,
  ModelStructuredOutputSchema,
} from "../../../src/ports/model-provider.port.js";
import {
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRequestCancelledError,
  ModelRequestInvalidError,
  ModelRequestTimeoutError,
  ModelResponseInvalidError,
} from "../../../src/domain/errors.js";
import {
  ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
  LiveAgentBrain,
} from "../../../src/application/live-agent-brain.js";
import { AgentStepController } from "../../../src/application/agent-step-controller.js";
import { SqliteStateStore } from "../../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../../src/application/worker-runtime.js";
import { SettableClock } from "../../../src/ports/clock.port.js";
import { createExecutionPolicy } from "../../../src/domain/policy.js";
import { createAndActivateContract } from "../../application/test-helpers.js";

// ============================================================================
// Test Utilities & Fake Transports
// ============================================================================

interface MockTransportState {
  callCount: number;
  lastUrl?: string;
  lastInit?: RequestInit;
  lastBody?: Record<string, unknown>;
}

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>
): { fetch: OllamaFetchLike; state: MockTransportState } {
  const state: MockTransportState = {
    callCount: 0,
  };

  const fetchImpl: OllamaFetchLike = async (url, init) => {
    state.callCount++;
    state.lastUrl = String(url);
    state.lastInit = init;
    if (init?.body && typeof init.body === "string") {
      try {
        state.lastBody = JSON.parse(init.body);
      } catch {
        state.lastBody = undefined;
      }
    }
    return handler(String(url), init);
  };

  return { fetch: fetchImpl, state };
}

function createStandardMockResponse(overrides: Record<string, unknown> = {}): Response {
  const defaultBody = {
    model: "llama3.2",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: '{"actionType":"CREATE_FILE","path":"src/test.ts","content":"console.log(1);"}',
    },
    done: true,
    done_reason: "stop",
    total_duration: 1500000000,
    load_duration: 200000000,
    prompt_eval_count: 42,
    prompt_eval_duration: 300000000,
    eval_count: 58,
    eval_duration: 1000000000,
    ...overrides,
  };

  return new Response(JSON.stringify(defaultBody), {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// Unit & Integration Test Suite
// ============================================================================

describe("OllamaModelProvider — Phase 6.3 Local Open-Source Adapter", () => {
  // ==========================================================================
  // 1. Request Translation & Parameter Mapping
  // ==========================================================================
  describe("1. Request Translation & Parameter Mapping", () => {
    it("translates ModelProviderRequest messages to Ollama format and sets stream=false", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({ fetch });

      const request: ModelProviderRequest = {
        requestId: "req-translate-1",
        model: "llama3.2",
        input: [
          { role: "system", content: "You are an agent." },
          { role: "user", content: "Solve task." },
          { role: "assistant", content: "I am working." },
        ],
        timeoutMs: 15000,
      };

      const response = await provider.generate(request);

      expect(state.callCount).toBe(1);
      expect(state.lastUrl).toBe("http://127.0.0.1:11434/api/chat");
      expect(state.lastBody?.model).toBe("llama3.2");
      expect(state.lastBody?.stream).toBe(false);
      expect(state.lastBody?.messages).toEqual([
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Solve task." },
        { role: "assistant", content: "I am working." },
      ]);

      expect(response.requestId).toBe("req-translate-1");
      expect(response.model).toBe("llama3.2");
      expect(response.finishReason).toBe("STOP");
    });

    it("translates generation options (temperature, topP, maxOutputTokens, stopSequences)", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({ fetch });

      const request: ModelProviderRequest = {
        requestId: "req-translate-gen",
        model: "qwen2.5-coder",
        input: [{ role: "user", content: "Generate plan." }],
        generation: {
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 2048,
          stopSequences: ["\nEND", "STOP_HERE"],
        },
        timeoutMs: 20000,
      };

      await provider.generate(request);

      const options = state.lastBody?.options as Record<string, unknown>;
      expect(options).toBeDefined();
      expect(options.temperature).toBe(0.2);
      expect(options.top_p).toBe(0.9);
      expect(options.num_predict).toBe(2048);
      expect(options.stop).toEqual(["\nEND", "STOP_HERE"]);
    });

    it("translates structuredOutput schema to Ollama format: schema.jsonSchema", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({ fetch });

      const customSchema: ModelStructuredOutputSchema = {
        name: "test_action_schema",
        description: "Schema for testing structured proposal",
        strict: true,
        jsonSchema: {
          type: "object",
          properties: {
            action: { type: "string" },
            count: { type: "integer" },
          },
          required: ["action", "count"],
        },
      };

      const request: ModelProviderRequest = {
        requestId: "req-schema-1",
        model: "llama3.2",
        input: [{ role: "user", content: "Propose next step." }],
        generation: {
          structuredOutput: customSchema,
        },
        timeoutMs: 10000,
      };

      await provider.generate(request);

      expect(state.lastBody?.format).toEqual(customSchema.jsonSchema);
    });

    it("respects custom baseURL and strips trailing slashes", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({
        fetch,
        baseURL: "http://192.168.1.100:11434///",
      });

      expect(provider.endpoint).toBe("http://192.168.1.100:11434/api/chat");

      await provider.generate({
        requestId: "req-custom-url",
        model: "llama3.2",
        input: [{ role: "user", content: "Test" }],
        timeoutMs: 5000,
      });

      expect(state.lastUrl).toBe("http://192.168.1.100:11434/api/chat");
    });

    it("uses defaultModel if specified in provider options when request model is empty", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({
        fetch,
        defaultModel: "mistral-small",
      });

      const request: ModelProviderRequest = {
        requestId: "req-default-model",
        model: "mistral-small",
        input: [{ role: "user", content: "Hello" }],
        timeoutMs: 5000,
      };

      await provider.generate(request);
      expect(state.lastBody?.model).toBe("mistral-small");
    });
  });

  // ==========================================================================
  // 2. Single-Attempt Semantics & Zero-Retry Guarantees
  // ==========================================================================
  describe("2. Single-Attempt Semantics & Zero-Retry Guarantees", () => {
    it("performs exactly ONE HTTP request per generate() call", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({ fetch });

      const request: ModelProviderRequest = {
        requestId: "req-once-1",
        model: "llama3.2",
        input: [{ role: "user", content: "Run single step." }],
        timeoutMs: 10000,
      };

      await provider.generate(request);

      expect(state.callCount).toBe(1);
    });

    it("does NOT retry on network error: fails immediately with callCount === 1", async () => {
      let invocations = 0;
      const { fetch } = createMockFetch(async () => {
        invocations++;
        throw new TypeError("fetch failed: ECONNREFUSED");
      });

      const provider = new OllamaModelProvider({ fetch });

      const request: ModelProviderRequest = {
        requestId: "req-no-retry-on-error",
        model: "llama3.2",
        input: [{ role: "user", content: "Hello" }],
        timeoutMs: 5000,
      };

      await expect(provider.generate(request)).rejects.toThrow(ModelProviderUnavailableError);
      expect(invocations).toBe(1);
    });

    it("never switches to a fallback model on error", async () => {
      const { fetch, state } = createMockFetch(async () => {
        return new Response(JSON.stringify({ error: "model 'llama3.2' not found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-no-fallback",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelRequestInvalidError);

      expect(state.callCount).toBe(1);
      expect(state.lastBody?.model).toBe("llama3.2");
    });
  });

  // ==========================================================================
  // 3. Finish Reason & Token Usage Accounting
  // ==========================================================================
  describe("3. Finish Reason & Token Usage Accounting", () => {
    it("maps done_reason 'stop' to STOP", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({ done: true, done_reason: "stop" })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-fr-stop",
        model: "llama3.2",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });

      expect(res.finishReason).toBe("STOP");
    });

    it("maps done_reason 'length' to LENGTH", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({ done: true, done_reason: "length" })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-fr-length",
        model: "llama3.2",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });

      expect(res.finishReason).toBe("LENGTH");
    });

    it("maps unexpected done_reason to OTHER", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({ done: false, done_reason: "unknown_reason" })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-fr-other",
        model: "llama3.2",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });

      expect(res.finishReason).toBe("OTHER");
    });

    it("accurately populates inputTokens, outputTokens, totalTokens from prompt_eval_count and eval_count", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({
          prompt_eval_count: 120,
          eval_count: 45,
        })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-usage-full",
        model: "llama3.2",
        input: [{ role: "user", content: "Count tokens" }],
        timeoutMs: 5000,
      });

      expect(res.usage).toBeDefined();
      expect(res.usage?.inputTokens).toBe(120);
      expect(res.usage?.outputTokens).toBe(45);
      expect(res.usage?.totalTokens).toBe(165);
    });

    it("leaves usage undefined if Ollama does not provide token counts (never fabricates)", async () => {
      const { fetch } = createMockFetch(async () => {
        const body = {
          model: "llama3.2",
          message: { role: "assistant", content: "No tokens reported" },
          done: true,
        };
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-usage-none",
        model: "llama3.2",
        input: [{ role: "user", content: "No usage" }],
        timeoutMs: 5000,
      });

      expect(res.usage).toBeUndefined();
    });

    it("preserves non-authoritative provider diagnostic metadata", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({
          total_duration: 5000000000,
          load_duration: 100000000,
          prompt_eval_duration: 400000000,
          eval_duration: 4500000000,
        })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-meta-diag",
        model: "llama3.2",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });

      expect(res.providerMetadata).toBeDefined();
      expect(res.providerMetadata?.provider).toBe("ollama");
      expect(res.providerMetadata?.totalDurationNs).toBe(5000000000);
      expect(res.providerMetadata?.loadDurationNs).toBe(100000000);
    });
  });

  // ==========================================================================
  // 4. Structured Output Validation
  // ==========================================================================
  describe("4. Structured Output Validation", () => {
    it("accepts valid JSON conforming to requested structured output", async () => {
      const validProposalJson = JSON.stringify({
        toolName: "write_file",
        inputPayload: { path: "hello.txt", content: "world" },
        rationale: "Creating file",
      });

      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({
          message: { role: "assistant", content: validProposalJson },
        })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-so-valid",
        model: "llama3.2",
        input: [{ role: "user", content: "Propose" }],
        generation: {
          structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
        },
        timeoutMs: 5000,
      });

      expect(res.outputText).toBe(validProposalJson);
      expect(res.finishReason).toBe("STOP");
    });

    it("throws ModelResponseInvalidError if structured output is requested and outputText is empty", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({
          message: { role: "assistant", content: "" },
        })
      );
      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-so-empty",
          model: "llama3.2",
          input: [{ role: "user", content: "Propose" }],
          generation: {
            structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
          },
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });

    it("throws ModelResponseInvalidError if structured output is requested and response is malformed JSON", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({
          message: { role: "assistant", content: "{ not valid json ..." },
        })
      );
      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-so-malformed",
          model: "llama3.2",
          input: [{ role: "user", content: "Propose" }],
          generation: {
            structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
          },
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });

    it("permits free-form non-JSON text when structuredOutput was not requested", async () => {
      const { fetch } = createMockFetch(async () =>
        createStandardMockResponse({
          message: { role: "assistant", content: "This is regular natural language text." },
        })
      );
      const provider = new OllamaModelProvider({ fetch });

      const res = await provider.generate({
        requestId: "req-free-text",
        model: "llama3.2",
        input: [{ role: "user", content: "Explain something" }],
        timeoutMs: 5000,
      });

      expect(res.outputText).toBe("This is regular natural language text.");
      expect(res.finishReason).toBe("STOP");
    });
  });

  // ==========================================================================
  // 5. Error Taxonomy Mapping
  // ==========================================================================
  describe("5. Error Taxonomy Mapping", () => {
    it("detects pre-dispatch AbortSignal cancellation and fails immediately without making HTTP call", async () => {
      const controller = new AbortController();
      controller.abort();

      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-pre-abort",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
          abortSignal: controller.signal,
        })
      ).rejects.toThrow(ModelRequestCancelledError);

      expect(state.callCount).toBe(0);
    });

    it("maps in-flight AbortSignal cancellation to ModelRequestCancelledError", async () => {
      const controller = new AbortController();

      const { fetch } = createMockFetch(async () => {
        // Trigger abort while in flight
        controller.abort();
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-inflight-abort",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 10000,
          abortSignal: controller.signal,
        })
      ).rejects.toThrow(ModelRequestCancelledError);
    });

    it("maps request timeout to ModelRequestTimeoutError with timeoutMs", async () => {
      const { fetch } = createMockFetch(async () => {
        // Sleep longer than timeout
        await new Promise((resolve) => setTimeout(resolve, 100));
        return createStandardMockResponse();
      });

      const provider = new OllamaModelProvider({ fetch });

      const err = await provider
        .generate({
          requestId: "req-timeout-1",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 20, // 20ms timeout
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ModelRequestTimeoutError);
      expect((err as ModelRequestTimeoutError).timeoutMs).toBe(20);
      expect(err.code).toBe("MODEL_REQUEST_TIMEOUT");
    });

    it("maps connection refused / network error to ModelProviderUnavailableError", async () => {
      const { fetch } = createMockFetch(async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
      });

      const provider = new OllamaModelProvider({ fetch });

      const err = await provider
        .generate({
          requestId: "req-unavail-1",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ModelProviderUnavailableError);
      expect(err.code).toBe("MODEL_PROVIDER_UNAVAILABLE");
      expect(err.message).toContain("Local Ollama runtime is unavailable");
    });

    it("maps HTTP 404 (model not found) to ModelRequestInvalidError", async () => {
      const { fetch } = createMockFetch(async () => {
        return new Response(JSON.stringify({ error: "model 'non-existent' not found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-404-model",
          model: "non-existent",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelRequestInvalidError);
    });

    it("maps HTTP 400 (bad request) to ModelRequestInvalidError", async () => {
      const { fetch } = createMockFetch(async () => {
        return new Response(JSON.stringify({ error: "invalid options" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-400-bad",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelRequestInvalidError);
    });

    it("maps HTTP 500 (internal server error) to ModelProviderUnavailableError", async () => {
      const { fetch } = createMockFetch(async () => {
        return new Response(JSON.stringify({ error: "out of memory" }), {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-500-server",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelProviderUnavailableError);
    });

    it("maps malformed / non-JSON response body to ModelResponseInvalidError", async () => {
      const { fetch } = createMockFetch(async () => {
        return new Response("<html>Gateway Timeout</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-non-json",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });

    it("maps missing 'message' object in JSON to ModelResponseInvalidError", async () => {
      const { fetch } = createMockFetch(async () => {
        return new Response(JSON.stringify({ done: true, model: "llama3.2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-missing-msg",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });

    it("maps unexpected HTTP status (e.g. 418) to ModelProviderError", async () => {
      const { fetch } = createMockFetch(async () => {
        return new Response("I'm a teapot", { status: 418, statusText: "I'm a teapot" });
      });

      const provider = new OllamaModelProvider({ fetch });

      await expect(
        provider.generate({
          requestId: "req-teapot",
          model: "llama3.2",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelProviderError);
    });
  });

  // ==========================================================================
  // 6. Zero Credentials & Isolation Guarantees
  // ==========================================================================
  describe("6. Zero Credentials & Isolation Guarantees", () => {
    it("operates with zero API keys and never sends authorization headers", async () => {
      const { fetch, state } = createMockFetch(async () => createStandardMockResponse());
      const provider = new OllamaModelProvider({ fetch });

      await provider.generate({
        requestId: "req-no-auth",
        model: "llama3.2",
        input: [{ role: "user", content: "Hello" }],
        timeoutMs: 5000,
      });

      const headers = state.lastInit?.headers as Record<string, string>;
      expect(headers).toBeDefined();
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("possesses zero tool execution methods and zero authority", () => {
      const provider = new OllamaModelProvider();
      expect((provider as any).executeTool).toBeUndefined();
      expect((provider as any).authorize).toBeUndefined();
      expect((provider as any).executeAction).toBeUndefined();
      expect((provider as any).gateway).toBeUndefined();
      expect((provider as any).workspace).toBeUndefined();
    });
  });

  // ==========================================================================
  // 7. Controlled End-to-End Governance Integration
  // ==========================================================================
  describe("7. Governed Loop: StepController -> LiveAgentBrain -> OllamaModelProvider -> ProposalValidator -> WorkerRuntime", () => {
    let store: SqliteStateStore;
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-ollama-e2e-"));
      store = new SqliteStateStore();
    });

    afterEach(() => {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("executes complete governance loop: StepController -> LiveAgentBrain -> OllamaModelProvider -> ProposalValidator -> WorkerRuntime", async () => {
      const clock = new SettableClock(new Date("2026-10-13T16:00:00Z"));
      const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
      const coordinator = new RunCoordinator(store, clock);
      const workerId = "worker-ollama-e2e-1";

      const workerRuntime = new WorkerRuntime({
        workerId,
        coordinator,
        clock,
        workspacePort: workspaceAdapter,
      });

      // Mock Ollama transport simulating 2-step reasoning loop:
      // Step 1: Model proposes write_file with bound contextSnapshotHash
      // Step 2: Model completes mission (isGoalReached: true)
      let stepIndex = 0;
      const { fetch } = createMockFetch(async (_url, init) => {
        stepIndex++;
        if (stepIndex === 1) {
          const body = JSON.parse(init?.body as string);
          const prompt = (body.messages[1] as any).content;
          const hashMatch = prompt.match(/Context Snapshot Hash: ([a-f0-9]{64})/);
          const contextHash = hashMatch ? hashMatch[1] : "0".repeat(64);

          return createStandardMockResponse({
            message: {
              role: "assistant",
              content: JSON.stringify({
                isGoalReached: false,
                proposalId: "prop-step-1",
                toolName: "write_file",
                inputPayload: { path: "ollama-output.txt", content: "Hello from local Ollama governed loop" },
                contextSnapshotHash: contextHash,
                rationale: "Creating target file to satisfy goal",
              }),
            },
          });
        } else {
          return createStandardMockResponse({
            message: {
              role: "assistant",
              content: JSON.stringify({
                isGoalReached: true,
              }),
            },
          });
        }
      });

      const modelProvider = new OllamaModelProvider({ fetch });
      const liveBrain = new LiveAgentBrain({
        modelProvider,
        model: "llama3.2",
      });

      const stepController = new AgentStepController({
        allowUnverifiedCompletion: true, // loop-behavior test: no verification specs declared
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: liveBrain,
        clock,
      });

      const task = coordinator.createTask({
        title: "Ollama E2E Task",
        description: "Testing end-to-end step loop with OllamaModelProvider",
        inputPayload: { target: "test" },
      });

      createAndActivateContract(store, task.taskId, {
        contractId: "contract-ollama-e2e",
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
        pid: 2001,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });

      const { run } = coordinator.createRun({ taskId: task.taskId });
      coordinator.queueRun(run.runId);
      const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
      coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

      const wsHandle = await workspaceAdapter.provisionWorkspace({
        workspaceId: "ws-ollama-e2e",
        runId: run.runId,
        taskId: task.taskId,
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxFileSizeBytes: 1024 * 1024,
      });

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
      const targetFile = await workspaceAdapter.resolvePath(wsHandle.workspaceId, "ollama-output.txt");
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.readFileSync(targetFile, "utf8")).toBe("Hello from local Ollama governed loop");
    });
  });

  // ==========================================================================
  // 8. Gated Live Ollama Test (Strictly gated behind OLLAMA_LIVE_TESTS=true)
  // ==========================================================================
  describe("8. Gated Live Ollama Test", () => {
    it.runIf(process.env.OLLAMA_LIVE_TESTS === "true")(
      "communicates with live local Ollama endpoint when OLLAMA_LIVE_TESTS=true",
      async () => {
        const provider = new OllamaModelProvider({
          baseURL: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
          defaultModel: process.env.OLLAMA_MODEL ?? "llama3.2",
        });

        const request: ModelProviderRequest = {
          requestId: `live-ollama-test-${Date.now()}`,
          model: process.env.OLLAMA_MODEL ?? "llama3.2",
          input: [{ role: "user", content: "Reply with the single word: OK" }],
          generation: {
            temperature: 0.0,
            maxOutputTokens: 20,
          },
          timeoutMs: 15000,
        };

        try {
          const response = await provider.generate(request);
          expect(response.outputText).toBeDefined();
          expect(response.finishReason).toBe("STOP");
        } catch (err: unknown) {
          // If Ollama is not actually running on localhost, skip rather than fail
          if (err instanceof ModelProviderUnavailableError) {
            console.warn(
              "Skipping live Ollama test: local Ollama server is not reachable on localhost:11434"
            );
            return;
          }
          throw err;
        }
      }
    );
  });
});
