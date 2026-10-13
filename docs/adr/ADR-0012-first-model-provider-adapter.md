# ADR-0012: First Real Model Provider Adapter (OpenAI) & SDK Isolation Boundary

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

Phase 6.1 established the provider-neutral `ModelProviderPort` interface and domain error hierarchy. Phase 6.2 implemented `LiveAgentBrain` as the application bridge connecting `AgentStepController` to `ModelProviderPort`.

In Phase 6.3, Emerald requires its first concrete adapter connecting to an external model service.
The fundamental architectural challenge is:
> How do we connect to a real commercial LLM API while preserving strict provider neutrality, single-attempt predictability, zero credential leakage, 100% offline test reliability, and the foundational invariant that model output is strictly untrusted data?

If an adapter is implemented naively:
- Provider SDK types and proprietary error shapes leak into domain and application code.
- SDK default automatic retries and exponential backoff loops hide network latency, defeat timeout ceilings, and violate step budgeting.
- API keys can inadvertently leak into diagnostic logs, error messages, or commit history.
- The standard test suite would depend on live external network access, causing flaky CI and billing unpredictability.

---

## 2. Decision & Architectural Principles

We implement `OpenAIModelProvider` in `src/adapters/models/openai-model-provider.ts` as the first concrete adapter implementing `ModelProviderPort`:

```text
AgentStepController
        ↓
AgentBrainPort
        ↓
LiveAgentBrain (Phase 6.2)
        ↓
ModelProviderPort (Phase 6.1)
        ↓
OpenAIModelProvider (Phase 6.3 Adapter)
        ↓
OpenAI Chat Completions API
```

### 2.1 Provider Selection & Single Adapter Discipline
We select OpenAI (`openai` npm SDK) as the first and currently only concrete adapter:
- No secondary or speculative adapters are introduced (GEMINI.md Section 5: No Speculative Architecture).
- No model routing, round-robin, or fallback switching is introduced at this layer.
- The adapter strictly targets standard chat completions endpoints and compatible proxies via configurable `baseURL`.

### 2.2 Complete SDK Isolation
The OpenAI SDK dependency is strictly confined within `src/adapters/models/openai-model-provider.ts`:
- Zero OpenAI SDK types, classes, or interfaces leak across the `ModelProviderPort` boundary.
- All incoming requests conform strictly to `ModelProviderRequest`.
- All outgoing responses conform strictly to `ModelProviderResponse`.
- All errors are intercepted and translated into the strongly-typed Phase 6.1 domain error taxonomy (`ModelProviderError` hierarchy).

### 2.3 Non-Negotiable Single-Attempt Semantics
Automatic retries inside model SDKs destroy observability and violate Emerald's step budget governance:
- The OpenAI client is instantiated with `maxRetries: 0`.
- In calls to `chat.completions.create(...)`, `maxRetries: 0` is explicitly enforced.
- The adapter performs exactly **one** API request per `generate(...)` call.
- Any network drop, timeout, or rate limit fails immediately into domain error types, allowing the upstream `AgentStepController` and WorkerRuntime to record the failure transparently against step budgets.

### 2.4 Secret Safety & Fail-Closed Credentials
- API keys are sourced exclusively from runtime configuration (`options.apiKey`) or environment variables (`process.env.OPENAI_API_KEY`).
- If credentials are absent and no client was injected, the adapter fails closed immediately with `ModelProviderUnavailableError`.
- Any error message undergoing domain error mapping is sanitized with regex redaction (`sanitizeErrorMessage`) to strip potential API keys (`sk-...`) or Bearer tokens before exposure.
- Credentials are never written to disk, events, logs, or diagnostic metadata.

### 2.5 Structured Output Mapping
When `request.generation?.structuredOutput` is present:
- The provider-neutral `ModelStructuredOutputSchema` is translated directly to OpenAI's native `response_format: { type: "json_schema", json_schema: { ... } }`.
- Upon response arrival, the adapter performs JSON parse verification before returning to ensure schema conformance when `finishReason === "STOP"`. Malformed outputs produce `ModelResponseInvalidError`.

### 2.6 Deterministic Error Taxonomy Mapping
All provider exceptions are classified deterministically:
| OpenAI Error / Condition | Emerald Domain Error |
| :--- | :--- |
| `APIUserAbortError`, `AbortError`, pre-dispatch aborted signal | `ModelRequestCancelledError` |
| `APIConnectionTimeoutError`, `TimeoutError`, message includes timeout | `ModelRequestTimeoutError` |
| `RateLimitError`, HTTP 429 status | `ModelRateLimitedError` (extracts `retry-after-ms` or `retry-after`) |
| `context_length_exceeded`, max tokens exceeded | `ModelOutputLimitExceededError` |
| `BadRequestError`, `UnprocessableEntityError`, HTTP 400, 422 | `ModelRequestInvalidError` |
| `AuthenticationError` (401), `PermissionDeniedError` (403), `APIConnectionError`, 5xx | `ModelProviderUnavailableError` |
| Unrecognized or generic `APIError` | `ModelProviderError` (`code: "MODEL_PROVIDER_ERROR"`) |

### 2.7 100% Offline Test Suite with Dependency Injection
To ensure hermetic, fast, and repeatable testing without network dependencies:
- `OpenAIModelProvider` accepts an optional `client?: OpenAIClientLike` structural interface.
- 100% of the unit and integration test suite runs offline against deterministic mock clients.
- Live external network tests are quarantined behind an explicit opt-in environment flag (`LIVE_MODEL_TESTS === "true"` and `OPENAI_API_KEY`), ensuring CI and standard development workflows remain completely offline.

### 2.8 Zero Execution Authority
The adapter is an unprivileged leaf adapter:
- Zero execution of tools or tool adapters.
- Zero capability authorization.
- Zero persistence access.
- Zero modification of Mission Contracts or leases.

---

## 3. Alternatives Considered

1. **Third-Party Universal Provider Wrappers (LiteLLM, LangChain, Portkey)**:
   Rejected. Introduces heavy external dependencies, hides transport behavior, breaks fine-grained timeout and cancellation handling, and violates GEMINI.md Section 7 & 8.
2. **Raw `fetch` without Official SDK**:
   Rejected. Using the official `openai` SDK inside a strictly contained adapter provides reliable wire encoding and types while keeping SDK exposure 100% isolated behind `ModelProviderPort`.
3. **Allowing SDK Internal Retries**:
   Rejected. Hidden SDK retries conceal latency bottlenecks, prevent step budget accounting, and violate GEMINI.md Section 18 (Latency Model) and Section 26 (Bounded Retries).

---

## 4. Consequences & Revisit Conditions

### Positive Consequences
- Real model inference can now be performed via `LiveAgentBrain` through a real external API.
- Complete domain and application independence from OpenAI SDK maintained.
- Deterministic error taxonomy and single-attempt semantics enforced.
- Test suite remains 100% offline, deterministic, and free from external network flakiness.

### Revisit Conditions
- Implementation of additional provider adapters (e.g., Anthropic, Gemini, local models) in future phases.
- If OpenAI deprecates the Chat Completions API format in favor of a different wire protocol.
