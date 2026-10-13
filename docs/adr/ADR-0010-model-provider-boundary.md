# ADR-0010: Model Provider Boundary & Provider-Neutral Inference Port

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
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

Phase 5 established the complete governed autonomous reasoning loop (`AgentStepController`) and the trust conversion boundary (`AgentBrainPort` $\longrightarrow$ `ProposalValidator` $\longrightarrow$ `WorkerRuntime`).

In Phase 6, the system integrates real model inference capabilities. However, directly coupling the reasoning engine (`AgentBrainPort`) or execution controllers to concrete commercial model SDKs (e.g. OpenAI, Anthropic, Gemini, LangChain, LiteLLM) introduces catastrophic architectural liabilities:
1. **SDK Vendor Lock-In**: Exposing vendor-specific types (e.g., `OpenAI.ChatCompletion`, `Anthropic.MessageParam`) corrupts the core domain and leaks vendor-specific conventions upward.
2. **Authority Conflation (Model = System)**: Granting model SDKs or provider clients access to tool execution, workspace environments, database connections, or governance authority creates massive security vulnerabilities.
3. **Hidden / Silent Retries**: Third-party SDKs frequently implement automatic exponential backoff loops, masking rate limits, consuming budgets silently, and violating deterministic execution invariants.
4. **Conflated Timeout Accounting**: Merging model inference request timeouts with orchestration wall-clock budgets prevents precise attribution of latency bottlenecks.
5. **Loss of Replayability and Auditability**: Without provider-independent message, request, response, and error taxonomy representations, model calls cannot be systematically evaluated, audited, or reproduced.

---

## 2. Decision & Architectural Principles

We introduce `ModelProviderPort` as a provider-independent infrastructure port establishing a strict separation between model inference and governance:

```text
AgentStepController
        ↓
AgentBrainPort
        ↓
LiveAgentBrain (Phase 6.2)
        ↓
ModelProviderPort (Phase 6.1)
        ↓
┌───────────────────┬───────────────────┬───────────────────┐
│  OpenAI Adapter   │ Anthropic Adapter │  Gemini Adapter   │
│   (Phase 6.3+)    │   (Phase 6.3+)    │   (Phase 6.3+)    │
└───────────────────┴───────────────────┴───────────────────┘
        ↓                   ↓                   ↓
  External API        External API        External API
```

### 2.1 Model $\ne$ Authority
The model provider is treated strictly as an untrusted external dependency:
- The provider receives **zero** execution authority.
- The provider cannot execute tools, access workspaces, read filesystem paths, connect to SQLite, mutate Runs, create Actions, advance Attempts, issue capabilities, or approve proposals.
- Model output is always untrusted text until converted into an untrusted `ActionProposal` and validated through `ProposalValidator`'s 11-stage pipeline.

### 2.2 Provider Independence
The core domain and port layer contain **zero** model SDK dependencies (no OpenAI, Anthropic, Gemini, Ollama, LangChain, or LiteLLM). All concepts are expressed using provider-neutral domain contracts:
- `ModelMessageRole` (`"system" | "user" | "assistant"`)
- `ModelMessage` (`role`, `content`, `name?`)
- `ModelGenerationOptions` (`temperature`, `maxOutputTokens`, `topP`, `stopSequences`, `structuredOutput`)
- `ModelProviderRequest` (`requestId`, `model`, `input`, `generation`, `timeoutMs`, `abortSignal`)
- `ModelProviderResponse` (`requestId`, `model`, `outputText`, `finishReason`, `usage`, `providerMetadata`, `durationMs`)

### 2.3 Provider-Neutral Structured Output Specification
To enable the Agent Brain to solicit structured JSON action proposals without vendor coupling, `ModelStructuredOutputSchema` carries a clean, provider-independent JSON Schema object (`name`, `jsonSchema`, `description?`, `strict?`). Concrete provider adapters map this schema into their respective vendor APIs (e.g., OpenAI `response_format`, Anthropic tool/JSON schema, Gemini `response_schema`).

