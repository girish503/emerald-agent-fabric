# Emerald Agent Fabric: Runtime Architecture

## 1. Execution Semantics
The runtime adheres strictly to:
> **At-least-once execution with idempotent/atomic state transitions and append-only event logging.**

We explicitly reject claims of "exactly-once execution." If a worker dies after executing side effects but before persisting completion, the recovery sweeper re-dispatches the run. Idempotent operations and atomic database transitions ensure safety across crash-recovery cycles.

---

## 2. Decoupled Pure Domain State Machine
The state machine is implemented as a pure domain function completely decoupled from persistence:
```typescript
interface RunStateMachine {
  canTransition(currentState: RunState, command: RunCommand): boolean;
  applyTransition(snapshot: RunSnapshot, command: RunCommand): TransitionResult;
}
```

### Definitive State Transition Table

| Current State | Command / Event | Next State | Permitted Actor | Atomic Requirements |
| :--- | :--- | :--- | :--- | :--- |
| *(None)* | `run.create` | `CREATED` | Client / API | Insert `runs` row (`version = 1`), append `run.created`. |
| `CREATED` | `run.queue` | `QUEUED` | Client / Dispatcher | Verify `version`, update `status = QUEUED`, append `run.queued`. |
| `QUEUED` / `RECOVERING` | `worker.claim` | `LEASED` | Worker | Verify status & lease expiry, assign `worker_id`, `lease_id`, `lease_expires_at`, append `worker.claimed`. |
| `LEASED` | `run.start` | `RUNNING` | Lease-holding Worker | Verify `lease_id` & `version`, update `status = RUNNING`, append `run.started`. |
| `RUNNING` | `run.complete`| `COMPLETED` | Lease-holding Worker | Verify `lease_id` & `version`, store `result_payload`, append `run.completed`. |
| `RUNNING` | `run.fail` | `FAILED` | Lease-holding Worker | Verify `lease_id` & `version`, store `error_payload`, append `run.failed`. |
| `RUNNING` | `run.timeout` | `TIMED_OUT` | Lease Worker / Supervisor | Verify `lease_id` & `version`, store timeout error, append `run.timed_out`. |
| `RUNNING` | `run.cancel` | `CANCELLED` | Supervisor / Client | Verify `version`, update `status = CANCELLED`, append `run.cancelled`. |
| `LEASED` / `RUNNING` | `lease.expire`| `RECOVERING` | Supervisor / Sweeper | Verify `lease_expires_at < now`, update `status = RECOVERING`, append `lease.expired`. |
| `RECOVERING` | `run.retry` | `QUEUED` | Supervisor | Increment `attempt_count`, clear worker/lease, append `run.recovered`. |
| `RECOVERING` | `run.fail_exhausted` | `FAILED` | Supervisor | `attempt_count >= max_attempts`, update `status = FAILED`, append `run.failed`. |

*Rule*: All unlisted transitions throw `InvalidStateTransitionError` and roll back. Terminal states (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) are immutable.

---

## 3. Transaction Boundaries
Every state mutation and its associated event insertion MUST execute within a single SQLite transaction (`BEGIN IMMEDIATE ... COMMIT`):
- **Create Run**: Validate task → Insert `runs` row → Append `run.created` event → Commit.
- **Queue**: Validate `version` → Update `runs.status = 'QUEUED'` → Append `run.queued` event → Commit.
- **Claim**: Find eligible run → Update `status = 'LEASED'`, `worker_id`, `lease_id`, `expires_at` → Append `worker.claimed` event → Commit.
- **Start**: Validate `lease_id` & `version` → Update `status = 'RUNNING'` → Append `run.started` event → Commit.
- **Completion**: Validate `lease_id` & `version` → Update `status = 'COMPLETED'`, `result_payload` → Append `run.completed` event → Commit.
- **Failure**: Validate `lease_id` & `version` → Update `status = 'FAILED'`, `error_payload` → Append `run.failed` event → Commit.

*Rationale*: Committing state updates and events separately introduces the dual-write problem. A crash between the two writes causes divergence between operational state and event logs.

---

## 4. Gapless Event Sequencing
- **Definition of Gapless**: For a given `run_id`, event sequence numbers are strictly contiguous integers ($1, 2, 3, \dots, N$). There are no missing numbers, no duplicate numbers, and sequence strictly reflects causal commit order.
- **Allocation Mechanism**: Inside a `BEGIN IMMEDIATE` transaction, sequence is allocated via:
  ```sql
  SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = :run_id;
  ```
- **Serialization Guarantee**: SQLite's `BEGIN IMMEDIATE` acquires a reserved write lock before reading `MAX(sequence)`. Concurrent transactions are serialized at the lock boundary, preventing two writers from reading the same sequence.
- **Integrity**: Enforced by `UNIQUE(run_id, sequence)`. Rolled back transactions discard the sequence number, leaving no holes in the committed stream.

---

## 5. Crash Consistency Matrix

