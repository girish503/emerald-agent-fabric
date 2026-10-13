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

---

## 12. Policy & Capability Enforcement Boundary (Task 1.6)

### 12.1 Execution Pipeline
```text
Request
   ↓
Policy Evaluation
   ↓
Capability Check
   ↓
ExecutionProvider
   ↓
Sandbox / Execution Environment
   ↓
Result
```

### 12.2 Separation of Concerns
- **PolicyEvaluator (Domain)**: Pure domain function answering *"Is this capability permitted under this policy, and what isolation level is required?"* It has ZERO knowledge of Docker, execution providers, or daemon availability.
- **WorkerRuntime (Application Orchestrator)**: Evaluates policy upstream and verifies whether the configured execution provider satisfies the required isolation level. Fails closed with `ISOLATION_REQUIREMENT_NOT_MET` if unsatisfied.
- **ExecutionProvider (Infrastructure Adapter)**: Answers *"How do I mechanically execute this?"* Executes authorized code in the designated environment.
- Providers do not evaluate security policy, and callers/providers cannot bypass policy enforcement.

### 12.3 Core Policy Invariants
1. **Deny-by-Default**: Any capability not explicitly granted in `allowedCapabilities` is rejected (`CAPABILITY_NOT_GRANTED`).
2. **Explicit, Tiny Vocabulary**: Confined strictly to deterministic primitives (`execution.echo`, `execution.sum`, `execution.slow`, `execution.fail`). Unrecognized operations are rejected (`UNKNOWN_CAPABILITY`).
3. **Orthogonal Isolation Requirement**: Capability authorization and isolation requirements are independent dimensions.
   - `IN_PROCESS`: Permitted solely when the operation is explicitly classified as trusted deterministic execution in `trustedInProcessOperations`.
   - `ISOLATED`: Execution must take place in an isolated execution environment.
4. **Fail-Closed Isolation**: If `ISOLATED` execution is required and the isolated environment is unavailable, policy evaluation yields `DENIED` with `ISOLATION_REQUIREMENT_NOT_MET`. No silent in-process downgrade is ever permitted.
5. **No Self-Authorization**: Execution requests and payload data are treated as untrusted. Agents cannot grant themselves capabilities or modify frozen policy objects.
6. **Auditability**: Every policy decision produces structured audit data (`policy.evaluated` event) and on denial transitions the run to `FAILED` with `POLICY_DENIED`, releasing leases without triggering retry loops.

---

## 13. Evidence & Verification Boundary (Task 1.7)

### 13.1 Execution Claim vs Verified Outcome
Emerald strictly distinguishes between an **execution claim** and **verified success**:
```text
ExecutionProvider: status = SUCCESS  ≠  Verified Outcome
```
- The `ExecutionProvider` reports execution outcomes from its mechanical execution perspective (`ExecutionResult`). This is a self-reported claim.
- The `DeterministicVerifier` evaluates immutable, structured `Evidence` against an explicit `VerificationSpec` independently of the provider's claimed success.

### 13.2 V1 Qualification: Provider-Reported Evidence
- **V1 Qualification**: V1 does **NOT** provide out-of-band independent observation.
- V1 establishes:
  ```text
  Provider-produced observation
          ↓
  Structured evidence (source: PROVIDER_REPORTED)
          ↓
  Independent deterministic verification logic
  ```
- True independent observation (external filesystem probes, out-of-band monitors) is explicitly deferred to future sandbox iterations.

### 13.3 Execution & Verification Pipeline
```text
ExecutionProvider
      ↓
ExecutionResult (claim: status, output, duration)
      ↓
Observation
      ↓
Evidence (source: PROVIDER_REPORTED, SHA-256 digest, bounded summary)
      ↓
DeterministicVerifier  <───  VerificationSpec (rule: EXACT_OUTPUT_MATCH, OUTPUT_HASH_MATCH, EXIT_CODE_ZERO)
      ↓
VerificationResult (VERIFIED | FAILED)
 ┌────┴────┐
 ▼         ▼
VERIFIED   FAILED
 ↓         ↓
complete   failRun(VERIFICATION_FAILED)
```

### 13.4 Core Verification Invariants
1. **No Blind Trust**: `ExecutionResult.status === "SUCCESS"` never triggers `completeRun()` when a `VerificationSpec` is present until `DeterministicVerifier` returns `VERIFIED`.
2. **Canonical Hashing & Integrity**:
   - Observations are sanitized via deterministic key-based redaction (`token`, `secret`, `password`, `credential`, `authorization`).
   - Redacted payloads are serialized with deterministic canonical JSON (lexicographically sorted keys, original array order preserved).
   - Content digest is computed as lowercase hexadecimal SHA-256 over the canonical, redacted string.
   - The persisted `contentHash` corresponds strictly to the persisted redacted representation.
