/**
 * OpenAI Model Provider Adapter for Emerald Agent Fabric.
 *
 * Implements ModelProviderPort (src/ports/model-provider.port.ts) to provide
 * concrete communication with the OpenAI API and OpenAI-compatible endpoints.
 *
 * Architectural Invariants:
 * 1. Model != Authority: This adapter confers ZERO execution authority.
 *    It does not execute tools, mutate persistence, create Actions/Attempts,
 *    or modify MissionContracts or Capability Policies.
 * 2. Provider Isolation: OpenAI SDK types and errors are strictly contained
 *    within this adapter. Only provider-neutral ModelProviderResponse and
 *    Phase 6.1 domain errors (ModelProviderError hierarchy) leave this file.
 * 3. Single-Attempt Semantics: Performs exactly ONE API request per generate() call.
 *    Configured with maxRetries: 0. Zero internal retry or backoff loops.
 * 4. Explicit Timeouts: Request timeoutMs is passed directly to the SDK transport.
 * 5. Cancellation Propagation: request.abortSignal is passed through and maps
 *    to ModelRequestCancelledError when triggered.
 * 6. Structured Output Translation: Maps provider-neutral ModelStructuredOutputSchema
 *    directly to OpenAI response_format: { type: "json_schema", ... }.
 * 7. Secret Safety: API keys are read exclusively from runtime configuration
 *    (options.apiKey or process.env.OPENAI_API_KEY). Credentials are never logged,
 *    never committed, and never leaked in error messages or metadata.
 * 8. Zero Fabrication: Usage token counts are reported only if provided by OpenAI;
 *    never estimated or fabricated.
 */

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";
import {
  ModelFinishReason,
  ModelMessage,
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
  ModelStructuredOutputSchema,
  ModelUsageMetadata,
  validateModelProviderRequest,
} from "../../ports/model-provider.port.js";
import {
  ModelOutputLimitExceededError,
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRateLimitedError,
  ModelRequestCancelledError,
  ModelRequestInvalidError,
  ModelRequestTimeoutError,
  ModelResponseInvalidError,
} from "../../domain/errors.js";

// ============================================================================
// 1. Client Abstraction for Dependency Injection / Testing
// ============================================================================

/**
 * Structural interface matching the subset of the OpenAI SDK chat completions API
 * used by OpenAIModelProvider. Allows full dependency injection for unit testing
 * with zero network traffic.
 */
export interface OpenAIClientLike {
  readonly chat: {
    readonly completions: {
      create(
        body: Record<string, unknown>,
        options?: {
          readonly signal?: AbortSignal;
          readonly timeout?: number;
          readonly maxRetries?: number;
        }
      ): Promise<unknown>;
    };
  };
}

// ============================================================================
// 2. Configuration Options
// ============================================================================

export interface OpenAIModelProviderOptions {
  /**
   * Optional API key. If omitted, falls back to process.env.OPENAI_API_KEY.
   * If both are missing and no client is provided, fails closed on execution.
   */
  readonly apiKey?: string;

  /**
   * Optional custom base URL for OpenAI-compatible endpoints or proxies.
   */
  readonly baseURL?: string;

  /**
   * Optional default model identifier if not specified in request.
   */
  readonly defaultModel?: string;

  /**
   * Optional injected OpenAI client instance (for testing or custom transport).
   */
  readonly client?: OpenAIClientLike;

  /**
   * Optional default timeout in milliseconds (overridden by request.timeoutMs).
   */
  readonly timeoutMs?: number;
}

// ============================================================================
// 3. Helper Functions
// ============================================================================

/**
 * Redacts any potential API keys or authorization bearer tokens from error messages
 * before exposing them through domain error instances.
 */
function sanitizeErrorMessage(msg: string): string {
  if (!msg || typeof msg !== "string") {
    return "Unknown error";
  }
  return msg
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");
}

/**
 * Maps OpenAI choice finish_reason string to provider-neutral ModelFinishReason.
 */
function mapFinishReason(rawReason: unknown): ModelFinishReason {
  if (rawReason === "stop") return "STOP";
  if (rawReason === "length") return "LENGTH";
  if (rawReason === "content_filter") return "CONTENT_FILTER";
  return "OTHER";
}

/**
 * Translates provider-neutral ModelStructuredOutputSchema to OpenAI response_format descriptor.
 */