### 2.4 Single-Attempt Semantics (Zero Hidden Retries)
`ModelProviderPort.generate(...)` executes a single inference request. The port interface strictly prohibits internal retry loops or hidden exponential backoff:
- The provider reports what occurred (`response` or typed `ModelProviderError`).
- The upstream caller (`AgentBrain` or orchestration layer) owns retry and escalation policy.
- Bounded retries remain governed and observable.

### 2.5 Explicit Timeout Separation
`timeoutMs` on `ModelProviderRequest` enforces a lower-level inference deadline for the specific provider call. It is strictly decoupled from the `AgentStepController` wall-clock budget (`maxWallClockMs`).

### 2.6 Cooperative Cancellation via AbortSignal
`ModelProviderRequest` accepts an optional `AbortSignal`. Concrete adapters must observe this signal and fail-closed with `ModelRequestCancelledError` (`code: "MODEL_REQUEST_CANCELLED"`, `isRetryable: false`). Cancellation is never swallowed.

### 2.7 Explicit Usage Accounting (Zero Token Fabrication)
`ModelUsageMetadata` tracks `inputTokens`, `outputTokens`, and `totalTokens`. If a provider does not supply token metrics, the fields remain `undefined`. Token counts are never fabricated or guessed.

### 2.8 Informational Diagnostic Metadata
`providerMetadata` is strictly read-only informational diagnostic data (e.g. HTTP status, latency metrics, system fingerprint). It carries zero runtime authority.

### 2.9 Strongly-Typed Domain Error Taxonomy
Provider failures are mapped into domain errors extending `DomainError`:
- `ModelProviderUnavailableError` (code: `"MODEL_PROVIDER_UNAVAILABLE"`, `isRetryable: true`)
- `ModelRequestInvalidError` (code: `"MODEL_REQUEST_INVALID"`, `isRetryable: false`)
- `ModelRequestTimeoutError` (code: `"MODEL_REQUEST_TIMEOUT"`, `isRetryable: true`)
- `ModelRequestCancelledError` (code: `"MODEL_REQUEST_CANCELLED"`, `isRetryable: false`)
- `ModelRateLimitedError` (code: `"MODEL_RATE_LIMITED"`, `isRetryable: true`, `retryAfterMs?`)
- `ModelResponseInvalidError` (code: `"MODEL_RESPONSE_INVALID"`, `isRetryable: false`)
- `ModelOutputLimitExceededError` (code: `"MODEL_OUTPUT_LIMIT_EXCEEDED"`, `isRetryable: false`)

---

## 3. Alternatives Considered

1. **Direct SDK Usage in AgentBrain**: Calling vendor SDKs directly inside `AgentBrain` tightly couples the brain to a single vendor, prevents multi-model routing, and leaks vendor schemas into the core runtime. Rejected.
2. **Adopting LiteLLM or LangChain**: Introducing heavy multi-provider abstraction libraries adds dozens of transitive dependencies, obscure internal retry behavior, hidden prompt transformations, and security vulnerabilities. Rejected in favor of a minimal, typed, observable port.
3. **Port with Built-in Retries**: Embedding retry loops inside `ModelProviderPort` hides transient failures, burns step budgets silently, and prevents the step controller from recording failure metrics. Rejected.

---

## 4. Consequences & Revisit Conditions

### Positive Consequences
- Clean, provider-neutral boundary established for all future model integrations.
- Complete preservation of GEMINI.md Constitution: zero vendor leakage, zero network calls in core.
- Full testability with lightweight deterministic mock providers.

### Deliberately Deferred to Future Tasks
- `LiveAgentBrain` (translating `ContextSnapshot` to `ModelProviderRequest` and parsing proposals) is deferred to Phase 6.2.
- Concrete provider adapters (`OpenAIModelProvider`, `AnthropicModelProvider`, `GeminiModelProvider`) are deferred to Phase 6.3+.
- Network access, API key storage, and HTTP clients are deferred to Phase 6.3+.
