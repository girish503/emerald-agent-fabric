/**
 * Unit and Integration Test Suite for OpenAIModelProvider (Phase 6.3).
 *
 * Verifies:
 * 1. Request translation (messages, model, generation options, structured output schema, timeout, signal).
 * 2. Single-attempt semantics and zero-retry guarantee (maxRetries: 0, exactly one call).
 * 3. Response and usage mapping (finish reasons, output text, token counts, metadata).
 * 4. Structured output validation (rejects malformed/empty JSON on STOP).
 * 5. Error taxonomy mapping (timeout, cancellation, rate limiting, invalid request, output limit, provider unavailable).
 * 6. Secret safety and credential isolation (redaction, unconfigured key fail-closed).
 * 7. Controlled end-to-end integration (AgentStepController -> LiveAgentBrain -> OpenAIModelProvider -> ProposalValidator -> WorkerRuntime).
 * 8. Security regressions (model cannot authorize, execute tools, alter contracts or workspaces).
 * 9. Opt-in live provider test (100% offline during normal test suite execution).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import {
  OpenAIClientLike,
  OpenAIModelProvider,
} from "../../../src/adapters/models/openai-model-provider.js";
import {
  ModelFinishReason,
  ModelProviderRequest,
  ModelStructuredOutputSchema,
} from "../../../src/domain/model-provider.js";
import {
  ModelOutputLimitExceededError,
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRateLimitedError,
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
import { ProposalValidator } from "../../../src/application/proposal-validator.js";
import { WorkerRuntime } from "../../../src/application/worker-runtime.js";
import { RunCoordinator } from "../../../src/application/run-coordinator.js";
import { SqliteStateStore } from "../../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SettableClock } from "../../../src/ports/clock.port.js";
import { staticToolRegistry } from "../../../src/domain/tool.js";
import { createExecutionPolicy } from "../../../src/domain/policy.js";
import { DEFAULT_CONTEXT_BUDGET } from "../../../src/domain/context.js";
import { createAndActivateContract } from "../../application/test-helpers.js";

// ============================================================================
// Mock Client Factory
// ============================================================================

interface MockTransportState {
  callCount: number;
  lastBody?: Record<string, unknown>;
  lastOptions?: {
    signal?: AbortSignal;
    timeout?: number;
    maxRetries?: number;
  };
}

function createMockClient(
  handler: (
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }
  ) => Promise<unknown>
): { client: OpenAIClientLike; state: MockTransportState } {
  const state: MockTransportState = {
    callCount: 0,
  };

  const client: OpenAIClientLike = {
    chat: {
      completions: {
        async create(body, options) {
          state.callCount++;
          state.lastBody = body;
          state.lastOptions = options;
          return handler(body, options);
        },
      },
    },
  };

  return { client, state };
}

function createStandardMockResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-mock-test-123",
    object: "chat.completion",
    created: 1728800000,
    model: "gpt-4o-2024-08-06",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: '{"isGoalReached": true}',
          refusal: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 35,
      total_tokens: 155,
    },
    system_fingerprint: "fp_mock_456",
    service_tier: "default",
    ...overrides,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("OpenAIModelProvider — Phase 6.3 Adapter Implementation", () => {
  // ==========================================================================
  // 1. Request Translation
  // ==========================================================================
  describe("1. Request Translation", () => {
    it("translates ModelProviderRequest messages, model, and timeout correctly", async () => {
      const { client, state } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({ client });

      const request: ModelProviderRequest = {
        requestId: "req-translate-1",
        model: "gpt-4o",
        input: [
          { role: "system", content: "You are an agent." },
          { role: "user", content: "Solve task.", name: "user_alice" },
          { role: "assistant", content: "I am working." },
        ],
        timeoutMs: 15000,
      };

      const response = await provider.generate(request);

      expect(state.callCount).toBe(1);
      expect(state.lastBody?.model).toBe("gpt-4o");
      expect(state.lastBody?.messages).toEqual([
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Solve task.", name: "user_alice" },
        { role: "assistant", content: "I am working." },
      ]);
      expect(state.lastOptions?.timeout).toBe(15000);
      expect(state.lastOptions?.maxRetries).toBe(0);

      expect(response.requestId).toBe("req-translate-1");
      expect(response.model).toBe("gpt-4o-2024-08-06");
      expect(response.finishReason).toBe("STOP");
    });

    it("translates generation options (temperature, topP, maxOutputTokens, stopSequences)", async () => {
      const { client, state } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({ client });

      const request: ModelProviderRequest = {
        requestId: "req-translate-gen",
        model: "gpt-4o-mini",
        input: [{ role: "user", content: "Generate plan." }],
        generation: {
          temperature: 0.3,
          topP: 0.95,
          maxOutputTokens: 1024,
          stopSequences: ["\nEND", "STOP_HERE"],
        },
        timeoutMs: 20000,
      };

      await provider.generate(request);

      expect(state.lastBody?.temperature).toBe(0.3);
      expect(state.lastBody?.top_p).toBe(0.95);
      expect(state.lastBody?.max_completion_tokens).toBe(1024);
      expect(state.lastBody?.stop).toEqual(["\nEND", "STOP_HERE"]);
    });

    it("translates structuredOutput schema to OpenAI json_schema response_format", async () => {
      const { client, state } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({ client });

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
          additionalProperties: false,
        },
      };

      const request: ModelProviderRequest = {
        requestId: "req-schema-1",
        model: "gpt-4o",
        input: [{ role: "user", content: "Propose next step." }],
        generation: {
          structuredOutput: customSchema,
        },
        timeoutMs: 10000,
      };

      await provider.generate(request);

      const rf = state.lastBody?.response_format as Record<string, unknown>;
      expect(rf).toBeDefined();
      expect(rf.type).toBe("json_schema");

      const js = rf.json_schema as Record<string, unknown>;
      expect(js.name).toBe("test_action_schema");
      expect(js.description).toBe("Schema for testing structured proposal");
      expect(js.strict).toBe(true);
      expect(js.schema).toEqual(customSchema.jsonSchema);
    });

    it("uses defaultModel if specified in provider options when request allows", async () => {
      const { client, state } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({
        client,
        defaultModel: "gpt-4o-default",
      });

      const request: ModelProviderRequest = {
        requestId: "req-default-model",
        model: "gpt-4o-default",
        input: [{ role: "user", content: "Hello" }],
        timeoutMs: 5000,
      };

      await provider.generate(request);
      expect(state.lastBody?.model).toBe("gpt-4o-default");
    });
  });

  // ==========================================================================
  // 2. Single-Attempt Semantics & Zero-Retry Guarantees
  // ==========================================================================
  describe("2. Single-Attempt Semantics & Zero-Retry Guarantees", () => {
    it("enforces maxRetries: 0 in transport options and performs exactly ONE API call", async () => {
      const { client, state } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({ client });

      const request: ModelProviderRequest = {
        requestId: "req-once-1",
        model: "gpt-4o",
        input: [{ role: "user", content: "Run single step." }],
        timeoutMs: 10000,
      };

      await provider.generate(request);

      expect(state.callCount).toBe(1);
      expect(state.lastOptions?.maxRetries).toBe(0);
    });

    it("does NOT retry on error: fails immediately with callCount === 1", async () => {
      let invocations = 0;
      const { client } = createMockClient(async () => {
        invocations++;
        throw new RateLimitError(
          429,
          { error: { message: "Rate limit reached" } },
          "Rate limit reached",
          new Headers()
        );
      });

      const provider = new OpenAIModelProvider({ client });

      const request: ModelProviderRequest = {
        requestId: "req-no-retry-on-error",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hello" }],
        timeoutMs: 5000,
      };

      await expect(provider.generate(request)).rejects.toThrow(ModelRateLimitedError);
      expect(invocations).toBe(1);
    });

    it("does not attempt fallback models or fallback providers on failure", async () => {
      const attemptedModels: string[] = [];
      const { client } = createMockClient(async (body) => {
        attemptedModels.push(body.model as string);
        throw new BadRequestError(
          400,
          { error: { message: "Model gpt-fake does not exist" } },
          "Model gpt-fake does not exist",
          new Headers()
        );
      });

      const provider = new OpenAIModelProvider({ client });

      const request: ModelProviderRequest = {
        requestId: "req-no-fallback",
        model: "gpt-fake",
        input: [{ role: "user", content: "Hello" }],
        timeoutMs: 5000,
      };

      await expect(provider.generate(request)).rejects.toThrow(ModelRequestInvalidError);
      expect(attemptedModels).toEqual(["gpt-fake"]);
    });
  });

  // ==========================================================================
  // 3. Response and Usage Mapping
  // ==========================================================================
  describe("3. Response and Usage Mapping", () => {
    it("maps finish reasons (stop, length, content_filter, other) correctly", async () => {
      const testCases: Array<[string, ModelFinishReason]> = [
        ["stop", "STOP"],
        ["length", "LENGTH"],
        ["content_filter", "CONTENT_FILTER"],
        ["unknown_reason", "OTHER"],
      ];

      for (const [raw, expected] of testCases) {
        const { client } = createMockClient(async () =>
          createStandardMockResponse({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: raw,
              },
            ],
          })
        );
        const provider = new OpenAIModelProvider({ client });

        const res = await provider.generate({
          requestId: `req-finish-${raw}`,
          model: "gpt-4o",
          input: [{ role: "user", content: "Test" }],
          timeoutMs: 5000,
        });

        expect(res.finishReason).toBe(expected);
      }
    });

    it("maps refusal message when content is null", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                refusal: "I cannot fulfill this request due to safety policies.",
              },
              finish_reason: "content_filter",
            },
          ],
        })
      );
      const provider = new OpenAIModelProvider({ client });

      const res = await provider.generate({
        requestId: "req-refusal",
        model: "gpt-4o",
        input: [{ role: "user", content: "Unsafe prompt" }],
        timeoutMs: 5000,
      });

      expect(res.outputText).toBe("I cannot fulfill this request due to safety policies.");
      expect(res.finishReason).toBe("CONTENT_FILTER");
    });

    it("maps usage metrics accurately and leaves missing metrics undefined without fabrication", async () => {
      // 1. Full usage
      const { client: clientFull } = createMockClient(async () =>
        createStandardMockResponse({
          usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
        })
      );
      const pFull = new OpenAIModelProvider({ client: clientFull });
      const resFull = await pFull.generate({
        requestId: "req-u1",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });
      expect(resFull.usage).toEqual({
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
      });

      // 2. Partial usage
      const { client: clientPartial } = createMockClient(async () =>
        createStandardMockResponse({
          usage: { prompt_tokens: 150 },
        })
      );
      const pPartial = new OpenAIModelProvider({ client: clientPartial });
      const resPartial = await pPartial.generate({
        requestId: "req-u2",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });
      expect(resPartial.usage).toEqual({
        inputTokens: 150,
      });
      expect(resPartial.usage?.outputTokens).toBeUndefined();
      expect(resPartial.usage?.totalTokens).toBeUndefined();

      // 3. Omitted usage (never fabricated)
      const { client: clientNone } = createMockClient(async () =>
        createStandardMockResponse({ usage: null })
      );
      const pNone = new OpenAIModelProvider({ client: clientNone });
      const resNone = await pNone.generate({
        requestId: "req-u3",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });
      expect(resNone.usage).toBeUndefined();
    });

    it("normalizes provider metadata without raw SDK objects and preserves Emerald requestId", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          id: "chatcmpl-official-999",
          model: "gpt-4o-2024-08-06",
          system_fingerprint: "fp_prod_123",
          service_tier: "priority",
        })
      );
      const provider = new OpenAIModelProvider({ client });

      const res = await provider.generate({
        requestId: "emerald-req-id-777",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });

      expect(res.requestId).toBe("emerald-req-id-777");
      expect(res.providerMetadata).toEqual({
        provider: "openai",
        providerRequestId: "chatcmpl-official-999",
        providerModel: "gpt-4o-2024-08-06",
        systemFingerprint: "fp_prod_123",
        serviceTier: "priority",
      });
    });
  });

  // ==========================================================================
  // 4. Structured Output Validation
  // ==========================================================================
  describe("4. Structured Output Validation", () => {
    it("throws ModelResponseInvalidError if structured output is requested and response text is empty", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
        })
      );
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-so-empty",
          model: "gpt-4o",
          input: [{ role: "user", content: "Propose" }],
          generation: {
            structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
          },
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });

    it("throws ModelResponseInvalidError if structured output is requested and response is malformed JSON", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "{ not valid json ..." },
              finish_reason: "stop",
            },
          ],
        })
      );
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-so-malformed",
          model: "gpt-4o",
          input: [{ role: "user", content: "Propose" }],
          generation: {
            structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
          },
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });

    it("permits free-form non-JSON text when structuredOutput was not requested", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "This is regular natural language text." },
              finish_reason: "stop",
            },
          ],
        })
      );
      const provider = new OpenAIModelProvider({ client });

      const res = await provider.generate({
        requestId: "req-free-text",
        model: "gpt-4o",
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
    it("maps APIUserAbortError and AbortError to ModelRequestCancelledError", async () => {
      const { client } = createMockClient(async () => {
        throw new APIUserAbortError({ message: "User cancelled request" });
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-abort-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelRequestCancelledError);
    });

    it("detects pre-dispatch AbortSignal cancellation and fails immediately", async () => {
      const controller = new AbortController();
      controller.abort();

      const { client, state } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-pre-abort",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
          abortSignal: controller.signal,
        })
      ).rejects.toThrow(ModelRequestCancelledError);

      expect(state.callCount).toBe(0);
    });

    it("maps APIConnectionTimeoutError to ModelRequestTimeoutError with timeoutMs", async () => {
      const { client } = createMockClient(async () => {
        throw new APIConnectionTimeoutError({ message: "Request timed out" });
      });
      const provider = new OpenAIModelProvider({ client });

      const err = await provider
        .generate({
          requestId: "req-timeout-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 12345,
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ModelRequestTimeoutError);
      expect((err as ModelRequestTimeoutError).timeoutMs).toBe(12345);
      expect(err.code).toBe("MODEL_REQUEST_TIMEOUT");
    });

    it("maps RateLimitError (429) to ModelRateLimitedError with retryAfterMs", async () => {
      const headers = new Headers();
      headers.set("retry-after", "3.5");

      const { client } = createMockClient(async () => {
        throw new RateLimitError(
          429,
          { error: { message: "Rate limit reached" } },
          "Rate limit reached",
          headers
        );
      });
      const provider = new OpenAIModelProvider({ client });

      const err = await provider
        .generate({
          requestId: "req-ratelimit-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ModelRateLimitedError);
      expect(err.code).toBe("MODEL_RATE_LIMITED");
      expect((err as ModelRateLimitedError).retryAfterMs).toBe(3500);
    });

    it("maps BadRequestError (400) to ModelRequestInvalidError", async () => {
      const { client } = createMockClient(async () => {
        throw new BadRequestError(
          400,
          { error: { message: "Invalid parameters" } },
          "Invalid parameters",
          new Headers()
        );
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-bad-param",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelRequestInvalidError);
    });

    it("maps context length / max tokens error to ModelOutputLimitExceededError", async () => {
      const { client } = createMockClient(async () => {
        const errorBody = {
          error: {
            message: "This model's maximum context length is 128000 tokens.",
            code: "context_length_exceeded",
          },
        };
        const err = new BadRequestError(400, errorBody, errorBody.error.message, new Headers());
        (err as any).code = "context_length_exceeded";
        throw err;
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-output-limit",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          generation: { maxOutputTokens: 4096 },
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelOutputLimitExceededError);
    });

    it("maps AuthenticationError (401) to ModelProviderUnavailableError", async () => {
      const { client } = createMockClient(async () => {
        throw new AuthenticationError(
          401,
          { error: { message: "Incorrect API key provided" } },
          "Incorrect API key provided",
          new Headers()
        );
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-auth-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelProviderUnavailableError);
    });

    it("maps PermissionDeniedError (403) to ModelProviderUnavailableError", async () => {
      const { client } = createMockClient(async () => {
        throw new PermissionDeniedError(
          403,
          { error: { message: "Country not supported" } },
          "Country not supported",
          new Headers()
        );
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-perm-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelProviderUnavailableError);
    });

    it("maps APIConnectionError (network failure) to ModelProviderUnavailableError", async () => {
      const { client } = createMockClient(async () => {
        throw new APIConnectionError({ message: "Connection refused ECONNREFUSED" });
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-conn-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelProviderUnavailableError);
    });

    it("maps generic unhandled APIError to ModelProviderError", async () => {
      const { client } = createMockClient(async () => {
        throw new APIError(
          418,
          { error: { message: "I'm a teapot" } },
          "I'm a teapot",
          new Headers()
        );
      });
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-generic-1",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelProviderError);
    });

    it("throws ModelResponseInvalidError on missing or invalid choices array", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({ choices: [] })
      );
      const provider = new OpenAIModelProvider({ client });

      await expect(
        provider.generate({
          requestId: "req-no-choices",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
      ).rejects.toThrow(ModelResponseInvalidError);
    });
  });

  // ==========================================================================
  // 6. Secret Safety & Isolation
  // ==========================================================================
  describe("6. Secret Safety & Isolation", () => {
    it("redacts raw API keys in error messages", async () => {
      const { client } = createMockClient(async () => {
        throw new Error(
          "Invalid request with key sk-proj-1234567890abcdef1234567890 and Bearer test-token-value-xyz"
        );
      });
      const provider = new OpenAIModelProvider({ client });

      const err = await provider
        .generate({
          requestId: "req-leak-test",
          model: "gpt-4o",
          input: [{ role: "user", content: "Hi" }],
          timeoutMs: 5000,
        })
        .catch((e) => e);

      expect(err.message).not.toContain("sk-proj-1234567890abcdef1234567890");
      expect(err.message).toContain("[REDACTED_API_KEY]");
      expect(err.message).toContain("Bearer [REDACTED_TOKEN]");
    });

    it("fails closed with ModelProviderUnavailableError if no API key is configured and no client injected", async () => {
      const prevEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const provider = new OpenAIModelProvider({});

        await expect(
          provider.generate({
            requestId: "req-no-key",
            model: "gpt-4o",
            input: [{ role: "user", content: "Hi" }],
            timeoutMs: 5000,
          })
        ).rejects.toThrow(ModelProviderUnavailableError);
      } finally {
        if (prevEnv) {
          process.env.OPENAI_API_KEY = prevEnv;
        }
      }
    });

    it("does not leak secrets or SDK objects in providerMetadata or response", async () => {
      const { client } = createMockClient(async () => createStandardMockResponse());
      const provider = new OpenAIModelProvider({ client });

      const res = await provider.generate({
        requestId: "req-clean-meta",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        timeoutMs: 5000,
      });

      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain("apiKey");
      expect(serialized).not.toContain("authorization");
      expect(serialized).not.toContain("bearer");
      expect(res.providerMetadata).toBeDefined();
      expect(typeof res.providerMetadata).toBe("object");
    });
  });

  // ==========================================================================
  // 7. End-to-End Governed Autonomous Integration
  // ==========================================================================
  describe("7. End-to-End Governed Autonomous Integration", () => {
    it("executes complete governance loop: StepController -> LiveAgentBrain -> OpenAIModelProvider -> ProposalValidator -> WorkerRuntime", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-openai-e2e-"));
      const clock = new SettableClock(new Date("2026-10-13T16:00:00Z"));

      try {
        const store = new SqliteStateStore();
        const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
        const coordinator = new RunCoordinator(store, clock);

        const workerId = "worker-e2e-openai-1";

        const workerRuntime = new WorkerRuntime({
          workerId,
          coordinator,
          clock,
          workspacePort: workspaceAdapter,
        });

        const proposalValidator = new ProposalValidator({
          coordinator,
          stateStore: store,
          toolRegistry: staticToolRegistry,
          clock,
        });

        // Register worker
        store.transaction((tx) => {
          tx.insertWorker({
            workerId,
            hostname: "localhost",
            pid: process.pid,
            status: "ACTIVE",
            createdAt: clock.nowIso(),
            lastHeartbeatAt: clock.nowIso(),
          });
        });

        // 1. Task & Mission Contract setup
        const task = coordinator.createTask({
          title: "E2E OpenAI Task",
          description: "Verify governed step loop with OpenAI model provider adapter",
          inputPayload: { target: "test" },
        });

        createAndActivateContract(store, task.taskId, {
          policy: createExecutionPolicy({
            policyId: `policy-${task.taskId}`,
            allowedCapabilities: [
              "workspace.file.read",
              "workspace.file.write",
              "workspace.code.search",
            ],
            isolationRequirement: "IN_PROCESS",
          }),
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxAttempts: 2,
        });

        // 2. Run creation and claiming
        const { run } = coordinator.createRun({ taskId: task.taskId });
        coordinator.queueRun(run.runId);
        const claimResult = coordinator.claimRun(run.runId, workerId, 60000);
        coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

        // 3. Provision workspace
        const wsHandle = await workspaceAdapter.provisionWorkspace({
          workspaceId: `ws-${run.runId}`,
          runId: run.runId,
          taskId: task.taskId,
          maxWorkspaceBytes: 10 * 1024 * 1024,
          maxFileSizeBytes: 1024 * 1024,
        });

        // 4. Mock OpenAI transport simulating 2-step reasoning loop:
        // Step 1: write_file
        // Step 2: GOAL_REACHED
        let turn = 0;
        const { client } = createMockClient(async () => {
          turn++;
          if (turn === 1) {
            return createStandardMockResponse({
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      isGoalReached: false,
                      proposalId: "prop-step-1",
                      toolName: "write_file",
                      inputPayload: {
                        path: "result.txt",
                        content: "Hello from OpenAI governed loop",
                      },
                      rationale: "Write required task output file",
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            });
          } else {
            return createStandardMockResponse({
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      isGoalReached: true,
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            });
          }
        });

        const modelProvider = new OpenAIModelProvider({ client });
        const brain = new LiveAgentBrain({
          modelProvider,
          model: "gpt-4o",
        });

        const stepController = new AgentStepController({
          coordinator,
          stateStore: store,
          workerRuntime,
          agentBrain: brain,
          proposalValidator,
          toolRegistry: staticToolRegistry,
          clock,
        });

        // 5. Execute autonomous loop
        const result = await stepController.runStepLoop({
          runId: run.runId,
          workerId,
          leaseId: claimResult.lease.leaseId,
          workspace: wsHandle,
          budget: {
            maxSteps: 5,
            maxWallClockMs: 30000,
            maxActions: 3,
            maxConsecutiveFailures: 2,
            maxProposalRejections: 2,
          },
        });

        // Verify successful completion
        expect(result.terminalReason).toBe("COMPLETED");
        expect(result.totalSteps).toBe(2);
        expect(result.totalActions).toBe(1);

        // Verify physical file was written via governed runtime
        const filePath = await workspaceAdapter.resolvePath(wsHandle.workspaceId, "result.txt");
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe("Hello from OpenAI governed loop");

        store.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================================================
  // 8. Security Regression Tests
  // ==========================================================================
  describe("8. Security Regression Tests", () => {
    it("rejects model proposal attempting to self-authorize capabilities", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  isGoalReached: false,
                  toolName: "read_file",
                  inputPayload: { path: "test.txt" },
                  capability: "COMMAND_EXECUTION", // forbidden authority field
                  approved: true,
                }),
              },
              finish_reason: "stop",
            },
          ],
        })
      );

      const provider = new OpenAIModelProvider({ client });
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "gpt-4o",
      });

      const brainResult = await brain.proposeAction({
        runId: "run-sec-1",
        sequenceNumber: 1,
        availableTools: [],
        contextSnapshot: {
          snapshotId: "snap-sec-1",
          runId: "run-sec-1",
          taskId: "task-sec-1",
          policyVersion: "context-policy-v1",
          createdAt: new Date().toISOString(),
          budget: DEFAULT_CONTEXT_BUDGET,
          observations: [],
          omittedObservationsCount: 0,
          omittedObservationsSummary: [],
          totalEstimatedTokens: 0,
          totalBytes: 0,
          contextHash: "hash-sec-1",
        },
      });

      expect(brainResult.finishReason).toBe("ERROR");
      expect(brainResult.error).toContain("forbidden authority field(s)");
      expect(brainResult.proposal).toBeUndefined();
    });

    it("rejects model proposal attempting to alter contracts", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  isGoalReached: false,
                  toolName: "read_file",
                  inputPayload: { path: "test.txt" },
                  contractId: "attacker-contract", // forbidden authority field
                }),
              },
              finish_reason: "stop",
            },
          ],
        })
      );

      const provider = new OpenAIModelProvider({ client });
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "gpt-4o",
      });

      const brainResult = await brain.proposeAction({
        runId: "run-sec-2",
        sequenceNumber: 1,
        availableTools: [],
        contextSnapshot: {
          snapshotId: "snap-sec-2",
          runId: "run-sec-2",
          taskId: "task-sec-2",
          policyVersion: "context-policy-v1",
          createdAt: new Date().toISOString(),
          budget: DEFAULT_CONTEXT_BUDGET,
          observations: [],
          omittedObservationsCount: 0,
          omittedObservationsSummary: [],
          totalEstimatedTokens: 0,
          totalBytes: 0,
          contextHash: "hash-sec-2",
        },
      });

      expect(brainResult.finishReason).toBe("ERROR");
      expect(brainResult.error).toContain("forbidden authority field(s)");
    });

    it("rejects model proposal attempting to alter workspace root", async () => {
      const { client } = createMockClient(async () =>
        createStandardMockResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  isGoalReached: false,
                  toolName: "write_file",
                  inputPayload: { path: "test.txt", content: "data" },
                  workspaceRoot: "/", // forbidden authority field
                }),
              },
              finish_reason: "stop",
            },
          ],
        })
      );

      const provider = new OpenAIModelProvider({ client });
      const brain = new LiveAgentBrain({
        modelProvider: provider,
        model: "gpt-4o",
      });

      const brainResult = await brain.proposeAction({
        runId: "run-sec-3",
        sequenceNumber: 1,
        availableTools: [],
        contextSnapshot: {
          snapshotId: "snap-sec-3",
          runId: "run-sec-3",
          taskId: "task-sec-3",
          policyVersion: "context-policy-v1",
          createdAt: new Date().toISOString(),
          budget: DEFAULT_CONTEXT_BUDGET,
          observations: [],
          omittedObservationsCount: 0,
          omittedObservationsSummary: [],
          totalEstimatedTokens: 0,
          totalBytes: 0,
          contextHash: "hash-sec-3",
        },
      });

      expect(brainResult.finishReason).toBe("ERROR");
      expect(brainResult.error).toContain("forbidden authority field(s)");
    });
  });

  // ==========================================================================
  // 9. Opt-In Live Provider Integration Test
  // ==========================================================================
  describe("9. Opt-in Live Provider Integration Test", () => {
    it.runIf(process.env.LIVE_MODEL_TESTS === "true" && Boolean(process.env.OPENAI_API_KEY))(
      "communicates with live OpenAI endpoint when LIVE_MODEL_TESTS=true",
      async () => {
        const provider = new OpenAIModelProvider({
          apiKey: process.env.OPENAI_API_KEY,
        });

        const liveRequest: ModelProviderRequest = {
          requestId: `live-openai-test-${Date.now()}`,
          model: "gpt-4o-mini",
          input: [
            {
              role: "system",
              content: "You are a test helper. Reply strictly in structured JSON format.",
            },
            {
              role: "user",
              content: "Output isGoalReached: true.",
            },
          ],
          generation: {
            temperature: 0.0,
            maxOutputTokens: 100,
            structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA,
          },
          timeoutMs: 15000,
        };

        const response = await provider.generate(liveRequest);

        expect(response.requestId).toBe(liveRequest.requestId);
        expect(response.finishReason).toBe("STOP");
        expect(response.outputText).toContain("isGoalReached");
        const parsed = JSON.parse(response.outputText);
        expect(parsed.isGoalReached).toBe(true);
        expect(response.durationMs).toBeGreaterThan(0);
      }
    );
  });
});
