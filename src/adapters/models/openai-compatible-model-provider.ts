/**
 * OpenAI-Compatible Model Provider Adapter for Emerald Agent Fabric.
 *
 * Implements ModelProviderPort to support external providers offering
 * standard OpenAI-compatible HTTP endpoints (e.g., Groq, OpenAI, self-hosted vLLM).
 *
 * Invariants:
 * 1. Zero Authority: Model output is untrusted. No capability or state authority.
 * 2. Provider Independence: Domain and application layers remain free of external SDK dependencies.
 * 3. Security: API keys are sourced from process.env or runtime options only; never logged or serialized.
 * 4. Cost Governance: Tracks cumulative prompt/completion token spend and enforces spendCapUsd fail-closed.
 * 5. Single-Attempt Semantics: Performs a single HTTP request per generate() call. No internal retries.
 */

import {
  ModelMessage,
  ModelFinishReason,
  ModelProviderRequest,
  ModelProviderResponse,
  validateModelProviderRequest,
} from "../../domain/model-provider.js";
import {
  ModelProviderError,
  ModelProviderUnavailableError,
  ModelRateLimitedError,
  ModelRequestCancelledError,
  ModelRequestTimeoutError,
  ModelResponseInvalidError,
} from "../../domain/errors.js";
import { ModelProviderPort } from "../../ports/model-provider.port.js";
import type { EmeraldLifecycleTelemetry } from "../../application/observability-instrumentation.js";

export interface OpenAICompatibleModelProviderOptions {
  readonly providerName?: string;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly timeoutMs?: number;
  readonly spendCapUsd?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly telemetry?: EmeraldLifecycleTelemetry;
}

function parseResetDurationMs(val: string | null): number {
  if (!val) return 5000;
  const rawNum = Number(val);
  if (!Number.isNaN(rawNum) && rawNum > 0) return Math.ceil(rawNum * 1000);
  let ms = 0;
  const msMatch = val.match(/(\d+(?:\.\d+)?)\s*ms/i);
  if (msMatch && msMatch[1]) ms += parseFloat(msMatch[1]);
  const sMatch = val.match(/(\d+(?:\.\d+)?)\s*s(?![\w])/i);
  if (sMatch && sMatch[1]) ms += parseFloat(sMatch[1]) * 1000;
  const mMatch = val.match(/(\d+(?:\.\d+)?)\s*m(?![\w])/i);
  if (mMatch && mMatch[1]) ms += parseFloat(mMatch[1]) * 60_000;
  return ms > 0 ? Math.ceil(ms) : 5000;
}

export class OpenAICompatibleModelProvider implements ModelProviderPort {
  readonly providerName: string;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly spendCapUsd: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly telemetry?: EmeraldLifecycleTelemetry;

  private cumulativePromptTokens = 0;
  private cumulativeCompletionTokens = 0;
  private cumulativeEstimatedCostUsd = 0;

  constructor(options: OpenAICompatibleModelProviderOptions = {}) {
    this.providerName = options.providerName ?? process.env.EMERALD_MODEL_PROVIDER ?? "groq";
    const rawBaseUrl =
      options.baseURL ??
      (this.providerName === "groq"
        ? "https://api.groq.com/openai/v1"
        : "https://api.openai.com/v1");
    this.baseURL = rawBaseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.EMERALD_API_KEY ?? process.env.OPENAI_API_KEY;
    this.defaultModel = options.defaultModel ?? process.env.EMERALD_MODEL_NAME ?? "openai/gpt-oss-120b";
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000;
    this.spendCapUsd = options.spendCapUsd ?? parseFloat(process.env.EMERALD_SPEND_CAP_USD ?? "2.0");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.telemetry = options.telemetry;
  }

  get cumulativeSpend(): { promptTokens: number; completionTokens: number; costUsd: number } {
    return {
      promptTokens: this.cumulativePromptTokens,
      completionTokens: this.cumulativeCompletionTokens,
      costUsd: this.cumulativeEstimatedCostUsd,
    };
  }

