/**
 * Ollama Local Model Provider Adapter for Emerald Agent Fabric.
 *
 * Implements ModelProviderPort (src/ports/model-provider.port.ts) to provide
 * local, open-source model execution via the local Ollama HTTP API (http://127.0.0.1:11434).
 *
 * Project Invariants:
 * 1. Zero Cost & Open-Source: ₹0 development/inference cost, zero commercial API dependency,
 *    no API keys, no paid subscriptions. Runs strictly against local open-source models.
 * 2. Model != Authority: This adapter confers ZERO execution authority.
 *    It does not execute tools, mutate persistence, create Actions/Attempts,
 *    or modify MissionContracts or Capability Policies. Model output is strictly untrusted.
 * 3. Provider Isolation: Local HTTP communication details are strictly contained
 *    within this adapter. Only provider-neutral ModelProviderResponse and
 *    Phase 6.1 domain errors (ModelProviderError hierarchy) leave this file.
 * 4. Single-Attempt Semantics: Performs exactly ONE HTTP request per generate() call.
 *    Zero internal retry or backoff loops. Zero automatic fallback models.
 * 5. Explicit Timeouts: Request timeoutMs is enforced and maps to ModelRequestTimeoutError.
 * 6. Cancellation Propagation: request.abortSignal is passed through and maps
 *    to ModelRequestCancelledError when triggered.
 * 7. Structured Output Translation: Maps provider-neutral ModelStructuredOutputSchema
 *    directly to Ollama format: schema.jsonSchema (strict JSON schema output).
 * 8. Zero Fabrication: Usage token counts are extracted from Ollama's prompt_eval_count
 *    and eval_count; never estimated or fabricated.
 * 9. Offline Testability: Dependency-injectable fetch transport allows 100% offline,
 *    deterministic unit and integration testing with zero external network access.
 */

import {
  ModelFinishReason,
  ModelMessage,
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
  ModelUsageMetadata,
  validateModelProviderRequest,
} from "../../ports/model-provider.port.js";
import {
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRequestCancelledError,
  ModelRequestInvalidError,
  ModelRequestTimeoutError,
  ModelResponseInvalidError,
} from "../../domain/errors.js";

// ============================================================================
// 1. Transport Abstraction for Dependency Injection / Hermetic Testing
// ============================================================================

/**
 * Structural interface matching the native fetch signature used by OllamaModelProvider.
 * Allows dependency injection for 100% offline testing with zero network traffic.
 */
export interface OllamaFetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

// ============================================================================
// 2. Configuration Options
// ============================================================================

export interface OllamaModelProviderOptions {
  /**
   * Base URL for the local Ollama runtime.
   * Defaults to process.env.OLLAMA_BASE_URL or "http://127.0.0.1:11434".
   */
  readonly baseURL?: string;

  /**
   * Default model name if not specified in request.
   * Defaults to process.env.OLLAMA_MODEL or "llama3.2".
   */
  readonly defaultModel?: string;

  /**
   * Default timeout in milliseconds (overridden by request.timeoutMs).
   * Defaults to 60000ms (1 minute).
   */
  readonly timeoutMs?: number;

  /**
   * Optional injected fetch implementation (for hermetic unit testing).
   */
  readonly fetch?: OllamaFetchLike;
}

// ============================================================================
// 3. Helper Functions
// ============================================================================

/**
 * Maps Ollama done_reason string to provider-neutral ModelFinishReason.
 */
function mapFinishReason(done: unknown, doneReason: unknown): ModelFinishReason {
  if (doneReason === "stop") return "STOP";
  if (doneReason === "length") return "LENGTH";
  if (done === true) return "STOP";
  return "OTHER";
}

// ============================================================================
// 4. OllamaModelProvider Implementation
// ============================================================================

export class OllamaModelProvider implements ModelProviderPort {
  readonly providerName = "ollama";

  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: OllamaFetchLike;

