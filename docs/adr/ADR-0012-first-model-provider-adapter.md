# ADR-0012: Local Open-Source Model Provider Adapter (Ollama) & Zero-Cost Architecture

## Status
Approved (Architecture Specification Baseline)

## Date
2026-10-13

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [ADR-0001: Master Engineering Constitution](./ADR-0001-master-engineering-constitution.md)
- [ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
- [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](./ADR-0003-workspace-and-typed-tools.md)
- [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](./ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
- [ADR-0005: Action and Attempt Domain Architecture, Lifecycle Semantics, and Lease-Fenced Persistence](./ADR-0005-action-and-attempt-domain-architecture.md)
- [ADR-0006: Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper](./ADR-0006-crash-recovery-unknown-reconciliation-retry-safety.md)
- [ADR-0007: Typed Context Engine — Observation Selection, Context Budgeting, and Token Governance](./ADR-0007-context-engine-budgeting-and-observation-selection.md)
- [ADR-0008: Agent Brain Interface & Governed Action Proposal Boundary](./ADR-0008-agent-brain-action-proposal-boundary.md)
- [ADR-0009: Governed Autonomous Agent Reasoning Loop & Step Controller](./ADR-0009-governed-autonomous-step-controller.md)
- [ADR-0010: Model Provider Boundary & Provider-Neutral Inference Port](./ADR-0010-model-provider-boundary.md)
- [ADR-0011: LiveAgentBrain Boundary, Context Translation, and Untrusted Action Proposal Pipeline](./ADR-0011-live-agent-brain-boundary.md)
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

Phase 6.1 established the provider-neutral `ModelProviderPort` interface and domain error hierarchy. Phase 6.2 implemented `LiveAgentBrain` as the application-layer bridge mediating between `AgentStepController` and `ModelProviderPort`.

In Phase 6.3, Emerald establishes its first concrete model provider adapter.
A foundational project constraint governs Emerald Agent Fabric:
> **Zero Cost & Open-Source Infrastructure**: Emerald is developed under ₹0 development/inference cost, zero paid model APIs, zero commercial SaaS dependencies, and local open-source model execution wherever possible.

Commercial cloud model APIs (such as OpenAI, Anthropic, or proprietary hosted gateways) require paid subscriptions, recurring per-token billing, secret API credentials, and external network dependencies. Introducing a commercial model provider into the default baseline would violate Emerald's open-source, CPU-first, and zero-cost mission.

The engineering challenge:
> Implement a concrete model provider adapter using a local open-source model runtime (Ollama) that strictly fulfills the `ModelProviderPort` contract without leaking runtime HTTP details, requiring cloud credentials, or weakening the invariant that model output is strictly untrusted data.

---

## 2. Decision & Architectural Principles

We implement `OllamaModelProvider` in `src/adapters/models/ollama-model-provider.ts` as the primary concrete adapter implementing `ModelProviderPort`:

```text
AgentStepController
        ↓
AgentBrainPort
        ↓
LiveAgentBrain (Phase 6.2)
        ↓
ModelProviderPort (Phase 6.1)
        ↓
OllamaModelProvider (Phase 6.3 Adapter)
        ↓
Ollama Localhost HTTP API (http://127.0.0.1:11434)
        ↓
Local Open-Source Model (e.g., Llama, Qwen, Mistral)
```

### 2.1 ₹0 Cost & Zero Cloud Dependency
- **No Paid APIs**: Baseline development, CI, testing, and execution incur ₹0 in model inference fees.
- **No API Keys**: The adapter requires zero authentication tokens, bearer headers, or secret credentials.
- **Local Execution**: The default runtime communicates strictly with a local Ollama daemon (`http://127.0.0.1:11434`) over localhost. No prompts or code are dispatched to third-party commercial clouds.

### 2.2 Model Independence & Flexible Local Models
- The architecture does not mandate a specific model size or proprietary checkpoint.
- Models are configurable via `options.defaultModel`, `process.env.OLLAMA_MODEL`, or `request.model` (e.g., `llama3.2`, `qwen2.5-coder`, `mistral`).
- The system remains usable across varied local developer hardware (CPU-first, Apple Silicon, local GPU).

### 2.3 Strict Single-Attempt Semantics (Zero Hidden Retries)
- The adapter performs exactly **one** HTTP request per `generate(...)` invocation.
- Zero internal retry loops.
- Zero automatic exponential backoff.
- Zero silent model switching or fallback provider cascades.
- If Ollama is unavailable or inference fails, the call immediately rejects with a typed Phase 6.1 domain error, preserving step budget accounting in `AgentStepController`.

### 2.4 Complete Infrastructure Isolation
- Built using native Node.js `fetch` with zero external npm SDK dependencies (eliminating vendor package bloat).
- Zero Ollama-specific request, response, or error types leak into domain or application layers.
- All requests adhere strictly to `ModelProviderRequest`.
- All responses adhere strictly to `ModelProviderResponse`.

### 2.5 Structured Output Translation
- Provider-neutral `ModelStructuredOutputSchema` is translated directly to Ollama's schema specification (`format: schema.jsonSchema`).
- Upon receiving a completed response (`finishReason === "STOP"`), the adapter verifies valid JSON syntax before returning. If invalid or empty, it rejects with `ModelResponseInvalidError`.
- Regex parsers or loose fuzzy extractors are strictly prohibited.

### 2.6 Deterministic Error Taxonomy Mapping
All local HTTP and runtime failures map deterministically into Phase 6.1 domain errors:
| Local Runtime Failure / Condition | Emerald Domain Error |
| :--- | :--- |
| Pre-dispatch `abortSignal.aborted`, in-flight abort event | `ModelRequestCancelledError` |
| Inference timeout (`timeoutMs` exceeded) | `ModelRequestTimeoutError` |
| Local daemon unreachable (`ECONNREFUSED`, network drop) | `ModelProviderUnavailableError` |
| Model not found, route missing, bad options (HTTP 404, 400) | `ModelRequestInvalidError` |
| Internal daemon error, out of memory (HTTP 500) | `ModelProviderUnavailableError` |
| Malformed JSON response, missing `message` object | `ModelResponseInvalidError` |
| Output exceeds token limit | `ModelOutputLimitExceededError` |
| Unhandled HTTP status code | `ModelProviderError` |

### 2.7 Usage Accounting Without Fabrication
- Token counts are mapped strictly from Ollama's `prompt_eval_count` (`inputTokens`) and `eval_count` (`outputTokens`).
- If token counts are not reported, `usage` remains `undefined`. Token counts are never fabricated or guessed.

### 2.8 100% Offline Normal Test Suite
- `OllamaModelProvider` accepts an optional `fetch?: OllamaFetchLike` dependency.
- All unit and integration tests run 100% offline with zero network access and without requiring an active Ollama installation.
- Live localhost inference tests are strictly quarantined behind an explicit opt-in environment flag (`OLLAMA_LIVE_TESTS === "true"`).

### 2.9 Model $\ne$ Authority
Local models remain untrusted external dependencies:
- Zero tool execution capability.
- Zero capability escalation.
- Zero persistence access.
- Every candidate proposal generated by the local model must pass through the authoritative 11-stage `ProposalValidator` pipeline before execution.

---

## 3. Alternatives Considered

1. **Commercial Model Providers (OpenAI, Anthropic, Gemini)**:
   Rejected. Introduces recurring costs, requires API keys and subscriptions, creates external cloud dependencies, and violates the ₹0 / open-source constraint.
2. **Third-Party Model Proxy Wrappers (LiteLLM, LangChain, Ollama npm SDK)**:
   Rejected. Introduces unnecessary npm dependency bloat and risks leaking proprietary error shapes. Standard native `fetch` provides complete, lightweight HTTP control.
3. **Internal Model Switching / Fallback Cascades**:
   Rejected. Violates GEMINI.md Section 18 (Latency Model) and Section 26 (Bounded Retries). Fallback mechanisms must not hide underlying runtime failures.

---

## 4. Consequences & Revisit Conditions

### Positive Consequences
- ₹0 cost development and evaluation unlocked.
- Complete domain independence preserved: replacing OpenAI with Ollama required zero changes to `ModelProviderPort`, `LiveAgentBrain`, or `AgentStepController`.
- Zero external npm packages required for model inference.
- Test suite remains 100% offline, deterministic, and fast.

### Revisit Conditions
- If future local runtimes (e.g. llama.cpp direct bindings or ONNX runtime) provide faster CPU execution than Ollama HTTP.
- If Ollama introduces streaming chat completions requiring streaming port interfaces.
