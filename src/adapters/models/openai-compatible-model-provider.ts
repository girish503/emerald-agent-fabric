/**
 * OpenAI-Compatible Model Provider Adapter for Emerald Agent Fabric.
 *
 * Implements ModelProviderPort to support external providers offering
 * standard OpenAI-compatible HTTP endpoints (e.g., self-hosted vLLM or explicitly configured endpoints).
 *
 * Invariants:
 * 1. Zero Authority: Model output is untrusted. No capability or state authority.
 * 2. Provider Independence: Domain and application layers remain free of external SDK dependencies.
 * 3. Env-Only Configuration: No hardcoded cloud endpoints, keys, or model defaults; explicit config required.
 * 4. Allowlist & Cost Governance: Rejects unallowlisted models and enforces spendCapUsd fail-closed.
 * 5. Single-Attempt Semantics: Performs a single HTTP POST request per generate() call. No internal retries.
 * 6. Privacy-Preserving Telemetry: Logs tokens, cost, latency, and traceId on every call without secrets.
 */

import {
  ModelMessage,
  ModelFinishReason,
  ModelProviderRequest,
  ModelProviderResponse,
  validateModelProviderRequest,
} from "../../domain/model-provider.js";
import { redactTraceString } from "../../domain/trace.js";
import {
  ModelProviderUnavailableError,
  ModelRateLimitedError,
  ModelRequestCancelledError,
  ModelRequestInvalidError,
  ModelRequestTimeoutError,
  ModelResponseInvalidError,
} from "../../domain/errors.js";
import { ModelProviderPort } from "../../ports/model-provider.port.js";
import type { EmeraldLifecycleTelemetry } from "../../application/observability-instrumentation.js";
import {
  assertModelAllowed,
  assertWithinSpendCap,
  buildTelemetryPreviews,
  parseSpendCapUsd,
  resolveModelAllowlist,
} from "./gateway-policy.js";

export interface OpenAICompatibleModelProviderOptions {
  readonly providerName?: string;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly allowedModels?: readonly string[];
  readonly timeoutMs?: number;
  readonly spendCapUsd?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly telemetry?: EmeraldLifecycleTelemetry;
  readonly includeRawPromptTelemetry?: boolean;
}

/**
 * Parses Retry-After or Groq rate-limit reset headers (seconds, ms/s/m durations, or HTTP-date)
 * into milliseconds for upstream caller/router retry scheduling.
 */
function parseResetDurationMs(val: string | null): number | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  if (trimmed.length === 0) return undefined;
  const rawNum = Number(trimmed);
  if (Number.isFinite(rawNum) && rawNum > 0) return Math.ceil(rawNum * 1000);
  let ms = 0;
  const msMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*ms/i);
  if (msMatch && msMatch[1]) ms += parseFloat(msMatch[1]);
  const sMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*s(?![\w])/i);
  if (sMatch && sMatch[1]) ms += parseFloat(sMatch[1]) * 1000;
  const mMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*m(?![\w])/i);
  if (mMatch && mMatch[1]) ms += parseFloat(mMatch[1]) * 60_000;
  if (ms > 0) return Math.ceil(ms);
  const parsedDateMs = Date.parse(trimmed);
  if (Number.isFinite(parsedDateMs)) {
    const delta = parsedDateMs - Date.now();
    if (delta > 0) return Math.ceil(delta);
  }
  return undefined;
}

export class OpenAICompatibleModelProvider implements ModelProviderPort {
  readonly providerName: string;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly defaultModel?: string;
  private readonly allowedModels?: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly spendCapUsd: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly telemetry?: EmeraldLifecycleTelemetry;
  private readonly includeRawPromptTelemetry: boolean;

  private cumulativePromptTokens = 0;
  private cumulativeCompletionTokens = 0;
  private cumulativeEstimatedCostUsd = 0;

