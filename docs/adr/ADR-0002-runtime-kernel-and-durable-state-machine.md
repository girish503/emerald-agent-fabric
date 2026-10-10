# ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store

## Status
Approved

## Date
2026-10-10

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [docs/product/prd.md](../product/prd.md) (Capability 1 PRD)
- [ADR-0001](./ADR-0001-master-engineering-constitution.md)

---

## 1. Context
Autonomous agent runtimes commonly manage execution loops as ephemeral, in-memory async tasks (`while (running) { step() }`). When process terminations, unhandled exceptions, worker crashes, or machine reboots occur:
- Runtime execution state is permanently lost.
- In-flight operations leave dirty, unrecoverable machine states.
- Scattered boolean variables (`isDone`, `isRunning`) suffer from race conditions and lost updates.
- Ephemeral logs fail to provide deterministic, queryable audit trails or replay capabilities.
- Workers in background execution risk double-claiming tasks or silently abandoning failed runs.

Emerald Agent Fabric requires a deterministic, crash-recoverable execution foundation before introducing container sandboxes, tool invocation engines, LLM provider adapters, or Reflex heuristics.

---

## 2. Decision

We establish the **Emerald Runtime Kernel (Capability 1)** with the following architectural choices:

### 2.1 Execution Semantics: At-Least-Once Delivery with Atomic State Transitions
We explicitly reject claims of "exactly-once execution." Due to the fundamental impossibility of distributed consensus during unannounced worker crashes (Two Generals' Problem), an external operation may complete side effects before the worker dies, prior to persisting completion.
Therefore:
1. **Execution Delivery**: *At-least-once*. Crashed or abandoned runs are recovered and re-dispatched up to `max_attempts`.
2. **State Transition Atomicity**: *Exactly-once transactional mutation*. State mutations are governed by Optimistic Concurrency Control (`version`) and committed in single SQLite ACID transactions.
3. **Operation Idempotency**: *Contract-level requirement*. Operations must accept idempotency tokens or be pure functions $f(\text{input}) = \text{output}$.
4. **Event Persistence**: *Append-only, gapless, transaction-bound*. Every event is sequenced per `run_id` and committed in the identical transaction as the state mutation.

### 2.2 Decoupled Pure Domain State Machine
The domain state machine is implemented as a pure TypeScript model without database dependencies:
- Inputs: Current state snapshot, command/event, transition context.
- Output: Validated new state snapshot + domain event, or `InvalidStateTransitionError`.
- Terminal states (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) are immutable and irrevocable.
- The persistence layer executes state changes only after domain validation passes.

### 2.3 Single-Transaction Boundaries for Lifecycle Transitions
Every state mutation and its corresponding event insertion execute inside a single SQLite transaction (`BEGIN IMMEDIATE ... COMMIT`):
- `createRun`: Validate input → Insert `runs` row (`version = 1`) → Insert `run.created` event → Commit.
- `queueRun`: Verify `version` → Update `status = QUEUED`, increment `version` → Insert `run.queued` event → Commit.
- `claimRun`: Verify `status IN ('QUEUED', 'RECOVERING')` and lease expiry → Update `status = LEASED`, assign `worker_id`, `lease_id`, `lease_expires_at`, increment `version` → Insert `worker.claimed` event → Commit.
- `startRun`: Verify `worker_id` and `lease_id` → Update `status = RUNNING`, increment `version` → Insert `run.started` event → Commit.
- `completeRun`: Verify `worker_id` and `lease_id` → Update `status = COMPLETED`, persist `result_payload`, increment `version` → Insert `run.completed` event → Commit.
- `failRun`: Verify `worker_id` and `lease_id` → Update `status = FAILED`, persist `error_payload`, increment `version` → Insert `run.failed` event → Commit.

### 2.4 Gapless Event Sequencing via Serialized Write Locks
- The event sequence number is an integer strictly ordered $1, 2, 3, \dots, N$ per `run_id`.
- SQLite `BEGIN IMMEDIATE` serializes write transactions, preventing concurrent readers from seeing uncommitted `MAX(sequence)`.
- Inside the transaction, sequence is computed as:
  `SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = :run_id`.
- Enforced by database constraint: `UNIQUE(run_id, sequence)`.
- Rollbacks leave no holes in the committed sequence stream.

### 2.5 Distinct Worker, Lease, and Fencing Token Model
- `Worker`: Represents the executing process (`worker_id`).
- `Lease`: Represents a time-bounded exclusive lock on a run (`lease_id`, `expires_at`).
- `lease_id` functions as a **fencing token**. Every update by an active worker must match:
  `WHERE run_id = :run_id AND lease_id = :lease_id AND version = :version`.
- If a worker stalls past lease TTL and a sweeper reclaims the run with a new `lease_id`, the stale worker's subsequent update matches 0 rows and is rejected with `LEASE_LOST`. Stale workers cannot corrupt recovered runs.

### 2.6 Logical Timeout vs Physical Process Termination
- Capability 1 guarantees **logical timeout state transitions**: When wall-clock duration exceeds `timeout_ms`, the runtime transitions state to `TIMED_OUT`, revokes the lease, and emits `run.timed_out`.
- In-process Node.js execution cannot guarantee hard preemption of blocked synchronous CPU loops. Hard physical execution boundaries (SIGKILL, container cgroup disposal) belong strictly to Phase 3 (Sandbox Isolation Layer).

### 2.7 Hexagonal Architecture & Port/Adapter Decoupling
The codebase adheres to strict inward dependencies:
```
Transport → Application → Domain → Ports ← Adapters ← Infrastructure
```
- Domain depends only on pure ports (`StateStorePort`, `EventStorePort`, `DeterministicOperationPort`, `ClockPort`, `IdGeneratorPort`).
- SQLite, Fastify, and system clocks are external adapters implementing ports.
- Monolithic single-package modular directory layout (`src/domain`, `src/application`, `src/ports`, `src/adapters`) avoids premature monorepo packaging overhead while enforcing strict architectural boundaries.

---

## 3. Alternatives Considered

### 3.1 In-Memory State Machine
- *Evaluated*: Managing state solely in Node.js heap memory (e.g. state charts with XState or in-memory arrays).
- *Rejected*: Zero crash durability. Process termination loses all active work. Fails core research mission of recoverable agent systems.

### 3.2 External Relational Database (PostgreSQL)
- *Evaluated*: Using a containerized or remote PostgreSQL instance with `pg` client.
- *Rejected*: Violates the **CPU-First Developer Machine** requirement (Constitution Section 30). Requires Docker, network connectivity, and external service management for basic unit and integration tests.

### 3.3 Redis / Distributed Queue (BullMQ, Celery)
- *Evaluated*: Queueing tasks in Redis and tracking state via Redis hashes.
- *Rejected*: Violates No Speculative Architecture (Constitution Section 5). Dual-system consistency between Redis queue and persistent storage introduces split-brain failure modes without measured need.

### 3.4 Full Event Sourcing from Day One
- *Evaluated*: Storing zero operational state rows, deriving run status solely by replaying events on every query.
- *Rejected*: Adds unnecessary complexity to worker leasing, claim queries, and index filtering. Hybrid model (durable operational tables + append-only event stream in SQLite WAL) provides simple relational queries with complete event history.

---

## 4. Consequences

### Positive
- Total determinism and crash durability on standard developer workstations.
- Complete auditability and replay foundations via append-only event streams.
- Zero risk of lost updates or split-brain worker ownership due to OCC versioning and lease fencing.
- Fast local automated tests (in-memory SQLite or temporary files, executing in milliseconds).

### Negative
- SQLite file-level write serialization means write throughput on a single database file is bounded (typically 1,000–5,000 write transactions/sec on NVMe).
- In-process execution cannot physically terminate malicious infinite loops without container sandboxes (deferred to Phase 3).

---

## 5. Revisit Conditions
This architectural decision must be formally revisited via an ADR update if:
1. Multi-node distributed execution is required, and shared-disk SQLite (LiteFS/NFS) proves insufficient for concurrent multi-host writers.
2. Measured SQLite write transaction lock contention under realistic agent workloads exceeds 50ms p99 latency despite WAL tuning.
3. Complex multi-worker distributed scheduling requires Raft-based consensus or Postgres row-level locking (`SKIP LOCKED`).
