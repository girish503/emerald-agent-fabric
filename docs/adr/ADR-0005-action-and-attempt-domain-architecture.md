# ADR-0005: Action and Attempt Domain Architecture, Lifecycle Semantics, and Lease-Fenced Persistence

## Status
Approved (Architecture Specification Baseline)

## Date
2026-10-12

## Governing Documents
- [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- [ADR-0001: Master Engineering Constitution](./ADR-0001-master-engineering-constitution.md)
- [ADR-0002: Runtime Kernel, Durable State Machine, Leased Worker Coordination, and Append-Only Event Store](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
- [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](./ADR-0003-workspace-and-typed-tools.md)
- [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](./ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
- [Typed Tool System Architecture](../architecture/typed-tools.md)
- [Workspace Sandbox Architecture](../architecture/workspace-sandbox.md)
- [Runtime Architecture](../architecture/runtime.md)
- [Security Architecture](../architecture/security.md)

---

## 1. Context & Problem Statement

In Capability 1 (Tasks 1.1–1.8C), Emerald established a deterministic, crash-recoverable execution runtime governed by cryptographic Mission Contracts, leased worker coordination, and deterministic verification.
In Phase 3 (Tasks 3.1–3.4), Emerald hardened the Workspace Sandbox boundary with lexical path sanitization, canonical filesystem containment, Docker container volume isolation, and sweeper crash recovery.
In Phase 4 (Tasks 4.1–4.3), Emerald completed the typed tool contracts (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`), established the trusted `ToolExecutionGateway` boundary, implemented deterministic workspace tool adapters, integrated containerized command execution via `DockerExecutionProvider`, and enforced strict capability policy mapping and non-clamping Mission Contract resource ceilings.

However, the execution model currently treats tool invocations as ephemeral point-in-time calls dispatched directly by the `ToolExecutionGateway`. The runtime lacks explicit architectural entities to represent:
1. **Logical Intention vs Physical Execution**: A model or reasoning engine emits an intention (*"Run the unit tests"*). Physical reality may require multiple attempts due to transient timeouts or container restarts (*Attempt 1 $\rightarrow$ TIMEOUT; Attempt 2 $\rightarrow$ SUCCESS*). Conflating intention with execution makes bounded retries, cost accounting, and idempotency tracking impossible.
2. **Crash-Consistent In-Flight Tracking**: If a worker node crashes mid-execution (after invoking Docker or writing files to disk, but before returning results), the system cannot discern whether side effects occurred without an explicit durable state machine.
3. **Lease-Fenced Multi-Step Persistence**: As agents execute multi-step iterative trajectories within a single Run, state mutations must be fenced against zombie workers at the granular step level, not merely at the coarse Run boundary.
4. **Replay & Reflex Evaluation**: Future Reflex optimization and deterministic audit require proving exactly what was intended, what was authorized, what was attempted, what evidence was observed, and which verification spec evaluated each step.

This Architecture Decision Record establishes the pure domain boundaries, identity models, deterministic state machines, persistence schemas, lease fencing rules, failure recovery semantics, and event definitions for **Action** and **Attempt**.

---

## 2. Constraints & Non-Negotiable Invariants

All designs in this ADR adhere strictly to the following frozen architectural baselines:

1. **Mission Contract Governance (Task 1.8C) is FROZEN**:
   - The `MissionContract` aggregate, schema, and SQLite persistence layer must remain 100% untouched.
   - Authority flows strictly from the cryptographic Mission Contract bound to the `Run`. Actions and Attempts derive authority from the contract; they never synthesize authority.
2. **Resource Authority Ceilings are FROZEN**:
   - Resource ceilings (`timeoutMs`, `maxAttempts`, `maxOutputBytes`) set in `contract.spec.resourceLimits` are immutable upper bounds.
   - Any requested limit exceeding the contract ceiling **MUST be rejected with zero execution** (`ResourceLimitExceededError`). Silent clamping is strictly forbidden.
3. **ExecutionProvider Contract is FROZEN**:
   - The public contract of `ExecutionProvider` (`execute<TInput, TOutput>(request: ExecutionRequest<TInput>): Promise<ExecutionResult<TOutput>>`) remains unchanged.
4. **Workspace Sandbox Boundary (Phase 3) is FROZEN**:
   - The dual-boundary protection model (lexical sanitization + canonical filesystem containment + container mount confinement) must be preserved.
5. **No Distributed Infrastructure or Over-Engineering**:
   - The system is built on TypeScript, Node.js, SQLite, and Docker. No Redis, Kafka, Temporal, microservices, or distributed consensus engines may be introduced.
6. **Zero Code Changes in Task 4.4-A**:
   - This task is strictly architecture review and specification. No production runtime code, database migrations, or tool adapter changes may be committed.

---

## 3. The Core Semantic Distinction: Action vs Attempt

The foundational invariant of this architecture is:

$$\text{Action} \ne \text{Attempt}$$

```text
┌────────────────────────────────────────────────────────────────────────┐
│                                 RUN                                    │
│  Session-level governed boundary under immutable Mission Contract      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1..N (Sequential)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                                ACTION                                  │
│  Logical Unit of Work (Intention)                                      │
│  - Tool selection (e.g., run_command)                                  │
│  - Validated input parameters (e.g., argv: ["npm", "test"])            │
│  - Monotonic sequence number within Run (1..N)                         │
│  - Bound Mission Contract authority record                             │
│  - Cumulative lifecycle status (CREATED, AUTHORIZED, SUCCEEDED, etc.)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1..M (Bounded Retries)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                                ATTEMPT                                 │
│  Physical Execution Instance (Trial)                                   │
│  - Scoped to active worker lease (workerId, leaseId)                   │
│  - Deterministic attempt number (1..M)                                 │
│  - Discrete idempotency token (runId:actionId:attemptNumber)           │
│  - Physical dispatch parameters and container/process metadata         │
│  - Observable evidence produced (Evidence aggregate)                   │
│  - Physical outcome (SUCCEEDED, FAILED, TIMED_OUT, UNKNOWN)            │
└────────────────────────────────────────────────────────────────────────┘
```

### Detailed Conceptual Breakdown

| Dimension | `Action` | `Attempt` |
| :--- | :--- | :--- |
| **Meaning** | **Logical intention**: what the system decided to do. | **Physical trial**: one execution of that intention. |
| **Cardinality** | $1..N$ per Run (monotonically ordered). | $1..M$ per Action (bounded by `maxAttempts`). |
| **Identity** | `actionId` (UUIDv7) + `(runId, sequenceNumber)`. | `attemptId` (UUIDv7) + `(actionId, attemptNumber)`. |
| **Trust Level** | Trusted domain entity (derived from validated `ToolRequest`). | Trusted runtime execution record. |
| **Lease Ownership** | Transcends individual leases (can be recovered across workers). | Strictly bound to a single `(workerId, leaseId)`. |
| **Idempotency** | Owns logical idempotency classification (`IDEMPOTENT` vs `NON_IDEMPOTENT`). | Owns physical execution idempotency token (`idempotencyToken`). |
| **Retry Semantics** | Represents the entity *being retried*. | Cannot be retried; an Attempt is executed once and terminates. |
| **Persistence** | Durable row in `actions` table. | Durable row in `attempts` table. |
| **Evidence** | Aggregates verified evidence across attempts. | Directly produces raw execution evidence items. |
| **Verification** | Evaluated against `VerificationSpec` post-condition. | Evaluated against schema validity and physical exit status. |

---

## 4. Action Identity, Invariants & Lifecycle

### 4.1 Action Identity & Fields

An `Action` represents an authoritative domain entity within a Run.

```ts
export interface Action {
  readonly actionId: string;                 // Globally unique UUIDv7
  readonly runId: string;                    // Parent Run FK
  readonly sequenceNumber: number;           // Monotonic 1..N sequence per Run
  readonly toolName: ToolName;               // Statically registered tool name
  readonly inputPayload: unknown;            // Validated Zod input payload
  readonly inputHash: string;                // SHA-256 canonical hash of input payload
  readonly idempotency: ToolIdempotency;     // IDEMPOTENT | NON_IDEMPOTENT
  readonly contractId: string;               // Bound Mission Contract ID
  readonly contractVersion: number;          // Bound Mission Contract version
  readonly contractHash: string;             // Bound Mission Contract content hash
  readonly status: ActionStatus;             // Deterministic state
  readonly activeAttemptNumber: number | null;// Currently running attempt number
  readonly totalAttempts: number;            // Total attempts executed so far
  readonly maxAttempts: number;              // Governed maximum attempts ceiling
  readonly createdAt: string;                // ISO 8601 UTC creation timestamp
  readonly updatedAt: string;                // ISO 8601 UTC update timestamp
  readonly completedAt: string | null;       // Terminal completion timestamp
  readonly resultPayload: unknown | null;    // Verified output payload on success
  readonly errorPayload: unknown | null;     // Error details on failure
}
```

### 4.2 Invariant Rules Governing Actions

1. **Strict Monotonic Sequence (Zero Gaps)**:
   - For a given `runId`, actions must be sequenced strictly as $1, 2, 3, \dots, N$.
   - Any gap ($seq_{k} - seq_{k-1} \ne 1$) is a domain violation that fails closed. Gaps indicate lost state, out-of-order execution, or unrecorded mutations.
2. **Strictly Serial Execution (No Concurrency per Run)**:
   - In Phase 4, exactly **one Action may be active (`RUNNING` or `RETRYING`) per Run at any time**.
   - Concurrent actions within the same workspace are forbidden. Concurrency induces filesystem race conditions, violates Git index locking (`.git/index.lock`), and renders rollback/replay non-deterministic.
3. **Immutability of Intent**:
   - The fields defining *intent* (`toolName`, `inputPayload`, `inputHash`, `sequenceNumber`, `contractId`, `contractVersion`, `contractHash`) are **strictly immutable** once the Action is persisted.
   - Only lifecycle state (`status`, `activeAttemptNumber`, `totalAttempts`, `completedAt`, `resultPayload`, `errorPayload`, `updatedAt`) mutates through explicit state transitions.
4. **Authority Inheritance**:
   - An Action inherits authority from the active Run's `contractBinding`. It cannot execute under a different contract than the Run to which it belongs.

---

## 5. Attempt Identity, Invariants & Lifecycle

### 5.1 Attempt Identity & Fields

An `Attempt` represents one physical execution instance of an Action.

```ts
export interface Attempt {
  readonly attemptId: string;                // Globally unique UUIDv7
  readonly actionId: string;                 // Parent Action FK
  readonly runId: string;                    // Denormalized Run FK for indexing & fencing
  readonly attemptNumber: number;            // 1..M scoped to Action
  readonly workerId: string;                 // Executing worker ID
  readonly leaseId: string;                  // Active worker lease ID (fencing token)
  readonly idempotencyToken: string;         // Unique token: `${runId}:${actionId}:${attemptNumber}`
  readonly status: AttemptStatus;            // Deterministic state
  readonly startedAt: string;                // ISO 8601 UTC start timestamp
  readonly completedAt: string | null;       // ISO 8601 UTC completion timestamp
  readonly durationMs: number | null;        // Execution wall-clock duration in ms
  readonly exitCode: number | null;          // Physical process exit code (if applicable)
  readonly outputPayload: unknown | null;    // Raw validated output payload
  readonly errorPayload: unknown | null;     // Physical failure details
  readonly evidenceIds: readonly string[];   // Evidence records produced by this trial
  readonly providerMetadata?: Readonly<Record<string, unknown>>; // Container ID, host metrics
}
```

### 5.2 Invariant Rules Governing Attempts

1. **Single Physical Invocation**:
   - An Attempt is executed exactly once. An Attempt cannot be "retried". If an Attempt fails, it transitions to a terminal state (`FAILED`, `TIMED_OUT`, `UNKNOWN`), and a new Attempt ($N+1$) is created if authorized.
2. **Mandatory Worker & Lease Binding**:
   - An Attempt cannot be created without valid `workerId` and `leaseId`.
   - All mutations to an Attempt must verify that the worker holds the active lease for the Run.
3. **No Resumption After Crash**:
   - An in-flight Attempt interrupted by a worker crash or lease expiry **cannot be resumed**.
   - Physical execution inside a container or filesystem cannot be safely spliced. The interrupted Attempt is marked `UNKNOWN` / `FAILED_ABNORMAL`.
4. **Unique Idempotency Token**:
   - Every Attempt has a globally unique `idempotencyToken` formatted deterministically as `${runId}:${actionId}:${attemptNumber}`.
   - Retries do **not** reuse the previous Attempt's token. This guarantees that downstream providers never return stale cached results or suppress execution.

---

## 6. Deterministic State Machines

### 6.1 Action State Machine

```text
                  ┌──────────────┐
                  │   CREATED    │
                  └──────┬───────┘
                         │ authorize()
                         ▼
                  ┌──────────────┐
                  │  AUTHORIZED  │
                  └──────┬───────┘
                         │ startAttempt(1)
                         ▼
                  ┌──────────────┐
       ┌─────────►│   RUNNING    │◄─────────┐
       │          └──────┬───────┘          │
       │                 │                  │
       │  attempt failed │                  │ retry (new attempt)
       │  & can retry    │                  │
       │                 ▼                  │
       │          ┌──────────────┐          │
       └──────────┤   RETRYING   ├──────────┘
                  └──────┬───────┘
                         │ retries exhausted / non-idempotent
                         ▼
         ┌───────────────┬───────────────┬───────────────┐
         ▼               ▼               ▼               ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │  SUCCEEDED  │ │   FAILED    │ │  TIMED_OUT  │ │  CANCELLED  │
  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
  (Terminal)      (Terminal)      (Terminal)      (Terminal)
```

#### Valid Transitions for Action

| Current State | Command / Event | Next State | Guard Conditions |
| :--- | :--- | :--- | :--- |
| `CREATED` | `AUTHORIZE` | `AUTHORIZED` | PolicyEvaluator grants capability; resource limits $\le$ contract ceilings. |
| `CREATED` | `REJECT` | `FAILED` | Capability denied, contract revoked, or limits exceeded. Zero execution. |
| `AUTHORIZED` | `START_ATTEMPT` | `RUNNING` | Active lease held; Attempt #1 created and dispatched. |
| `AUTHORIZED` | `CANCEL` | `CANCELLED` | Run cancelled or aborted prior to execution. |
| `RUNNING` | `ATTEMPT_SUCCEEDED` | `SUCCEEDED` | Attempt succeeded; post-action verification passed. Terminal. |
| `RUNNING` | `ATTEMPT_FAILED` | `RETRYING` | Attempt failed; tool is `IDEMPOTENT`; `attemptNumber < maxAttempts`. |
| `RUNNING` | `ATTEMPT_FAILED` | `FAILED` | Attempt failed; tool is `NON_IDEMPOTENT` or retries exhausted. Terminal. |
| `RUNNING` | `TIMEOUT` | `TIMED_OUT` | Cumulative action deadline expired. Terminal. |
| `RUNNING` | `CANCEL` | `CANCELLED` | Abort signal triggered or lease revoked. Terminal. |
| `RETRYING` | `START_ATTEMPT` | `RUNNING` | Backoff elapsed; Attempt $N+1$ created and dispatched. |
| `RETRYING` | `FAIL_EXHAUSTED` | `FAILED` | Lease lost or retry budget exceeded while awaiting retry. Terminal. |
| `RETRYING` | `CANCEL` | `CANCELLED` | Run cancelled while in backoff delay. Terminal. |

---

### 6.2 Attempt State Machine

```text
                  ┌──────────────┐
                  │   CREATED    │
                  └──────┬───────┘
                         │ dispatch()
                         ▼
                  ┌──────────────┐
                  │  DISPATCHED  │
                  └──────┬───────┘
                         │ provider acknowledges
                         ▼
                  ┌──────────────┐
                  │   RUNNING    │
                  └──────┬───────┘
                         │
         ┌───────────────┼───────────────┬───────────────┬───────────────┐
         │               │               │               │               │
         ▼               ▼               ▼               ▼               ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │  SUCCEEDED  │ │   FAILED    │ │  TIMED_OUT  │ │  CANCELLED  │ │   UNKNOWN   │
  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
  (Terminal)      (Terminal)      (Terminal)      (Terminal)      (Terminal)
```

#### Valid Transitions for Attempt

| Current State | Command / Event | Next State | Guard Conditions |
| :--- | :--- | :--- | :--- |
| `CREATED` | `DISPATCH` | `DISPATCHED` | Persisted to DB with active lease token; adapter invoked. |
| `DISPATCHED` | `START` | `RUNNING` | Physical provider acknowledges start (e.g. Docker container launched). |
| `RUNNING` | `COMPLETE` | `SUCCEEDED` | Provider returns zero exit code / valid output; output schema validated. |
| `RUNNING` | `FAIL` | `FAILED` | Provider returns non-zero exit code or adapter error. |
| `RUNNING` | `TIMEOUT` | `TIMED_OUT` | Execution wall-clock time exceeds attempt timeout. |
| `RUNNING` | `CANCEL` | `CANCELLED` | Abort signal or worker shutdown. |
| `DISPATCHED` / `RUNNING` | `MARK_UNKNOWN` | `UNKNOWN` | Worker crashed or lease expired mid-execution. Marked by Sweeper. |

---

## 7. The Critical UNKNOWN State & Crash Window Analysis

### 7.1 The Asymmetric Crash Window
Consider the physical execution window:

```text
Worker A begins Attempt #1
  │
  ├─ 1. Persists Attempt #1 as DISPATCHED / RUNNING in SQLite
  │
  ├─ 2. Dispatches physical execution (e.g. Docker container launched / file write)
  │
  ├─ 3. [PHYSICAL SIDE EFFECT OCCURS IN CONTAINER OR WORKSPACE]
  │
  X ===> WORKER PROCESS CRASHES / KERNEL PANIC / POWER LOSS
  │
  └─ 4. Attempt completion is NEVER persisted to SQLite!
```

When a Sweeper or recovering worker inspects the database after lease expiry:
- The database shows Attempt #1 as `DISPATCHED` or `RUNNING`.
- Did the command finish executing?
- Did it write 500 files to the workspace?
- Did it fail halfway through?
- **The system cannot know without physical inspection.**

### 7.2 Resolution: Explicit UNKNOWN State
Marking the interrupted attempt as `FAILED` is dangerous because automated retry logic might treat it as a routine transient failure and blindly re-execute the action.

Therefore, the state machine requires an explicit **`UNKNOWN`** terminal state:
1. When a lease expires with an attempt in `DISPATCHED` or `RUNNING`, the Sweeper transitions the attempt to `UNKNOWN`.
2. **Idempotency Rule**:
   - **If the Tool is IDEMPOTENT** (`read_file`, `search_code`, `git_status`, `git_diff`):
     - Pure read-only queries leave zero persistent workspace side effects.
     - The Action Controller can safely record Attempt #1 as `UNKNOWN` and spawn Attempt #2.
   - **If the Tool is NON-IDEMPOTENT** (`write_file`, `run_command`):
     - Workspace state may be partially corrupted or arbitrarily modified.
     - Automated retries are **STRICTLY PROHIBITED**.
     - The Action Controller must fail the Action closed (`FAILED` with reason `UNRECOVERABLE_UNKNOWN_EXECUTION`).
     - Recovery requires workspace reclamation (re-provisioning from baseline or git checkout) before any further actions can execute.

---

## 8. Idempotency Architecture & Guarantees

### 8.1 Responsibility Allocation

```text
Tool Definition (Domain)
    │  declares: ToolIdempotency (IDEMPOTENT | NON_IDEMPOTENT)
    ▼
Action Aggregate (Domain)
    │  owns: Logical Retry Policy (Can this action be retried?)
    ▼
Attempt Aggregate (Runtime)
    │  owns: Physical Execution Token (idempotencyToken = `${runId}:${actionId}:${attemptNumber}`)
    ▼
ExecutionProvider (Port)
    │  executes: Disposable, single-shot physical operation
```

### 8.2 What Emerald Guarantees vs What It CANNOT Guarantee

1. **Emerald GUARANTEES**:
   - **Fail closed on uncertain non-idempotent execution**: If an attempt on a non-idempotent tool experiences an uncertain outcome or crash (UNKNOWN), Emerald will never automatically issue a second execution; it fails closed and requires explicit recovery/reclamation decisions.
   - **At-least-once execution for idempotent tools**: Read-only tools can be retried across crashes until verified completion or retry budget exhaustion.
   - **Cryptographic integrity and deterministic verification**: Output and state changes are hashed and validated against immutable Mission Contracts.
2. **Emerald CANNOT GUARANTEE**:
   - **Exactly-once external physical execution**: If an arbitrary command (`curl -X POST https://api.stripe.com/...`) executes inside a container and the host loses power before saving the result, the HTTP request was sent. No software runtime on Earth can guarantee exactly-once execution of arbitrary external network or process side effects across arbitrary crashes.

---

## 9. Lease Fencing & Stale Worker Concurrency Defense

To guarantee that zombie workers cannot corrupt Action or Attempt state, all database mutations enforce **lease fencing tokens**:

```text
Stale Worker A                          Active Worker B
(Lease l1 expired)                     (Lease l2 acquired)
       │                                       │
       │                                       ├─ Sweeper expires l1
       │                                       ├─ Claims run with lease l2
       │                                       │
       ├─ Attempts to mark Attempt 1           │
       │  as SUCCEEDED in SQLite               │
       │                                       │
       ▼                                       │
UPDATE attempts                                │
SET status = 'SUCCEEDED'                       │
WHERE attempt_id = 'att-1'                     │
  AND lease_id = 'l1'                          │
  AND run_id = 'run-1';                        │
       │                                       │
       ├─ Rows matched: 0                      │
       ▼                                       │
THROWS LeaseLostError!                         │
(Worker A terminated immediately)              │
                                               ▼
                                  Executes safely under lease l2
```

### Invariant:
Every mutation to `actions` and `attempts` must include:
$$\text{fencing} = \{ \text{workerId}, \text{leaseId} \}$$
If the database record's `lease_id` does not match, the query affects zero rows, rolling back the transaction and raising `LeaseLostError`.

---

## 10. Mission Contract Authority Binding

An Action and Attempt must never escape Mission Contract governance.

### 10.1 Binding Hierarchy
- Authority is established at the `Run` level via immutable `(contractId, version, contentHash)` binding.
- Each `Action` persisted to SQLite explicitly stores:
  - `contract_id`
  - `contract_version`
  - `contract_hash`
- **Why store contract binding on Action?**
  1. **Audit & Replay Independence**: An Action record is self-contained. Years later, an auditor or Reflex optimization model can prove exactly which contract version authorized that specific command without navigating complex multi-table historical joins.
  2. **Immutability Defense**: Prevents any theoretical bug where a Run's contract binding might be updated while an Action is executing.
  3. **Revocation Check**: At every stage (before dispatch, during retry, and before committing output), the Gateway verifies that the contract has not been `REVOKED`. If revoked, execution halts immediately with zero side effects.

---

## 11. Boundary Relations Across Subsystems

```text
Untrusted Model / Agent
       │
       ├─ emits ToolRequest (untrusted proposal)
       ▼
WorkerRuntime / Action Controller
       │
       ├─ validates sequence number & active lease
       ├─ creates Action (status: CREATED)
       ▼
ToolExecutionGateway
       │
       ├─ Stage 1-7: Verify Contract, Policy, Resource Ceilings, Zod Schema
       │             (If invalid: Action -> FAILED, ZERO execution)
       ├─ Stage 8-10: Workspace Boundary & Sandbox Isolation Verification
       │
       ├─ Action transitions: CREATED -> AUTHORIZED
       ├─ Creates Attempt #1 (status: CREATED -> DISPATCHED)
       ▼
Tool Adapter (WorkspacePort or ExecutionProvider)
       │
       ├─ executes physical operation inside sandbox
       ▼
Physical Execution Result
       │
       ├─ creates Evidence (OUTPUT_PAYLOAD, PROCESS_EXIT)
       ├─ evaluates DeterministicVerifier (VerificationSpec)
       │
       ├─ Attempt transitions: DISPATCHED -> SUCCEEDED / FAILED
       └─ Action transitions: RUNNING -> SUCCEEDED / RETRYING / FAILED
```

---

## 12. Evidence & Verification Boundaries

### 12.1 Evidence Ownership
- **Evidence is produced by an Attempt**: Physical reality is observed during a trial.
  - An Attempt captures: `evidenceIds: readonly string[]`.
  - Evidence items are immutable, content-hashed with SHA-256, and stored in the event stream / evidence store.
- **Action Aggregate Role**: The Action stores the terminal `resultPayload` and the collection of `evidenceIds` produced across all its attempts for historical audit.

### 12.2 Verification Ownership
- **Attempt-Level Output Validation**: The Gateway validates that the raw adapter output satisfies the tool's `outputSchema`.
- **Action-Level Post-Condition Verification**: If the Mission Contract defines a `VerificationSpec` for the task/action:
  - The `DeterministicVerifier` runs against the evidence list.
  - The verdict (`VERIFIED` or `FAILED`) determines whether the Action is allowed to transition to `SUCCEEDED`.
  - A failed verification prevents the Action from succeeding, failing closed or triggering a retry.

---

## 13. Persistence Design (Design Specification Only)

To preserve existing Phase 1–3 stability, no SQLite migrations are applied in this review task. The target schema design for Phase 4.4 implementation is:

### 13.1 `actions` Table Specification

```sql
CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    sequence_number INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    input_payload TEXT NOT NULL,
    result_payload TEXT,
    error_payload TEXT,
    contract_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    contract_hash TEXT NOT NULL,
    active_attempt_number INTEGER,
    total_attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(contract_id, contract_version) REFERENCES mission_contracts(contract_id, version),
    UNIQUE(run_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_actions_run_seq ON actions(run_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_contract ON actions(contract_id, contract_version);
```

### 13.2 `attempts` Table Specification

```sql
CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt_number INTEGER NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(worker_id),
    lease_id TEXT NOT NULL REFERENCES leases(lease_id),
    status TEXT NOT NULL,
    idempotency_token TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    exit_code INTEGER,
    output_payload TEXT,
    error_payload TEXT,
    evidence_ids TEXT,
    provider_metadata TEXT,
    UNIQUE(action_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_action_num ON attempts(action_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_attempts_run_lease ON attempts(run_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
```

---

## 14. Event Model & Causal Ordering

All state changes emit strongly typed domain events into the append-only `run_events` table.

### 14.1 Candidate Event Sequence

```text
1. action.created       (Action proposed with validated intent)
2. action.authorized    (Passed policy, contract, and resource limits)
3. attempt.created      (Attempt #N initialized under active lease)
4. attempt.dispatched   (Adapter / provider invoked)
5. evidence.recorded    (Physical output / exit code hashed)
6. verification.completed (VerificationSpec evaluated)
7. attempt.completed / attempt.failed (Terminal attempt outcome)
8. action.completed / action.failed   (Terminal action outcome)
```

### 14.2 Principle of Causal Durability
$$\text{Event History} \ne \text{Operational Authority}$$
- Events provide an immutable, append-only causal audit log.
- Operational authority resides exclusively in the ACID SQLite state tables (`runs`, `leases`, `actions`, `attempts`).
- Crash recovery reconstructs state from durable tables; events serve replay and observability.

---

## 15. Comprehensive Failure Matrix (Cases A through G)

| Case | Scenario | Authoritative State | Safe Recovery Action | Automated Retry Permitted? | Fails Closed? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | Action created in DB; worker crashes before Attempt is created. | `Action: AUTHORIZED`, zero attempts exist. | New worker acquires lease; inspects Action; finds 0 attempts; starts Attempt #1. | **Yes** (zero side effects occurred). | No; safely retried. |
| **B** | Attempt created as `CREATED`/`DISPATCHED`; worker crashes before provider dispatch. | `Attempt: DISPATCHED`, zero provider execution. | Sweeper detects expired lease; marks Attempt #1 as `UNKNOWN`. If tool is idempotent, starts Attempt #2. If non-idempotent, fails closed. | **Only if tool is IDEMPOTENT**. | Fails closed if non-idempotent. |
| **C** | Provider dispatched (Docker container running); worker crashes; completion unknown. | `Attempt: RUNNING`, provider state indeterminate. | Sweeper detects expired lease; cleans/kills orphaned Docker container; marks Attempt #1 as `UNKNOWN`. | **Only if tool is IDEMPOTENT**. Non-idempotent fails closed. | Yes for non-idempotent. |
| **D** | Provider completed successfully; worker crashes before persisting completion to SQLite. | `Attempt: RUNNING`, result lost in worker memory. | Sweeper marks Attempt #1 as `UNKNOWN`. For `read_file`, retry re-reads cleanly. For `write_file`/`run_command`, fails closed; requires rollback. | **Only if tool is IDEMPOTENT**. | Yes for non-idempotent. |
| **E** | Worker loses lease during Attempt (network pause / GC); old worker attempts write. | Lease expired; new lease granted to Worker B. | Worker A write rejected with `LeaseLostError` via fencing token. Worker A halts immediately. | N/A (Worker A is fenced). | Fenced worker terminates. |
| **F** | Mission Contract revoked during Attempt execution. | Contract status `REVOKED`. | Post-execution verification rejects result; workspace cleaned; Action fails closed with `CONTRACT_REVOKED`. | **No** (Zero retries). | **Yes, immediately.** |
| **G** | Worker crashes after non-idempotent side effect (`write_file` or `run_command`). | Workspace mutated on disk; DB in `RUNNING`. | Sweeper marks Attempt #1 as `UNKNOWN`. Action fails closed (`FAILED`). Workspace disposed/reclaimed during cleanup. | **No** (Automated retry strictly prohibited). | **Yes, immediately.** |

---

## 16. Threat Modeling & Security Analysis

| Threat | Vulnerability Vector | Defense Layer & Invariant |
| :--- | :--- | :--- |
| **Prompt Injection** | Model injects malicious tool payloads via untrusted `ToolRequest`. | Gateway validates strict Zod schemas, enforces discrete `argv` tokens, and sanitizes arguments before Action creation. |
| **Privilege Escalation** | Model requests unauthorized capability or resource budget. | PolicyEvaluator and Gateway enforce exact Mission Contract ceilings. Silent clamping is forbidden (fails closed). |
| **Zombie Worker Corruption** | Partitioned worker writes stale data after lease expiry. | Lease fencing token (`workerId`, `leaseId`) enforced on every SQLite write (`LeaseLostError`). |
| **Non-Idempotent Corruption** | Duplicate execution of destructive commands after crash. | Crash window marks in-flight trials as `UNKNOWN`; automated retry of non-idempotent tools is strictly blocked. |
| **Secret Exfiltration** | Sensitive keys persisted in action/attempt database rows. | Sensitive environment variables and payload fields are redacted prior to SHA-256 canonical hashing and persistence. |
| **Contract Revocation Bypass** | Execution continues after contract revoked by admin. | Pre-dispatch and post-execution revocation checks fail closed immediately. |
| **Workspace Boundary Escape** | Path traversal via `../` or absolute paths in file tools. | Lexical path sanitization in `workspace-path.ts` and canonical realpath confinement in `NodeFsWorkspaceAdapter`. |

---

## 17. Replay Requirements for Future Reflex Architecture

To support deterministic replay and Reflex self-optimization without stochastic drift:

1. **Replayable Artifacts (100% Deterministic)**:
   - Logical Action sequence ($seq = 1..N$).
   - Input payloads and their SHA-256 canonical `inputHash`.
   - Bound Mission Contract `contentHash` and policy decisions.
   - Exact tool definitions and schema versions.
   - Deterministic verification specs and verification verdict history.
2. **Non-Replayable Realities (Must Be Mocked / Virtualized During Replay)**:
   - External network latency and container startup wall-clock durations.
   - Non-deterministic third-party outputs from arbitrary bash commands.
   - Ephemeral process IDs and worker hostnames.
3. **Replay Invariant**:
   - Replay evaluates the recorded *transcript of intentions, hashes, and evidence*. It does not re-execute physical side effects against production infrastructure.

---

## 18. Implementation Sequence Roadmap

The implementation of Action and Attempt will proceed through small, verified, bounded increments:

```text
Phase 4 / Task 4.4-A (Current)
└── Action & Attempt Domain Architecture Review (ADR-0005, Design Only)

Phase 4 / Task 4.4-B
└── Action & Attempt Pure Domain Contracts & Invariants (src/domain/action.ts, src/domain/attempt.ts)

Phase 4 / Task 4.4-C
└── Action & Attempt State Machines & Event Definitions (Pure domain transitions)

Phase 4 / Task 4.4-D
└── SQLite Persistence Schema, Repositories & Lease Fencing (actions & attempts tables)

Phase 4 / Task 4.4-E
└── Tool Execution Gateway & WorkerRuntime Action Lifecycle Integration

Phase 4 / Task 4.4-F
└── Crash Recovery, Idempotency Defense & Sweeper Orphan Reclamation
```

---

## 19. Architectural Decision Verdict

The separation of **Action** (logical intention) and **Attempt** (physical execution instance) is **APPROVED**.
- Actions provide monotonic, contract-bound, replayable intention tracking.
- Attempts provide lease-fenced, crash-aware, evidence-producing physical execution.
- Non-idempotent tools enforce strict fail-closed semantics on unknown crash outcomes.
- All invariants preserve existing Mission Contract, Workspace Sandbox, and ExecutionProvider baselines without modification.