| Scenario | Database State | Worker State | Lease State | Recovery Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Crash before transaction commit** | Previous valid state. | Dead / Restarted. | Retains previous lease or null. | Transaction rolled back by SQLite WAL recovery. Run remains in previous state. |
| **Crash between state update & event append** | Previous valid state. | Dead / Restarted. | Previous state. | Impossible to persist partially: both occur in single uncommitted transaction. Rolled back on crash. |
| **Crash after event append before commit** | Previous valid state. | Dead / Restarted. | Previous state. | Transaction uncommitted; WAL frame discarded on recovery. |
| **Crash immediately after commit** | Committed state & event present. | Dead / Restarted. | Active lease with `lease_expires_at`. | Committed frames recovered by SQLite WAL. Run remains in newly committed state. |
| **Worker crash during operation execution** | `status = 'RUNNING'`. | Dead. | Lease active until `lease_expires_at`. | Heartbeats stop. Sweeper detects expired lease, transitions to `RECOVERING`. Retried if `attempt_count < max_attempts`. |
| **Worker crash after operation side-effect, pre-commit** | `status = 'RUNNING'`. | Dead. | Expired lease. | Sweeper transitions to `RECOVERING` → `QUEUED`. Operation is re-executed on next claim (requires operation idempotency). |

---

## 6. Lease Architecture & Fencing Tokens
- `Worker`: Process identity (`worker_id`).
- `Lease`: Time-bounded exclusive lock record (`lease_id`, `expires_at`).
- `Run`: Target entity (`run_id`, `status`, `lease_id`, `version`).

### Fencing Token Defense against Stale Workers
1. Worker A claims Run 1 with `lease_id = L1`.
2. Worker A experiences a severe GC pause or CPU stall.
3. Worker A's lease expires (`lease_expires_at < now`).
4. Sweeper detects expired lease, transitions Run 1 to `RECOVERING` and re-queues.
5. Worker B claims Run 1 with `lease_id = L2`.
6. Worker A resumes and attempts to complete the run:
   ```sql
   UPDATE runs SET status = 'COMPLETED', version = version + 1
   WHERE run_id = 1 AND lease_id = 'L1' AND version = 7;
   ```
7. The update matches 0 rows because `lease_id` in database is now `L2`.
8. Worker A detects 0 rows updated, throws `LEASE_LOST`, and aborts without corrupting Worker B's execution.

---

## 7. Optimistic Concurrency Control (OCC)
- `runs.version` is incremented on every state mutation (`version = version + 1`).
- Example:
  - Worker A reads `version = 7`.
  - Worker B reads `version = 7`.
  - Worker A executes: `UPDATE runs SET status = 'RUNNING', version = 8 WHERE run_id = 1 AND version = 7`. Succeeded (1 row affected).
  - Worker B executes: `UPDATE runs SET status = 'RUNNING', version = 8 WHERE run_id = 1 AND version = 7`. Matched 0 rows.
  - Worker B detects 0 rows affected, rolls back, and throws `STATE_CONFLICT`.

---

## 8. Idempotency Model (Three Tiers)
1. **Request Idempotency**:
   - `runs.idempotency_key` with unique constraint.
   - Duplicate `createRun` calls with identical key return the existing `run_id` without duplicating tasks.
2. **State Transition Idempotency**:
   - Commands verify current state before transition. Re-requesting an already-attained state (e.g. `queueRun` on `QUEUED` run) safely returns current snapshot without redundant event generation.
3. **Operation Idempotency**:
   - Operations receive an `idempotencyToken`.
   - In Capability 1, deterministic operations are pure functions: $f(\text{input}) = \text{output}$. Re-executing an operation produces identical results without cumulative side effects.

---

## 9. Timeout Semantics: Logical vs Physical
- **Logical Timeout (Guaranteed by Capability 1)**:
  - Wall-clock execution is monitored via timer / `AbortController`.
  - When duration exceeds `timeout_ms`, the runtime transitions status to `TIMED_OUT`, revokes the lease, and emits `run.timed_out`.
- **Physical Process Termination (Deferred to Phase 3)**:
  - Node.js cannot forcibly interrupt synchronous blocking code (`while(true) {}`) on the main event loop.
  - Hard physical preemption, memory ceiling enforcement, and `SIGKILL` belong strictly to the Docker/OCI container sandbox layer (Phase 3). Capability 1 relies on cooperative asynchronous promises.

---

## 10. Refined Failure Taxonomy

| Category | Classification | Retry Policy | Terminal State | Description |
| :--- | :--- | :--- | :--- | :--- |
| `STATE_CONFLICT` | Concurrency Error | Immediate caller re-read | None | OCC version mismatch; 0 rows affected. |
| `LEASE_LOST` | Fencing Violation | Worker aborts execution | None | Worker attempted mutation after lease expired/stolen. |
| `OPERATION_FAILURE`| Operation Error | Configurable (Permanent / Transient) | `FAILED` | Deterministic error thrown by operation logic. |
| `TIMEOUT` | Temporal Exhaustion | No Retry | `TIMED_OUT` | Wall-clock execution exceeded `timeout_ms`. |
| `CANCELLED` | Administrative Abort| No Retry | `CANCELLED` | User or supervisor cancelled the run. |
| `PERSISTENCE_FAILURE`| Storage Error | Bounded retry with backoff | None | SQLite lock contention (`SQLITE_BUSY`). |
| `WORKER_CRASH` | Node Failure | Recovered by Sweeper | `RECOVERING` → `QUEUED` or `FAILED` | Worker stopped heartbeats mid-execution. |
| `POLICY_DENIED` | Security Gate | No Retry | `FAILED` | Reserved for security policy rejections (Phase 4). |
| `INTERNAL_ERROR` | Runtime Panic | No Retry | `FAILED` | Unhandled runtime exception or invariant breach. |
