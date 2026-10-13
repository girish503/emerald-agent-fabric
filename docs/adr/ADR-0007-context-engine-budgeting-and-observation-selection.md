# ADR-0007: Typed Context Engine — Observation Selection, Context Budgeting, and Token Governance

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
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

Across Phases 1 through 4, Emerald Agent Fabric established durable Run lifecycles, SQLite transactional persistence, Mission Contracts, sandboxed workspaces, typed tool execution gateways, Action/Attempt domains, and fail-closed crash recovery.

In Phase 5, the architecture addresses information boundaries for the future Agent Brain:
```text
Model
  ↓
Agent Brain
  ↓
Context Engine (Information Boundary)
  ↓
Action Proposal
  ↓
Existing Phase 4 Governance (Authority Boundary)
  ↓
Execution
```

Without an authoritative, typed Context Engine, software agent systems suffer from critical failure modes:
1. **Unbounded Context Inflation**: Unchecked concatenation of raw event logs, tool outputs, and historical actions exhausts model context windows, inflates token latency, and increases cost exponentially.
2. **Authority vs Observation Conflation**: If the context engine possesses execution authority or mutates runtime state, observation cannot be safely decoupled from execution.
3. **Information Smuggling & Secret Leakage**: Raw configuration payloads, access tokens, and environment secrets embedded in tasks or contracts risk being ingested into context and sent to external model providers.
4. **Epistemic Erasure of Uncertainty**: Normalizing or omitting `UNKNOWN` attempts misinforms the agent brain, hiding physical side effects and causing unsafe double-execution.
5. **Non-Deterministic Replay**: Inconsistent ordering or non-reproducible truncation destroys experiment reproducibility and benchmark auditability.

---

## 2. Invariants & Non-Negotiable Principles

1. **Information Boundary, Not Authority Boundary**:
   The Context Engine is strictly read-only. It NEVER mutates Run, Action, Attempt, Mission Contract, Workspace, or Tool execution state. Execution authority remains strictly with the Mission Contract, Policy Evaluator, Tool Gateway, and Execution Provider.
2. **Mandatory Safety Floor**:
   `RUN_STATE` and `MISSION_CONTEXT` (and active `UNKNOWN` attempts) are non-negotiable safety observations. If a budget cannot fit the mandatory safety floor, the engine MUST fail closed with `ContextBudgetExceededError` rather than dropping safety state.
3. **Epistemic Uncertainty Preservation**:
   Observations for `UNKNOWN` attempts MUST preserve `executionOutcomeUncertain: true` and `unknownReason`. They MUST NEVER be normalized to `FAILED` or `SUCCEEDED`.
4. **Deterministic Token & Byte Governance**:
   Token estimation is deterministic and provider-independent ($\lceil \text{bytes} / 4 \rceil$). Context budgets enforce independent hard ceilings on `maxEstimatedTokens`, `maxBytes`, and `maxObservations`.
5. **Universal Secret Redaction**:
   All candidate observations undergo deterministic key-based redaction (`redactSensitiveData`) before content hashing, budgeting, or snapshot inclusion.
6. **Cryptographic Integrity & Replayability**:
   Every `ContextSnapshot` produces a deterministic SHA-256 `contextHash` over canonical JSON representation of selected observations, budget, and policy.

---

## 3. Observation Model & Semantic Categories

Candidate observations are partitioned into 10 typed semantic categories:

| Category | Semantic Scope | Priority | Mandatory |
| :--- | :--- | :---: | :---: |
| `RUN_STATE` | Current run state machine status, version, lease, retry counts, error reasons | 100 | Yes |
| `MISSION_CONTEXT` | Bound Mission Contract goals, constraints, non-goals, authorized capabilities, ceilings | 90 | Yes |
| `ATTEMPT_HISTORY` (UNKNOWN) | Attempts with uncertain execution outcomes (`executionOutcomeUncertain: true`) | 85 | Yes |
| `TOOL_ERROR` | Tool execution failures, timeouts, and governance rejections | 80 | No |
| `VERIFICATION` | Verification specs, pass/fail status, and diagnostic checks | 75 | No |
| `WORKSPACE_STATE` | Workspace path, provisioning status, boundary verification | 70 | No |
| `TOOL_RESULT` | Tool execution outputs (bounded by `maxToolOutputBytes`) | 60 | No |
| `ACTION_HISTORY` | Logical action sequence numbers, tool names, and statuses | 50 | No |
| `ATTEMPT_HISTORY` (Settled) | Past settled attempts (succeeded, cancelled) | 45 | No |
| `EVIDENCE` | Authoritative evidence records | 30 | No |
| `SYSTEM_EVENT` | Bounded causal audit trail events | 20 | No |

Within categories, freshness ranking boosts recent observations: `CURRENT` (+15), `RECENT` (+5), `STALE` (+0).

---

## 4. Deterministic Truncation & Budget Selection

### 4.1 Tool Output Truncation
When tool output in `TOOL_RESULT` or `TOOL_ERROR` exceeds `maxToolOutputBytes`:
- The engine identifies oversized string payloads (including nested fields like `output.stdout`).
- Deterministic head/tail truncation retains the beginning and end with a clear marker:
  `... [TRUNCATED N CHARACTERS DUE TO CONTEXT BUDGET] ...`
- `TruncationMetadata` records `originalBytes`, `retainedBytes`, `originalEstimatedTokens`, `retainedEstimatedTokens`, and strategy (`HEAD_TAIL`).
- Invariant guarantee: `retainedBytes <= originalBytes` and `retainedEstimatedTokens <= originalEstimatedTokens`.

### 4.2 Category Ceilings & Priority Pruning
Before total budget filling, category-level count bounds are applied:
- `maxHistoryEvents`: retains the $N$ most recent system events.
- `maxActionHistory`: retains the $N$ most recent actions.
- `maxAttemptHistory`: retains the $N$ most recent non-mandatory attempts.
- `maxEvidenceItems`: retains the $N$ most recent evidence records.

Pruned observations are recorded in `omittedObservationsSummary` with reason (`CATEGORY_LIMIT` or `BUDGET_LIMIT`), count, bytes, and tokens.

---

## 5. Security & Provenance

1. **Redaction**: Credentials, tokens, API keys, and passwords in input payloads, contracts, or tool outputs are replaced with `[REDACTED]`.
2. **Authoritative Provenance**: Every observation links to an authoritative runtime entity (`Run`, `MissionContract`, `Action`, `Attempt`, `DomainEvent`, `Workspace`, `Evidence`, `VerificationSpec`) with `isAuthoritativeRuntimeFact: true`.
3. **Hash Integrity**: `contentHash` is the SHA-256 digest of canonical JSON of redacted content. `contextHash` binds the entire selected context view.

---

## 6. Consequences & Trade-Offs

### Positive
- Prevents runaway token growth and context overflow.
- Guarantees future agent brains receive critical safety and uncertainty data.
- Ensures identical context snapshots are generated across replay and verification.
- Completely decouples observation assembly from execution authority.

### Negative / Limitations
- Character-based token estimation ($\lceil \text{bytes} / 4 \rceil$) is an upper-bound heuristic and does not match specific model tokenizers (e.g. BPE/tiktoken).
- Truncation of large tool outputs discards middle log content; downstream tools must request specific byte offsets if needed.
