/**
 * Model Provider Domain Models and Contracts for Emerald Agent Fabric.
 *
 * Defines the provider-independent message, generation, request, response,
 * and usage types mediating between agent reasoning (AgentBrainPort) and
 * concrete model provider adapters (OpenAI, Anthropic, Gemini, local models).
 *
 * Architectural Invariants:
 * 1. Model != Authority: The model provider is an untrusted external dependency.
 *    It must NEVER receive authority over MissionContracts, capabilities, policies,
 *    workspaces, credentials, worker IDs, lease IDs, retries, attempts, or ToolGateway.
 * 2. Provider Independence: Zero model SDK types (no OpenAI, Anthropic, Gemini, LangChain).
 * 3. Single-Attempt Semantics: The provider contract performs no internal retry loops.
 * 4. Explicit Timeouts: Request timeoutMs is a lower-level inference deadline, distinct
 *    from AgentStepController wall-clock budget.
 * 5. Cancellation: AbortSignal is observed and propagates as ModelRequestCancelledError.
 * 6. Informational Metadata: Provider metadata is strictly non-authoritative diagnostic data.
 */

import {
  ModelRequestInvalidError,
  ModelResponseInvalidError,
} from "./errors.js";

// ============================================================================
// 1. Message Model
// ============================================================================

export type ModelMessageRole = "system" | "user" | "assistant";

export const MODEL_MESSAGE_ROLES: readonly ModelMessageRole[] = Object.freeze([
  "system",
  "user",
  "assistant",
]);

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
  readonly name?: string;
}

// ============================================================================
// 2. Structured Output Schema Descriptor
// ============================================================================

export interface ModelStructuredOutputSchema {
  /**
   * Logical identifier for the schema (e.g., "action_proposal").
   */
  readonly name: string;

  /**
   * Provider-independent JSON Schema object specifying the required structure.
   */
  readonly jsonSchema: Readonly<Record<string, unknown>>;

  /**
   * Optional human-readable description for models that consume schema docstrings.
   */
  readonly description?: string;

  /**
   * Whether strict schema conformance is enforced (default: true).
   */
  readonly strict?: boolean;
}

// ============================================================================
// 3. Generation Options
// ============================================================================

export interface ModelGenerationOptions {
  /**
   * Sampling temperature, bounded in [0.0, 2.0].
   */
  readonly temperature?: number;

  /**
   * Maximum tokens to generate. Must be a positive integer.
   */
  readonly maxOutputTokens?: number;

  /**
   * Nucleus sampling cutoff, bounded in (0.0, 1.0].
   */
  readonly topP?: number;

  /**
   * Optional stop sequences (strings upon which generation halts).
   */
  readonly stopSequences?: readonly string[];

  /**
   * Optional structured output schema requirement.
   */
  readonly structuredOutput?: ModelStructuredOutputSchema;
}

// ============================================================================
// 4. Request Model
// ============================================================================

export interface ModelProviderRequest {
  /**
   * Unique client-generated correlation ID for this inference call.
   */
  readonly requestId: string;

  /**
   * Logical model identifier (e.g., "gpt-4o", "claude-3-7-sonnet", "gemini-1.5-pro").
   */
  readonly model: string;

  /**
   * Input conversation history. Must contain at least one message.
   */
  readonly input: readonly ModelMessage[];

  /**
   * Optional provider-neutral generation parameters.
   */
  readonly generation?: ModelGenerationOptions;

  /**
   * Request timeout ceiling in milliseconds. Must be a positive integer.
   */
  readonly timeoutMs: number;

  /**
   * Optional cooperative cancellation signal.
   */
  readonly abortSignal?: AbortSignal;
}

// ============================================================================
// 5. Usage Metadata
// ============================================================================

export interface ModelUsageMetadata {
  /**
   * Number of tokens in the prompt/input, if provided by the model provider.
   */
  readonly inputTokens?: number;

  /**
   * Number of tokens generated in the output, if provided by the model provider.
   */
  readonly outputTokens?: number;

  /**
   * Total token count (input + output), if provided by the model provider.
   */
  readonly totalTokens?: number;
}

// ============================================================================
// 6. Finish Reasons
// ============================================================================

export type ModelFinishReason =
  | "STOP"
  | "LENGTH"
  | "CONTENT_FILTER"
  | "CANCELLED"
  | "ERROR"
  | "OTHER";

export const MODEL_FINISH_REASONS: readonly ModelFinishReason[] = Object.freeze([
  "STOP",
  "LENGTH",
  "CONTENT_FILTER",
  "CANCELLED",
  "ERROR",
  "OTHER",
]);

// ============================================================================
// 7. Response Model
// ============================================================================

