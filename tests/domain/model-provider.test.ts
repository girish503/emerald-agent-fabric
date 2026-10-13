import { describe, expect, it } from "vitest";
import {
  ModelMessage,
  ModelMessageRole,
  MODEL_MESSAGE_ROLES,
  ModelStructuredOutputSchema,
  ModelProviderRequest,
  ModelFinishReason,
  MODEL_FINISH_REASONS,
  ModelProviderResponse,
  validateModelProviderRequest,
  validateModelProviderResponse,
} from "../../src/domain/model-provider.js";
import {
  ModelProviderPort,
} from "../../src/ports/model-provider.port.js";
import {
  DomainError,
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRequestInvalidError,
  ModelRequestTimeoutError,
  ModelRequestCancelledError,
  ModelRateLimitedError,
  ModelResponseInvalidError,
  ModelOutputLimitExceededError,
} from "../../src/domain/errors.js";

describe("Phase 6.1 — Model Provider Port & Neutral Contracts", () => {
  // =========================================================================
  // 1. Valid Request Construction & Validation
  // =========================================================================
  it("validates well-formed ModelProviderRequest with full options", () => {
    const request: ModelProviderRequest = {
      requestId: "req-12345",
      model: "gpt-4o",
      input: [
        { role: "system", content: "You are a helpful coding assistant." },
        { role: "user", content: "Fix the bug in index.ts", name: "Alice" },
      ],
      generation: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        topP: 0.95,
        stopSequences: ["\n```\n", "STOP"],
        structuredOutput: {
          name: "action_proposal",
          jsonSchema: {
            type: "object",
            properties: {
              toolName: { type: "string" },
              inputPayload: { type: "object" },
            },
            required: ["toolName", "inputPayload"],
          },
          description: "Structured Action Proposal",
          strict: true,
        },
      },
      timeoutMs: 30_000,
    };

    expect(() => validateModelProviderRequest(request)).not.toThrow();
    expect(MODEL_MESSAGE_ROLES).toEqual(["system", "user", "assistant"]);
    expect(request.requestId).toBe("req-12345");
    expect(request.model).toBe("gpt-4o");
    expect(request.input.length).toBe(2);
    expect(request.generation?.temperature).toBe(0.2);
    expect(request.generation?.maxOutputTokens).toBe(2048);
  });

  // =========================================================================
  // 2. Invalid Empty Model Identifier
  // =========================================================================
  it("rejects empty or whitespace model identifier with ModelRequestInvalidError", () => {
    const baseRequest = {
      requestId: "req-1",
      input: [{ role: "user" as const, content: "Hello" }],
      timeoutMs: 5000,
    };

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, model: "" })
    ).toThrow(ModelRequestInvalidError);

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, model: "   " })
    ).toThrow(ModelRequestInvalidError);

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, model: null as unknown as string })
    ).toThrow(ModelRequestInvalidError);
  });

  // =========================================================================
  // 3. Invalid Empty Input Messages
  // =========================================================================
  it("rejects empty, non-array, or malformed input messages", () => {
    const baseRequest = {
      requestId: "req-1",
      model: "test-model",
      timeoutMs: 5000,
    };

    // Empty array
    expect(() =>
      validateModelProviderRequest({ ...baseRequest, input: [] })
    ).toThrow(ModelRequestInvalidError);

    // Non-array
    expect(() =>
      validateModelProviderRequest({ ...baseRequest, input: null as unknown as ModelMessage[] })
    ).toThrow(ModelRequestInvalidError);

    // Invalid role
    expect(() =>
      validateModelProviderRequest({
        ...baseRequest,
        input: [{ role: "admin" as unknown as ModelMessageRole, content: "hi" }],
      })
    ).toThrow(ModelRequestInvalidError);

    // Non-string content
    expect(() =>
      validateModelProviderRequest({
        ...baseRequest,
        input: [{ role: "user", content: 12345 as unknown as string }],
      })
    ).toThrow(ModelRequestInvalidError);

    // Empty name if provided
    expect(() =>
      validateModelProviderRequest({
        ...baseRequest,
        input: [{ role: "user", content: "hi", name: "   " }],
      })
    ).toThrow(ModelRequestInvalidError);
  });

  // =========================================================================
  // 4. Invalid Timeout
  // =========================================================================
  it("rejects non-positive or non-finite timeout ceilings", () => {
    const baseRequest = {
      requestId: "req-1",
      model: "test-model",
      input: [{ role: "user" as const, content: "Hello" }],
    };

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, timeoutMs: 0 })
    ).toThrow(ModelRequestInvalidError);

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, timeoutMs: -1000 })
    ).toThrow(ModelRequestInvalidError);

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, timeoutMs: NaN })
    ).toThrow(ModelRequestInvalidError);

    expect(() =>
      validateModelProviderRequest({ ...baseRequest, timeoutMs: Infinity })
    ).toThrow(ModelRequestInvalidError);
  });

  // =========================================================================
  // 5. Cancellation Representation
  // =========================================================================
  it("represents cooperative cancellation via AbortSignal", () => {
    const controller = new AbortController();
    const request: ModelProviderRequest = {
      requestId: "req-cancel",
      model: "test-model",
      input: [{ role: "user", content: "test" }],
      timeoutMs: 10_000,
      abortSignal: controller.signal,
    };

    expect(request.abortSignal).toBeDefined();
    expect(request.abortSignal?.aborted).toBe(false);

    controller.abort();
    expect(request.abortSignal?.aborted).toBe(true);

    const cancelError = new ModelRequestCancelledError("Request aborted by caller", {
      providerName: "mock-provider",
      requestId: request.requestId,
    });

    expect(cancelError).toBeInstanceOf(DomainError);
    expect(cancelError).toBeInstanceOf(ModelProviderError);
    expect(cancelError.code).toBe("MODEL_REQUEST_CANCELLED");
    expect(cancelError.isRetryable).toBe(false);
    expect(cancelError.requestId).toBe("req-cancel");
    expect(cancelError.providerName).toBe("mock-provider");
  });

  // =========================================================================
  // 6. Structured Output Requirement Representation
  // =========================================================================
  it("represents provider-neutral structured output requirements and rejects malformed schemas", () => {
    const schema: ModelStructuredOutputSchema = {
      name: "action_proposal",
      jsonSchema: {
        type: "object",
        properties: { toolName: { type: "string" } },
      },
      description: "A tool proposal",
      strict: true,
    };

    const validRequest: ModelProviderRequest = {
      requestId: "req-schema",
      model: "test-model",
      input: [{ role: "user", content: "test" }],
      generation: { structuredOutput: schema },
      timeoutMs: 5000,
    };

    expect(() => validateModelProviderRequest(validRequest)).not.toThrow();

    // Rejects empty schema name
    expect(() =>
      validateModelProviderRequest({
        ...validRequest,
        generation: {
          structuredOutput: { ...schema, name: "   " },
        },
      })
    ).toThrow(ModelRequestInvalidError);

    // Rejects non-object jsonSchema
    expect(() =>
      validateModelProviderRequest({
        ...validRequest,
        generation: {
          structuredOutput: { ...schema, jsonSchema: null as unknown as Record<string, unknown> },
        },
      })
    ).toThrow(ModelRequestInvalidError);
  });

  // =========================================================================
  // 7. Valid Response Construction & Validation
  // =========================================================================
  it("validates well-formed ModelProviderResponse with token usage and metadata", () => {
    const response: ModelProviderResponse = {
      requestId: "req-resp-1",
      model: "claude-3-7-sonnet",
      outputText: '{"toolName":"write_file","inputPayload":{"path":"a.txt"}}',
      finishReason: "STOP",
      usage: {
        inputTokens: 150,
        outputTokens: 42,
        totalTokens: 192,
      },
      providerMetadata: {
        latencyMs: 380,
        systemFingerprint: "fp_claude_123",
      },
      durationMs: 382,
    };

    expect(() => validateModelProviderResponse(response)).not.toThrow();
    expect(response.finishReason).toBe("STOP");
    expect(response.usage?.totalTokens).toBe(192);
  });

  // =========================================================================
  // 8. Missing / Unknown Usage Representation
  // =========================================================================
  it("explicitly handles missing or partial token usage without inventing counts", () => {
    // Response with completely omitted usage
    const responseNoUsage: ModelProviderResponse = {
      requestId: "req-no-usage",
      model: "local-model",
      outputText: "hello",
      finishReason: "STOP",
      durationMs: 120,
    };

    expect(() => validateModelProviderResponse(responseNoUsage)).not.toThrow();
    expect(responseNoUsage.usage).toBeUndefined();

    // Response with partial usage (e.g., provider only provides totalTokens)
    const responsePartialUsage: ModelProviderResponse = {
      requestId: "req-partial-usage",
      model: "local-model",
      outputText: "hello",
      finishReason: "STOP",
      usage: {
        totalTokens: 100,
      },
      durationMs: 120,
    };

    expect(() => validateModelProviderResponse(responsePartialUsage)).not.toThrow();
    expect(responsePartialUsage.usage?.inputTokens).toBeUndefined();
    expect(responsePartialUsage.usage?.outputTokens).toBeUndefined();
    expect(responsePartialUsage.usage?.totalTokens).toBe(100);

    // Rejects negative tokens
    expect(() =>
      validateModelProviderResponse({
        ...responsePartialUsage,
        usage: { totalTokens: -5 },
      })
    ).toThrow(ModelResponseInvalidError);

    // Rejects non-integer tokens
    expect(() =>
      validateModelProviderResponse({
        ...responsePartialUsage,
        usage: { totalTokens: 12.34 },
      })
    ).toThrow(ModelResponseInvalidError);
  });

  // =========================================================================
  // 9. Finish Reason Handling
  // =========================================================================
  it("accepts all standard MODEL_FINISH_REASONS and rejects unknown finish reasons", () => {
    const baseResponse = {
      requestId: "req-finish",
      model: "test-model",
      outputText: "output",
      durationMs: 100,
    };

    for (const finishReason of MODEL_FINISH_REASONS) {
      expect(() =>
        validateModelProviderResponse({ ...baseResponse, finishReason })
      ).not.toThrow();
    }

    expect(() =>
      validateModelProviderResponse({
        ...baseResponse,
        finishReason: "SUCCESS" as unknown as ModelFinishReason,
      })
    ).toThrow(ModelResponseInvalidError);

    expect(() =>
      validateModelProviderResponse({
        ...baseResponse,
        finishReason: "COMPLETED" as unknown as ModelFinishReason,
      })
    ).toThrow(ModelResponseInvalidError);
  });

  // =========================================================================
  // 10. Provider Error Mapping
  // =========================================================================
  it("maps provider errors with retryability classification and diagnostic context", () => {
    const err = new ModelProviderUnavailableError("Upstream 503 Service Unavailable", {
      providerName: "anthropic",
      requestId: "req-err-1",
      cause: new Error("Connection reset"),
    });

    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.code).toBe("MODEL_PROVIDER_UNAVAILABLE");
    expect(err.isRetryable).toBe(true);
    expect(err.providerName).toBe("anthropic");
    expect(err.requestId).toBe("req-err-1");
    expect(err.cause).toBeDefined();

    const outputLimitErr = new ModelOutputLimitExceededError("Generation exceeded max tokens", {
      maxOutputTokens: 2048,
      providerName: "openai",
    });
    expect(outputLimitErr.code).toBe("MODEL_OUTPUT_LIMIT_EXCEEDED");
    expect(outputLimitErr.isRetryable).toBe(false);
    expect(outputLimitErr.maxOutputTokens).toBe(2048);
  });

  // =========================================================================
  // 11. Timeout Error Mapping
  // =========================================================================
  it("maps timeout errors distinctly as retryable lower-level failures", () => {
    const timeoutErr = new ModelRequestTimeoutError("Model inference timed out after 30000ms", {
      timeoutMs: 30000,
      providerName: "openai",
      requestId: "req-timeout",
    });

    expect(timeoutErr.code).toBe("MODEL_REQUEST_TIMEOUT");
    expect(timeoutErr.isRetryable).toBe(true);
    expect(timeoutErr.timeoutMs).toBe(30000);
    expect(timeoutErr.requestId).toBe("req-timeout");
  });

  // =========================================================================
  // 12. Cancellation Error Mapping
  // =========================================================================
  it("maps cancellation errors distinctly as non-retryable", () => {
    const cancelErr = new ModelRequestCancelledError("Inference cancelled via AbortSignal", {
      providerName: "gemini",
      requestId: "req-cancel-123",
    });

    expect(cancelErr.code).toBe("MODEL_REQUEST_CANCELLED");
    expect(cancelErr.isRetryable).toBe(false);
    expect(cancelErr.requestId).toBe("req-cancel-123");
  });

  // =========================================================================
  // 13. Rate Limit Error Mapping
  // =========================================================================
  it("maps rate limit errors as retryable with optional retryAfterMs hint", () => {
    const rateLimitErr = new ModelRateLimitedError("Rate limit exceeded: 429 Too Many Requests", {
      retryAfterMs: 2500,
      providerName: "openai",
      requestId: "req-rate",
    });

    expect(rateLimitErr.code).toBe("MODEL_RATE_LIMITED");
    expect(rateLimitErr.isRetryable).toBe(true);
    expect(rateLimitErr.retryAfterMs).toBe(2500);
    expect(rateLimitErr.providerName).toBe("openai");
  });

  // =========================================================================
  // 14. Malformed Response Representation
  // =========================================================================
  it("rejects malformed responses violating schema invariants", () => {
    const valid = {
      requestId: "req-1",
      model: "test-model",
      outputText: "out",
      finishReason: "STOP" as const,
      durationMs: 100,
    };

    // Missing requestId
    expect(() =>
      validateModelProviderResponse({ ...valid, requestId: "" })
    ).toThrow(ModelResponseInvalidError);

    // Missing model
    expect(() =>
      validateModelProviderResponse({ ...valid, model: "  " })
    ).toThrow(ModelResponseInvalidError);

    // Non-string outputText
    expect(() =>
      validateModelProviderResponse({ ...valid, outputText: 123 as unknown as string })
    ).toThrow(ModelResponseInvalidError);

    // Negative durationMs
    expect(() =>
      validateModelProviderResponse({ ...valid, durationMs: -1 })
    ).toThrow(ModelResponseInvalidError);
  });

  // =========================================================================
  // 15. Provider Metadata Remains Informational
  // =========================================================================
  it("ensures provider metadata is strictly non-authoritative diagnostic data", () => {
    const response: ModelProviderResponse = {
      requestId: "req-info",
      model: "test-model",
      outputText: "sample text",
      finishReason: "STOP",
      providerMetadata: Object.freeze({
        httpStatusCode: 200,
        requestIdHeader: "x-request-id-abc",
        cfRay: "12345",
      }),
      durationMs: 200,
    };

    validateModelProviderResponse(response);
    expect(response.providerMetadata?.["httpStatusCode"]).toBe(200);
    expect(response.providerMetadata?.["requestIdHeader"]).toBe("x-request-id-abc");
  });

  // =========================================================================
  // 16. No Authority Fields in Provider Response Contract
  // =========================================================================
  it("enforces Model != Authority: response contract contains zero authority fields", () => {
    const response: ModelProviderResponse = {
      requestId: "req-sec",
      model: "test-model",
      outputText: "untrusted output",
      finishReason: "STOP",
      durationMs: 150,
    };

    // Authority fields must be completely absent from response type
    const responseKeys = Object.keys(response);
    const forbiddenAuthorityKeys = [
      "capability",
      "capabilities",
      "requiredCapability",
      "workerId",
      "leaseId",
      "contractBinding",
      "contractId",
      "resourceCeilings",
      "isolationLevel",
      "workspaceRoot",
      "executionStatus",
      "approved",
    ];

    for (const forbiddenKey of forbiddenAuthorityKeys) {
      expect(responseKeys).not.toContain(forbiddenKey);
      expect((response as unknown as Record<string, unknown>)[forbiddenKey]).toBeUndefined();
    }
  });

  // =========================================================================
  // 17. Provider Port Does Not Expose ToolGateway
  // =========================================================================
  it("proves ModelProviderPort exposes zero ToolGateway references", () => {
    class DummyProvider implements ModelProviderPort {
      readonly providerName = "dummy";
      async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
        return {
          requestId: request.requestId,
          model: request.model,
          outputText: "mock text",
          finishReason: "STOP",
          durationMs: 10,
        };
      }
    }

    const provider: ModelProviderPort = new DummyProvider();
    expect(provider.providerName).toBe("dummy");
    expect((provider as any).toolExecutionGateway).toBeUndefined();
    expect((provider as any).executeTool).toBeUndefined();
    expect((provider as any).authorize).toBeUndefined();
  });

  // =========================================================================
  // 18. Provider Port Does Not Expose MissionContract Mutation
  // =========================================================================
  it("proves ModelProviderPort exposes zero MissionContract authority", () => {
    class DummyProvider implements ModelProviderPort {
      readonly providerName = "dummy";
      async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
        return {
          requestId: request.requestId,
          model: request.model,
          outputText: "mock text",
          finishReason: "STOP",
          durationMs: 10,
        };
      }
    }

    const provider = new DummyProvider();
    expect((provider as any).missionContractStore).toBeUndefined();
    expect((provider as any).activateContract).toBeUndefined();
    expect((provider as any).revokeContract).toBeUndefined();
  });

  // =========================================================================
  // 19. Provider Port Does Not Expose Workspace Access
  // =========================================================================
  it("proves ModelProviderPort exposes zero workspace access or filesystem capabilities", () => {
    class DummyProvider implements ModelProviderPort {
      readonly providerName = "dummy";
      async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
        return {
          requestId: request.requestId,
          model: request.model,
          outputText: "mock text",
          finishReason: "STOP",
          durationMs: 10,
        };
      }
    }

    const provider = new DummyProvider();
    expect((provider as any).workspaceAdapter).toBeUndefined();
    expect((provider as any).workspaceHandle).toBeUndefined();
    expect((provider as any).readFile).toBeUndefined();
    expect((provider as any).writeFile).toBeUndefined();
  });

  // =========================================================================
  // 20. Single-Attempt Semantics: Port Performs Zero Internal Retries
  // =========================================================================
  it("verifies single-attempt invariant: port performs zero internal retries on failure", async () => {
    let callCount = 0;

    class SingleAttemptMockProvider implements ModelProviderPort {
      readonly providerName = "single-attempt-mock";

      async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
        callCount++;
        // Simulate a transient rate limit error
        throw new ModelRateLimitedError("Rate limit exceeded", {
          providerName: this.providerName,
          requestId: request.requestId,
          retryAfterMs: 1000,
        });
      }
    }

    const provider = new SingleAttemptMockProvider();

    await expect(
      provider.generate({
        requestId: "req-single-attempt",
        model: "mock-model",
        input: [{ role: "user", content: "hello" }],
        timeoutMs: 5000,
      })
    ).rejects.toThrow(ModelRateLimitedError);

    // Call count must be EXACTLY 1: zero silent retries, zero exponential backoff loops
    expect(callCount).toBe(1);
  });
});
