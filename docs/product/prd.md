# Emerald Agent Fabric: Product Requirements Document (PRD)

## Document Information
- **Status**: Approved PRD — Capability 1 Baseline
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Layer**: Product Specification (PRD)

---

# Capability 1: Deterministic Runtime Loop & State Machine

## 1. Problem Statement
Autonomous software-engineering agents execute on unpredictable filesystems, invoke external tools, and interface with stochastic model APIs. In contemporary open-source and commercial agent frameworks, execution is typically managed as an uninstrumented, in-memory asynchronous loop (`while (running) { step() }`).

This pattern suffers from critical engineering defects:
1. **Zero Process Durability**: A process crash, uncaught exception, or machine restart destroys all runtime state. Unfinished tasks remain in limbo, zombie child processes are orphaned, and work cannot be resumed.
2. **Scatter-Boolean State Corruption**: When execution state is managed via scattered boolean flags (`isRunning = true`, `isDone = false`), race conditions and unexpected state mutations lead to duplicate tool executions or unhandled error states.
3. **Absence of Replay and Audit Trails**: Ephemeral stdout/stderr logs are unstructured, non-transactional, and lack deterministic sequencing. They cannot be used for post-hoc security audits, failure attribution, or deterministic replay.
4. **Uncoordinated Worker Ownership**: Without explicit leasing and heartbeat semantics, multi-worker or background executions risk double-claiming tasks or silently abandoning failed runs.

Downstream capabilities in Emerald Agent Fabric (sandboxed execution, tool orchestration, human approvals, Reflex risk scoring, and harness evaluation) require an unyielding, durable, verifiable execution kernel.

---

## 2. Goal
Build the minimal, zero-dependency, deterministic runtime execution kernel for Emerald Agent Fabric. The kernel must guarantee:
- Explicit, validatable lifecycle state transitions.
- Atomic state and event persistence using SQLite in WAL mode.
- Worker lease coordination with heartbeat and crash recovery semantics.
- Exactly-once state transitions with at-least-once dispatch idempotency.
- Complete execution determinism without requiring an LLM, sandbox, or network services.

---

## 3. Users and Actors
1. **AI Infrastructure Engineer**: Embeds the runtime kernel into workers, runners, and agent harnesses.
2. **AI Security Researcher**: Audits state transition gates, capability grants, and immutable event sequences.
3. **Agent Evaluation Researcher**: Relies on deterministic execution traces and failure classifications for benchmark reproducibility.
4. **System Worker**: Autonomous background process that leases, executes, and updates runs.

---

## 4. Scope & Smallest Useful Vertical Slice

### Minimal Vertical Slice Architecture
The vertical slice executes a purely deterministic operation (e.g., a pure mathematical transform, string transformation, or JSON schema inspection) end-to-end:

```
Create Task (Input Specification)
       │
       ▼
Create Run (Idempotency Key, Attempt Count = 0)
       │
       ▼
Queue Run (Status: QUEUED)
       │
       ▼
Worker Claims Run (Status: LEASED, Worker ID, Lease TTL)
       │
       ▼
Start Run (Status: RUNNING)
       │
       ▼
Execute Deterministic Operation (Pure function execution)
       │
       ▼
Persist Result Payload & Append Events
       │
       ▼
Complete Run (Status: COMPLETED)
```

### Slice Parameters
- **Input**: Strongly-typed task input payload (e.g. `{ operation: "echo", text: "hello" }` or `{ operation: "sum", values: [1, 2, 3] }`).
- **Output**: Strongly-typed result payload (e.g. `{ status: "ok", result: 6, executionTimeMs: 2 }`).
- **Persistence**: Single SQLite database file in WAL mode with tables: `tasks`, `runs`, `run_events`, `workers`, `leases`.
- **Events Emitted**: `run.created`, `run.queued`, `worker.claimed`, `run.started`, `operation.started`, `operation.completed`, `run.completed`.

---

## 5. Explicit Non-Goals
To prevent premature complexity and maintain focus on the deterministic kernel:
- **NO LLM Integration**: Zero model provider SDKs, prompt wrappers, or tokenizer dependencies.
- **NO Sandbox/Docker**: No container runtimes, OCI images, or cgroups in this phase.
- **NO Shell Execution**: No arbitrary CLI command execution (`exec`, `spawn`, `sh`).
- **NO Network / Distributed Infrastructure**: No Kafka, Redis, RabbitMQ, PostgreSQL, or cloud services.
- **NO REST / WebSocket APIs**: This capability is delivered as a pure, testable TypeScript library/kernel.
- **NO Frontend / Web UI**: Run consoles and UI visualizations belong to Phase 6.
- **NO Reflex / Heuristic Layer**: Reflex rules belong to Phase 11.