  constructor(options: OllamaModelProviderOptions = {}) {
    const rawBaseUrl =
      options.baseURL ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    this.baseURL = rawBaseUrl.replace(/\/+$/, "");
    this.defaultModel =
      options.defaultModel ?? process.env.OLLAMA_MODEL ?? "llama3.2";
    this.defaultTimeoutMs = options.timeoutMs ?? 60000;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as OllamaFetchLike);
  }

  /**
   * Returns the normalized chat completion endpoint URL.
   */
  get endpoint(): string {
    return `${this.baseURL}/api/chat`;
  }

  /**
   * Executes a single, non-retried model inference request against local Ollama.
   *
   * Invariants:
   * 1. Single attempt: Performs exactly ONE HTTP request. Zero internal retries or fallback models.
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

    // 3. Resolve target model
    const model = request.model || this.defaultModel;

    // 4. Translate conversation messages
    const messages = request.input.map((msg: ModelMessage) => ({
      role: msg.role,
      content: msg.content,
    }));

    // 5. Build Ollama request body
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    const gen = request.generation;
    if (gen) {
      // Structured Output Translation:
      // Ollama 0.5+ supports strict JSON schema directly via format: <jsonSchemaObject>
      if (gen.structuredOutput) {
        body.format = gen.structuredOutput.jsonSchema;
      }

      // Generation Options mapping
      const options: Record<string, unknown> = {};
      if (gen.temperature !== undefined) {
        options.temperature = gen.temperature;
      }
      if (gen.topP !== undefined) {
        options.top_p = gen.topP;
      }
      if (gen.maxOutputTokens !== undefined) {
        options.num_predict = gen.maxOutputTokens;
      }
      if (gen.stopSequences && gen.stopSequences.length > 0) {
        options.stop = [...gen.stopSequences];
      }

      if (Object.keys(options).length > 0) {
        body.options = options;
      }
    }

    // 6. Setup timeout and cooperative cancellation
    const effectiveTimeoutMs =
      request.timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    let didTimeout = false;
    let didAbort = false;

    const onCallerAbort = () => {
      didAbort = true;
      controller.abort(request.abortSignal?.reason);
    };

    if (request.abortSignal) {
      request.abortSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`Timeout of ${effectiveTimeoutMs}ms exceeded`));
    }, effectiveTimeoutMs);

    const startMs = Date.now();
    let rawResponse: Response;

    try {
      rawResponse = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (request.abortSignal) {
        request.abortSignal.removeEventListener("abort", onCallerAbort);
      }

      if (didAbort || request.abortSignal?.aborted) {
        throw new ModelRequestCancelledError("Model request was cancelled", {
          providerName: this.providerName,
          requestId: request.requestId,
          cause: err,
        });
      }

      if (didTimeout) {
        throw new ModelRequestTimeoutError(
          `Ollama model inference timed out after ${effectiveTimeoutMs}ms`,
          {
            timeoutMs: effectiveTimeoutMs,
            providerName: this.providerName,
            requestId: request.requestId,
            cause: err,
          }
        );
      }

      // Network unreachable / connection refused / DNS failure
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new ModelProviderUnavailableError(
        `Local Ollama runtime is unavailable at ${this.endpoint}: ${errorMsg}`,
        {
          providerName: this.providerName,
          requestId: request.requestId,
          cause: err,
        }
      );
    } finally {
      clearTimeout(timer);
      if (request.abortSignal) {
        request.abortSignal.removeEventListener("abort", onCallerAbort);
      }
    }

    const durationMs = Math.max(0, Date.now() - startMs);

    if (didAbort || request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError("Model request was cancelled", {
        providerName: this.providerName,
        requestId: request.requestId,
      });
    }

    if (didTimeout) {
      throw new ModelRequestTimeoutError(
        `Ollama model inference timed out after ${effectiveTimeoutMs}ms`,
        {
          timeoutMs: effectiveTimeoutMs,
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    // 7. Handle non-2xx HTTP responses
    if (!rawResponse.ok) {
      let errorBodyText = "";
      try {
        errorBodyText = await rawResponse.text();
      } catch {
        // ignore read failure
      }

      let parsedError: string | undefined;
      try {
        const errorJson = JSON.parse(errorBodyText);
        if (typeof errorJson?.error === "string") {
          parsedError = errorJson.error;
        }
      } catch {
        // raw text fallback
      }

      const message = parsedError || errorBodyText || `HTTP ${rawResponse.status} ${rawResponse.statusText}`;

      // Model not found or route not found -> 404
      if (rawResponse.status === 404) {
        throw new ModelRequestInvalidError(
          `Ollama reported model or endpoint not found: ${message}`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
          }
        );
      }

      // Bad request -> 400
      if (rawResponse.status === 400) {
        throw new ModelRequestInvalidError(
          `Ollama rejected request as invalid: ${message}`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
          }
        );
      }

      // Server error -> 500
      if (rawResponse.status >= 500) {
        throw new ModelProviderUnavailableError(
          `Ollama runtime encountered internal server error (${rawResponse.status}): ${message}`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
          }
        );
      }

      throw new ModelProviderError(
        "MODEL_PROVIDER_ERROR",
        `Ollama returned unexpected HTTP ${rawResponse.status}: ${message}`,
        {
          isRetryable: false,
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    // 8. Parse JSON response body
    let responseJson: Record<string, unknown>;
    try {
      const parsed = await rawResponse.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON object");
      }
      responseJson = parsed as Record<string, unknown>;
    } catch (parseErr: unknown) {
      throw new ModelResponseInvalidError(
        `Failed to parse Ollama JSON response: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`,
        {
          providerName: this.providerName,
          requestId: request.requestId,
          cause: parseErr,
        }
      );
    }

    // 9. Extract and validate message content
    const message = responseJson.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      throw new ModelResponseInvalidError(
        "Ollama response does not contain a valid 'message' object",
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    }

    const outputText = typeof message.content === "string" ? message.content : "";

    const finishReason = mapFinishReason(responseJson.done, responseJson.done_reason);

    // 10. Structured Output Conformance Check
    if (gen?.structuredOutput && finishReason === "STOP") {
      if (outputText.trim().length === 0) {
        throw new ModelResponseInvalidError(
          `Ollama returned empty output text when structured output schema '${gen.structuredOutput.name}' was requested`,
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
          `Ollama output text does not satisfy requested structured output schema '${gen.structuredOutput.name}' (invalid JSON): ${
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

    // 11. Usage Accounting (Never fabricated)
    let usage: ModelUsageMetadata | undefined;
    const promptEvalCount =
      typeof responseJson.prompt_eval_count === "number" &&
      Number.isInteger(responseJson.prompt_eval_count) &&
      responseJson.prompt_eval_count >= 0
        ? responseJson.prompt_eval_count
        : undefined;

    const evalCount =
      typeof responseJson.eval_count === "number" &&
      Number.isInteger(responseJson.eval_count) &&
      responseJson.eval_count >= 0
        ? responseJson.eval_count
        : undefined;

    if (promptEvalCount !== undefined || evalCount !== undefined) {
      const totalTokens =
        promptEvalCount !== undefined && evalCount !== undefined
          ? promptEvalCount + evalCount
          : undefined;

      usage = Object.freeze({
        ...(promptEvalCount !== undefined ? { inputTokens: promptEvalCount } : {}),
        ...(evalCount !== undefined ? { outputTokens: evalCount } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      });
    }

    // 12. Non-Authoritative Diagnostic Metadata
    const providerMetadata: Record<string, unknown> = {
      provider: this.providerName,
      ...(typeof responseJson.model === "string" ? { providerModel: responseJson.model } : {}),
      ...(typeof responseJson.total_duration === "number"
        ? { totalDurationNs: responseJson.total_duration }
        : {}),
      ...(typeof responseJson.load_duration === "number"
        ? { loadDurationNs: responseJson.load_duration }
        : {}),
      ...(typeof responseJson.prompt_eval_duration === "number"
        ? { promptEvalDurationNs: responseJson.prompt_eval_duration }
        : {}),
      ...(typeof responseJson.eval_duration === "number"
        ? { evalDurationNs: responseJson.eval_duration }
        : {}),
    };

    return Object.freeze({
      requestId: request.requestId,
      model: typeof responseJson.model === "string" ? responseJson.model : model,
      outputText,
      finishReason,
      ...(usage ? { usage } : {}),
      providerMetadata: Object.freeze(providerMetadata),
      durationMs,
    });
  }
}
