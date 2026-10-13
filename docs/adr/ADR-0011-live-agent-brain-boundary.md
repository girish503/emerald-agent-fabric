# ADR-0011: LiveAgentBrain Boundary, Context Translation, and Untrusted Action Proposal Pipeline

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
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

Phase 5 established the autonomous step loop (`AgentStepController`), the 11-stage proposal governance pipeline (`ProposalValidator`), and the `AgentBrainPort` interface. Phase 6.1 established the provider-neutral model inference port (`ModelProviderPort`).

In Phase 6.2, Emerald implements `LiveAgentBrain` as the application-layer bridge mediating between:
1. The governed reasoning loop (`AgentStepController` via `AgentBrainPort`), and
2. The external provider-neutral model inference boundary (`ModelProviderPort`).

Without this bounded bridge:
- Orchestration controllers would be forced to format prompts, handle raw text strings, and decode JSON directly, blurring orchestration and model inference boundaries.
- Models could attempt to dictate execution authority (workerId, leaseId, contracts, capabilities, mount paths, retry counts, execution outcomes).
- Internal retries inside the brain could hide latency bottlenecks and burn step budgets silently.

---

## 2. Decision & Architectural Principles

We implement `LiveAgentBrain` as an application service implementing `AgentBrainPort`:

```text
AgentStepController
        ↓
AgentBrainPort
        ↓
LiveAgentBrain (Phase 6.2)
        ↓
ModelProviderPort (Phase 6.1)
        ↓
Provider Adapters (OpenAI / Anthropic / Gemini / Mock) (Phase 6.3+)
```

### 2.1 The Two Fundamental Layers
1. **Inflow Translation (ContextSnapshot $\longrightarrow$ ModelProviderRequest)**:
   Transforms immutable runtime observations and tool definitions into provider-neutral conversation messages (`system` and `user`).
2. **Outflow Decoding (ModelProviderResponse $\longrightarrow$ UNTRUSTED ActionProposal)**:
   Extracts, validates shape, strips authority, and produces an untrusted candidate `ActionProposal` for subsequent evaluation by `ProposalValidator`.

### 2.2 Model $\ne$ Authority
`LiveAgentBrain` reinforces the central tenet:
$$\text{Model Output} \ne \text{Authority}$$
- **Zero Tool Execution**: Invoking `LiveAgentBrain.proposeAction(...)` executes zero tools and invokes zero execution providers ($\text{providerInvocationCount} = 0$).
- **Zero Persistence Mutation**: `LiveAgentBrain` never creates or writes `Action` or `Attempt` records in durable storage.
- **Zero Capability Escalation**: The brain cannot issue capabilities or alter Mission Contracts.

### 2.3 Information Inflow Firewall
The model receives strictly reasoning context:
- `taskId`, `runId`, `sequenceNumber`, `contextSnapshotHash`
- `availableTools` (name, capability, description, idempotency)
- Selected observations (category, priority, freshness, redacted content, truncation note)
- Omitted observations summary

The model is strictly prohibited from receiving authority-bearing state:
- `workerId`
- `leaseId`
- Mission Contract content hash
- Database handles or transaction contexts
- Docker mount configurations or daemon sockets
- Host credentials or API tokens

### 2.4 Parsing is Shape Validation, NOT Authorization
`LiveAgentBrain` performs **shape validation** on model output:
- Validates JSON object structure.
- Validates `toolName` is a registered tool.
- Validates `inputPayload` is an object.
- Validates payload size $\le 64$ KB (`MAX_PROPOSAL_BYTES`).
- Validates rationale length $\le 4096$ chars (`MAX_RATIONALE_LENGTH`).
- Rejects any forbidden authority fields via `findForbiddenAuthorityKeys(parsed)`.

Crucially:
> Validating the shape of an ActionProposal does NOT authorize its execution.
The proposal remains strictly **UNTRUSTED** until it passes through `ProposalValidator`'s 11-stage pipeline.

### 2.5 Single-Attempt Semantics (Zero Hidden Retries)
`LiveAgentBrain.proposeAction(...)` executes at most **one** call to `ModelProviderPort.generate(...)`:
- No exponential backoff.
- No sleep or retry loops.
- No second correction calls on malformed model outputs.
- Any provider failure (timeout, cancellation, rate limit, provider unavailable) immediately propagates upstream.
- The `AgentStepController` owns the overall step loop budget and decides whether to continue, count failure, or halt.

### 2.6 Cancellation Propagation
`LiveAgentBrain` checks `request.abortSignal?.aborted` before dispatch and passes `abortSignal` through to `ModelProviderRequest`. If aborted, it fails immediately with `ModelRequestCancelledError`. Cancellation is never swallowed.

### 2.7 Deferred Capabilities
- Tool calling / function calling loops are deferred to later phases.
- Real provider SDK adapters are deferred to Phase 6.3.

---

## 3. Alternatives Considered

1. **Embedding Model Inference Directly in StepController**:
   Violates Single Responsibility Principle. Pollutes the orchestration state machine with prompt templates, JSON extraction, and tokenizer heuristics.
2. **Authorizing Proposals Inside LiveAgentBrain**:
   Directly violates GEMINI.md Defense-in-Depth. Merging proposal extraction with capability authorization would create a single point of failure and risk model-controlled capability escalation.
3. **Internal Retry on Malformed JSON**:
   Hiding model correction loops inside `LiveAgentBrain` breaks latency accounting and burns step budgets invisibly. The StepController must observe every reasoning step explicitly.

---

## 4. Consequences & Revisit Conditions

### Positive Consequences
- Strict separation between reasoning generation and governance authorization maintained.
- 100% provider independence preserved (zero model SDK imports).
- Complete testability with deterministic fake providers (42 tests, 960 full repository tests green).
- Full compliance with GEMINI.md Sections 8, 9, 10, 11, 12, 17, and 33.

### Revisit Conditions
- If future models support native multi-turn tool calling schemas requiring changes to structured output descriptors.
- If prompt-injection defense mechanisms require signed context encapsulation.
