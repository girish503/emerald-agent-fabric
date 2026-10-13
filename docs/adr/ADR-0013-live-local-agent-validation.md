# ADR-0013: Live Local Agent Governance Validation & Evaluation Smoke Path

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
- [ADR-0012: Local Open-Source Model Provider Adapter (Ollama) & Zero-Cost Architecture](./ADR-0012-first-model-provider-adapter.md)
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Research Problem

Across Phases 1 through 6.3, Emerald Agent Fabric established a complete, layered execution and governance stack:
- Phase 1 & 2: Deterministic runtime kernel, SQLite persistence, leased worker coordination, and causal events.
- Phase 3: Workspace isolation and path traversal prevention.
- Phase 4: Typed tools, capability policies, `ToolExecutionGateway`, Action/Attempt lifecycle, and crash recovery.
- Phase 5: Typed `ContextEngine`, `AgentBrainPort`, untrusted `ActionProposal`, 11-stage `ProposalValidator`, and `AgentStepController`.
- Phase 6.1–6.3: Provider-neutral `ModelProviderPort`, `LiveAgentBrain`, and local open-source `OllamaModelProvider`.

Phase 6.4 addresses the central empirical question:
> **Can a real local open-source model produce actions that travel through Emerald's complete governance pipeline and safely execute inside an isolated sandbox without bypassing any control boundary?**

This is the first end-to-end empirical validation of the full reasoning-to-execution cycle:
$$\text{Reasoning} \longrightarrow \text{Proposal} \longrightarrow \text{Governance} \longrightarrow \text{Action} \longrightarrow \text{Execution} \longrightarrow \text{Observation} \longrightarrow \text{Next Step}$$

---

## 2. Decision & Architectural Principles

We establish a typed, reproducible evaluation harness (`src/application/evaluation/local-eval-harness.ts`) and comprehensive integration test suite (`tests/integration/live-local-governance-eval.test.ts`) validating the live local agent governance loop.

```text
AgentStepController
        ↓
LiveAgentBrain
        ↓
ModelProviderPort
        ↓
OllamaModelProvider
        ↓
Ollama localhost (http://127.0.0.1:11434)
        ↓
Local Open-Source Model (e.g., Llama 3.2, Qwen 2.5 Coder)
        ↓
UNTRUSTED ActionProposal
        ↓
ProposalValidator (11 Stages)
        ↓
Capability Policy Check
        ↓
WorkerRuntime
        ↓
ToolExecutionGateway
        ↓
Workspace Sandbox
```

### 2.1 Controlled Task Fixture
The task is intentionally minimal and deterministic:
- Isolated workspace containing `src/greeting.txt` initialized to `"Hello, World!\n"`.
- Objective: Inspect the workspace, read the current greeting, update `src/greeting.txt` to `"Hello, Emerald Agent Fabric!\n"`, and signal goal completion.
- Flow requires:
  $$\text{read\_file} \longrightarrow \text{reasoning} \longrightarrow \text{write\_file} \longrightarrow \text{verification} \longrightarrow \text{COMPLETED}$$
- Lowest-risk tools first: zero shell execution required.

### 2.2 Model & Runtime Infrastructure
- Local open-source model executed via Ollama (`http://127.0.0.1:11434`).
- External configuration via `OLLAMA_BASE_URL` and `OLLAMA_MODEL`.
- Zero commercial cloud model dependencies (zero OpenAI, Anthropic, or Gemini cloud APIs, ₹0 cost, zero API keys).
- CPU-first execution: practical on standard developer laptops without requiring dedicated GPU/VRAM.

### 2.3 Strict Least-Privilege Mission Contract
The Mission Contract grants strictly the minimal capabilities needed for the task:
- `workspace.file.read`
- `workspace.file.write`
- `process.execute` (`run_command`) is **explicitly denied**.
- Proves least privilege: attempting ungranted tools fails immediately at ProposalValidator Stage 8 without touching physical execution providers.

### 2.4 Workspace Isolation & Lifecycle
- Every evaluation run provisions a dedicated temporary workspace directory via `NodeFsWorkspaceAdapter`.
- All file operations are bound by canonical realpath verification, rejecting traversal outside the root.
- The workspace is cleanly disposed and the temporary directory unlinked after test completion.

### 2.5 Authoritative Governance Pipeline
Model output is NEVER trusted:
1. `LiveAgentBrain` strips forbidden authority fields (`workerId`, `leaseId`, `contractId`, `capability`, `workspaceRoot`).
2. `ProposalValidator` executes the 11-stage verification pipeline (size, authority fields, schema, context hash match, lease fencing, active contract, tool registry, capability policy, input validation/path traversal, resource ceilings).
3. `ToolExecutionGateway` re-verifies policy and isolation boundaries.
4. `WorkerRuntime` creates leased `Action` and `Attempt` domain records in SQLite.