function mapStructuredOutput(
  schema: ModelStructuredOutputSchema
): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.jsonSchema,
      strict: schema.strict ?? true,
      ...(schema.description ? { description: schema.description } : {}),
    },
  };
}

// ============================================================================
// 4. OpenAIModelProvider Implementation
// ============================================================================

export class OpenAIModelProvider implements ModelProviderPort {
  readonly providerName = "openai";

  private readonly apiKey?: string;
  private readonly baseURL?: string;
  private readonly defaultModel?: string;
  private readonly defaultTimeoutMs?: number;
  private client?: OpenAIClientLike;

  constructor(options: OpenAIModelProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.defaultModel = options.defaultModel;
    this.defaultTimeoutMs = options.timeoutMs;

    if (options.client) {
      this.client = options.client;
    }
  }

  /**
   * Lazily resolves or instantiates the OpenAI client.
   * If credentials are unconfigured and no client was injected, fails closed immediately.
   */
  private getClient(): OpenAIClientLike {
    if (this.client) {
      return this.client;
    }

    const resolvedApiKey = this.apiKey ?? process.env.OPENAI_API_KEY;
    if (!resolvedApiKey || resolvedApiKey.trim().length === 0) {
      throw new ModelProviderUnavailableError(
        "OpenAI API key is missing. Set the OPENAI_API_KEY environment variable or supply apiKey in configuration.",
        { providerName: this.providerName }
      );
    }

    // Initialize OpenAI client with maxRetries: 0 (NON-NEGOTIABLE)
    this.client = new OpenAI({
      apiKey: resolvedApiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      maxRetries: 0,
    }) as unknown as OpenAIClientLike;

    return this.client;
  }

  /**
   * Executes a single, non-retried model inference request against OpenAI.
   *
   * Invariants:
   * 1. Single attempt: Performs exactly ONE API request (maxRetries: 0).
   * 2. Zero authority: Does not execute tools, mutate databases, or grant capabilities.
   * 3. Cancellation: Observes request.abortSignal and rejects with ModelRequestCancelledError.
   * 4. Timeout: Enforces request.timeoutMs and rejects with ModelRequestTimeoutError.
   * 5. Fail-closed: Translates all failures into strongly-typed Phase 6.1 domain errors.
   */
  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    // 1. Validate request invariants
    validateModelProviderRequest(request);

