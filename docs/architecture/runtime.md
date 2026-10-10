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
1. **Request / Run Idempotency**:
   - `runs.idempotency_key` with unique constraint protects creation and recovery semantics for the run.
   - Duplicate `createRun` calls with identical key return the existing `run_id` without duplicating tasks.
   - *Boundary Constraint*: A run-level idempotency key protects run creation/recovery. It must **NOT** automatically be treated as sufficient operation-level idempotency for arbitrary future multi-step agent actions.
2. **State Transition Idempotency**:
   - Commands verify current state before transition. Re-requesting an already-attained state (e.g. `queueRun` on `QUEUED` run) safely returns current snapshot without redundant event generation.
3. **Operation Idempotency vs Granular Execution Tracking**:
   - Operations receive an `idempotencyToken`.
   - In Capability 1, deterministic operations are pure functions: $f(\text{input}) = \text{output}$. Re-executing an operation produces identical results without cumulative side effects.
   - *Future Architectural Entity Separation*: Multi-step agent actions in future phases will distinguish:
     - `run_id` (overall user task run)
     - `execution_id` (worker execution cycle)
     - `operation_id` (specific step or action identity)
     - `attempt_number` (attempt count within retry budget)
     - `operation_idempotency_token` (token supplied to external systems/providers)
     These fields are not introduced prematurely in Capability 1.

---

## 9. Timeout Semantics: Logical vs Physical
- **Logical Timeout (Guaranteed by Capability 1 & InProcessExecutionProvider)**:
  - Wall-clock execution is monitored via timers and `Promise.race()`.
  - When duration exceeds `timeout_ms`, the runtime transitions status to `TIMED_OUT`, revokes the lease, and emits `run.timed_out`.
  - *Non-Preemption Guarantee*: In `InProcessExecutionProvider`, `Promise.race()` causes the runtime to stop waiting for an operation and drop late results, but it does **NOT** physically terminate underlying asynchronous operations or worker threads.
- **Physical Process Termination (Implemented in DockerExecutionProvider)**:
  - In `DockerExecutionProvider`, timeouts trigger active physical termination:
    1. Sends `SIGTERM` / `SIGKILL` to the host child process wrapper (`child.kill("SIGKILL")`).
    2. Explicitly invokes `docker kill <containerName>` to terminate the running container immediately.
    3. Guarantees container destruction via `docker rm -f <containerName>` in a `finally` block.

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

---

## 11. Execution Provider Boundary & Performance Protocol

### 11.1 Lifecycle Responsibility Division
- **ExecutionProvider**:
  - Owns execution mechanics ONLY (in-process, container, subprocess).
  - Reports raw execution outcomes (`SUCCESS`, `FAILED`, `TIMED_OUT`, `CANCELLED`).
  - Does **NOT** own: run lifecycle, lease state, worker ownership, retry policy, or run state transitions.
- **Application Runtime (`WorkerRuntime` & `RunCoordinator`)**:
  - Owns run lifecycle, leases, fencing verification, retry decisions, and state persistence.
  - Maps provider execution outcomes into atomic state machine transitions.

### 11.2 Operation Registry vs Authorization Gate
- Looking up an operation by `operationName` in a provider registry is mechanical dispatch, **NOT** an authorization mechanism.
- Future operation execution must pass through an outer policy and capability authorization gate before dispatch. Authorization is not implemented at the provider execution layer.

### 11.3 Performance Evaluation Protocol
- Early microbenchmark observations (e.g. `<0.01 ms/op` provider abstraction overhead) represent **initial local microbenchmark observations only**, NOT production performance guarantees.
- Future rigorous performance evaluations must report at minimum:
  - `p50` latency
  - `p95` latency
  - `p99` latency
  and include explicit workload patterns, host hardware, and OS environment specifications.

### 11.4 Docker Execution Provider Architecture (Task 1.5)
- **Drop-in Provider Compatibility**:
  - `DockerExecutionProvider` implements `ExecutionProvider` alongside `InProcessExecutionProvider`.
  - The application runtime (`WorkerRuntime`, `RunCoordinator`, state machine, lease manager) remains 100% unaware of container mechanics.
- **Ephemeral Container Lifecycle & Blast Radius Reduction**:
  - Each execution request launches an ephemeral container named `emerald-exec-<runId>-<attempt>-<nonce>`.
  - Input JSON is streamed directly via pipe to Node.js inside the container via standard input (`stdin`); no host files or daemon sockets are mounted.
  - The container is isolated from host filesystem mounts, uses a read-only container root filesystem (`--read-only`), and has only explicitly controlled temporary writable storage (`--tmpfs /tmp:rw,noexec,nosuid,size=64m`). This significantly reduces the blast radius of filesystem mutation and untrusted execution relative to in-process execution, but does not represent an absolute filesystem security boundary.
  - Docker `--network=none` is configured. Normal container network connectivity is therefore disabled. Platform and daemon assumptions remain part of the threat model. Container isolation is defense-in-depth, not an absolute security boundary.
- **Fail-Closed Policy for Untrusted Operations**:
  - For operations requiring isolation: if Docker is unavailable, the runtime/caller must **fail closed (FAIL CLOSED)**.
  - In-process execution must **NOT** be used as an automatic fallback for untrusted operations.
  - In-process execution remains available exclusively for explicitly trusted deterministic operations.
- **Output Limit Protection**:
  - Stdout and stderr streams are continuously counted; if combined bytes exceed `maxOutputBytes` (default 1MB), the host immediately terminates the container and returns `FAILED` with error code `OUTPUT_LIMIT_EXCEEDED`.
- **Cleanup Guarantees**:
  - Container removal (`docker rm -f <containerName>`) is unconditionally executed in a `finally` block on every execution path (success, error, timeout, or output truncation).
- **Observed Characteristics & Threat Model Limitations**:
  - **Latency Observation**: Container startup latency of $\approx 1.2\text{s} - 2.5\text{s}$ per operation is an **initial local observation on the development environment** (Windows 11 host with Docker Desktop 29.8.0, image `node:22-alpine`, 15 test executions of deterministic echo/sum scripts). It is not a production benchmark.
  - **Threat Model**: Host OS kernel is shared with the container via WSL2. Container escape vulnerabilities, kernel bugs, and Docker daemon bugs remain part of the threat model. Multi-tenant untrusted execution requires dedicated microVM isolation (e.g. Firecracker/gVisor).