### 2.6 Structured Evidence Generation
Every evaluation run records a gapless evidence transcript without leaking credentials or unbounded model transcripts:
- `runId`, `taskId`, `stepNumber`, `contextSnapshotHash`
- `modelProvider`, `model`
- `actionId`, `toolName`
- `durationMs`
- `result` (`ACCEPTED`, `REJECTED`, `EXECUTED`, `EXECUTION_FAILED`, `NO_ACTION`, `GOAL_REACHED`)
- `verificationResult`, `terminalReason`

### 2.7 Observability & Metric Accounting
The harness measures:
- `taskSuccess`: End-to-end task goal achieved and physically verified.
- `proposalAcceptanceRate`: Ratio of valid proposals accepted by `ProposalValidator`.
- `proposalRejectionCount`: Cumulative invalid proposals rejected.
- `stepsUsed` & `actionsUsed`: Reasoning cycles and tool executions consumed.
- `modelCalls` & `toolCalls`: Physical provider invocations.
- `modelLatencyMs` & `toolLatencyMs`: Disaggregated wall-clock durations.
- Token counts (`promptTokens`, `outputTokens`, `totalTokens`): Extracted directly from Ollama usage metadata when available; never fabricated.

### 2.8 Determinism Boundary
- **Model Non-Determinism**: Generative local models may vary in token selection or reasoning text across runs.
- **Governance Determinism**: For identical inputs, policies, contracts, and proposals, `ProposalValidator`, `PolicyEvaluator`, and `ToolExecutionGateway` produce 100% deterministic authorization outcomes.
- We do not make false claims of end-to-end deterministic model inference.

### 2.9 Failure Safety & Bounded Ceilings
The evaluation suite tests all failure modes deterministically:
- `ModelProviderUnavailableError` $\longrightarrow$ Safe halt with `BRAIN_FAILURE` (zero retry loops, zero cloud fallback).
- `ModelRequestTimeoutError` $\longrightarrow$ Safe halt with `BRAIN_FAILURE`.
- `AbortSignal` $\longrightarrow$ Safe halt with `CANCELLED` (zero actions executed post-abort).
- Uncertain tool execution $\longrightarrow$ `Attempt.UNKNOWN` $\longrightarrow$ `Action.FAILED` $\longrightarrow$ Safe halt with `UNKNOWN_EXECUTION` (zero automatic retry of non-idempotent uncertain operations).
- Contract revocation $\longrightarrow$ Safe halt with `CONTRACT_REVOKED`.
- Lease loss/theft $\longrightarrow$ Safe halt with `LEASE_LOST`.
- Multi-dimensional loop ceilings (`maxSteps`, `maxActions`, `maxWallClockMs`, `maxProposalRejections`).

---

## 3. Why This Is Not Yet a Benchmark

Phase 6.4 is a **smoke and control-plane validation experiment**, NOT a benchmark.
- It tests a single synthetic task to verify architectural correctness of the pipeline.
- It does not measure statistical pass rates across diverse coding problems.
- It makes zero claims regarding SWE-bench, Terminal-Bench, or competitive autonomous programming capability.
- Benchmark harnesses, multi-task suites, and harness evolution belong to subsequent evaluation phases (Phase 7+).

---

## 4. Security Invariants Confirmed

1. **No Direct Tool Invocation**: `LiveAgentBrain` contains zero execution handles. The model cannot execute a tool without `ProposalValidator` and `WorkerRuntime`.
2. **Authority Key Immunity**: Injected authority keys (`workerId`, `leaseId`, `contractId`) are rejected before creating runtime state.
3. **Workspace Confinement**: Path traversal proposals (`../../etc/passwd`) are rejected by lexical sanitization at Stage 9.
4. **Least Privilege Enforced**: Proposals for ungranted tools (`run_command`) are rejected by Capability Policy at Stage 8.
5. **No Credential Exposure**: Context snapshots and evaluation evidence contain zero API keys, secrets, or passwords.

---

## 5. Next Steps

- Phase 7.1: Multi-task evaluation harness supporting structured task suites.
- Phase 7.2: Evaluation dataset integration and reproducible harness versioning (`harness-0.1`).
- Phase 7.3: Harbor-compatible evaluation interfaces for SWE-bench Verified tasks.