export interface ModelProviderResponse {
  /**
   * Correlation ID echoing the request.
   */
  readonly requestId: string;

  /**
   * Canonical model identifier reported by provider.
   */
  readonly model: string;

  /**
   * Raw text generated by the model. If structuredOutput was requested,
   * this contains the serialized JSON payload to be parsed upstream.
   */
  readonly outputText: string;

  /**
   * Termination reason reported by the provider.
   */
  readonly finishReason: ModelFinishReason;

  /**
   * Token usage metadata, if supplied by the provider.
   * If unavailable, left undefined (never fabricated).
   */
  readonly usage?: ModelUsageMetadata;

  /**
   * Untrusted provider-specific diagnostic metadata (e.g. latency breakdown,
   * system fingerprint, HTTP status). NEVER bears runtime authority.
   */
  readonly providerMetadata?: Readonly<Record<string, unknown>>;

  /**
   * Elapsed time in milliseconds for the inference call.
   */
  readonly durationMs: number;
}

// ============================================================================
// 8. Invariant Validators
// ============================================================================

/**
 * Validates a ModelProviderRequest for structural conformance and invariant integrity.
 * Throws ModelRequestInvalidError if invalid.
 */
export function validateModelProviderRequest(request: ModelProviderRequest): void {
  if (!request || typeof request !== "object") {
    throw new ModelRequestInvalidError("ModelProviderRequest must be a non-null object");
  }

  if (typeof request.requestId !== "string" || request.requestId.trim().length === 0) {
    throw new ModelRequestInvalidError("requestId must be a non-empty string");
  }

  if (typeof request.model !== "string" || request.model.trim().length === 0) {
    throw new ModelRequestInvalidError("model must be a non-empty string", {
      requestId: request.requestId,
    });
  }

  if (!Array.isArray(request.input) || request.input.length === 0) {
    throw new ModelRequestInvalidError("input must be a non-empty array of ModelMessage objects", {
      requestId: request.requestId,
    });
  }

  for (let i = 0; i < request.input.length; i++) {
    const msg = request.input[i];
    if (!msg || typeof msg !== "object") {
      throw new ModelRequestInvalidError(`input[${i}] must be a non-null ModelMessage object`, {
        requestId: request.requestId,
      });
    }

    if (!MODEL_MESSAGE_ROLES.includes(msg.role)) {
      throw new ModelRequestInvalidError(
        `input[${i}].role '${String(msg.role)}' is invalid; expected one of: ${MODEL_MESSAGE_ROLES.join(", ")}`,
        { requestId: request.requestId }
      );
    }

    if (typeof msg.content !== "string") {
      throw new ModelRequestInvalidError(`input[${i}].content must be a string`, {
        requestId: request.requestId,
      });
    }

    if (msg.name !== undefined && (typeof msg.name !== "string" || msg.name.trim().length === 0)) {
      throw new ModelRequestInvalidError(`input[${i}].name must be a non-empty string if provided`, {
        requestId: request.requestId,
      });
    }
  }

  if (
    typeof request.timeoutMs !== "number" ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0
  ) {
    throw new ModelRequestInvalidError("timeoutMs must be a positive finite number", {
      requestId: request.requestId,
    });
  }

  if (request.generation !== undefined) {
    const gen = request.generation;
    if (!gen || typeof gen !== "object" || Array.isArray(gen)) {
      throw new ModelRequestInvalidError("generation options must be a valid object if provided", {
        requestId: request.requestId,
      });
    }

    if (
      gen.temperature !== undefined &&
      (typeof gen.temperature !== "number" ||
        !Number.isFinite(gen.temperature) ||
        gen.temperature < 0 ||
        gen.temperature > 2)
    ) {
      throw new ModelRequestInvalidError("temperature must be a finite number between 0.0 and 2.0", {
        requestId: request.requestId,
      });
    }

    if (
      gen.maxOutputTokens !== undefined &&
      (typeof gen.maxOutputTokens !== "number" ||
        !Number.isInteger(gen.maxOutputTokens) ||
        gen.maxOutputTokens <= 0)
    ) {
      throw new ModelRequestInvalidError("maxOutputTokens must be a positive integer", {
        requestId: request.requestId,
      });
    }

    if (
      gen.topP !== undefined &&
      (typeof gen.topP !== "number" ||
        !Number.isFinite(gen.topP) ||
        gen.topP <= 0 ||
        gen.topP > 1)
    ) {
      throw new ModelRequestInvalidError("topP must be a finite number in range (0.0, 1.0]", {
        requestId: request.requestId,
      });
    }

    if (gen.stopSequences !== undefined) {
      if (!Array.isArray(gen.stopSequences)) {
        throw new ModelRequestInvalidError("stopSequences must be an array of strings if provided", {
          requestId: request.requestId,
        });
      }
      for (let s = 0; s < gen.stopSequences.length; s++) {
        if (typeof gen.stopSequences[s] !== "string" || gen.stopSequences[s].length === 0) {
          throw new ModelRequestInvalidError(
            `stopSequences[${s}] must be a non-empty string`,
            { requestId: request.requestId }
          );
        }
      }
    }

    if (gen.structuredOutput !== undefined) {
      const so = gen.structuredOutput;
      if (!so || typeof so !== "object" || Array.isArray(so)) {
        throw new ModelRequestInvalidError("structuredOutput must be a valid object if provided", {
          requestId: request.requestId,
        });
      }

      if (typeof so.name !== "string" || so.name.trim().length === 0) {
        throw new ModelRequestInvalidError("structuredOutput.name must be a non-empty string", {
          requestId: request.requestId,
        });
      }

      if (!so.jsonSchema || typeof so.jsonSchema !== "object" || Array.isArray(so.jsonSchema)) {
        throw new ModelRequestInvalidError("structuredOutput.jsonSchema must be a non-null object", {
          requestId: request.requestId,
        });
      }

      if (so.description !== undefined && typeof so.description !== "string") {
        throw new ModelRequestInvalidError("structuredOutput.description must be a string if provided", {
          requestId: request.requestId,
        });
      }

      if (so.strict !== undefined && typeof so.strict !== "boolean") {
        throw new ModelRequestInvalidError("structuredOutput.strict must be a boolean if provided", {
          requestId: request.requestId,
        });
      }
    }
  }
}

