# Phase 31 Report: Deterministic Multi-Attempt Recovery & Durable Worker Lease Fencing

## Baseline

- **Repository**: `emerald-agent-fabric`
- **Initial Baseline Commit**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Working Tree Cleanliness**: Verified prior to modifications (`git status --porcelain`).
- **Core Constraints**: ₹0 cost, strictly open-source/open-weight, zero model inference, zero model downloads, local execution only, no proprietary APIs or cloud dependencies.

---

## Existing Semantics

Prior to Phase 31, Emerald possessed foundational domain abstractions for `Run`, `Action`, `Attempt`, and `LeaseRecord`, stored in SQLite using WAL mode:
1. **Action Domain**: Encapsulated logical user intent (`actionId`, `toolName`, `inputPayload`, `contractBinding`). Invariants enforced that `totalAttempts <= maxAttempts`, and `evaluateRetryEligibility` returned typed verdicts based on tool idempotency and attempt terminal states.
2. **Attempt Domain**: Represented physical trials with immutable identity (`attemptId`, `actionId`, `runId`, `attemptNumber`, `workerId`, `leaseId`). An explicit `UNKNOWN` state represented execution uncertainty.
3. **Lease Coordination**: `LeaseManager` acquired and released time-bounded leases, while `RunCoordinator.recoverExpiredRuns()` swept expired leases and re-queued runs or failed them if retry budgets were exhausted.
4. **Audit Findings**:
   - Time-based lease expiration was not checked inside SQL mutation transactions (`validateLeaseFencing`), creating a race where an expired lease could mutate state before the sweeper ran.
   - Attempt-level lease and worker ownership was not verified during attempt updates, allowing a worker with a valid run lease to mutate an attempt owned by another lease.
   - Duplicate delivery of completion commands for already-succeeded attempts or actions threw `TerminalStateError` rather than safely returning the existing record idempotently.
   - `LeaseManager.renew()` did not enforce that current time was strictly before lease expiration, allowing expired leases to be resurrected.

---

## Implemented Changes

To address these vulnerabilities, the following changes were introduced:

1. **`src/domain/errors.ts`**:
   - Added `LeaseExpiredError`: Raised when an operation or renewal is attempted using a lease whose expiration timestamp has passed (`nowIso >= expiresAt`).
   - Added `AttemptNotOwnedError`: Raised when a worker or lease attempts to advance or mutate an attempt assigned to a different worker or lease ID.

2. **`src/ports/state-store.port.ts`**:
   - Extended `LeaseFencingCheck` with an optional `nowIso?: string` field to enable transactional time-based fence verification inside the database transaction.

3. **`src/application/lease-manager.ts`**:
   - Enhanced `renew()` to reject renewals if `nowIso >= lease.expiresAt` with `LeaseExpiredError`.
   - Added cross-verification ensuring the run's currently assigned `leaseId` and `workerId` match the lease being renewed, throwing `LeaseLostError` on mismatch.

4. **`src/adapters/persistence/sqlite-state-store.ts`**:
   - Refactored lease fencing into a unified `validateLeaseFencing(runId, fencing)` method executed within SQLite transactions. Checks:
     - Run exists and matches `fencing.workerId` and `fencing.leaseId`.
     - Lease record exists and is in `ACTIVE` state.
     - Lease `expires_at` is strictly greater than `fencing.nowIso` (if provided).
   - Added attempt ownership validation in `updateAttempt` and `transitionAttempt`: verifies `current.workerId === fencing.workerId` and `current.leaseId === fencing.leaseId`, rejecting usurpers with `AttemptNotOwnedError`.
   - Added idempotent duplicate completion handling in `transitionAttempt` (command `COMPLETE` on `SUCCEEDED` attempt) and `transitionAction` (command `SUCCEED` on `SUCCEEDED` action), returning the existing snapshot and recorded event without mutating state or appending duplicate events.

5. **`src/application/worker-runtime.ts`**:
   - Threaded `this.clock.nowIso()` into `executeAction` fencing checks.
   - Implemented idempotent early return in `executeAction` when the requested `actionId` is already in terminal `SUCCEEDED` status.

---

## Lease Fencing Guarantees

- **Transactional Verification**: Fencing is verified inside SQLite `BEGIN IMMEDIATE` transactions, preventing TOCTOU races between sweeper lease reassignment and worker state mutation.
- **Fail-Closed on Time Expiry**: When `fencing.nowIso >= lease.expires_at`, mutations fail immediately with `LeaseExpiredError`, closing the window where an expired worker could commit state before sweeper detection.
- **Run Assignment Binding**: Mutations fail with `LeaseLostError` if the run has been leased to another worker or transitioned away from `LEASED`/`RUNNING`.
- **Attempt Isolation**: Workers cannot advance attempts created under previous leases or other workers; mutations fail with `AttemptNotOwnedError`.