---

## 6. Runtime State Machine

### Canonical States

| State | Role in Capability 1 | Description |
| :--- | :--- | :--- |
| `CREATED` | Active | Initial record created in persistence; task parameters validated. |
| `QUEUED` | Active | Run is ready and visible for worker lease acquisition. |
| `LEASED` | Active | Worker holds an active lease with expiration TTL; preparing run. |
| `RUNNING` | Active | Deterministic operation is actively executing. |
| `VERIFYING` | Domain Model Only (Reserved) | Reserved for code verification phases (Phases 7/8). |
| `WAITING_APPROVAL` | Domain Model Only (Reserved) | Reserved for human-in-the-loop policy gates (Phases 4/7). |
| `COMPLETED` | Active (Terminal) | Successful termination; output payload and terminal event persisted. |
| `FAILED` | Active (Terminal) | Unrecoverable error or max retries exhausted; error classified. |
| `CANCELLED` | Active (Terminal) | Explicit cancellation triggered by supervisor. |
| `TIMED_OUT` | Active (Terminal) | Wall-clock execution exceeded configured timeout. |
| `RECOVERING` | Active | Worker lease expired or heartbeat failed; supervisor evaluating retry vs failure. |

### State Transition Matrix

| Source State | Target State | Trigger / Event | Permitted Actor | Atomic Mutation |
| :--- | :--- | :--- | :--- | :--- |
| *(None)* | `CREATED` | `run.create` | Client / API | Insert `runs` row with `version = 1`. |
| `CREATED` | `QUEUED` | `run.queue` | Client / Dispatcher | Update `status = QUEUED`, emit `run.queued`. |
| `QUEUED` | `LEASED` | `worker.claim` | Worker | Atomic update with `worker_id`, `lease_id`, `lease_expires_at`. |
| `LEASED` | `RUNNING` | `run.start` | Lease-holding Worker | Update `status = RUNNING`, emit `run.started`. |
| `RUNNING` | `COMPLETED` | `run.complete` | Lease-holding Worker | Store `result_payload`, update `status = COMPLETED`. |
| `RUNNING` | `FAILED` | `run.fail` | Lease-holding Worker | Store `error_payload`, update `status = FAILED`. |
| `RUNNING` | `TIMED_OUT` | `run.timeout` | Lease Worker / Supervisor | Store timeout error, update `status = TIMED_OUT`. |
| `RUNNING` | `CANCELLED` | `run.cancel` | Supervisor / Client | Update `status = CANCELLED`, revoke lease. |
| `LEASED` / `RUNNING` | `RECOVERING` | `lease.expire` | Supervisor / Sweeper | Worker heartbeat lapsed; update `status = RECOVERING`. |
| `RECOVERING` | `QUEUED` | `run.retry` | Supervisor | Increment `attempt_count`, clear worker/lease, status to `QUEUED`. |
| `RECOVERING` | `FAILED` | `run.fail_exhausted`| Supervisor | `attempt_count >= max_attempts`; status to `FAILED`. |

**Rule**: Any transition not listed above is an **Invalid State Transition** and must throw `InvalidStateTransitionError` and immediately abort the transaction.

---

## 7. Runtime Invariants
1. **Uniqueness**: Every Task, Run, Worker, Lease, and Event possesses a unique, sortable identifier (UUIDv7).
2. **Monotonic Terminal States**: Once a Run reaches `COMPLETED`, `FAILED`, `CANCELLED`, or `TIMED_OUT`, it can never transition to any other state.
3. **Mutual Exclusion of Leases**: A run has at most one valid, unexpired lease at any timestamp $T$.
4. **No Unleased Execution**: A worker can only transition a run from `LEASED` to `RUNNING` or `RUNNING` to `COMPLETED`/`FAILED` if it currently holds the active, unexpired lease matching `current_worker_id` and `lease_id`.
5. **State-Event Atomicity**: Every state transition and its corresponding `run_events` entry MUST be committed in the exact same SQLite ACID transaction.
6. **Strict Event Sequencing**: Events for a given `run_id` have a monotonically increasing, gapless sequence number ($1, 2, 3, \dots$).
7. **Authoritative Persistence**: The SQLite WAL database is the sole source of truth. In-memory state and application logs are non-authoritative projections.
8. **Explicit Error Categorization**: Every failure must be classified into a typed error domain (`TRANSIENT`, `PERMANENT`, `INTERNAL_ERROR`, `TIMED_OUT`).

---

## 8. Persistence Model (SQLite + WAL)

