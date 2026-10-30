# Phase 32A: Existing Semantics Audit

## 1. Executive Summary

Phase 32 strengthens Emerald Agent Fabric's infrastructure by introducing:
1. Exact Mission Contract binding and integrity continuity across process failure boundaries.
2. Durable mission checkpoints committed atomically with authoritative state transitions.
3. Supervisor identity, leases, and heartbeat fencing preventing stale supervisors from mutating state.
4. Deterministic multi-attempt recovery (Attempt $N \rightarrow N+1$) governed by supervisor authority and contract continuity.

- **Baseline Commit**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Working Tree**: Verified intact with Phase 31 fencing enhancements.
- **Constraints**: ₹0 cost, strictly local execution, open-source only, zero model inference, zero model downloads, no external APIs.

---

## 2. Audit of Existing Semantics

### Question 1: Where is the authoritative mission contract currently stored?
Authoritative mission contracts are stored in the SQLite `mission_contracts` table:
```sql
CREATE TABLE IF NOT EXISTS mission_contracts (
    contract_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    status TEXT NOT NULL, -- DRAFT | ACTIVE | REVOKED
    content_hash TEXT NOT NULL, -- SHA-256 of canonical MissionContractSpec
    canonical_spec TEXT NOT NULL, -- JSON string of canonical spec
    created_at TEXT NOT NULL,
    activated_at TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    PRIMARY KEY(contract_id, version)
);
```
Contracts are retrieved via `StateStorePort.getContract(contractId, version)` or `findContractsByTaskId(taskId, status)`.

### Question 2: What exact contract identity is bound to a run?
The contract identity bound to a `Run` is represented by the immutable domain value object `ContractBinding`:
```typescript
export interface ContractBinding {
  readonly contractId: string;
  readonly version: number;
  readonly contentHash: string;
}
```
This is stored directly in the `runs` table across three columns: `contract_id`, `contract_version`, and `contract_hash`, with a foreign key constraint referencing `mission_contracts(contract_id, version)` and an invariant check constraint ensuring all three fields (and `max_output_bytes`) are present together or absent together.

### Question 3: Is the content hash persisted and verified during recovery?
Yes. During `RunCoordinator.recoverExpiredRuns()`:
1. The run snapshot's `contractBinding` is inspected.
2. The exact contract `(binding.contractId, binding.version)` is fetched from the store.
3. The canonical hash is recomputed using `computeCanonicalHash(contract.spec)`.
4. The recomputed hash is verified against both `contract.contentHash` and `binding.contentHash`.
5. If any mismatch occurs, recovery fails closed with error code `CONTRACT_INTEGRITY_MISMATCH`.

### Question 4: What is currently considered a durable checkpoint?
Currently, durable state is captured as independent aggregate snapshots in the `runs`, `actions`, `attempts`, and `run_events` tables. Every domain transition together with its corresponding domain event is persisted inside an atomic SQLite transaction (`BEGIN IMMEDIATE ... COMMIT`).
However, there is no explicit `MissionCheckpoint` entity or table linking a run's checkpoint version, active action ID, attempt number, durable state, and event sequence together into a formal checkpoint record.

### Question 5: Which state transitions constitute a checkpoint boundary?
A checkpoint boundary occurs whenever authoritative durable state advances:
- **Run Transitions**: `CREATED` $\rightarrow$ `QUEUED` $\rightarrow$ `LEASED` $\rightarrow$ `RUNNING` $\rightarrow$ `RECOVERING` $\rightarrow$ (`COMPLETED` | `FAILED` | `TIMED_OUT` | `CANCELLED`).
- **Action Transitions**: `CREATED` $\rightarrow$ `AUTHORIZED` $\rightarrow$ `RUNNING` $\rightarrow$ (`SUCCEEDED` | `FAILED` | `RETRYING`).
- **Attempt Transitions**: `CREATED` $\rightarrow$ `DISPATCHED` $\rightarrow$ `RUNNING` $\rightarrow$ (`SUCCEEDED` | `FAILED` | `UNKNOWN` | `CANCELLED`).
- **Verification Milestones**: Clean-room verification started / completed.
In SQLite WAL mode, each transaction commits durably to disk before the operation returns.

### Question 6: Who currently has authority to perform recovery?
Currently, `RunCoordinator.recoverExpiredRuns()` is invoked by any caller with access to the `RunCoordinator` instance. It operates as an internal sweeper loop without requiring an explicit supervisor identity, supervisor lease, or fencing token.

### Question 7: Can two supervisors currently attempt recovery simultaneously?
Yes, and this is a key gap. If two processes or coordinator instances invoke `recoverExpiredRuns()` concurrently, SQLite transactions serialize the raw SQL operations, but there is no domain-level supervisor lease or fencing mechanism. Consequently, two coordinators could alternate sweeps or race without explicit supervisor ownership or heartbeat fencing.

### Question 8: How is supervisor liveness represented, if at all?
Supervisor liveness is currently **unrepresented**. While worker liveness is tracked in the `workers` table (`last_heartbeat_at`) and `leases` table (`expires_at`), there is no table, aggregate, or heartbeat mechanism for supervisors.

### Question 9: What existing Phase 31 fencing mechanism can be reused?
Phase 31 established:
- **Transactional Lease Fencing**: `validateLeaseFencing(runId, fencing)` checking lease ID, worker/supervisor ID, active state, and `expires_at > nowIso`.
- **Fail-Closed Timestamp Validation**: Rejecting operations where `nowIso >= expires_at` with a typed expiration error (`LeaseExpiredError`).
- **Attempt Ownership Fencing**: Rejecting mutations on attempts created under another lease with `AttemptNotOwnedError`.
- **Duplicate Completion Idempotency**: Detecting repeated calls on terminal states and returning existing snapshots and events without generating sequence gaps.
- **Atomic Event Sequencing**: Guaranteeing that rejected transactions roll back completely, preserving strictly gapless per-run sequence numbers ($1, 2, \dots, N$).

All of these patterns can be directly reused and extended for supervisor leases and recovery transactions.

### Question 10: What information must survive a process crash?
1. The exact `ContractBinding` (`contractId`, `version`, `contentHash`).
2. The full `MissionContract` specification.
3. The latest durable `MissionCheckpoint` (`runId`, `checkpointVersion`, `contractBinding`, `actionId`, `attemptNumber`, `durableState`, `eventSequence`).
4. The immutable history of previous attempts (Attempt $1 \dots N$), including exit codes, durations, and error payloads.
5. The complete, gapless per-run event stream.
6. The active supervisor lease, ensuring a crashed supervisor cannot resume and execute mutations after its lease expires.