3. **Bounded Summary (64 KB)**:
   - Initial experimental V1 limit of 64 KB for embedded summaries in the event store.
   - Payloads exceeding 64 KB omit raw content and transition `kind` to `CONTENT_HASH` to prevent SQLite WAL blob bloat.
4. **Pure, Deterministic Evaluation**:
   - `DeterministicVerifier` has zero I/O, zero network, zero Docker dependencies, and zero time-dependent decision logic.
   - Identical evidence + spec + verifier version yields identical verdicts.
5. **Decoupled Retry Responsibility**:
   - The verifier reports semantic verdicts (`VERIFIED` or `FAILED`) only.
   - The application runtime owns retry decisions. For deterministic operations, a verification failure indicates a logic violation rather than a transient fault, failing closed to terminal `FAILED` without retrying.
6. **State Machine: Dormant `VERIFYING` State**:
   - The `VERIFYING` state remains dormant in V1 to avoid write amplification and complex lease-handling for sub-millisecond CPU-bound checks.
   - Verification executes synchronously within the active `RUNNING` lease window before committing `run.completed` or `run.failed`.
7. **VerificationSpec Ownership**:
   - Durable ownership of verification specifications is intentionally deferred until Mission Contract design. In V1, specifications are passed via `WorkerRuntimeOptions.verificationSpec`.

### 13.5 Replay Architecture (Future Capability)
- **Architecturally Supported**: Deterministic content hashing and immutable evidence recording provide the foundation for deterministic audit and replay.
- **Scope Qualification**: Full execution replay and counterfactual evaluation engines are future research capabilities (Emerald Reflex); Task 1.7 implements the durable evidence schema and deterministic verification primitives.

---

## 14. Mission Contract Persistence & Reconstitution Architecture (Task 1.8B)

### 14.1 Storage Schema
Mission Contracts are persisted in the `mission_contracts` table:
```sql
CREATE TABLE IF NOT EXISTS mission_contracts (
  contract_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'REVOKED')),
  content_hash TEXT NOT NULL,
  canonical_spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  revoked_at TEXT,
  revocation_reason TEXT,
  PRIMARY KEY (contract_id, version)
);

CREATE INDEX IF NOT EXISTS idx_contracts_task_status ON mission_contracts(task_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_hash ON mission_contracts(contract_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_contracts_hash ON mission_contracts(content_hash);
```

### 14.2 Immutability vs Lifecycle Mutability
- **Governance Specification (`canonical_spec`)**: Completely immutable once inserted. Contains the execution policy, resource limits, verification specifications, and credential scopes.
- **Cryptographic Content Hash (`content_hash`)**: 64-character lowercase SHA-256 digest computed exclusively over the canonicalized, sorted specification. Remains identical across the entire contract lifecycle (`DRAFT`, `ACTIVE`, `REVOKED`).
- **Mutable Lifecycle Metadata**: Stored as distinct relational columns (`status`, `activated_at`, `revoked_at`, `revocation_reason`). Mutations execute through atomic domain transition guards (`activateMissionContract`, `revokeMissionContract`) and atomic SQL updates.

### 14.3 Fail-Closed Reconstitution
Reconstitution (`getContract`, `findContractsByHash`, `findContractsByTaskId`) does not trust stored database content blindly:
1. `canonical_spec` JSON is parsed and re-validated through `createMissionContractSpec`.
2. Any secret-bearing fields (`apiKey`, `password`, `secret`, `token`, `bearer`) trigger immediate rejection.
3. Cryptographic digest of the parsed specification is re-computed on the fly.
4. If computed hash differs from the stored `content_hash`, reconstitution throws `InvalidMissionContractError` immediately without repairing or fallback.
5. Reconstituted aggregates are deeply frozen (`deepFreeze`) before returning to the application layer.

### 14.4 Atomic Transitions & Referential Integrity
- Contracts reference tasks via `task_id REFERENCES tasks(task_id)`. SQLite foreign key constraints prevent orphan contracts.
- Transitions (`activateContract`, `revokeContract`) execute within `BEGIN IMMEDIATE` transactions, verifying current status (`WHERE status = 'DRAFT'` or `WHERE status = 'ACTIVE'`) to prevent concurrency races.
- The repository port `MissionContractStorePort` is integrated directly into `StateStorePort` and `StorageTransaction`, ensuring that contract updates can participate atomically in larger transaction boundaries.

---

## 15. Action and Attempt Execution Lifecycle Integration (Task 4.4-E)

