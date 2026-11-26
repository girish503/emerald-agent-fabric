/**
 * Shared Model Gateway Hardening Policy Helpers.
 *
 * Enforces allowlist validation, fail-closed spend-cap checks, privacy-preserving
 * telemetry preview digests, and bounded retries strictly for idempotent reads.
 *
 * Operational Policy Notes:
 * - Strict config/allowlist mode is opt-in via `EMERALD_STRICT_ENV_CONFIG=true` or
 *   explicit `allowedModels` (`OLLAMA_ALLOWED_MODELS` / `EMERALD_ALLOWED_MODELS`).
 * - The default Fastify server path (`emerald-cli.ts` -> `buildFastifyServer`) is not
 *   strict by default and wires `DeterministicFixtureModelProvider` by default.
 * - `ModelProviderPort.generate()` is strictly single-attempt; bounded HTTP 429 (and
 *   provider-confirmed non-processing 5xx) retry/backoff lives at the router/caller
 *   layer (`dispatchWithRateLimitRetry` in `governed-model-router.ts` / `AgentStepController`).
 */

import * as crypto from "node:crypto";
import type { ModelMessage } from "../../domain/model-provider.js";
import { redactTraceString } from "../../domain/trace.js";
import {
  ModelProviderError,
  ModelRequestInvalidError,
} from "../../domain/errors.js";

/**
 * Resolves an explicit allowlist array or comma-separated environment variable.
 * Returns `undefined` only when neither `explicit` nor `envRaw` was provided.
 */
export function resolveModelAllowlist(
  explicit?: readonly string[],
  envRaw?: string
): readonly string[] | undefined {
  if (explicit !== undefined) {
    return Object.freeze(explicit.map((m) => m.trim()).filter((m) => m.length > 0));
  }
  if (envRaw !== undefined && envRaw.trim().length > 0) {
    return Object.freeze(
      envRaw
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    );
  }
  return undefined;
}

/**
 * Enforces model allowlisting fail-closed before dispatching any provider request.
 */
export function assertModelAllowed(
  model: string,
  allowlist: readonly string[] | undefined,
  context: {
    readonly providerName: string;
    readonly requestId: string;
    readonly requireAllowlist?: boolean;
  }
): void {
  if (!model || model.trim().length === 0) {
    throw new ModelRequestInvalidError(
      `Model identifier is required for provider '${context.providerName}'`,
      { providerName: context.providerName, requestId: context.requestId }
    );
  }

  if (allowlist === undefined) {
    if (context.requireAllowlist) {
      throw new ModelRequestInvalidError(
        `Model '${model}' rejected fail-closed: no model allowlist is configured for provider '${context.providerName}'`,
        { providerName: context.providerName, requestId: context.requestId }
      );
    }
    return;
  }

  if (!allowlist.includes(model)) {
    throw new ModelRequestInvalidError(
      `Model '${model}' is not in the configured allowlist for provider '${context.providerName}'`,
      { providerName: context.providerName, requestId: context.requestId }
    );
  }
}

/**
 * Parses and validates spendCapUsd fail-closed. Returns NaN-safe finite number >= 0,
 * or throws ModelProviderError if invalid or negative.
 */
export function parseSpendCapUsd(
  explicitCap: number | undefined,
  envRaw: string | undefined,
  defaultCap: number,
  providerName: string
): number {
  let resolved: number;
  if (explicitCap !== undefined) {
    resolved = explicitCap;
  } else if (envRaw !== undefined && envRaw.trim().length > 0) {
    resolved = Number(envRaw.trim());
  } else {
    resolved = defaultCap;
  }

  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved < 0) {
    throw new ModelProviderError(
      "MODEL_PROVIDER_ERROR",
      `Invalid spendCapUsd '${String(explicitCap ?? envRaw)}' for provider '${providerName}'; refusing fail-closed.`,
      { isRetryable: false, providerName, requestId: "config" }
    );
  }
  return resolved;
}

/**
 * Enforces cumulative spend cap BEFORE executing an inference call.
 */
export function assertWithinSpendCap(params: {
  readonly providerName: string;
  readonly requestId: string;
  readonly cumulativeCostUsd: number;
  readonly spendCapUsd: number;
  readonly rejectZeroCap: boolean;
}): void {
  const { providerName, requestId, cumulativeCostUsd, spendCapUsd, rejectZeroCap } = params;

  if (!Number.isFinite(spendCapUsd) || spendCapUsd < 0) {
    throw new ModelProviderError(
      "MODEL_PROVIDER_ERROR",
      `Invalid spend cap (${String(spendCapUsd)}) for provider '${providerName}'. Halting inference fail-closed.`,
      { isRetryable: false, providerName, requestId }
    );
  }

  if (rejectZeroCap && spendCapUsd <= 0) {
    throw new ModelProviderError(
      "MODEL_PROVIDER_ERROR",
      `Spend cap of $${spendCapUsd.toFixed(2)} prohibits paid inference on provider '${providerName}'. Halting fail-closed.`,
      { isRetryable: false, providerName, requestId }
    );
  }

  const breached = rejectZeroCap
    ? cumulativeCostUsd >= spendCapUsd
    : cumulativeCostUsd > spendCapUsd || (spendCapUsd > 0 && cumulativeCostUsd >= spendCapUsd);

  if (breached) {
    throw new ModelProviderError(
      "MODEL_PROVIDER_ERROR",
      `Spend cap of $${spendCapUsd.toFixed(2)} exceeded (accumulated: $${cumulativeCostUsd.toFixed(4)}). Halting inference fail-closed.`,
      { isRetryable: false, providerName, requestId }
    );
  }
}

/**
 * Privacy-by-default telemetry preview builder: returns SHA-256 digests + byte/char counts
 * unless raw telemetry is explicitly opted in (and even then redacts secret-shaped strings).
 */
export function buildTelemetryPreviews(
  messages: readonly ModelMessage[],
  outputText: string | undefined,
  includeRawPromptTelemetry: boolean
): {
  readonly promptPreview: unknown;
  readonly outputPreview?: unknown;
} {
  const promptPreview = includeRawPromptTelemetry
    ? messages.map((m) => ({ role: m.role, content: redactTraceString(m.content, 512) }))
    : {
        redactedMode: "sha256_metadata_only",
        messageCount: messages.length,
        totalChars: messages.reduce((acc, m) => acc + m.content.length, 0),
        sha256: crypto.createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex"),
      };

  if (outputText === undefined) {
    return { promptPreview };
  }

  const outputPreview = includeRawPromptTelemetry
    ? redactTraceString(outputText, 512)
    : {
        redactedMode: "sha256_metadata_only",
        charLength: outputText.length,
        sha256: crypto.createHash("sha256").update(outputText, "utf8").digest("hex"),
      };

  return { promptPreview, outputPreview };
}

/**
 * Bounded exponential-backoff retry helper strictly for idempotent read operations (e.g., GET /api/tags).
 * Never use for non-idempotent / mutating POST inference calls.
 */
export async function retryIdempotentRead<T>(
  operationKind: "idempotent_read",
  fn: () => Promise<T>,
  options: {
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
    readonly isRetryable?: (err: unknown) => boolean;
  } = {}
): Promise<T> {
  if (operationKind !== "idempotent_read") {
    throw new Error("Retries are permitted strictly for idempotent read operations.");
  }
  const maxRetries = Math.max(0, Math.min(5, Math.floor(options.maxRetries ?? 2)));
  const baseDelayMs = Math.max(10, Math.floor(options.baseDelayMs ?? 100));
  const isRetryable = options.isRetryable ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delayMs = Math.min(2000, baseDelayMs * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