  constructor(options: OpenAICompatibleModelProviderOptions = {}) {
    this.providerName =
      options.providerName ??
      process.env.EMERALD_MODEL_PROVIDER?.trim() ??
      "openai-compatible";
    const rawBaseUrl =
      options.baseURL ??
      process.env.EMERALD_MODEL_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      "";
    this.baseURL = rawBaseUrl.trim().replace(/\/+$/, "");
    this.apiKey =
      options.apiKey ?? process.env.EMERALD_API_KEY ?? process.env.OPENAI_API_KEY;
    const rawDefaultModel =
      options.defaultModel ?? process.env.EMERALD_MODEL_NAME;
    this.defaultModel =
      rawDefaultModel && rawDefaultModel.trim().length > 0
        ? rawDefaultModel.trim()
        : undefined;
    const explicitOrEnvAllowlist = resolveModelAllowlist(
      options.allowedModels,
      process.env.EMERALD_ALLOWED_MODELS
    );
    this.allowedModels =
      explicitOrEnvAllowlist ??
      (this.defaultModel ? Object.freeze([this.defaultModel]) : undefined);
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
    this.spendCapUsd = parseSpendCapUsd(
      options.spendCapUsd,
      process.env.EMERALD_SPEND_CAP_USD,
      0,
      this.providerName
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.telemetry = options.telemetry;
    this.includeRawPromptTelemetry = options.includeRawPromptTelemetry ?? false;
  }

  get cumulativeSpend(): { promptTokens: number; completionTokens: number; costUsd: number } {
    return {
      promptTokens: this.cumulativePromptTokens,
      completionTokens: this.cumulativeCompletionTokens,
      costUsd: this.cumulativeEstimatedCostUsd,
    };
  }

  private calculateCostUsd(_model: string, promptTokens: number, completionTokens: number): number {
    // Conservative rates for hosted models ($0.15/M input, $0.60/M output)
    const inputRatePerMillion = 0.15;
    const outputRatePerMillion = 0.60;
    return (
      (promptTokens / 1_000_000) * inputRatePerMillion +
      (completionTokens / 1_000_000) * outputRatePerMillion
    );
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const startMs = Date.now();
    const startTimeIso = new Date(startMs).toISOString();
    const traceId = request?.traceId ?? request?.requestId;

    try {
      const { response, callCost } = await this.generateCore(request, startMs);
      const { promptPreview, outputPreview } = buildTelemetryPreviews(
        request.input,
        response.outputText,
        this.includeRawPromptTelemetry
      );
      this.telemetry?.recordModelInvocation({
        provider: this.providerName,
        model: response.model,
        status: "ok",
        durationMs: response.durationMs,
        startTimeIso,
        endTimeIso: new Date().toISOString(),
        requestId: request.requestId,
        traceId,
        costUsd: callCost,
        promptPreview,
        outputPreview,
        promptTokens: response.usage?.inputTokens,
        completionTokens: response.usage?.outputTokens,
      });
      return response;
    } catch (err: unknown) {
      const status =
        err instanceof ModelRequestTimeoutError
          ? "timeout"
          : err instanceof ModelRequestCancelledError
            ? "cancelled"
            : err instanceof ModelProviderUnavailableError
              ? "unavailable"
              : "error";
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      this.telemetry?.recordModelInvocation({
        provider: this.providerName,
        model: request?.model || this.defaultModel || "unconfigured",
        status,
        durationMs: Math.max(0, Date.now() - startMs),
        startTimeIso,
        endTimeIso: new Date().toISOString(),
        requestId: request?.requestId ?? "invalid-request",
        traceId,
        costUsd: 0,
        errorMessage: redactTraceString(rawErrMsg, 256),
      });
      throw err;
    }
  }

  private async generateCore(
    request: ModelProviderRequest,
    startMs: number
  ): Promise<{ readonly response: ModelProviderResponse; readonly callCost: number }> {
    validateModelProviderRequest(request);

    // 1. Fail closed if spend cap reached or zero cap prohibits paid inference
    assertWithinSpendCap({
      providerName: this.providerName,
      requestId: request.requestId,
      cumulativeCostUsd: this.cumulativeEstimatedCostUsd,
      spendCapUsd: this.spendCapUsd,
      rejectZeroCap: true,
    });

    // 2. Require explicit endpoint & API key (no silent cloud defaults)
    if (!this.baseURL) {
      throw new ModelProviderUnavailableError(
        `Base URL for provider '${this.providerName}' is not configured. Set options.baseURL, EMERALD_MODEL_BASE_URL, or OPENAI_BASE_URL.`,
        { providerName: this.providerName, requestId: request.requestId }
      );
    }

    if (!this.apiKey) {
      throw new ModelProviderUnavailableError(
        `API key for provider '${this.providerName}' is not set. EMERALD_API_KEY or OPENAI_API_KEY required.`,
        { providerName: this.providerName, requestId: request.requestId }
      );
    }

    if (request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError("Model request was cancelled prior to dispatch", {
        providerName: this.providerName,
        requestId: request.requestId,
      });
    }

    // 3. Resolve model & enforce allowlist fail-closed
    const model = request.model || this.defaultModel || "";
    assertModelAllowed(model, this.allowedModels, {
      providerName: this.providerName,
      requestId: request.requestId,
      requireAllowlist: true,
    });

    const messages = request.input.map((msg: ModelMessage) => ({
      role: msg.role,
      content: msg.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.generation?.temperature ?? 0.0,
    };

    if (request.generation?.maxOutputTokens !== undefined) {
      body.max_tokens = Math.min(1024, request.generation.maxOutputTokens);
    }
    if (request.generation?.topP !== undefined) {
      body.top_p = request.generation.topP;
    }
    if (request.generation?.stopSequences && request.generation.stopSequences.length > 0) {
      body.stop = [...request.generation.stopSequences];
    }
    if (request.generation?.structuredOutput) {
      body.response_format = { type: "json_object" };
      const schemaInstruction = `\n\n[OUTPUT FORMAT REQUIREMENT]\nYou must respond with a JSON object matching one of these two forms:\n\nForm 1: Propose Tool Action\n{\n  "isGoalReached": false,\n  "proposalId": "prop-<id>",\n  "toolName": "<exact_tool_name_from_available_tools>",\n  "contextSnapshotHash": "<exact_contextSnapshotHash>",\n  "rationale": "<brief reason for action>",\n  "inputPayload": { <tool input parameters matching Available Tools> }\n}\n\nForm 2: Goal Reached (no tool action)\n{\n  "isGoalReached": true,\n  "proposalId": "prop-<id>",\n  "rationale": "<explanation of completion>"\n}\n\nCRITICAL RULES:\n1. 'isGoalReached' is a required boolean discriminator.\n2. When proposing an action, 'isGoalReached' MUST be false, and 'proposalId', 'toolName', 'inputPayload', and 'contextSnapshotHash' are required.\n3. 'toolName' must be exact (e.g., read_file, edit_file, write_file, run_command, search_code, git_status, git_diff).\n4. In 'inputPayload', the target file parameter must always be named 'path' (never filePath).\n5. For edit_file, the parameters are 'path', 'searchAnchor', 'replacementText'.\n6. Output raw JSON only with no markdown backticks.`;

      const systemIdx = messages.findIndex((m) => m.role === "system");
      if (systemIdx >= 0) {
        messages[systemIdx] = {
          role: "system",
          content: messages[systemIdx]!.content + schemaInstruction,
        };
      } else {
        messages.unshift({
          role: "system",
          content: schemaInstruction,
        });
      }
    }

    // 4. Single-attempt dispatch with strict per-request timeout (never retry POST inference calls)
    const effectiveTimeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
      throw new ModelRequestInvalidError("timeoutMs must be a positive finite number", {
        providerName: this.providerName,
        requestId: request.requestId,
      });
    }

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

    let rawResponse: Response;
    try {
      rawResponse = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
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
        throw new ModelRequestCancelledError("Inference request was cancelled during execution", {
          providerName: this.providerName,
          requestId: request.requestId,
        });
      }

      if (didTimeout) {
        throw new ModelRequestTimeoutError(
          `Inference request timed out after ${effectiveTimeoutMs}ms`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
            timeoutMs: effectiveTimeoutMs,
          }
        );
      }

      throw new ModelProviderUnavailableError(
        `Failed to reach model provider endpoint '${this.baseURL}': ${err instanceof Error ? err.message : String(err)}`,
        {
          providerName: this.providerName,
          requestId: request.requestId,
        }
      );
    } finally {
      clearTimeout(timer);
      if (request.abortSignal) {
        request.abortSignal.removeEventListener("abort", onCallerAbort);
      }
    }

    if (didAbort || request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError("Inference request was cancelled during execution", {
        providerName: this.providerName,
        requestId: request.requestId,
      });
    }

    if (didTimeout) {
      throw new ModelRequestTimeoutError(
        `Inference request timed out after ${effectiveTimeoutMs}ms`,
        {
          providerName: this.providerName,
          requestId: request.requestId,
          timeoutMs: effectiveTimeoutMs,
        }
      );
    }

    if (!rawResponse.ok) {
      let errorBody = "";
      try {
        errorBody = await rawResponse.text();
      } catch {
        /* best-effort */
      }

      const safeErrBody = redactTraceString(errorBody, 200);
      if (rawResponse.status === 429) {
        const resetHeader =
          rawResponse.headers.get("retry-after") ||
          rawResponse.headers.get("x-ratelimit-reset-tokens") ||
          rawResponse.headers.get("x-ratelimit-reset-requests");
        const retryAfterMs = parseResetDurationMs(resetHeader);
        throw new ModelRateLimitedError(
          `Provider rate limit exceeded (HTTP 429): ${safeErrBody}`,
          {
            providerName: this.providerName,
            requestId: request.requestId,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          }
        );
      }
      if (rawResponse.status === 400 || rawResponse.status === 404) {
        throw new ModelRequestInvalidError(
          `Provider rejected request (HTTP ${rawResponse.status}): ${safeErrBody}`,
          { providerName: this.providerName, requestId: request.requestId }
        );
      }
      const confirmedNonProcessing =
        rawResponse.status >= 500 &&
        (rawResponse.headers.get("x-request-not-processed") === "true" ||
          rawResponse.headers.get("x-emerald-non-processing") === "true");
      throw new ModelProviderUnavailableError(
        `Provider returned HTTP error ${rawResponse.status}: ${safeErrBody}`,
        {
          providerName: this.providerName,
          requestId: request.requestId,
          ...(confirmedNonProcessing ? { confirmedNonProcessing: true } : {}),
        }
      );
    }

    const durationMs = Math.max(0, Date.now() - startMs);

    let payload: any;
    try {
      payload = await rawResponse.json();
    } catch (err: unknown) {
      throw new ModelResponseInvalidError(
        `Provider returned invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
        { providerName: this.providerName, requestId: request.requestId }
      );
    }

    const choice = payload.choices?.[0];
    if (!choice || typeof choice !== "object") {
      throw new ModelResponseInvalidError(
        "Provider response missing valid 'choices[0]' entry",
        { providerName: this.providerName, requestId: request.requestId }
      );
    }
    const outputText = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const rawFinishReason = choice?.finish_reason;

    let finishReason: ModelFinishReason = "OTHER";
    if (rawFinishReason === "stop") finishReason = "STOP";
    else if (rawFinishReason === "length") finishReason = "LENGTH";
    else if (rawFinishReason === "content_filter") finishReason = "CONTENT_FILTER";

    const promptTokens =
      typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : 0;
    const completionTokens =
      typeof payload.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : 0;
    const totalTokens =
      typeof payload.usage?.total_tokens === "number"
        ? payload.usage.total_tokens
        : promptTokens + completionTokens;

    this.cumulativePromptTokens += promptTokens;
    this.cumulativeCompletionTokens += completionTokens;
    const callCost = this.calculateCostUsd(model, promptTokens, completionTokens);
    this.cumulativeEstimatedCostUsd += callCost;

    const response: ModelProviderResponse = {
      requestId: request.requestId,
      model,
      outputText,
      finishReason,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        totalTokens,
      },
      durationMs,
      providerMetadata: {
        httpStatus: rawResponse.status,
        callCostUsd: callCost,
        cumulativeCostUsd: this.cumulativeEstimatedCostUsd,
      },
    };

    return { response, callCost };
  }
}