---

## Multi-Attempt Recovery Guarantees

- **Immutable History**: When an attempt fails or becomes uncertain, Attempt $N$ remains frozen in the database with its exact execution metadata (`durationMs`, `exitCode`, `errorPayload`). It is never overwritten.
- **Monotonic Attempt Numbering**: Attempt $N+1$ is assigned `attemptNumber = N + 1`. Monotonicity is verified before insert, rejecting any skips or duplicates.
- **Idempotency Tokens**: Each attempt carries `${runId}:${actionId}:${attemptNumber}`, guaranteeing that retried attempts have distinct idempotency identities.

---

## Crash Recovery

- **Fail-Closed Attempt Disposition**: When a worker crashes and its lease expires, `RunCoordinator.recoverExpiredRuns()` executes `reconcileStaleActionsAndAttemptsForRun`:
  - `CREATED` attempts (never dispatched) transition to `CANCELLED`.
  - `DISPATCHED` or `RUNNING` attempts transition to `UNKNOWN` with `reasonCode = "LEASE_EXPIRED_DURING_EXECUTION"`.
- **Safe Action Reconcile**:
  - Non-idempotent actions with `UNKNOWN` attempts transition to `FAILED` (no automatic retry).
  - Idempotent actions with remaining attempt budget transition to `RETRYING`, enabling subsequent leased workers to safely initiate Attempt $N+1$.
- **Atomic Sweeper Transaction**: Expiring the lease, reconciling attempts, reconciling actions, and requeuing the run occur within a single atomic SQLite transaction.

---

## Stale Worker Behavior

A stale (zombie) worker that resumes execution after its lease has expired or been reassigned encounters strict barriers:
1. Attempting `transitionAction` $\rightarrow$ Rejected with `LeaseLostError` or `LeaseExpiredError`.
2. Attempting `updateAttempt` $\rightarrow$ Rejected with `LeaseLostError` or `AttemptNotOwnedError`.
3. Attempting `transitionAttempt` $\rightarrow$ Rejected with `LeaseLostError` or `AttemptNotOwnedError`.
4. Attempting `completeRun` $\rightarrow$ Rejected with `LeaseLostError`.
5. Event stream integrity $\rightarrow$ Rejected transactions roll back completely, ensuring zero phantom events or sequence gaps.

---

## Concurrency Behavior

- **Mutual Exclusion on State Advancement**: In SQLite WAL mode with immediate transactions, two workers racing to advance an active attempt or claim a run are serialized.
- **Conflicting Attempt Rejection**: If two workers attempt to insert Attempt 1 concurrently, the second worker is rejected by the SQLite unique constraint `(action_id, attempt_number)` and domain invariants.
- **Ownership Partitioning**: Even if Worker B obtains a valid lease on the run after Worker A's lease expires, Worker B cannot modify Attempt 1 which was owned by Worker A; Worker B must create Attempt 2.

---

## Idempotency Behavior

- **At-Most-One Authorized State Advancement**: We do not claim "exactly-once physical execution". Physical tool commands may run multiple times if a crash occurs mid-execution. However, state advancement is strictly at-most-one per attempt.
- **Duplicate Completion Idempotency**: If a network retry or re-delivered message calls `COMPLETE` on an attempt that is already `SUCCEEDED`, the state store detects the duplicate, finds the previously persisted `attempt.completed` event, and returns `{ snapshot, event }` without modifying data or generating duplicate events.
- **Action Re-Execution**: Calling `executeAction` on an already-`SUCCEEDED` action returns the existing succeeded result without re-executing physical tools.

---

## Event Integrity

- **Strictly Monotonic Gapless Sequences**: Per-run sequence numbers ($1, 2, 3, \dots, N$) are computed and enforced atomically.
- **Rollback Consistency**: Any operation rejected due to lease fencing, invariant violation, or conflict fails within the transaction before the event sequence counter is committed.
- **Verification**: Verified via test `T12`, where deliberate failures, rejected stale mutations, and multi-step transitions produced an uninterrupted, contiguous sequence from 1 to 14 without gaps.

---

## Test Matrix

The dedicated suite `tests/persistence/phase31-recovery-fencing.test.ts` executes 18 end-to-end scenarios against a real SQLite database:

| Test ID | Scenario Description | Expected Outcome | Result |
| :--- | :--- | :--- | :--- |
| **T1** | Valid worker with active lease advances action through authorized transitions | Action reaches `RUNNING` with valid lease | **PASSED** |
| **T2** | Stale worker with mismatched/expired lease attempts action transition | Rejected with `LeaseLostError` | **PASSED** |
| **T3** | Duplicate execution of already `SUCCEEDED` action | Returns existing snapshot without re-execution | **PASSED** |
| **T4** | Stale worker attempts `updateAttempt` | Rejected with `LeaseLostError` | **PASSED** |
| **T5** | Two workers racing to insert Attempt 1 for same action | Second worker rejected with duplicate attempt error | **PASSED** |
| **T6** | Stale worker attempts `transitionAttempt` | Rejected with `LeaseLostError` | **PASSED** |
| **T7** | Duplicate `COMPLETE` command on `SUCCEEDED` attempt | Idempotent return of existing snapshot and event | **PASSED** |
| **T8** | Worker crashes while attempt is `RUNNING`; sweeper reconciles | Attempt transitions to `UNKNOWN` fail-closed | **PASSED** |
| **T9** | Multi-attempt recovery creates Attempt 2 after Attempt 1 failure | Attempt 1 preserved as `FAILED`; Attempt 2 created `RUNNING` | **PASSED** |
| **T10** | Attempt numbering monotonicity enforcement | Non-monotonic attempt number (Attempt 2 without 1) rejected | **PASSED** |
| **T11** | Worker B attempts to complete attempt owned by Worker A | Rejected with `LeaseLostError` / `AttemptNotOwnedError` | **PASSED** |
| **T12** | Event sequence monotonicity across rejected and accepted operations | Contiguous 1..N sequence without gaps | **PASSED** |
| **T13** | Idempotent retry execution for `read_file` tool creates Attempt 2 | Action and Attempt succeed on second attempt | **PASSED** |
| **T14** | Non-idempotent tool failure prevents unsafe automatic retry | Action transitions to `FAILED` with non-retryable verdict | **PASSED** |
| **T15** | Worker crashes, lease expires, run recovered deterministically | Run returns to `QUEUED` with incremented `attemptCount` | **PASSED** |
| **T16** | Zombie worker resumes execution after sweeper reassigned run | Zombie completion rejected with `LeaseLostError` | **PASSED** |
| **T17** | Lease renewal race when clock passes expiration timestamp | Renewal rejected with `LeaseExpiredError` | **PASSED** |
| **T18** | End-to-end idempotent duplicate completion of Action and Attempt | Safe return of existing state and events | **PASSED** |

---

## Regression Results

All regression suites were executed and verified clean:

1. `npx tsc --noEmit`: Clean (0 errors).
2. `npx vitest run tests/persistence/phase31-recovery-fencing.test.ts`: **18/18 passed** (100%).
3. `npx vitest run tests/integration/phase14-independent-verification.test.ts`: **11/11 passed** (100%).
4. `npx vitest run tests/integration/`: **83 passed, 1 skipped** (100% of runnable tests passed).
5. `npx tsx scripts/verify-phase10h-artifacts.ts`: **36/36 passed** (All historical SHA-256 hashes byte-for-byte verified).
6. `git diff --check`: Clean (0 whitespace/formatting errors).
7. `git rev-parse HEAD`: Matches required baseline `70979cf4bcbf4a237b79af3a23449a4b932104d5`.

---

## Remaining Risks

1. **Un-fenced Physical Side Effects**: While SQLite transactions guarantee that durable state can never be mutated by a stale worker, a stale worker executing in an external operating system process or network socket may still perform physical actions (e.g. sending a packet) before it discovers its lease was lost. Fail-closed `UNKNOWN` status isolates Emerald's internal state machine from this external ambiguity.
2. **Clock Synchronization**: In multi-machine worker topologies, physical clock drift could lead to discrepancies between a worker's local clock and the database clock. Node-local timestamps must be calibrated or database-authoritative clocks should be preferred in distributed deployments.

---

## Scientific / Architectural Conclusion

Phase 31 proves that distributed agent execution guarantees can be achieved independently of model size, training dataset, or inference provider. 

By enforcing:
- **Durable transactional lease fencing**
- **Monotonic, immutable multi-attempt tracking**
- **Fail-closed `UNKNOWN` states on execution uncertainty**
- **Idempotent duplicate completion semantics**
- **Gapless per-run event ordering**

Emerald Agent Fabric ensures that even when workers crash, leases expire, or network messages duplicate, the system never compromises correctness, never rewrites historical execution evidence, and prevents stale workers from corrupting state.

---

## Phase 32 Recommendation

Proceed to Phase 32: Formalize **Mission Contract Checkpointing and Distributed Supervisor Heartbeating**, extending the durable multi-attempt recovery model to long-running, multi-step agent trajectories with formal failure recovery checkpoints.
