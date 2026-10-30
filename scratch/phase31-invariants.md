# Phase 31B: Domain Invariants & Error Semantics Specification

## 1. Core Principles

Emerald Agent Fabric operates under a fundamental distributed execution constraint:
> **Physical external work may occur zero, one, or multiple times depending on failure timing, but Emerald's durable state transitions and event history must remain strictly deterministic, fenced, and gapless.**

The runtime guarantees **at-most-one authorized state advancement per active attempt**. The model is an untrusted decision component; the runtime enforces correctness regardless of worker crashes, network partitions, or delayed re-deliveries.

---

## 2. Formal Invariants Specification

### Invariant A — Lease Ownership
A worker may mutate active-attempt or action state only while holding the currently valid lease.
- **Formulation**:
  $$\forall \text{ op} \in \text{AttemptMutations}, \quad \text{holdsLease}(\text{op.workerId}, \text{op.leaseId}, \text{op.runId}, \text{op.now}) = \text{TRUE}$$
- **Durable Enforcement**: Inside the SQLite transaction, the lease record must exist, must have `state == 'ACTIVE'`, and must satisfy `expires_at > op.now`. Furthermore, `runs.lease_id == op.leaseId` and `runs.current_worker_id == op.workerId`.

### Invariant B — Lease Fencing
A stale lease ID must never successfully advance an attempt.
- **Scenario**:
  ```text
  Worker A (Lease A)
      ↓
  Lease A expires / revoked
      ↓
  Worker B (Lease B) assigned
      ↓
  Worker A resumes
      ↓
  Worker A attempt completion MUST be rejected with LeaseLostError
  ```
- **Durable Enforcement**: Fencing token matching (`fencing.leaseId == runs.lease_id`) is evaluated inside SQLite `BEGIN IMMEDIATE`. Stale workers receive `LeaseLostError`.

### Invariant C — Attempt Identity
Every physical execution attempt is uniquely identifiable by:
- `attemptId`: UUIDv4 primary key.
- `actionId`: Parent logical unit of work.
- `runId`: Top-level execution run.
- `attemptNumber`: Positive integer ($1, 2, \dots$).
- `workerId`: Identifier of the claiming worker.
- `leaseId`: Unique lease token bound to the physical trial.
- `idempotencyToken`: Formatted as `${runId}:${actionId}:${attemptNumber}`.

All identity fields are frozen upon `Attempt.create()` and verified immutable across all subsequent transitions.

### Invariant D — Attempt Number Monotonicity
For any Action, attempt numbers must form a strictly increasing sequence starting at 1:
$$\text{Attempt}_1, \text{Attempt}_2, \text{Attempt}_3, \dots, \text{Attempt}_N$$
Attempt numbers must never:
- Decrease ($N+1 < N$)
- Duplicate ($N == M$ for distinct attempts)
- Skip ($N+2$ without $N+1$)
- Exceed `action.maxAttempts`

Enforced by SQLite partial index, unique constraint `(action_id, attempt_number)`, and pre-insert monotonic assertion `attemptNumber === max(attempt_number) + 1`.

### Invariant E — Action / Attempt Consistency
An Action must never report `SUCCEEDED` while its authoritative active Attempt remains `FAILED` or `UNKNOWN`.
- Dual transitions (`Attempt COMPLETE` + `Action SUCCEED`) must commit atomically within the same database transaction.
- When an Attempt enters `UNKNOWN`, the Action must fail closed (`Action FAILED` or awaiting manual intervention), never auto-succeeding.

### Invariant F — UNKNOWN Safety
If physical execution outcome cannot be established safely (e.g., worker crash, lease expiry during tool execution):
$$\text{Attempt} \rightarrow \text{UNKNOWN}$$
The runtime must not silently assume success. Automatic retry must obey the strict idempotency policy:
- `NON_IDEMPOTENT` tool: **Strictly fail-closed**. No automatic retry permitted (`NON_IDEMPOTENT_UNKNOWN`).
- `IDEMPOTENT` tool: May transition to `RETRYING` only if attempts remain and execution limits permit.