  private calculateCostUsd(_model: string, promptTokens: number, completionTokens: number): number {
    // Conservative rates for hosted frontier / 120B models ($0.15/M input, $0.60/M output)
    const inputRatePerMillion = 0.15;
    const outputRatePerMillion = 0.60;
    return (promptTokens / 1_000_000) * inputRatePerMillion + (completionTokens / 1_000_000) * outputRatePerMillion;
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    validateModelProviderRequest(request);

    // Fail closed if spend cap reached
    if (this.cumulativeEstimatedCostUsd >= this.spendCapUsd) {
      throw new ModelProviderError(
        "MODEL_PROVIDER_ERROR",
        `Spend cap of $${this.spendCapUsd.toFixed(2)} exceeded (accumulated: $${this.cumulativeEstimatedCostUsd.toFixed(4)}). Halting inference fail-closed.`,
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

    const model = request.model || this.defaultModel;
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

    const effectiveTimeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const startMs = Date.now();
    let rawResponse: Response | undefined;
    let attempt = 0;
    const maxRetries = 3;

    while (attempt <= maxRetries) {
      attempt++;
      const remainingMs = effectiveTimeoutMs - (Date.now() - startMs);
      if (remainingMs <= 0 || request.abortSignal?.aborted) {
        break;
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

      const stepTimeoutMs = Math.min(remainingMs, 60_000);
      const timer = setTimeout(() => {
        didTimeout = true;
        controller.abort(new Error(`Timeout of ${stepTimeoutMs}ms exceeded`));
      }, stepTimeoutMs);

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
            `Inference request timed out after ${stepTimeoutMs}ms`,
            {
              providerName: this.providerName,
              requestId: request.requestId,
              timeoutMs: stepTimeoutMs,
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

      if (rawResponse.ok) {
        break;
      }

      let errorBody = "";
      try {
        errorBody = await rawResponse.text();
      } catch {
        /* best-effort */
      }

      const isRateLimit =
        rawResponse.status === 429 ||
        (rawResponse.status === 413 && /TPM|rate limit|tokens per minute/i.test(errorBody));

      if (isRateLimit && attempt <= maxRetries) {
        const resetHeader =
          rawResponse.headers.get("x-ratelimit-reset-tokens") ||
          rawResponse.headers.get("retry-after");
        const waitMs = Math.min(35_000, parseResetDurationMs(resetHeader) + 500);

        if (Date.now() - startMs + waitMs < effectiveTimeoutMs && !request.abortSignal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
      }

      if (rawResponse.status === 429) {
        throw new ModelRateLimitedError(
          `Provider rate limit exceeded (HTTP 429): ${errorBody.slice(0, 200)}`,
          { providerName: this.providerName, requestId: request.requestId }
        );
      }

      throw new ModelProviderUnavailableError(
        `Provider returned HTTP error ${rawResponse.status}: ${errorBody.slice(0, 200)}`,
        { providerName: this.providerName, requestId: request.requestId }
      );
    }

    if (!rawResponse || !rawResponse.ok) {
      throw new ModelProviderUnavailableError(
        `Inference request failed after ${attempt} attempts`,
        { providerName: this.providerName, requestId: request.requestId }
      );
    }

    const durationMs = Date.now() - startMs;

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
    const outputText = choice?.message?.content ?? "";
    const rawFinishReason = choice?.finish_reason;

    let finishReason: ModelFinishReason = "OTHER";
    if (rawFinishReason === "stop") finishReason = "STOP";
    else if (rawFinishReason === "length") finishReason = "LENGTH";
    else if (rawFinishReason === "content_filter") finishReason = "CONTENT_FILTER";

    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const totalTokens = payload.usage?.total_tokens ?? (promptTokens + completionTokens);

    this.cumulativePromptTokens += promptTokens;
    this.cumulativeCompletionTokens += completionTokens;
    const callCost = this.calculateCostUsd(model, promptTokens, completionTokens);
    this.cumulativeEstimatedCostUsd += callCost;

    this.telemetry?.recordModelInvocation({
      provider: this.providerName,
      model,
      status: "ok",
      durationMs,
      startTimeIso: new Date(startMs).toISOString(),
      endTimeIso: new Date().toISOString(),
      requestId: request.requestId,
      promptTokens,
      completionTokens,
    });

    return {
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
  }
}
