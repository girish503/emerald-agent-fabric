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

### 15.6 Strict Boundaries: Single-Trial Baseline in 4.4-E
- **Single-Trial Baseline**: Task 4.4-E established single-trial execution (`attemptNumber = 1`) connecting WorkerRuntime to ToolExecutionGateway.
- **Provider Invocation Boundary**: On any governance denial, invalid contract, revoked contract, or resource ceiling violation, execution terminates with `provider invocation count = 0`.

---

## 16. Crash Recovery, UNKNOWN Reconciliation, Retry Safety, and Attempt Sweeper (Task 4.4-F)

### 16.1 Crash Recovery & Epistemic Uncertainty
When a worker process crashes, stalls, or loses its lease midway through execution, physical reality and persisted state can diverge. Emerald explicitly distinguishes between **execution failure** (where physical execution returned a deterministic error) and **execution uncertainty** (where process disappearance prevents knowing if side effects occurred).

### 16.2 Crash Windows (A through H) & Deterministic Reconciliation
The runtime deterministically classifies and reconciles crashes across eight discrete windows:
- **Windows A & B** (Before Attempt Creation): Action is in `CREATED` or `AUTHORIZED`. Sweeper reconciles Action to `FAILED`. Zero attempts created, zero provider execution.
- **Window C** (Attempt `CREATED`, before dispatch): No physical side effects occurred. Sweeper marks Attempt `CANCELLED`. If tool is `IDEMPOTENT` and attempts remain under contract ceiling, Action transitions to `RETRYING`; otherwise `FAILED`.
- **Windows D, E & F** (Attempt `DISPATCHED` or `RUNNING`): Physical side effects are indeterminate. Sweeper marks Attempt `UNKNOWN` (`LEASE_EXPIRED_DURING_EXECUTION`). Action transitions to `FAILED` (fail-closed against blind auto-retry).
- **Window G** (Attempt terminal, Action `RUNNING`): Attempt already completed deterministically before worker died. Sweeper reconciles Action status to match Attempt outcome without re-invoking the tool or provider.
- **Window H** (Action `RETRYING`, worker crashed before Attempt #2): Recovering worker starts Attempt #2 exactly once, bounded by monotonic attempt numbers and `createAttemptIdempotencyToken()`.

### 16.3 UNKNOWN Semantics & Fail-Closed Retry Prevention
- `UNKNOWN` is an immutable, terminal state on Attempt. It cannot be updated, resumed, or re-executed.
- Non-idempotent operations (`write_file`, `run_command`) that end in `UNKNOWN` evaluate to `eligible: false` with reason `NON_IDEMPOTENT_UNKNOWN` in `evaluateRetryEligibility()`. They are **NEVER** retried automatically.
- Idempotent operations in crash recovery with uncertain outcome fail closed.

### 16.4 Bounded Idempotent Retry Lifecycle
Retries are permitted strictly when:
1. Tool is declared `IDEMPOTENT` (`read_file`, `search_code`, `git_status`, `git_diff`).
2. Prior attempt failed with deterministic `FAILED` status (not `UNKNOWN` or `TIMED_OUT`).
3. Total attempts remain below both `action.maxAttempts` and `contract.spec.resourceLimits.maxAttempts`.
4. The bound `MissionContract` remains `ACTIVE`. If revoked or expired, retry execution is refused and Action transitions to `FAILED` with zero provider calls.
5. Tool capability remains authorized in the bound policy.

### 16.5 Integrated Sweeper & Recovery Methods
1. **`RunCoordinator.recoverExpiredRuns()`**:
   - Reconciles expired runs, reclaims leases, and within the same atomic transaction invokes `reconcileStaleActionsAndAttemptsForRun()`.
2. **`RunCoordinator.recoverStaleExecutions()`**:
   - Provides targeted or global sweeping of in-flight actions and attempts without requiring complete run reclamation.
3. **`WorkerRuntime.recoverStaleExecutions()`**:
   - Sweeps stale attempts and automatically executes eligible `RETRYING` actions under the worker's active run lease, caching and binding the workspace sandbox handle.

---

## 17. Typed Context Engine: Observation Selection, Context Budgeting, and Token Governance (Task 5.1)

### 17.1 Architecture & Separation of Boundaries
The Typed Context Engine forms the deterministic information-control boundary consumed by future agent reasoning layers:
```text
Model
  ↓
Agent Brain
  ↓
Context Engine (Information Boundary — Read-Only)
  ↓
Action Proposal
  ↓
Governance & Policy (Authority Boundary)
  ↓
Execution (Tool Gateway & Providers)
```
The Context Engine is strictly read-only with respect to runtime authority:
- Does **NOT** mutate Run, Action, Attempt, MissionContract, or Workspace state.
- Does **NOT** append domain events.
- Does **NOT** execute tools or subprocesses.

### 17.2 Observation Model & 10 Semantic Categories
Information from durable storage is extracted as typed, immutable `Observation` records partitioned into 10 semantic categories:
1. `RUN_STATE`: Run state machine status, version, lease, retry counts, error reasons.
2. `MISSION_CONTEXT`: Bound Mission Contract goals, constraints, non-goals, capabilities authorized, resource ceilings.
3. `ATTEMPT_HISTORY` (UNKNOWN): Physical attempts with uncertain execution outcomes (`executionOutcomeUncertain: true`).
4. `TOOL_ERROR`: Tool errors and policy rejections.
5. `VERIFICATION`: Verification specs and diagnostic checks.
6. `WORKSPACE_STATE`: Workspace directory and status.
7. `TOOL_RESULT`: Tool execution outputs (bounded by `maxToolOutputBytes`).
8. `ACTION_HISTORY`: Logical action sequences and tool identities.
9. `ATTEMPT_HISTORY` (Settled): Past settled attempts.
10. `EVIDENCE`: Authoritative evidence records.
11. `SYSTEM_EVENT`: Bounded causal domain events.

Within categories, freshness boosts priority: `CURRENT` (+15), `RECENT` (+5), `STALE` (+0).

### 17.3 Mandatory Safety Floor & Epistemic Uncertainty Preservation
- `RUN_STATE` and `MISSION_CONTEXT` are non-negotiable safety observations (`isMandatory: true`).
- Attempts in `UNKNOWN` state are marked `isMandatory: true` and retain `executionOutcomeUncertain: true` and `unknownReason`. They are **NEVER** normalized to `FAILED` or `SUCCEEDED`.
- If budget ceilings cannot accommodate mandatory safety observations, `ContextEngine.build()` fails closed by throwing `ContextBudgetExceededError`.

### 17.4 Token & Byte Ceilings, Category Bounds, and Truncation
- **Token Estimation**: Computed deterministically as $\lceil \text{bytes} / 4 \rceil$ over canonical JSON. Independent of specific model tokenizers.
- **Category Ceilings**: Enforces `maxHistoryEvents`, `maxActionHistory`, `maxAttemptHistory`, and `maxEvidenceItems`.
- **Tool Output Truncation**: Tool outputs exceeding `maxToolOutputBytes` are truncated using head/tail retention (`HEAD_TAIL`), appending detailed `TruncationMetadata`. Invariant guaranteed: `retainedBytes <= originalBytes`.
- **Omitted Observations Summary**: Any observation omitted due to category bounds or budget limits is aggregated in `omittedObservationsSummary`.

### 17.5 Universal Secret Redaction & Replay Integrity
- All observation contents undergo key-based redaction (`redactSensitiveData`) before content hashing, budgeting, or snapshot inclusion.
- Snapshots produce a deterministic cryptographic `contextHash` (SHA-256 over canonical JSON of selected observations, budget, and policy), ensuring identical hashes across replay and verification.

---

## 18. Agent Brain Interface & Governed Action Proposal Boundary

### 18.1 Architectural Principle: Untrusted Proposal Boundary
The Agent Brain Interface establishes the strict trust boundary between model generation and runtime execution:
```text
ContextSnapshot
      ↓
AgentBrainPort (Provider-Independent Interface)
      ↓
untrusted ActionProposal
      ↓
ProposalValidator (11-Stage Governance Pipeline)
      ↓
trusted Action aggregate (Action.create)
      ↓
WorkerRuntime ↔ ToolExecutionGateway Execution
```

Model output is strictly **UNTRUSTED**. A model is never granted direct execution authority.

### 18.2 Zero Provider Invocation Invariant
Generating an `ActionProposal` via `AgentBrainPort.proposeAction(...)` and validating it via `ProposalValidator.validate(...)` touches zero tool adapters and zero execution providers:
$$\text{providerInvocationCount} = 0$$

### 18.3 Forbidden Authority Fields (Fail-Closed)
Models may only propose:
- `proposalId`: string (unique generation identity)
- `toolName`: valid registered tool name
- `inputPayload`: discrete tool arguments
- `contextSnapshotHash`: 64-char hex SHA-256 hash of active ContextSnapshot
- `rationale`?: bounded explanation ($\le 4096$ chars)
- `sequenceHint`?: optional positive integer hint

Models are strictly prohibited from proposing or controlling runtime authority:
- `workerId`, `leaseId`
- `contractId`, `contractVersion`, `contractHash`, `contractBinding`
- `capability`, `capabilities`, `requiredCapability`
- `resourceCeilings`, `resourceLimits`, `limits`
- `isolationLevel`, `isolationRequirement`, `workspaceRoot`, `hostPath`, `mountPath`
- `provider`, `image`, `container`, `network`
- `credentials`, `secret`, `token`
- `retry`, `maxAttempts`, `attemptNumber`, `totalAttempts`
- `executionStatus`, `status`, `executionResult`, `result`, `resultPayload`, `errorPayload`, `exitCode`
- `evidence`, `verification`, `verificationResult`

Any presence of these fields causes immediate rejection with `FORBIDDEN_AUTHORITY_FIELD`.

### 18.4 Cryptographic Context Binding
Every proposal must declare `contextSnapshotHash`. The validator asserts:
$$\text{proposal.contextSnapshotHash} = \text{contextSnapshot.contextHash}$$
If mismatched, the proposal is rejected with `CONTEXT_HASH_MISMATCH`, preventing stale proposal replays.

### 18.5 The 11-Stage Proposal Validation Pipeline
1. **Stage 1 (Payload Size)**: Rejects proposals $> 65536$ bytes (`PROPOSAL_SIZE_EXCEEDED`).
2. **Stage 2 (Structure & Authority)**: Rejects non-objects and forbidden authority keys (`MALFORMED_PROPOSAL` / `FORBIDDEN_AUTHORITY_FIELD`).
3. **Stage 3 (Schema & Rationale)**: Validates with `ActionProposalSchema.strict()` and enforces rationale $\le 4096$ chars (`RATIONALE_TOO_LONG`).
4. **Stage 4 (Context Hash)**: Asserts hash equality with active `ContextSnapshot` (`CONTEXT_HASH_MISMATCH`).
5. **Stage 5 (Run & Lease)**: Verifies active `RUNNING` status and lease/worker fencing (`RUN_NOT_ACTIVE` / `LEASE_INVALID`).
6. **Stage 6 (Mission Contract)**: Verifies active contract binding, contentHash match, and `ACTIVE` status (`CONTRACT_REVOKED`).
7. **Stage 7 (Tool Registry)**: Resolves tool in `ToolRegistry` (`UNKNOWN_TOOL`).
8. **Stage 8 (Policy & Capability)**: Verifies tool required capability is granted by policy (`UNAUTHORIZED_CAPABILITY`).
9. **Stage 9 (Tool Input Schema)**: Strict Zod validation and lexical path traversal defense (`INVALID_TOOL_INPUT`).
10. **Stage 10 (Resource Ceilings)**: Asserts tool-requested `timeoutMs`, `maxOutputBytes`, and `maxBytes` do not exceed contract limits (`RESOURCE_LIMIT_EXCEEDED`).
11. **Stage 11 (Success & Action Factory)**: Constructs immutable `ProposalValidationSuccess` and instantiates authoritative `Action` aggregate via `createActionFromProposal`.

### 18.6 Zero Database Mutation on Rejection
Rejected proposals never create or persist `Action` or `Attempt` records in durable persistence.

---

## 19. Governed Autonomous Agent Reasoning Loop & Step Controller (Task 5.3)

Section 19 establishes the autonomous reasoning and action loop integrating the Context Engine, Agent Brain Port, Action Proposal Validator, and WorkerRuntime:

$$\text{ContextEngine} \longrightarrow \text{AgentBrainPort} \longrightarrow \text{ProposalValidator} \longrightarrow \text{WorkerRuntime} \longrightarrow \text{ToolExecutionGateway}$$

### 19.1 Core Research Question & Guarantees
Can an autonomous agent operate over multiple execution steps while remaining bounded, observable, cancellable, lease-fenced, contract-governed, policy-governed, resource-bounded, recoverable, deterministic at the orchestration layer, incapable of directly executing tools, and incapable of escalating authority?

`AgentStepController` guarantees:
1. **Zero Provider Invocation Invariant**: The controller never invokes tool adapters or execution providers directly ($\text{providerInvocationCount} = 0$). All physical execution dispatches through `WorkerRuntime.executeAction(...)`.
2. **Untrusted Agent Brain**: External models or planning systems interface strictly through `AgentBrainPort`. Model output is strictly untrusted.
3. **Double Lease Fencing**: Checked before context building and model reasoning, and re-verified immediately prior to physical action dispatch. If lease ownership is lost or expired, the controller halts with `LEASE_LOST`.
4. **Active Mission Contract Fencing**: Verified pre-step, during proposal validation Stage 6, and pre-execution. If the contract is revoked, the controller halts immediately with `CONTRACT_REVOKED`.
5. **Multi-Dimensional Step Budgets**: Bounded by `maxSteps`, `maxWallClockMs`, `maxActions`, `maxConsecutiveFailures`, and `maxProposalRejections`.
6. **Serial Execution Only**: Strictly at most one active Action per Run; parallel actions are prohibited.
7. **Fail-Closed UNKNOWN Stop**: If an execution results in `UNKNOWN`, the controller halts with `UNKNOWN_EXECUTION`. The agent is never permitted to guess or retry uncertainty.
8. **Ephemeral Proposal Rejections**: Rejected proposals create zero `Action` and zero `Attempt` rows in persistence. Feedback is routed into the subsequent context snapshot.
9. **In-Memory Structured Step Transcript**: Every step produces an immutable transcript entry tracking context hash, proposal, validation, and action outcome for post-run audit and evidence bundling.
10. **Deterministic Terminal Reason Taxonomy**: Terminal reasons are drawn strictly from `StepControllerTerminalReason` (`COMPLETED`, `NO_ACTION`, `MAX_STEPS`, `MAX_WALL_CLOCK`, `MAX_ACTIONS`, `MAX_FAILURES`, `MAX_PROPOSAL_REJECTIONS`, `CANCELLED`, `LEASE_LOST`, `CONTRACT_REVOKED`, `UNKNOWN_EXECUTION`, `CONTEXT_BUDGET_EXCEEDED`, `BRAIN_FAILURE`).

---

## 20. Model Provider Boundary & Neutral Inference Port (Task 6.1)

Section 20 establishes the provider-neutral infrastructure boundary decoupling agent reasoning from commercial model provider SDKs and APIs:

$$\text{AgentBrainPort} \longrightarrow \text{LiveAgentBrain (Phase 6.2)} \longrightarrow \text{ModelProviderPort (Phase 6.1)} \longrightarrow \text{Provider Adapters (Phase 6.3+)}$$

### 20.1 Core Architectural Principles
1. **Model $\ne$ Authority**: The model provider is strictly an untrusted external dependency. It receives zero execution authority over Mission Contracts, capabilities, policies, workspace roots, credentials, worker IDs, lease IDs, retry counts, attempts, or ToolExecutionGateway.
2. **Provider Independence**: Zero provider SDK types (no OpenAI, Anthropic, Gemini, Ollama, LangChain, or LiteLLM) leak into the domain or application layers.
3. **Single-Attempt Semantics**: `ModelProviderPort.generate(...)` executes a single inference call with zero internal retries or backoff loops. Retry policy is owned exclusively by the caller.
4. **Explicit Lower-Level Timeouts**: `request.timeoutMs` defines an inference-level deadline, decoupled from `AgentStepController` wall-clock loop budgets.
5. **Cooperative Cancellation**: `request.abortSignal` is observed and propagates as `ModelRequestCancelledError` (`code: "MODEL_REQUEST_CANCELLED"`). Cancellation is never swallowed.
6. **Provider-Neutral Structured Output**: `ModelStructuredOutputSchema` carries an agnostic JSON Schema descriptor (`name`, `jsonSchema`, `description?`, `strict?`) mapped by concrete adapters to vendor-specific schemas.
7. **Explicit Token Accounting**: `ModelUsageMetadata` tracks `inputTokens`, `outputTokens`, and `totalTokens`. Unavailable metrics remain `undefined` and are never fabricated.
8. **Informational Metadata**: `providerMetadata` is strictly non-authoritative diagnostic data.
9. **Strongly-Typed Domain Errors**: Provider failures are classified into `ModelProviderUnavailableError`, `ModelRequestInvalidError`, `ModelRequestTimeoutError`, `ModelRequestCancelledError`, `ModelRateLimitedError`, `ModelResponseInvalidError`, and `ModelOutputLimitExceededError`.

---

## 21. LiveAgentBrain & Untrusted Action Proposal Boundary (Task 6.2)

Section 21 establishes the application-layer bridge mediating between the governed step controller (`AgentStepController` via `AgentBrainPort`) and the provider-neutral model inference interface (`ModelProviderPort`):

$$\text{AgentStepController} \longrightarrow \text{AgentBrainPort} \longrightarrow \text{LiveAgentBrain} \longrightarrow \text{ModelProviderPort} \longrightarrow \text{Model}$$

### 21.1 Core Architectural Principles
1. **The Translation Seam**: `LiveAgentBrain` translates between Emerald's reasoning contract (`ContextSnapshot`) and the provider-neutral model inference contract (`ModelProviderRequest`). It does not authorize, execute, persist, or grant authority.
2. **Untrusted Model Output**:
   $$\text{Model Response} \longrightarrow \text{UNTRUSTED} \longrightarrow \text{ProposalValidator} \longrightarrow \text{TRUSTED Action}$$
   The proposal generated by `LiveAgentBrain` is strictly data. The existing `ProposalValidator` remains the sole trust-conversion boundary before any Action can be executed.
3. **Information Inflow Firewall**: The model request contains strictly reasoning data (Task ID, Run ID, sequence number, context snapshot hash, registered tool definitions, and selected observations). All authority-bearing runtime details (`workerId`, `leaseId`, `contractBinding`, `contractHash`, DB connections, Docker mounts, credentials) are rigorously excluded.
4. **Parsing is Shape Validation, NOT Authorization**:
   `LiveAgentBrain` parses raw model text (including markdown code blocks), enforces JSON object structure, checks registered tool names, verifies payload size ($\le 64$ KB) and rationale length ($\le 4096$ chars), and runs `findForbiddenAuthorityKeys(parsed)`. Validating shape does NOT authorize execution.
5. **Single-Attempt Guarantee**: Exactly one `ModelProviderPort.generate(...)` invocation per `proposeAction()` call. Zero internal retries, zero exponential backoff loops, zero hidden correction calls.
6. **Cooperative Cancellation**: `request.abortSignal` is verified pre-dispatch and passed through to `ModelProviderRequest`. If aborted, it fails immediately with `ModelRequestCancelledError`.
7. **Zero Side Effects**: `LiveAgentBrain` executes zero tools, touches zero execution providers, and mutates zero persistence records ($\text{providerInvocationCount} = 0$).

---

## 22. Local Open-Source Model Provider Adapter — Ollama (Task 6.3)

Section 22 establishes the first concrete provider adapter connecting `ModelProviderPort` to the local open-source Ollama runtime (`http://127.0.0.1:11434`):

$$\text{LiveAgentBrain} \longrightarrow \text{ModelProviderPort} \longrightarrow \text{OllamaModelProvider} \longrightarrow \text{Ollama Localhost API} \longrightarrow \text{Open-Source Model}$$

### 22.1 Core Architectural Principles
1. **₹0 Inference Cost & Open-Source Discipline**: Emerald operates under ₹0 development/inference cost, zero commercial API dependencies, no subscriptions, and no API keys. The baseline model inference path runs locally against open-source models (e.g. Llama, Qwen, Mistral).
2. **Native HTTP & Zero External SDKs**: The adapter uses native Node.js `fetch` with zero external npm SDK dependencies. All Ollama wire protocol details are 100% contained within `src/adapters/models/ollama-model-provider.ts`.
3. **Single-Attempt Non-Negotiable Guarantee**:
   The adapter performs exactly one HTTP request per `generate(...)` call. Zero internal retries, zero automatic backoff loops, and zero silent fallback models exist.
4. **Hardware & Model Flexibility**: Model selection is configurable via `options.defaultModel`, `process.env.OLLAMA_MODEL`, or `request.model`. No specific massive model is hardcoded, keeping Emerald runnable on CPU-first developer machines.
5. **Deterministic Error Mapping**: Local runtime failures map deterministically to Emerald's Phase 6.1 domain error taxonomy (`ModelRequestCancelledError`, `ModelRequestTimeoutError`, `ModelProviderUnavailableError`, `ModelRequestInvalidError`, `ModelOutputLimitExceededError`, `ModelResponseInvalidError`, `ModelProviderError`).
6. **Structured Output Translation**: Translates provider-neutral `ModelStructuredOutputSchema` to Ollama's schema specification (`format: schema.jsonSchema`) and verifies valid JSON syntax before returning when `finishReason === "STOP"`.
7. **100% Hermetic Offline Test Suite**: Dependency injection of `OllamaFetchLike` enables fully offline, deterministic testing of request translation, error mapping, structured output conformance, and governance loop integration without requiring an active Ollama installation. Live tests are isolated behind `OLLAMA_LIVE_TESTS === "true"`.
8. **Zero Execution Authority**: The local model remains untrusted. The adapter confers zero execution authority, runs zero tools, touches zero execution providers, and makes zero database changes. Model proposals must pass through `ProposalValidator` before execution.

---

## 23. Live Local Agent Governance Validation & Evaluation Smoke Path (Task 6.4)

Section 23 establishes the first empirical validation and minimal evaluation harness for the complete end-to-end governed execution loop running against a local open-source model:

$$\text{ContextEngine} \longrightarrow \text{LiveAgentBrain} \longrightarrow \text{ModelProviderPort} \longrightarrow \text{Ollama} \longrightarrow \text{ActionProposal} \longrightarrow \text{ProposalValidator} \longrightarrow \text{WorkerRuntime} \longrightarrow \text{Gateway} \longrightarrow \text{Workspace}$$

### 23.1 Empirical Research Question
Can an autonomous agent driven by a real local open-source model execute multi-step software tasks while remaining strictly observable, lease-fenced, contract-bounded, sandboxed, and verifiable without bypassing any governance boundary?

`LocalEvaluationHarness` (`src/application/evaluation/local-eval-harness.ts`) confirms:
1. **End-to-End Governance Path**: Untrusted model proposals pass through the 11-stage `ProposalValidator`, Capability Policy checks, and `ToolExecutionGateway` before executing inside an isolated workspace.
2. **Least Privilege Enforcement**: Contracts grant only minimal capabilities (e.g. `workspace.file.read` and `workspace.file.write`). Proposing unauthorized tools (`run_command`) is rejected at Stage 8 with zero physical executions.
3. **Workspace Confinement**: Path traversal attempts (`../../etc/passwd`) are rejected by lexical sanitization at Stage 9 with zero file reads outside the provisioned workspace directory.
4. **Authority Field Firewall**: Model-injected authority keys (`workerId`, `leaseId`, `contractId`) are rejected before creating runtime state.
5. **Exact Metric & Token Accounting**: Wall-clock time, model calls, tool calls, model/tool latencies, and token counts are measured directly without fabrication. Token metrics are extracted strictly from provider usage metadata when supplied.
6. **Fail-Closed Safety**: Provider unavailability and timeouts trigger clean `BRAIN_FAILURE` stops; `AbortSignal` triggers immediate `CANCELLED` stops; uncertain tool outcomes trigger `UNKNOWN_EXECUTION` without automatic retries.
7. **Offline Deterministic Verification**: Dependency-injected mock transport enables 100% offline, deterministic CI testing across all governance and failure scenarios, while live execution tests are isolated behind `OLLAMA_LIVE_TESTS === "true"`.

---

## 24. Reproducible Multi-Task Evaluation Architecture (Task 7.1)

Section 24 establishes the provider- and model-independent domain contracts and application evaluation runner for reproducible agent benchmarking and evaluation:

$$\text{EvaluationTaskDefinition} \longrightarrow \text{EvaluationRunner} \longrightarrow \text{AgentStepController} \longrightarrow \text{Governed Runtime} \longrightarrow \text{EvaluationRunResult}$$

### 24.1 Core Architectural Principles
1. **Task Immutability & Content Hashing**: Evaluation tasks are versioned specifications $(\text{taskId}, \text{version})$. Content modifications mandate a new version. Every task computes a canonical SHA-256 hash ($\text{taskContentHash}$) over its deterministic specification (fixture, mission, criteria, budget), completely excluding runtime execution timestamps.
2. **Input $\ne$ Authority**: Evaluation fixtures (`EvaluationFixture`) describe input workspace state only. Fixtures are strictly prohibited from specifying credentials, host paths, traversal, or runtime authority fields (`workerId`, `leaseId`, `contractId`, `capability`).
3. **Governance Supremacy**: Evaluation tasks declare required capabilities (`EvaluationMission`), but confer zero direct authority. The evaluation runner constructs and activates an authoritative `MissionContract` via SQLite; all agent proposals pass through the 11-stage `ProposalValidator` and `ToolExecutionGateway`.
4. **Objective Ground-Truth Verification**: Evaluation success is determined by evaluating `EvaluationCriterion` specifications (`FILE_CONTENT_EQUALS`, `FILE_EXISTS`, `FILE_ABSENT`, `TEXT_CONTAINS`, `COMMAND_EXIT_CODE`, `VERIFICATION_SPEC`) against the physical workspace via an independent `CriteriaReader`. Agent claims (`isGoalReached: true`) are recorded for observability, but do not dictate success.
5. **Deterministic Configuration Fingerprint**: Every result includes a canonical `EvaluationConfigFingerprint` capturing `modelProvider`, `model`, `harnessVersion` (`harness-0.1`), `taskVersion`, and generation parameters with automatic secret redaction.
6. **Explicit Outcome Taxonomy**: Evaluation runs conclude in one of six explicit states (`PASSED`, `FAILED`, `ERROR`, `TIMED_OUT`, `CANCELLED`, `BLOCKED`), clearly distinguishing assertion failures from environment errors or governance fencing.
7. **Strict Metric Semantics**: `EvaluationMetrics` measures steps, actions, attempts, model/tool calls, failures, wall-clock time, and token counts. Metrics that are unsupported or not reported by the provider are preserved as `undefined`, strictly distinct from observed zero (`0`), and are never fabricated.
8. **Decoupled Trial and Run Identity**: `evaluationRunId` identifies the scientific evaluation trial, which references the authoritative runtime kernel `runId` and causal event IDs without duplicating state.

---

## 25. Evaluation Trial Architecture (Task 7.2)

Section 25 establishes the domain model and application-layer execution primitive for repeated, comparable evaluation trials:

```text
EvaluationTaskDefinition
        │
        ├── taskId
        ├── version
        └── taskContentHash
                 │
                 ▼
      EvaluationConfigFingerprint
                 │
                 ▼
          Evaluation Trial
                 │
                 ├── trialOrdinal
                 ├── trialId
                 └── runtimeRunId
                         │
                         ▼
                Evaluation Runner
                         │
                         ▼
                AgentStepController
                         │
                         ▼
                 Governed Runtime
                         │
                         ▼
               Objective Evaluation
```

### 25.1 Architectural Role and Invariants
1. **EvaluationTrial $\ne$ Runtime Run**:
   `EvaluationTrial` is NOT a replacement for the Runtime Run and does not grant execution authority. The Runtime Run (`runId`) remains the sole authoritative execution state machine managed by `RunCoordinator` with durable SQLite persistence, lease fencing, and crash recovery. `EvaluationTrial` is an immutable evaluation-layer record describing: *"This evaluation task and configuration was executed once (trial ordinal $N$), producing this objective outcome and metrics."*
2. **Canonical Deterministic Trial Identity**:
   Trial semantic identity is deterministically computed via canonical hashing over:
   $$\text{trialIdentityHash} = \text{SHA-256}(\text{canonical}(\text{configFingerprintHash}, \text{taskId}, \text{taskContentHash}, \text{taskVersion}, \text{trialOrdinal}))$$
   Timestamps and ephemeral IDs do not define semantic trial identity.
3. **Explicit Trial Ordinal Semantics**:
   `trialOrdinal` is an explicit, positive bounded integer ($1, 2, \dots, N$) where $1 \le \text{trialOrdinal} \le 10{,}000$. Ordinals are immutable once assigned and included in canonical trial identity.
4. **Pristine Workspace Isolation**:
   Every trial execution receives a freshly provisioned, isolated workspace initialized with task fixtures. Workspaces are never shared or reused across trials, eliminating cross-trial contamination.
5. **Rigid Comparability Contract**:
   Two trials are comparable (`areTrialsComparable`) if and only if their evaluation identity matches:
   $$\text{taskId}_A = \text{taskId}_B \quad\land\quad \text{version}_A = \text{version}_B \quad\land\quad \text{taskContentHash}_A = \text{taskContentHash}_B \quad\land\quad \text{fingerprintHash}_A = \text{fingerprintHash}_B$$
   Differing `trialOrdinal` is the expected distinction between comparable repeated runs. Trials from different task versions, altered content hashes, or differing model/harness configurations cannot be silently compared or batched.
6. **No Premature Persistence or Statistical Conflation**:
   `EvaluationTrial` remains an in-memory, JSON-serializable domain record. No SQLite evaluation tables or statistical aggregations (mean, variance, confidence intervals) are introduced in this phase.

---

## 26. Controlled Evaluation Experiments (Task 7.3)

Section 26 establishes the provider- and model-neutral domain contracts for controlled evaluation experiments comparing alternative agent configurations across identical evaluation tasks:

```text
EvaluationTaskDefinition
          │
          ▼
EvaluationExperiment
          │
     ┌────┴────┐
     ▼         ▼
Condition A  Condition B
     │         │
     ▼         ▼
 EvaluationTrial records
     │         │
     └────┬────┘
          ▼
     Runtime Runs
```

### 26.1 Architectural Role and Invariants
1. **Experiment as Research Scope & Metadata**:
   `EvaluationExperiment` defines what is being compared, why (human-readable `hypothesis`), which task is targeted (`taskRef`), and under what controlled conditions (`conditions`). It is descriptive research metadata, NOT an execution engine or policy arbiter.
2. **Zero Execution Authority**:
   The experiment layer:
   - Does NOT execute tools.
   - Does NOT authorize capabilities or issue capability grants.
   - Does NOT mutate or bypass `MissionContract` boundaries.
   - Does NOT replace or alter the authoritative `Run` state machine.
   - Does NOT compute statistical conclusions or significance tests.
3. **Canonical Deterministic Experiment Hashing**:
   Experiment definitions are versioned $(experimentId, version, experimentContentHash)$ where the hash is computed canonically over:
   $$\text{experimentContentHash} = \text{SHA-256}(\text{canonical}(\text{conditions}, \text{description}, \text{experimentId}, \text{harnessVersion}, \text{hypothesis}, \text{plannedTrialCount}, \text{taskRef}, \text{title}, \text{version}))$$
   Condition ordering is canonically sorted by `conditionId`, guaranteeing key-order independence. Ephemeral lifecycle state (`status`) and runtime execution timestamps are excluded from the semantic hash.
4. **Fenced Condition & Trial Membership**:
   Each `EvaluationExperimentCondition` binds strictly to an immutable `EvaluationConfigFingerprint`. An `EvaluationTrial` can belong to an experiment condition only when its `taskId`, `taskVersion`, `taskContentHash`, and `configFingerprint.fingerprintHash` match the experiment's declared task and condition configuration. Mismatched or incomparable trials are rejected fail-closed.
5. **Planned Trial Count vs. Statistical Power**:
   `plannedTrialCount` indicates the intended number of trials the experiment aims to run. It does not dictate, enforce, or compute statistical sample sizes or statistical power.

---

## 27. Descriptive Evaluation Reporting (Task 7.4)

Section 27 establishes the pure evaluation reporting layer that derives deterministic descriptive reports (`EvaluationReport`) and explicit condition comparisons (`ConditionComparison`) from immutable experiment and trial records:

```text
EvaluationExperiment
        │
        ├── Condition A
        │      ↓
        │   Trials
        │
        └── Condition B
               ↓
             Trials
                │
                ▼
      Descriptive Report
                │
        ┌───────┴────────┐
        ▼                ▼
 Outcome Distribution   Metric Aggregates
        │                │
        └───────┬────────┘
                ▼
        Baseline / Candidate
             Deltas
```

> **Reporting is a pure evaluation-layer operation and has no execution authority.**

### 27.1 Architectural Role and Invariants

1. **Pure Derived Artifact (Zero Execution Authority)**:
   `EvaluationReport` is an immutable, derived domain object generated from completed `EvaluationTrial` records and an `EvaluationExperiment`. The reporting layer:
   - Does NOT invoke the AgentBrain, model providers, or `ToolExecutionGateway`.
   - Does NOT create Actions, Attempts, or Runtime Runs.
   - Does NOT issue worker leases or modify `MissionContract` boundaries.
   - Does NOT mutate source `EvaluationExperiment` or `EvaluationTrial` instances.
   - Contains zero security-sensitive or authority-bearing fields (`workerId`, `leaseId`, `contractId`, credentials).

2. **Deterministic Canonical Report Identity**:
   Reports are identified strictly by the experiment they describe: `experimentId`, `experimentVersion`, `experimentContentHash`.
   The `reportContentHash` is computed canonically over sorted semantic contents (conditions sorted by `conditionId`, canonical metric keys, sorted trial references) and completely excludes runtime execution timestamps, worker IDs, or ephemeral state.

3. **Discrete Outcome Distribution**:
   Every condition report preserves the discrete outcome distribution across all six evaluation statuses:
   $$\text{totalTrials} = \text{passedTrials} + \text{failedTrials} + \text{timedOutTrials} + \text{cancelledTrials} + \text{blockedTrials} + \text{errorTrials}$$
   Incomplete or aborted evaluations (`TIMED_OUT`, `CANCELLED`, `BLOCKED`, `ERROR`) are never silently discarded or collapsed into failed trials.

4. **Explicit Descriptive Pass Rate Semantics**:
   The objective pass rate is represented as an explicit, strongly typed ratio:
   $$\text{objectivePassRate} = \left\{\text{numerator}: \text{passedTrials}, \; \text{denominator}: \text{completedTrials}, \; \text{rate}: \frac{\text{passedTrials}}{\text{completedTrials}}\right\}$$
   where $\text{completedTrials} = \text{passedTrials} + \text{failedTrials}$.
   Incomplete outcomes are excluded from the completion denominator. If $\text{completedTrials} = 0$, the pass rate is explicitly `undefined` rather than a fabricated `0`. When zero passes occur among completed trials, the rate is exact `0`.

5. **Rigorous Missing Metric Semantics**:
   Existing metric semantics ($0$ = observed zero, $\text{undefined}$ = unavailable/unsupported) are strictly preserved across aggregation:
   - Numeric aggregates (`MetricAggregate`) track `observedCount` and `unavailableCount` explicitly.
   - Missing observations do not default to zero; only observed values contribute to `sum`, `average`, `minimum`, and `maximum`.
   - If $\text{observedCount} = 0$, all statistical aggregates remain `undefined`.

6. **Explicit Baseline Comparison & Comparability Fencing**:
   Condition comparison (`compareConditions`, `compareExperimentConditions`) requires an explicit baseline designation (no implicit ordering or hardcoded defaults).
   Comparisons fail closed if candidate and baseline conditions do not share the identical task scope ($\text{taskId}$, $\text{taskVersion}$, $\text{taskContentHash}$).
   Differences are reported as descriptive deltas ($\text{deltaAverage}$, $\text{deltaSum}$, $\text{delta}$) rather than value-laden labels such as "improvement".

7. **Explicit Non-Goals (No Statistical Inference)**:
   This reporting layer explicitly omits statistical inference (variance, standard deviation, confidence intervals, p-values, hypothesis tests, effect sizes, statistical power, or causal claims). Reports describe observed empirical evidence without making unverified statistical generalizations.

---

## 28. Statistical Evaluation Analysis (Task 7.5)

Section 28 establishes the mathematical evaluation analysis layer that derives sample statistics, uncertainty estimates, and directional differences from immutable evaluation records:

```text
EvaluationExperiment
        │
        ▼
EvaluationTrial[]
        │
        ▼
EvaluationReport
        │
        ▼
StatisticalAnalysisConfig
        │
        ▼
StatisticalAnalysis
        │
   ┌────┴─────┐
   ▼          ▼
Point      Uncertainty
Estimate   Interval
   │          │
   └────┬─────┘
        ▼
Baseline / Candidate
      Comparison
```

> **StatisticalAnalysis is a pure evaluation-layer computation and has no execution authority.**

### 28.1 Architectural Role and Invariants

1. **Pure Research-Analysis Computation**:
   `StatisticalAnalysis` is an immutable, derived research artifact. It does NOT invoke the AgentBrain, execute model providers, issue worker leases, mutate `MissionContract` boundaries, or interact with Docker. It operates strictly over in-memory domain evaluation records.

2. **Numerically Stable Sample Statistics (Welford's Algorithm)**:
   Sample variance ($s^2$) and standard deviation ($s$) for continuous numeric observations are computed via Welford's one-pass recurrence, eliminating catastrophic cancellation and floating-point variance underflow. Non-finite inputs (`NaN`, `Infinity`) fail closed immediately.

3. **Explicit Uncertainty Intervals**:
   - **Student's t Confidence Intervals**: Continuous metrics use Student's t intervals ($\bar{x} \pm t_{\text{crit}} \times SE$) with degrees of freedom $\nu = n - 1$. The system does not assume known population variance. For $n < 2$, uncertainty intervals remain unavailable.
   - **Wilson Score Intervals**: Binary success rates use Wilson score intervals rather than naive Wald intervals, guaranteeing non-zero bounds at extreme success counts ($k = 0$ or $k = n$) and ensuring the point estimate strictly resides within $[\text{lower}, \text{upper}]$. For $n = 0$, intervals remain unavailable.

4. **Independent Observations by Default**:
   Observations across conditions are treated as independent samples unless paired semantics are explicitly declared in the experiment. No implicit pairing or dependent t-tests are implemented.

5. **Analysis Quantifies Observations, Not Causality**:
   Statistical analysis quantifies observed differences under declared experimental conditions. It does not establish causality, superiority, or statistical significance by itself.

6. **Transparent Methodological Limitations**:
   Small samples ($n < 2$), missing data, zero baselines, unequal sample counts, and wide confidence intervals are explicitly exposed as `StatisticalWarning` objects, providing observable boundaries on evidence strength.

---

## 29. Reflex Evaluation Boundary (Task 7.6)

Section 29 establishes the architectural condition boundary for evaluating Emerald Reflex:

```text
                    Evaluation Experiment
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
             BASELINE                REFLEX
                 │                     │
                 │              future Reflex layer
                 │                     │
                 └──────────┬──────────┘
                            ▼
                    Governed Runtime
                            │
                    ┌───────┴────────┐
                    ▼                ▼
              Tool Gateway      Verification
                    │
                    ▼
              Workspace/Sandbox
```

> **The evaluation condition specifies which execution mode is being evaluated; it does not implement execution behavior or grant runtime authority. The Reflex controller itself remains unimplemented in this phase.**

### 29.1 Architectural Role and Invariants

1. **Explicit Execution Modes**:
   Trials execute under one of two strongly typed modes:
   - `BASELINE`: The existing governed `AgentStepController` runtime without an adaptive Reflex control layer.
   - `REFLEX`: Reserved for execution through the future Emerald Reflex control layer.

2. **Explicit Preflight Rejection (No Silent Downgrade)**:
   Because the Reflex adaptive controller does not yet exist, any execution runner encountering a `REFLEX` condition fails closed during preflight:
   - Throws `ReflexNotImplementedError` with machine-actionable error code `REFLEX_NOT_IMPLEMENTED`.
   - Rejection occurs before creating a runtime `Run`, claiming a lease, or provisioning a workspace.
   - Silent fallback (`REFLEX → BASELINE`) is strictly prohibited to prevent data contamination in experimental evaluation records.

3. **Condition Identity Fencing**:
   `EvaluationExperimentCondition` incorporates `executionMode` into its canonical SHA-256 `conditionHash`.
   `BASELINE + configFingerprint` and `REFLEX + configFingerprint` are semantically distinct conditions that yield different condition hashes. `EvaluationConfigFingerprint` is preserved unchanged, guaranteeing backward compatibility.

4. **Proposed Future Reflex Position**:
   When implemented, the Reflex controller will sit inside the governed loop between untrusted proposals and policy validation:
   ```text
   AgentStepController
           ↓
        AgentBrain
           ↓
      ActionProposal (UNTRUSTED)
           ↓
        [Reflex] (Future: Prune, Defer, Constrain)
           ↓
    Policy / Governance
           ↓
   ToolExecutionGateway
           ↓
    Workspace / Sandbox
   ```

5. **Reflex Safety Invariant (Monotonic Authority Reduction)**:
   The future Reflex layer is strictly monotonic with respect to governance authority:
   > *Reflex may reduce or constrain what the agent attempts, but it may not expand what the agent is authorized to do.*
   Reflex may reject or defer proposals, request alternatives, or stop execution early. It can never grant capabilities, modify `MissionContract` boundaries, bypass `ProposalValidator` or `ToolExecutionGateway`, select credentials, alter worker/lease identities, or weaken sandbox isolation.

6. **Multi-Objective Evaluation Boundary**:
   Reflex evaluation evaluates multiple research dimensions without scalar score collapse:
   - **Primary**: Objective task success (`verificationPassed`)
   - **Efficiency**: Model calls, tool calls, wall-clock latency, model/tool latency, token consumption
   - **Safety / Governance**: Blocked actions, proposal rejections, execution failures, unknown outcomes
   No composite `ReflexScore` or `ReflexEfficiencyScore` is created.

7. **Default Controlled Experimentation**:
   The primary scientific comparison isolates the execution mode while holding all other variables constant:
   - Same `taskId`, `taskVersion`, `taskContentHash`
   - Same `MissionContract` & `Policy`
   - Same workspace constraints & initial fixture
   - Same objective criteria & verification specs
   - Same model provider, model, & generation parameters
   - Same resource ceilings
   - **Only difference**: Execution condition (`BASELINE` vs `REFLEX`)

8. **Scientific Limitations**:
   - **Association vs. Causation**: Observed performance differences between `BASELINE` and `REFLEX` constitute empirical associations within the trial dataset. Strong causal attribution requires controlled experimental isolation and replication.
   - **Model Non-Determinism**: Identical declared configuration does not guarantee identical inference outputs, hardware conditions, or runtime scheduling across repeated trials.
