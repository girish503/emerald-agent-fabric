# ADR-0006: Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper

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
- [Runtime Architecture](../architecture/runtime.md)

---

## 1. Context & Problem Statement

In Phase 4 / Task 4.4-E, Emerald established the end-to-end governed execution path:
```text
Run + Lease
   ↓
Action
   ↓
Mission Contract / Policy
   ↓
Attempt #1
   ↓
ToolExecutionGateway
   ↓
Typed Tool Adapter
   ↓
ExecutionProvider (where required)
   ↓
Attempt result
   ↓
Action result
   ↓
SQLite state + causal events
```

However, distributed autonomous agent architectures face unavoidable process crashes, worker network partitions, host reboots, container eviction, and lease expirations. When a worker process abruptly disappears midway through executing an Action or Attempt, the runtime is exposed to critical consistency and safety hazards:

1. **Execution Uncertainty vs Failure Conflation**: If a worker process disappears while an Attempt is `DISPATCHED` or `RUNNING`, the physical outcome in the external environment (container, disk, git repo) is unknown. Conflating execution uncertainty with execution failure is dangerous: a future recovery agent might interpret `FAILED` as safe to retry, leading to double-execution of non-idempotent physical side effects.
2. **Zombie Workers and Split-Brain Mutation**: A stalled or delayed worker may wake up after its lease has been revoked and attempt to persist late results, overwrite reconciled states, or mutate actions after another worker has reclaimed the run.
3. **Unbounded or Unsafe Retries**: Uncontrolled retries on failing or uncertain operations can cause cascading failures, exhaust resource limits, or bypass Mission Contract capability authority.
4. **At-Least-Once Physical Realities vs Exactly-Once Claims**: Physical reality does not permit distributed "exactly-once" execution without universal transactional hardware. The runtime must explicitly embrace at-least-once invocation while enforcing monotonic sequence ordering, idempotent tokens, and fail-closed reconciliation.

This Architecture Decision Record defines the deterministic crash recovery lifecycle, the formal semantics of the `UNKNOWN` state, retry eligibility governance, and the automated sweeper reconciliation architecture.

---

## 2. Invariants & Non-Negotiable Principles

1. **Physical Uncertainty $\neq$ Execution Failure**:
   `UNKNOWN` is a first-class, immutable safety state. It indicates that the system cannot authoritatively determine whether a physical side effect took place.
2. **Fail-Closed on Uncertainty**:
   Uncertain execution outcomes on non-idempotent operations must **NEVER** be automatically retried. Non-idempotent actions whose attempts end in `UNKNOWN` transition immediately and deterministically to `FAILED`.
3. **Mission Contract Authority on Every Attempt**:
   Retries derive authority strictly from the bound `MissionContract`. If the contract is `REVOKED` or `EXPIRED`, retries are immediately aborted with zero provider execution.
4. **Non-Clamping Resource Ceilings**:
   Retry attempts are strictly bounded by `contract.spec.resourceLimits.maxAttempts`. Any attempt to exceed the ceiling fails closed.
5. **Lease-Fenced Concurrency Defense**:
   All state and event persistence operations enforce strict lease fencing against `runs.lease_id` and `runs.current_worker_id`. Stale workers attempting late mutations are rejected with `LeaseLostError`.
6. **Zero Subprocesses in Recovery**:
   Recovery and sweeping paths inspect and reconcile durable state using SQLite transactions. They never spawn host subprocesses (`child_process`, `exec`, `spawn`, `fork`).

---

## 3. Crash Windows Taxonomy (Windows A through H)

The execution lifecycle comprises eight discrete vulnerability windows between state transitions:

```text
Action CREATED (Window A)
   ↓
Action AUTHORIZED (Window B)
   ↓
Attempt CREATED (Window C)
   ↓
Attempt DISPATCHED (Window D)
   ↓
Attempt RUNNING (Window E)
   ↓
Provider / Adapter Execution (Window F)
   ↓
Attempt Terminal Persisted (Window G)
   ↓
Action RETRYING (Window H)
   ↓
Attempt #2+ Execution
```