### Invariant G — Stale Completion Rejection
A completion submission from an obsolete lease must be rejected with zero mutation of authoritative state:
- Attempt status remains unchanged.
- Action status remains unchanged.
- No `action.completed` or `attempt.completed` events are emitted.
- The rejection is deterministically returned to the calling worker as a `LeaseLostError`.

### Invariant H — Event Sequence Preservation
Every accepted state transition must preserve gapless per-run event sequencing:
$$\text{sequence}_{i} = \text{sequence}_{i-1} + 1$$
Rejected stale-worker operations abort the transaction, rolling back sequence allocation and preserving total order.

### Invariant I — Idempotent Duplicate Completion
Repeated submission of the identical attempt completion (matching `attemptId`, `workerId`, `leaseId`, and result payload) on an attempt that has already reached `SUCCEEDED` must be handled idempotently:
- Zero new rows inserted in `run_events`.
- Zero mutations to `attempts` or `actions`.
- Returns the existing authoritative result deterministically.

---

## 3. Error Taxonomy & Behavioral Mapping

| Error Code | Class Name | Trigger Condition | Consequence |
| :--- | :--- | :--- | :--- |
| `LEASE_LOST` | `LeaseLostError` | Presented `leaseId` does not match active lease in `runs` | Operation aborted; state unchanged |
| `LEASE_EXPIRED` | `LeaseExpiredError` | Presented lease has `expires_at <= now` or `state != 'ACTIVE'` | Renewal or mutation aborted |
| `ATTEMPT_NOT_OWNED` | `AttemptNotOwnedError` | Attempt `leaseId`/`workerId` does not match mutating worker | Mutation rejected; attempt unmutated |
| `ACTIVE_ATTEMPT_CONFLICT`| `ActiveAttemptConflictError` | New attempt created while another attempt is non-terminal | Insert aborted; existing attempt preserved |
| `DUPLICATE_ATTEMPT_NUMBER`| `DuplicateAttemptError` | Attempt number already exists for action | Insert aborted; uniqueness preserved |
| `TERMINAL_STATE_MUTATION`| `TerminalStateError` | Mutation attempted on terminal action or attempt | Mutation rejected |
| `VERSION_CONFLICT` | `VersionConflictError` | OCC version mismatch on `runs` update | Mutation aborted |

---

## 4. State Transition Table for Multi-Attempt Recovery

| Prior Attempt Status | Tool Idempotency | Attempts Remaining? | Recovery Attempt Transition | Resulting Action State |
| :--- | :--- | :--- | :--- | :--- |
| `CREATED` (un-dispatched) | Any | Yes/No | `CANCELLED` | `RETRYING` (if attempts remain) else `FAILED` |
| `DISPATCHED` | Non-Idempotent | Any | `UNKNOWN` | `FAILED` (Fail-Closed) |
| `DISPATCHED` | Idempotent | Yes | `UNKNOWN` | `FAILED` (Fail-Closed against blind auto-retry) |
| `RUNNING` | Non-Idempotent | Any | `UNKNOWN` | `FAILED` (Fail-Closed) |
| `RUNNING` | Idempotent | Yes | `UNKNOWN` | `FAILED` (Fail-Closed against blind auto-retry) |
| `FAILED` | Idempotent | Yes | Preserved `FAILED` | `RETRYING` $\rightarrow$ Attempt $N+1$ created |
| `FAILED` | Non-Idempotent | Any | Preserved `FAILED` | `FAILED` (No retry) |
| `FAILED` | Idempotent | No (exhausted) | Preserved `FAILED` | `FAILED` (Exhausted) |

---

## 5. Architectural Proof Statement

Under these invariants:
1. At most one fenced worker can advance state for a given run and attempt at any instant.
2. A crashed worker can never overwrite state created by its successor.
3. Every historical attempt trial remains permanently recorded in SQLite for verification and audit.