### SQLite PRAGMA Configuration
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### Table Definitions

#### 1. `tasks`
Stores immutable task definitions.
- `task_id` (TEXT PRIMARY KEY)
- `title` (TEXT NOT NULL)
- `description` (TEXT NOT NULL DEFAULT '')
- `input_payload` (TEXT NOT NULL) -- JSON
- `created_at` (TEXT NOT NULL) -- ISO 8601 UTC
- `updated_at` (TEXT NOT NULL)

#### 2. `runs`
Tracks run lifecycle, leases, and operational state.
- `run_id` (TEXT PRIMARY KEY)
- `task_id` (TEXT NOT NULL REFERENCES tasks(task_id))
- `status` (TEXT NOT NULL) -- CREATED, QUEUED, LEASED, RUNNING, COMPLETED, FAILED, CANCELLED, TIMED_OUT, RECOVERING
- `idempotency_key` (TEXT UNIQUE)
- `current_worker_id` (TEXT REFERENCES workers(worker_id))
- `lease_id` (TEXT)
- `lease_expires_at` (TEXT) -- ISO 8601 UTC
- `attempt_count` (INTEGER NOT NULL DEFAULT 0)
- `max_attempts` (INTEGER NOT NULL DEFAULT 3)
- `timeout_ms` (INTEGER NOT NULL DEFAULT 30000)
- `result_payload` (TEXT) -- JSON
- `error_payload` (TEXT) -- JSON
- `version` (INTEGER NOT NULL DEFAULT 1) -- Optimistic concurrency control
- `created_at` (TEXT NOT NULL)
- `updated_at` (TEXT NOT NULL)

*Indexes*: `idx_runs_status`, `idx_runs_task_id`, `idx_runs_lease_expires`.

#### 3. `run_events`
Append-only immutable audit trail and replay stream.
- `event_id` (TEXT PRIMARY KEY)
- `run_id` (TEXT NOT NULL REFERENCES runs(run_id))
- `sequence` (INTEGER NOT NULL)
- `timestamp` (TEXT NOT NULL)
- `event_type` (TEXT NOT NULL)
- `schema_version` (INTEGER NOT NULL DEFAULT 1)
- `producer` (TEXT NOT NULL)
- `payload` (TEXT NOT NULL) -- JSON

*Constraints*: `UNIQUE(run_id, sequence)`.
*Indexes*: `idx_events_run_id_seq`, `idx_events_type`.

#### 4. `workers`
Active and historic worker node registry.
- `worker_id` (TEXT PRIMARY KEY)
- `hostname` (TEXT NOT NULL)
- `pid` (INTEGER NOT NULL)
- `status` (TEXT NOT NULL) -- ACTIVE, DRAINING, STOPPED
- `last_heartbeat_at` (TEXT NOT NULL)
- `created_at` (TEXT NOT NULL)

#### 5. `leases`
Audit trail of lease acquisitions and releases.
- `lease_id` (TEXT PRIMARY KEY)
- `run_id` (TEXT NOT NULL REFERENCES runs(run_id))
- `worker_id` (TEXT NOT NULL REFERENCES workers(worker_id))
- `acquired_at` (TEXT NOT NULL)
- `expires_at` (TEXT NOT NULL)
- `released_at` (TEXT)
- `state` (TEXT NOT NULL) -- ACTIVE, EXPIRED, RELEASED, REVOKED

---

## 9. Event Model & Contract

### Canonical Event Structure
```typescript
export interface FabricEvent<T = Record<string, unknown>> {
  eventId: string;          // UUIDv7
  runId: string;            // UUIDv7 of target run
  sequence: number;         // 1-indexed gapless monotonic integer
  timestamp: string;        // ISO 8601 UTC
  eventType: string;        // e.g. "run.started", "operation.completed"
  schemaVersion: number;    // SemVer integer (default 1)
  producer: string;         // e.g. "worker:hostname:pid"
  payload: T;               // Validated event payload
}
```

### Capability 1 Event Taxonomy
- `run.created`: Initial creation with task reference and parameters.
- `run.queued`: Run marked ready for worker pickup.
- `worker.claimed`: Worker secured lease with TTL.
- `run.started`: Execution initiated by worker.
- `operation.started`: Deterministic operation step commenced.
- `operation.completed`: Deterministic operation finished with result output.
- `run.completed`: Run transitioned to terminal success state.
- `run.failed`: Run encountered unrecoverable failure.
- `run.timed_out`: Run execution exceeded wall-clock timeout budget.
- `run.cancelled`: Run cancelled by supervisor.
- `lease.renewed`: Worker heartbeat extended lease duration.
- `lease.expired`: Lease expired without heartbeat; entered recovery.
- `run.recovered`: Run recovered for retry attempt.

