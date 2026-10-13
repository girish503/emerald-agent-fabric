/**
 * Model Provider Port for Emerald Agent Fabric.
 *
 * Establishes the provider-neutral infrastructure boundary between
 * the Emerald agent reasoning layer (AgentBrainPort) and concrete external
 * model inference providers (e.g., OpenAI, Anthropic, Gemini, local models).
 *
 * Architectural Invariants:
 * 1. Model != Authority: This port confers ZERO execution authority.
 *    The provider never receives authority over MissionContracts, capabilities,
 *    policies, workspace roots, credentials, worker IDs, lease IDs, retries,
 *    attempts, execution providers, ToolExecutionGateway, persistence, or verification.
 *    Model output is strictly untrusted.
 * 2. Provider Independence: Zero provider-specific SDK types leak into the domain
 *    or application layers. No OpenAI, Anthropic, Gemini, Ollama, LangChain, or LiteLLM types.
 * 3. Single-Attempt Semantics: The port interface performs ZERO internal retries or
 *    exponential backoff loops. The caller (AgentBrain or orchestration layer) owns retry policy.
 * 4. Explicit Timeouts: Request timeoutMs is a lower-level inference deadline, distinct
 *    from AgentStepController wall-clock budget.
 * 5. Cooperative Cancellation: Must observe request.abortSignal and reject with
 *    ModelRequestCancelledError if cancelled. Cancellation is never swallowed.
 * 6. Informational Metadata: Provider metadata is strictly non-authoritative diagnostic data.
 *    It can never inject capabilities, grant approval, or mutate state.
 */

import {
  ModelProviderRequest,
  ModelProviderResponse,
} from "../domain/model-provider.js";

export * from "../domain/model-provider.js";

export interface ModelProviderPort {
  /**
   * Logical identifier of this model provider adapter (e.g., "mock", "openai", "anthropic", "gemini").
   */
  readonly providerName: string;

  /**
   * Executes a single, non-retried model inference request.
   *
   * Invariants:
   * 1. Single attempt: This method must NEVER perform internal retries or backoff loops.
   * 2. Zero authority: Does not execute tools, mutate databases, or grant capabilities.
   * 3. Cancellation: Must observe request.abortSignal and reject with ModelRequestCancelledError if aborted.
   * 4. Timeout: Must enforce request.timeoutMs and reject with ModelRequestTimeoutError on expiry.
   * 5. Fail-closed: Rejects with strongly-typed ModelProviderError on any provider failure.
   */
  generate(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}