/**
 * Validates a ModelProviderResponse for structural conformance and invariant integrity.
 * Throws ModelResponseInvalidError if invalid.
 */
export function validateModelProviderResponse(response: ModelProviderResponse): void {
  if (!response || typeof response !== "object") {
    throw new ModelResponseInvalidError("ModelProviderResponse must be a non-null object");
  }

  if (typeof response.requestId !== "string" || response.requestId.trim().length === 0) {
    throw new ModelResponseInvalidError("requestId must be a non-empty string");
  }

  if (typeof response.model !== "string" || response.model.trim().length === 0) {
    throw new ModelResponseInvalidError("model must be a non-empty string", {
      requestId: response.requestId,
    });
  }

  if (typeof response.outputText !== "string") {
    throw new ModelResponseInvalidError("outputText must be a string", {
      requestId: response.requestId,
    });
  }

  if (!MODEL_FINISH_REASONS.includes(response.finishReason)) {
    throw new ModelResponseInvalidError(
      `finishReason '${String(response.finishReason)}' is invalid; expected one of: ${MODEL_FINISH_REASONS.join(", ")}`,
      { requestId: response.requestId }
    );
  }

  if (
    typeof response.durationMs !== "number" ||
    !Number.isFinite(response.durationMs) ||
    response.durationMs < 0
  ) {
    throw new ModelResponseInvalidError("durationMs must be a non-negative finite number", {
      requestId: response.requestId,
    });
  }

  if (response.usage !== undefined) {
    const u = response.usage;
    if (!u || typeof u !== "object" || Array.isArray(u)) {
      throw new ModelResponseInvalidError("usage must be a valid object if provided", {
        requestId: response.requestId,
      });
    }

    if (
      u.inputTokens !== undefined &&
      (typeof u.inputTokens !== "number" || !Number.isInteger(u.inputTokens) || u.inputTokens < 0)
    ) {
      throw new ModelResponseInvalidError("usage.inputTokens must be a non-negative integer", {
        requestId: response.requestId,
      });
    }

    if (
      u.outputTokens !== undefined &&
      (typeof u.outputTokens !== "number" || !Number.isInteger(u.outputTokens) || u.outputTokens < 0)
    ) {
      throw new ModelResponseInvalidError("usage.outputTokens must be a non-negative integer", {
        requestId: response.requestId,
      });
    }

    if (
      u.totalTokens !== undefined &&
      (typeof u.totalTokens !== "number" || !Number.isInteger(u.totalTokens) || u.totalTokens < 0)
    ) {
      throw new ModelResponseInvalidError("usage.totalTokens must be a non-negative integer", {
        requestId: response.requestId,
      });
    }
  }

  if (response.providerMetadata !== undefined) {
    if (
      !response.providerMetadata ||
      typeof response.providerMetadata !== "object" ||
      Array.isArray(response.providerMetadata)
    ) {
      throw new ModelResponseInvalidError("providerMetadata must be a valid object if provided", {
        requestId: response.requestId,
      });
    }
  }
}