---

## 10. Worker / Lease Semantics

1. **Worker Identity**: Workers generate a globally unique identifier on boot:
   `worker-${hostname}-${pid}-${randomNanoSuffix}`.
2. **Atomic Lease Claim**:
   A worker queries for candidate runs:
   ```sql
   UPDATE runs
   SET status = 'LEASED',
       current_worker_id = :worker_id,
       lease_id = :lease_id,
       lease_expires_at = :lease_expires_at,
       version = version + 1,
       updated_at = :now
   WHERE run_id = (
       SELECT run_id FROM runs
       WHERE status IN ('QUEUED', 'RECOVERING')
         AND (lease_expires_at IS NULL OR lease_expires_at < :now)
       ORDER BY created_at ASC
       LIMIT 1
   )
   RETURNING run_id, task_id, version;
   ```
3. **Heartbeat Loop**:
   - While a worker executes a task, a recurring heartbeat extends `lease_expires_at` by `leaseTtlMs` (default: 5000ms) every `heartbeatIntervalMs` (default: 1500ms).
   - If the database is unreachable or locks fail for greater than `leaseTtlMs`, the worker must abort execution locally.
4. **Crash Recovery (Sweeper)**:
   - A supervisor or sweeper process scans for runs where `status IN ('LEASED', 'RUNNING')` and `lease_expires_at < :now`.
   - The supervisor marks the lease as `EXPIRED`, transitions the run to `RECOVERING`, and:
     - If `attempt_count < max_attempts`: resets status to `QUEUED` and increments `attempt_count`.
     - If `attempt_count >= max_attempts`: transitions to `FAILED` with `INTERNAL_ERROR: WORKER_LEASE_EXPIRED`.

---

## 11. Failure Taxonomy & Handling

| Category | Classification | Retry Policy | Terminal State | Example |
| :--- | :--- | :--- | :--- | :--- |
| `TRANSIENT` | Recoverable | Retry up to `max_attempts` | `RECOVERING` → `QUEUED` | SQLite lock contention, transient I/O pause. |
| `PERMANENT` | Fatal | No Retry | `FAILED` | Invalid input payload schema, unknown operation code. |
| `INTERNAL_ERROR` | Fatal / Unchecked | No Retry (unless worker died pre-commit) | `FAILED` | Corrupted binary state, unhandled runtime panic. |
| `TIMED_OUT` | Fatal | No Retry | `TIMED_OUT` | Execution duration exceeded `timeout_ms`. |
| `CANCELLED` | Administrative | No Retry | `CANCELLED` | Explicit abort request issued by caller. |

---

## 12. Idempotency Model
1. **Creation Idempotency**:
   - `runs` table enforces `UNIQUE(idempotency_key)`.
   - A client submitting `createRun` with an existing `idempotency_key` receives the existing `run_id` without creating duplicate execution tasks.
2. **Transition Idempotency**:
   - Updates utilize optimistic concurrency via `version = version + 1`.
   - If another process altered the run between read and write, the update matches 0 rows and fails safely.
3. **Operation Determinism**:
   - Deterministic operations in Capability 1 are pure functions: $f(\text{input}) \to \text{output}$. Executing the operation multiple times produces identical results without side effects.

---

## 13. Security Boundaries
1. **Input Payload Validation**: All inputs are validated via strict Zod schemas with unknown key stripping before reaching the database.
2. **SQL Injection Defense**: 100% of database interactions use typed parameterized SQLite statements. No dynamic string SQL concatenation.
3. **Immutability of Audit Events**: `run_events` is append-only. The database layer exposes no update or delete primitives for events.
4. **Lease Tamper Prevention**: Workers cannot renew leases or transition states for runs where `current_worker_id != worker_id` or `lease_id != active_lease_id`.
5. **No Shell / No Eval**: The runtime engine forbids `eval`, `Function()`, or child process execution.

---

## 14. Observability & Telemetry

### Authoritative vs Diagnostic Data
- **Authoritative Source of Truth**: SQLite WAL database (`runs`, `run_events`).
- **Diagnostic Output**: Structured JSON log lines written to stderr/stdout with fields:
  `{ timestamp, level, runId, workerId, eventType, message, durationMs }`.
- **OpenTelemetry (Future Bridge)**: Prepared span hooks for:
  - `run.queue_latency_ms` = $T_{\text{leased}} - T_{\text{queued}}$
  - `run.execution_latency_ms` = $T_{\text{completed}} - T_{\text{started}}$
  - `state.transition_latency_ms` = duration of transaction.