    // 2. Check early cancellation
    if (request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError(
        "Model request was cancelled prior to dispatch",
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    // 3. Obtain client (fail-closed if credentials missing)
    const client = this.getClient();

    // 4. Translate request messages
    const messages = request.input.map((msg: ModelMessage) => {
      const entry: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.name) {
        entry.name = msg.name;
      }
      return entry;
    });

    // 5. Model resolution
    const model = request.model || this.defaultModel || "gpt-4o";

    // 6. Build OpenAI request body
    const body: Record<string, unknown> = {
      model,
      messages,
    };

    const gen = request.generation;
    if (gen) {
      if (gen.temperature !== undefined) {
        body.temperature = gen.temperature;
      }
      if (gen.topP !== undefined) {
        body.top_p = gen.topP;
      }
      if (gen.maxOutputTokens !== undefined) {
        body.max_completion_tokens = gen.maxOutputTokens;
      }
      if (gen.stopSequences && gen.stopSequences.length > 0) {
        body.stop = [...gen.stopSequences];
      }
      if (gen.structuredOutput) {
        body.response_format = mapStructuredOutput(gen.structuredOutput);
      }
    }

    const effectiveTimeoutMs = request.timeoutMs ?? this.defaultTimeoutMs ?? 30000;

    const startMs = Date.now();

    // 7. Dispatch single API invocation with maxRetries: 0
    let rawResponse: unknown;
    try {
      rawResponse = await client.chat.completions.create(body, {
        signal: request.abortSignal,
        timeout: effectiveTimeoutMs,
        maxRetries: 0,
      });
    } catch (err: unknown) {
      const elapsedMs = Math.max(0, Date.now() - startMs);
      throw this.mapProviderError(err, request, elapsedMs);
    }

    const durationMs = Math.max(0, Date.now() - startMs);

    // 8. Validate and parse completion response
    const completion = rawResponse as Record<string, unknown> | null;
    if (!completion || typeof completion !== "object") {
      throw new ModelResponseInvalidError(
        "OpenAI returned a null or non-object completion response",
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    const choices = completion.choices as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ModelResponseInvalidError(
        "OpenAI completion response contains no choices",
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    const firstChoice = choices[0];
    if (!firstChoice || typeof firstChoice !== "object") {
      throw new ModelResponseInvalidError(
        "OpenAI completion choice[0] is null or invalid",
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    const message = firstChoice.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      throw new ModelResponseInvalidError(
        "OpenAI completion choice[0].message is missing or invalid",
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    let outputText = "";
    if (typeof message.content === "string") {
      outputText = message.content;
    } else if (typeof message.refusal === "string") {
      outputText = message.refusal;
    }

    const rawFinishReason = firstChoice.finish_reason;
    const finishReason = mapFinishReason(rawFinishReason);

    // 9. Structured Output Conformance Check
    if (gen?.structuredOutput && finishReason === "STOP") {
      if (outputText.trim().length === 0) {
        throw new ModelResponseInvalidError(
          `OpenAI returned empty output text when structured output schema '${gen.structuredOutput.name}' was requested`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
          }
        );
      }

      try {
        JSON.parse(outputText.trim());
      } catch (parseErr: unknown) {
        throw new ModelResponseInvalidError(
          `OpenAI output text does not satisfy requested structured output schema '${gen.structuredOutput.name}' (invalid JSON): ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
            cause: parseErr,
          }
        );
      }
    }

    // 10. Usage Metadata Extraction (Never fabricated)
    let usage: ModelUsageMetadata | undefined;
    const rawUsage = completion.usage as Record<string, unknown> | undefined;
    if (rawUsage && typeof rawUsage === "object") {
      const inputTokens =
        typeof rawUsage.prompt_tokens === "number" &&
        Number.isInteger(rawUsage.prompt_tokens) &&
        rawUsage.prompt_tokens >= 0
          ? rawUsage.prompt_tokens
          : undefined;

      const outputTokens =
        typeof rawUsage.completion_tokens === "number" &&
        Number.isInteger(rawUsage.completion_tokens) &&
        rawUsage.completion_tokens >= 0
          ? rawUsage.completion_tokens
          : undefined;

      const totalTokens =
        typeof rawUsage.total_tokens === "number" &&
        Number.isInteger(rawUsage.total_tokens) &&
        rawUsage.total_tokens >= 0
          ? rawUsage.total_tokens
          : undefined;

      if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
        usage = Object.freeze({
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
        });
      }
    }

    // 11. Informational Provider Metadata (Normalized, Bounded, No Secrets)
    const providerMetadata: Record<string, unknown> = {
      provider: this.providerName,
      ...(typeof completion.id === "string" ? { providerRequestId: completion.id } : {}),
      ...(typeof completion.model === "string" ? { providerModel: completion.model } : {}),
      ...(typeof completion.system_fingerprint === "string"
        ? { systemFingerprint: completion.system_fingerprint }
        : {}),
      ...(typeof completion.service_tier === "string"
        ? { serviceTier: completion.service_tier }
        : {}),
    };

    return Object.freeze({
      requestId: request.requestId,
      model: typeof completion.model === "string" ? completion.model : model,
      outputText,
      finishReason,
      ...(usage ? { usage } : {}),
      providerMetadata: Object.freeze(providerMetadata),
      durationMs,
    });
  }

  /**
   * Deterministically maps any provider-specific failure into the Phase 6.1 domain error taxonomy.
   */
  private mapProviderError(
    err: unknown,
    request: ModelProviderRequest,
    _elapsedMs: number
  ): ModelProviderError {
    // If it's already a domain error, rethrow as is
    if (err instanceof ModelProviderError) {
      return err;
    }

    const rawMessage = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = sanitizeErrorMessage(rawMessage);

    // 1. Cancellation Detection
    if (
      err instanceof APIUserAbortError ||
      (err as any)?.name === "AbortError" ||
      (err as any)?.name === "APIUserAbortError" ||
      request.abortSignal?.aborted
    ) {
      return new ModelRequestCancelledError(sanitizedMsg || "Model request was cancelled", {
        providerName: this.providerName,
        requestId: request.requestId,
        cause: err,
      });
    }

    // 2. Timeout Detection
    if (
      err instanceof APIConnectionTimeoutError ||
      (err as any)?.name === "TimeoutError" ||
      (err as any)?.name === "APIConnectionTimeoutError" ||
      sanitizedMsg.toLowerCase().includes("timeout") ||
      sanitizedMsg.toLowerCase().includes("timed out")
    ) {
      return new ModelRequestTimeoutError(
        sanitizedMsg || `Model request timed out after ${request.timeoutMs}ms`,
        {
          timeoutMs: request.timeoutMs,
          providerName: this.providerName,
          requestId: request.requestId,
          cause: err,
        }
      );
    }

    // 3. Rate Limiting Detection (429)
    if (err instanceof RateLimitError || (err as any)?.status === 429) {
      let retryAfterMs: number | undefined;
      const headers = (err as any)?.headers;
      if (headers) {
        let msHeader: unknown;
        let secHeader: unknown;
        if (typeof (headers as any).get === "function") {
          msHeader = (headers as any).get("retry-after-ms");
          secHeader = (headers as any).get("retry-after");
        } else if (typeof headers === "object") {
          msHeader = (headers as any)["retry-after-ms"] ?? (headers as any)["Retry-After-Ms"];
          secHeader = (headers as any)["retry-after"] ?? (headers as any)["Retry-After"];
        }

        if (msHeader !== undefined && msHeader !== null) {
          const parsedMs = Number.parseFloat(String(msHeader));
          if (Number.isFinite(parsedMs) && parsedMs > 0) {
            retryAfterMs = Math.round(parsedMs);
          }
        } else if (secHeader !== undefined && secHeader !== null) {
          const parsedSec = Number.parseFloat(String(secHeader));
          if (Number.isFinite(parsedSec) && parsedSec > 0) {
            retryAfterMs = Math.round(parsedSec * 1000);
          }
        }
      }

      return new ModelRateLimitedError(sanitizedMsg || "OpenAI rate limit exceeded", {
        retryAfterMs,
        providerName: this.providerName,
        requestId: request.requestId,
        cause: err,
      });
    }

    // 4. Output Limit Exceeded Detection
    const code = (err as any)?.code;
    if (
      code === "context_length_exceeded" ||
      sanitizedMsg.toLowerCase().includes("maximum context length") ||
      sanitizedMsg.toLowerCase().includes("max_tokens") ||
      sanitizedMsg.toLowerCase().includes("max_completion_tokens")
    ) {
      return new ModelOutputLimitExceededError(
        sanitizedMsg || "Maximum model output/context length exceeded",
        {
          maxOutputTokens: request.generation?.maxOutputTokens,
          providerName: this.providerName,
          requestId: request.requestId,
          cause: err,
        }
      );
    }

    // 5. Invalid Request Detection (400, 422)
    if (
      err instanceof BadRequestError ||
      err instanceof UnprocessableEntityError ||
      (err as any)?.status === 400 ||
      (err as any)?.status === 422
    ) {
      return new ModelRequestInvalidError(sanitizedMsg || "Invalid model request", {
        providerName: this.providerName,
        requestId: request.requestId,
        cause: err,
      });
    }

    // 6. Provider Unavailable / Authentication / Network / Server Error (401, 403, 5xx)
    if (
      err instanceof AuthenticationError ||
      err instanceof PermissionDeniedError ||
      err instanceof APIConnectionError ||
      err instanceof InternalServerError ||
      (typeof (err as any)?.status === "number" && (err as any).status >= 500) ||
      (err as any)?.status === 401 ||
      (err as any)?.status === 403
    ) {
      return new ModelProviderUnavailableError(
        sanitizedMsg || "OpenAI service is unavailable or credentials are invalid",
        {
          providerName: this.providerName,
          requestId: request.requestId,
          cause: err,
        }
      );
    }

    // 7. Generic APIError / Unknown Model Provider Error
    if (err instanceof APIError) {
      return new ModelProviderError("MODEL_PROVIDER_ERROR", sanitizedMsg, {
        isRetryable: false,
        providerName: this.providerName,
        requestId: request.requestId,
        cause: err,
      });
    }

    return new ModelProviderError(
      "MODEL_PROVIDER_ERROR",
      sanitizedMsg || "Unhandled model provider failure",
      {
        isRetryable: false,
        providerName: this.providerName,
        requestId: request.requestId,
        cause: err,
      }
    );
  }
}