| Window | Description | Durable State at Crash | Reconciliation Action | Resulting Status | Retry Eligible? |
|---|---|---|---|---|---|
| **Window A** | Crash after Action `CREATED`, before authorization | Action: `CREATED`<br>Attempts: `0` | Action marked `FAILED` (Worker crashed before authorization) | Action: `FAILED` | No |
| **Window B** | Crash after Action `AUTHORIZED`, before Attempt #1 created | Action: `AUTHORIZED`<br>Attempts: `0` | Action marked `FAILED` (Worker crashed before dispatch) | Action: `FAILED` | No |
| **Window C** | Crash after Attempt #1 `CREATED`, before dispatch | Action: `RUNNING`<br>Attempt: `CREATED` | Attempt marked `CANCELLED`. Action evaluated for retry. | Attempt: `CANCELLED`<br>Action: `RETRYING` (if idempotent) / `FAILED` | Yes (if idempotent & attempts remain) |
| **Window D** | Crash after Attempt `DISPATCHED`, before `START` | Action: `RUNNING`<br>Attempt: `DISPATCHED` | Outcome uncertain: Attempt marked `UNKNOWN`. | Attempt: `UNKNOWN`<br>Action: `FAILED` | **No** (Fail-Closed) |
| **Window E** | Crash after Attempt `RUNNING`, before tool execution | Action: `RUNNING`<br>Attempt: `RUNNING` | Outcome uncertain: Attempt marked `UNKNOWN`. | Attempt: `UNKNOWN`<br>Action: `FAILED` | **No** (Fail-Closed) |
| **Window F** | Crash after tool execution returned, before attempt result persisted | Action: `RUNNING`<br>Attempt: `RUNNING` | Outcome uncertain: Attempt marked `UNKNOWN`. | Attempt: `UNKNOWN`<br>Action: `FAILED` | **No** (Fail-Closed) |
| **Window G** | Crash after Attempt completed (`SUCCEEDED`/`FAILED`), before Action updated | Action: `RUNNING`<br>Attempt: Terminal | Action reconciled to match Attempt outcome without re-execution. | Action: Matches Attempt terminal status | N/A (Already executed) |
| **Window H** | Crash while Action in `RETRYING`, before Attempt #2 created | Action: `RETRYING`<br>Attempt #1: `FAILED` | Sweeper / recovering worker starts Attempt #2 exactly once. | Attempt #2 created<br>Action: `RUNNING` | Yes |

---

## 4. The UNKNOWN State Semantics

### 4.1 Definition
`UNKNOWN` represents an epistemic boundary: the physical attempt was dispatched or executed, but the worker process disappeared before durably committing the result.

### 4.2 Immutability
Once an Attempt transitions to `UNKNOWN`, it is terminal:
- It can never be updated, resumed, completed, or cancelled.
- Any subsequent mutation attempt by a revived worker throws `InvalidAttemptTransitionError` or `TerminalStateError`.

### 4.3 Action Mapping
When an Attempt becomes `UNKNOWN`:
- **NON_IDEMPOTENT tool** (`write_file`, `run_command`): Action transitions to `FAILED`. `evaluateRetryEligibility()` yields `eligible: false` with reason `NON_IDEMPOTENT_UNKNOWN`.
- **IDEMPOTENT tool** (`read_file`, `git_status`, `git_diff`, `search_code`): In crash recovery, execution uncertainty is treated as fail-closed against blind auto-retry. Action transitions to `FAILED`.

---

## 5. Retry Safety Matrix

Retries are only permitted when all of the following conditions are met:

| Check | Condition | Invariant Enforced |
|---|---|---|
| **Tool Idempotency** | Must be `IDEMPOTENT` (`read_file`, `search_code`, `git_status`, `git_diff`) | Non-idempotent operations (`write_file`, `run_command`) are NEVER retried. |
| **Attempt Outcome** | Must be deterministic failure (`FAILED`) | `UNKNOWN`, `TIMED_OUT`, `CANCELLED` attempts are never retried. |
| **Ceiling Budget** | `action.totalAttempts < action.maxAttempts` and `< contract.spec.resourceLimits.maxAttempts` | Bounded resource consumption; non-clamping ceiling enforcement. |
| **Contract State** | Bound `MissionContract` must be `ACTIVE` | If `REVOKED` or `EXPIRED`, retry is aborted and Action marked `FAILED`. |
| **Capability Authority** | Tool capability must remain granted in `policy` | If revoked before retry, execution is denied with zero provider calls. |

---

## 6. Zombie Worker Fencing

To prevent stale workers from corrupting state after lease expiry or crash:
1. **Fencing Verification on Transaction**:
   Every mutation to `actions` and `attempts` validates that `runs.current_worker_id === fencing.workerId` and `runs.lease_id === fencing.leaseId`.
2. **Rejection with LeaseLostError**:
   If the lease was revoked or claimed by another worker, the transaction is rejected with `LeaseLostError`.
3. **Optimistic Status Concurrency**:
   `UPDATE attempts ... WHERE attempt_id = ? AND status = ?` guarantees that concurrent transitions are detected and rejected.

---

## 7. Sweeper Reconciliation Architecture

Recovery is integrated at two levels:

1. **Coordinator-Level Sweeper (`RunCoordinator.recoverExpiredRuns()` / `recoverStaleExecutions()`)**:
   - Identifies expired runs and stale in-flight attempts.
   - Transitions stale attempts to `CANCELLED` (Window C) or `UNKNOWN` (Windows D, E, F) within atomic SQLite transactions.
   - Reconciles orphaned action states.
2. **Worker-Level Recovery (`WorkerRuntime.recoverStaleExecutions()`)**:
   - Calls coordinator recovery to reconcile stale attempts.
   - Queries actions remaining in `RETRYING` state under the worker's active run lease.
   - Evaluates retry eligibility via `evaluateRetryEligibility()`.
   - Executes eligible retries (creating Attempt #2+) deterministically through `ToolExecutionGateway`.

---

## 8. Consequences & Operational Guarantees

- **Safety**: No non-idempotent side effect is ever duplicated due to process crashes.
- **Auditability**: Complete causal trace is preserved in `run_events` with explicit `attempt.unknown` events documenting the crash reason.
- **Determinism**: Sweeper reconciliation is completely idempotent; repeated invocations produce zero extraneous events or transitions.
- **Resource Protection**: Ceilings and revocations are enforced upstream before any execution provider is invoked.