### 15.1 Responsibility Hierarchy
The deterministic execution lifecycle coordinates six distinct architectural boundaries:
```text
WorkerRuntime
    ↓ coordinates lifecycle & lease authority
Action (Domain)
    ↓ owns logical intention, monotonic sequence, and state machine invariants
Attempt (Domain)
    ↓ owns physical execution trial (#1), idempotency token, and physical state machine
ToolExecutionGateway
    ↓ owns pre-execution governance, policy authorization, resource limits, and input validation
ToolAdapter
    ↓ owns typed tool implementation within workspace boundaries
ExecutionProvider
    ↓ owns physical sandbox execution (e.g. Docker container) where required
```

### 15.2 Deterministic Execution Lifecycle
For a governed Action, the runtime progresses through an unskippable sequence:
1. **Authoritative Run & Lease Resolution**: Worker verifies its active lease (`workerId`, `leaseId`) against the authoritative `runs` record.
2. **Action Creation / Ingestion**: Action is created in `CREATED` state or loaded from persistent state. If newly created, `Action.create` validates invariants and emits `action.created`.
3. **Gateway Authorization**: `ToolExecutionGateway.authorize()` evaluates Mission Contract authority, capability policy, resource ceilings, schema validation, workspace containment, and isolation posture. Zero provider execution occurs during authorization.
   - If denied: Action transitions directly from `CREATED` to `FAILED` with `action.failed`. Zero Attempts are created.
4. **Action Start**: Action transitions `CREATED` → `AUTHORIZED` (`action.authorized`) → `RUNNING` (`action.started`, attempt #1).
5. **Attempt Creation & Dispatch**: Attempt #1 is created in `CREATED` state (`attempt.created`), then transitions to `DISPATCHED` (`attempt.dispatched`) and `RUNNING` (`attempt.started`).
6. **Physical Tool Execution**: Invoked strictly through `ToolExecutionGateway.execute()`, which delegates to the registered `ToolAdapter` and underlying `ExecutionProvider`.
7. **Terminal Mapping**: Results map into Attempt and Action states atomically:
   - Success: `Attempt.SUCCEEDED` (`attempt.completed`) + `Action.SUCCEEDED` (`action.completed`).
   - Failure: `Attempt.FAILED` (`attempt.failed`) + `Action.FAILED` (`action.failed`).
   - Timeout: `Attempt.TIMED_OUT` (`attempt.timed_out`) + `Action.TIMED_OUT` (`action.timed_out`).
   - Cancellation: `Attempt.CANCELLED` (`attempt.cancelled`) + `Action.CANCELLED` (`action.cancelled`).
   - Execution Uncertainty: `Attempt.UNKNOWN` (`attempt.unknown`) + `Action.FAILED` (`action.failed`).

### 15.3 Transactional Boundaries and Durability
Every state mutation and its causal domain event are committed atomically inside a single ACID SQLite transaction (`store.transaction((tx) => { ... })`).
Terminal transitions for an Attempt and its parent Action are committed together in a single atomic transaction:
```typescript
store.transaction((tx) => {
  tx.transitionAttempt(attemptId, completeCommand, idGen, fencing);
  tx.transitionAction(actionId, succeedCommand, idGen, fencing);
});
```
This guarantees zero divergence between operational state tables (`actions`, `attempts`) and the append-only event stream (`run_events`).

### 15.4 Lease Fencing
Every Action and Attempt mutation is lease-fenced via `LeaseFencingCheck { workerId, leaseId }`. The persistence transaction verifies that the run's current lease matches the caller's credentials. If the worker lost its lease (due to expiry, stall, or usurpation), the mutation is rejected immediately with `LeaseLostError`, preventing zombie writes to Action, Attempt, Run, and event tables.

### 15.5 Execution Uncertainty (UNKNOWN Semantics)
If the outcome of physical execution is indeterminate (such as `PROVIDER_RESULT_UNAVAILABLE`, `WORKER_CRASHED`, `LEASE_EXPIRED_DURING_EXECUTION`, or `PROCESS_TERMINATION_BEFORE_PERSISTENCE`), the Attempt status is preserved strictly as `UNKNOWN` with the preserved reason code. The runtime does NOT convert execution uncertainty into `FAILED`, nor does it attempt automated retries. The parent Action transitions to `FAILED` to reflect terminal outcome of the trial.

### 15.6 Strict Boundaries: No Automatic Retries & Deferred Recovery
- **No Automatic Retry**: Task 4.4-E implements single-trial execution (`attemptNumber = 1`). Retry loops, backoff algorithms, and multi-attempt schedulers are explicitly omitted.
- **Provider Invocation Boundary**: On any governance denial, invalid contract, revoked contract, or resource ceiling violation, execution terminates with `provider invocation count = 0`.
- **Deferred Recovery**: Crash recovery, sweeper orphan cleanup, and retry/re-execution orchestration are deferred to Task 4.4-F.