---

## 15. Performance Baseline Targets (Local CPU Machine)
- State Transition Transaction Latency: $< 5\text{ ms}$ (SQLite WAL).
- Single Event Append Latency: $< 2\text{ ms}$.
- Worker Claim Query Latency: $< 5\text{ ms}$.
- End-to-End Trivial Run Latency: $< 30\text{ ms}$ total wall-clock duration.
- Memory Footprint: $< 50\text{ MB}$ RSS overhead for the runtime engine.

---

## 16. Evaluation Test Suite Plan

### Deterministic Test Matrix
1. **Happy Path Execution**:
   - `CREATED` → `QUEUED` → `LEASED` → `RUNNING` → `COMPLETED`.
   - Verifies: Correct result output, 7 events emitted with sequences 1..7, final status `COMPLETED`.
2. **Invalid State Transition Rejection**:
   - Attempt `CREATED` → `RUNNING` (skipping `QUEUED` & `LEASED`).
   - Attempt `COMPLETED` → `RUNNING`.
   - Attempt `FAILED` → `QUEUED`.
   - Verifies: Throws `InvalidStateTransitionError`, zero rows modified, no events appended.
3. **Concurrent Worker Claim Race**:
   - Two workers attempt to claim the same queued run simultaneously.
   - Verifies: Exactly one worker acquires the lease; the second worker gets `null`; no duplicate execution.
4. **Worker Crash & Lease Expiration**:
   - Worker claims run, transitions to `RUNNING`, and stops sending heartbeats.
   - Sweeper inspects expired lease; transitions run to `RECOVERING` → `QUEUED`.
   - Verifies: `attempt_count` increments, run is reclaimable by a healthy worker.
5. **Duplicate Event Sequence Violation**:
   - Attempt to insert an event with an existing `(run_id, sequence)`.
   - Verifies: SQLite unique constraint violation, transaction rollback.
6. **Creation Idempotency**:
   - Submit two create run calls with identical `idempotency_key`.
   - Verifies: Second call returns existing `run_id`; table row count remains 1.
7. **Timeout Enforcement**:
   - Run configured with `timeout_ms = 100`; operation pauses for 250ms.
   - Verifies: Worker detects timeout, transitions to `TIMED_OUT`, persists timeout error payload.
8. **Administrative Cancellation**:
   - Run in `RUNNING` receives cancellation signal.
   - Verifies: Status transitions to `CANCELLED`, lease is released, terminal event emitted.
9. **Database Restart Recovery**:
   - Database connection closed and reopened mid-lifecycle.
   - Verifies: SQLite WAL recovery restores valid state; uncorrupted event sequences.

---

## 17. Definition of Done
Capability 1 is complete only when:
1. Product PRD (this document) and Architecture ADR-0002 are formally approved.
2. TypeScript domain state machine rejects 100% of invalid transitions with typed errors.
3. SQLite WAL persistence stores tasks, runs, run_events, workers, and leases transactionally.
4. Worker lease acquisition, heartbeat renewal, and sweeper recovery are implemented and verified.
5. All 9 evaluation test suites pass with 100% determinism in Vitest.
6. Typecheck (`tsc --noEmit`) passes with zero errors under strict mode.
7. Zero LLM, sandbox, or network dependencies introduced.
8. Security review confirms parameterized SQL, append-only events, and input validation.

---

## 18. Risks & Mitigations
- **Risk**: SQLite file lock contention under rapid worker polling.
  - *Mitigation*: Enable `PRAGMA busy_timeout = 5000` and use exponential backoff on worker poll intervals.
- **Risk**: Time drift across worker clocks affecting lease expirations.
  - *Mitigation*: Initial design runs locally on a single machine using monotonic timestamps (`performance.now()` / system clock); future multi-node systems will use database-generated timestamps.

---

## 19. Open Questions
1. Should worker heartbeats append an event to `run_events` on *every* renewal, or would that bloat the event stream for long-running agent tasks?
   *(Current recommendation: Store heartbeat timestamp only on `workers` and `leases` tables; emit `lease.renewed` event only on lease expiration or recovery anomalies).*
2. Should deterministic operations support streaming output events, or is a single `operation.completed` payload sufficient for Capability 1?
   *(Current recommendation: Single `operation.completed` payload for Capability 1; stream chunk events can be introduced with tool execution in Phase 4).*

---

## 20. Next Implementation Step
Produce **Architecture Decision Record (ADR-0002)** detailing the concrete software architecture, domain model, hexagonal port/adapter interfaces, and SQLite persistence implementation plan.
