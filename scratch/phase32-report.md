# Phase 32: Mission Contract Checkpointing & Supervisor Heartbeat Fencing
## Comprehensive Engineering & Empirical Verification Report

---

### 1. Executive Summary

Phase 32 implements a production-grade recovery mechanism for multi-attempt software engineering agent missions across worker and supervisor failure boundaries within the Emerald Agent Fabric architecture. Building strictly upon the Phase 31 lease fencing and attempt continuity foundation, Phase 32 introduces:
1. **Cryptographic Mission-Contract Binding Integrity**: Strict validation across `contractId`, `version`, and canonical SHA-256 `contentHash` during execution, checkpoint creation, and recovery, failing closed if any divergence occurs.
2. **Durable Mission Checkpointing**: Append-only checkpoint persistence with strictly monotonic versions, capturing durable agent state, current attempt lineage, and gapless event sequence references.
3. **Supervisor Ownership & Heartbeat Fencing**: Dedicated durable supervisor leases (`supervisor_leases` table) decoupled from worker execution leases, with TTL-bounded heartbeats, usurpation prevention, and fail-closed fence checking.
4. **Historical Attempt Immutability**: Full preservation of crashed, failed, or uncertain attempts ($1..N$) as immutable historical records, while generating Attempt $N+1$ with monotonic attempt numbering.
5. **Zero Speculative Consensus**: Implemented entirely under the authoritative SQLite single-writer transactional state boundary without claiming distributed consensus or physical exactly-once execution.

Across the 24 newly authored persistence and recovery tests (`T1`–`T24`), 18 Phase 31 recovery tests, 83 integration tests, and 36 Phase 10H artifact trials, all invariant gates passed with 0 failures, preserving strict ₹0-cost local execution.

---

### 2. Frozen Baseline Verification

- **Required Baseline Git Commit**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Verified `git rev-parse HEAD`**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Frozen Architectural Components**:
  - `ProposalValidator`: Frozen and unviolated.
  - `Reflex`: Frozen and unviolated.
  - `PolicyEvaluator`: Frozen and unviolated.
  - `ContextEngine`: Frozen and unviolated.
  - `AgentStepController`: Frozen and unviolated.
  - Model Selection & Ollama Configuration: Frozen; 0 model downloads, 0 model inference calls executed.

---

### 3. Mission Contract Checkpoint Semantics

A mission contract in Emerald defines the immutable governance specification (`MissionContractSpec`), containing execution policies, tool capabilities, resource ceilings, credential scopes, and verification specifications. 

During runtime:
- **Binding Creation**: At run creation, the exact contract identity (`contractId`, `version`, `contentHash`) is embedded into `RunSnapshot.contractBinding`.
- **Validation on Checkpointing**: Whenever a `MissionCheckpoint` is saved via `saveCheckpoint`, the state store asserts that the checkpoint's `contractBinding` matches the run's `contractBinding` and verifies that the referenced contract exists in `mission_contracts` with an identical cryptographic hash.
- **Fail-Closed on Recovery**: During `recoverMission`, the supervisor asserts that the contract has not been tampered with and is not `REVOKED`. If the content hash differs by even a single bit or the contract has been revoked, recovery aborts immediately (`ContractIntegrityError` or `InvalidMissionContractError`), leaving historical state unmodified.

---

### 4. Supervisor Heartbeat Fencing Architecture

Emerald cleanly decouples two distinct leasing responsibilities:
- **Worker Execution Leases (`leases` table)**: Govern a worker's physical authority to mutate actions, attempts, and disk workspaces for a leased run.
- **Supervisor Leases (`supervisor_leases` table)**: Govern a supervisor node's administrative authority to inspect, checkpoint, mark stale executions, rebind leases, and schedule retry attempts across runs.

#### Supervisor Lifecycle State Machine:
$$\text{ACTIVE} \xrightarrow{\text{renew / heartbeat}} \text{ACTIVE}$$
$$\text{ACTIVE} \xrightarrow{t \ge \text{expires\_at}} \text{EXPIRED}$$
$$\text{ACTIVE} \xrightarrow{\text{release}} \text{RELEASED}$$

#### Fencing Guarantees:
- **Mutual Exclusion**: At most one supervisor lease can be `ACTIVE` and unexpired for a given `run_id` at any point in time. Attempted usurpation without holding the active lease throws `SupervisorLeaseLostError`.
- **TTL Enforcement**: Heartbeats presented after the lease expiration deadline fail closed with `SupervisorLeaseExpiredError`, transitioning the lease state to `EXPIRED`.
- **Administrative Reassignment**: Upon recovering an expired run, the supervisor fences out the stale worker by marking the old worker lease `EXPIRED`, rebinding the run row in `runs` to a new worker and new worker lease, and appending a `run.recovered` event.

---

### 5. Checkpoint Schema & Persistence Design

The durable schema extensions were added to `src/adapters/persistence/schema.ts` with idempotent migrations:

#### `supervisor_leases` Table:
```sql
CREATE TABLE IF NOT EXISTS supervisor_leases (
  lease_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  supervisor_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'EXPIRED', 'RELEASED'))
);
CREATE INDEX IF NOT EXISTS idx_supervisor_leases_run_active 
  ON supervisor_leases(run_id, state);
```

#### `mission_checkpoints` Table:
```sql
CREATE TABLE IF NOT EXISTS mission_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  checkpoint_version INTEGER NOT NULL,
  contract_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  contract_hash TEXT NOT NULL,
  action_id TEXT REFERENCES actions(action_id),
  attempt_number INTEGER,
  durable_state TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, checkpoint_version)
);
CREATE INDEX IF NOT EXISTS idx_mission_checkpoints_run_ver 
  ON mission_checkpoints(run_id, checkpoint_version);
```

Checkpoints enforce strict version monotonicity: inserting a checkpoint with `checkpoint_version <= current_max_version` throws `CheckpointVersionConflictError`.

---

### 6. Recovery Execution Flow

The `recoverMission` method in `RunCoordinator` executes inside a single atomic SQLite transaction (`BEGIN IMMEDIATE`):

1. **Supervisor Fencing Validation**: Asserts that `supervisorId` holds an active, unexpired lease matching `supervisorLeaseId`.
2. **Run Existence & Contract Verification**: Validates `runId`, retrieves `runSnapshot.contractBinding`, and checks canonical content hash integrity against `mission_contracts`.
3. **Contract Lifecycle Check**: Aborts if contract status is `REVOKED` or not `ACTIVE`.
4. **Idempotency Guard**: If the latest attempt is already a recovery attempt created for this checkpoint version in an active or retryable state, returns the existing state without creating duplicate attempts.
5. **In-Flight Crash Reconciliation**: If the latest attempt was left in `CREATED`, `DISPATCHED`, or `RUNNING`, marks it as `UNKNOWN` with reason `EXECUTION_UNCERTAIN` and error code `SUPERVISOR_RECOVERY`.
6. **Action State Transition**: Transitions the action to `FAIL` and then `PREPARE_RETRY` if retry-eligible.
7. **Worker Lease Fencing Update**: Expires the stale worker lease and re-binds `runs.current_worker_id`, `runs.lease_id`, and `runs.lease_expires_at` to the new recovery worker and lease.
8. **Monotonic Attempt Generation**: Constructs Attempt $N+1$ with incremented `attemptNumber`, monotonic sequence token, and identical `contractBinding`.
9. **Checkpoint Materialization**: Computes incremented `checkpointVersion`, associates the latest gapless `eventSequence`, and inserts the durable `MissionCheckpoint`.
10. **Atomicity**: Any uncaught exception causes an immediate SQLite transaction rollback, leaving no partial state.

---

### 7. Historical Attempt Immutability & Continuity

Emerald guarantees the **Audit History $\neq$ Current Authority** invariant:
- Stale, failed, or crashed attempts are never deleted, overwritten, or updated in place.
- Attempt 1 remains durably in `UNKNOWN` (or `FAILED`), recording its original `startedAt`, `workerId`, and `leaseId`.
- Attempt 2 is appended as a distinct entity with `attemptNumber = 2`, referencing the exact same `actionId` and `runId`.
- All historical evidence IDs and event sequences linked to Attempt 1 remain accessible for forensic replay and verification.

---

### 8. Gapless Event Sequencing Invariants

Event emission inside `run_events` is strictly monotonic and gapless ($1, 2, 3, \dots, M$):
- Sequences are assigned atomically under SQLite `BEGIN IMMEDIATE` via:
  ```sql
  SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?
  ```
- If an operation fails or is rejected by policy/fencing, the transaction rolls back, producing no orphan event and creating no gaps.
- Checkpoints persist `eventSequence` referencing the exact latest committed event at the time of checkpointing.

---

### 9. Fail-Closed Boundary Verification

Every recovery boundary enforces fail-closed semantics:
- **Contract Hash Tampering**: Tampering with `mission_contracts.content_hash` triggers `ContractIntegrityError`; recovery is denied.
- **Contract Revocation**: Setting contract status to `REVOKED` triggers `InvalidMissionContractError`; recovery is denied.
- **Supervisor Lease Expiration**: Attempting recovery after lease expiration triggers `SupervisorLeaseExpiredError`; recovery is denied.
- **Supervisor Usurpation**: Attempting recovery with an unauthorized supervisor ID triggers `SupervisorLeaseLostError`; recovery is denied.
- **Stale Worker Mutation**: Once the supervisor has recovered a run, the old worker presenting its stale lease is rejected with `LeaseLostError`.

---

### 10. T1–T24 Test Matrix

| Test ID | Objective | Expected Invariant | Status |
|---|---|---|---|
| **T1** | Valid contract binding recovery | Binding matched, Attempt 2 created | **PASS** |
| **T2** | Contract hash mismatch detection | Fails closed with `ContractIntegrityError` | **PASS** |
| **T3** | Revoked contract recovery | Fails closed with `InvalidMissionContractError` | **PASS** |
| **T4** | Checkpoint persistence & retrieval | Checkpoint retrieved with full fields | **PASS** |
| **T5** | Checkpoint version monotonicity | Rejects non-monotonic checkpoint version | **PASS** |
| **T6** | Checkpoint supervisor lease fencing | Rejects checkpoint from unleased supervisor | **PASS** |
| **T7** | Supervisor heartbeat renewal | Renews active lease and extends expiration | **PASS** |
| **T8** | Supervisor heartbeat expiration | Fails expired lease and marks status `EXPIRED` | **PASS** |
| **T9** | Heartbeat unauthorized supervisor | Rejects heartbeat with `SupervisorLeaseLostError` | **PASS** |
| **T10** | Heartbeat nonexistent lease | Rejects heartbeat with `SupervisorLeaseLostError` | **PASS** |
| **T11** | Explicit supervisor release | Releases lease, transitions state to `RELEASED` | **PASS** |
| **T12** | Supervisor usurpation prevention | Prevents concurrent active supervisor lease | **PASS** |
| **T13** | Monotonic attempt generation | Generates Attempt $N+1$ with attempt number 2 | **PASS** |
| **T14** | Historical attempt preservation | Attempt 1 remains frozen with original timestamps | **PASS** |
| **T15** | Contract binding inheritance | Attempt $N+1$ inherits exact run contract binding | **PASS** |
| **T16** | Stale supervisor recovery rejection | Rejects recovery from stale supervisor | **PASS** |
| **T17** | Recovery transaction rollback | Transaction rollback leaves 0 partial checkpoints | **PASS** |
| **T18** | Gapless event sequencing | Sequence numbers form contiguous integers $1..M$ | **PASS** |
| **T19** | Duplicate recovery idempotency | Idempotent re-execution creates no extra attempts | **PASS** |
| **T20** | Checkpoint without active action | Checkpoint persists with `null` action/attempt | **PASS** |
| **T21** | In-flight crashed attempt reconciliation | Marks crashed attempt `UNKNOWN`, preserves record | **PASS** |
| **T22** | Worker lease fencing preservation | Stale worker mutations rejected with `LeaseLostError` | **PASS** |
| **T23** | Contract binding restart durability | Contract binding & checkpoint survive store restart | **PASS** |
| **T24** | Multi-attempt recovery chain | Chain (Att 1 $\to$ Att 2 $\to$ Att 3) completes cleanly | **PASS** |

---

### 11. Phase 31 Regression Verification

- **Test Suite**: `tests/persistence/phase31-recovery-fencing.test.ts`
- **Results**: 18 passed / 0 failed (Duration: 889ms)
- **Verified Invariants**:
  - Deterministic multi-attempt recovery across Windows A–H.
  - Crash-safe attempt reconciliation with `MARK_UNKNOWN`.
  - Durable worker lease fencing under concurrent lease expiration.
  - Stale worker mutation rejection.

---

### 12. Phase 14 Regression Verification

- **Test Suite**: `tests/integration/phase14-independent-verification.test.ts`
- **Results**: 11 passed / 0 failed (Duration: 2.27s)
- **Verified Invariants**:
  - Clean-room baseline materialization.
  - Test file tampering fail-closed gating.
  - Zero-code mutation rejection.
  - Independent clean-room patch verification.

---

### 13. Full Integration Suite Results

- **Command**: `npx vitest run tests/integration/`
- **Summary**: 8 test files passed, 83 tests passed, 1 test skipped (live Ollama skipped), 0 failed.
- **Suites Verified**:
  - `live-local-governance-eval.test.ts` (17 tests | 1 skipped)
  - `phase13c-governed-recovery.test.ts` (8 tests)
  - `phase13b-completion-gate.test.ts` (9 tests)
  - `phase12-multi-step-governed-loop.test.ts` (10 tests)
  - `phase13-governed-coding-loop.test.ts` (11 tests)
  - `phase13d-verification-stage.test.ts` (12 tests)
  - `phase11-governed-tool-execution.test.ts` (6 tests)
  - `phase14-independent-verification.test.ts` (11 tests)

---

### 14. Phase 10H Artifact Invariant Verification

- **Command**: `npx tsx scripts/verify-phase10h-artifacts.ts`
- **Summary**: All 4 audit checks passed.
- **Key Metrics**:
  - 36/36 trial records intact.
  - Historical artifact SHA-256 byte-for-byte verified.
  - Valid tool input rate delta: $+77.8\%$ (Baseline $0.0\%$ vs Standardized $77.8\%$).

---

### 15. Hardware & Resource Footprint

- **Host Environment**: Intel Core i3-N305, 8 cores, 8 threads, ~7.6 GiB RAM, CPU-only.
- **Operating System**: Windows 11 Home (10.0.26100).
- **Execution Cost**: ₹0.
- **Memory Footprint**: SQLite database operating in WAL mode with connection-scoped sync transactions; peak Node.js memory $< 120$ MB.
- **External Calls**: 0 external API calls, 0 model downloads, 0 proprietary SDK dependencies.

---

### 16. Threat Model & Failure Modes Evaluated

| Threat / Failure Mode | Mitigating Architecture | Test Verification |
|---|---|---|
| Tampered contract spec or hash | Deterministic canonical JSON hash recalculation on load and recovery | `T2`, `T15` |
| Execution against revoked contract | Explicit status lifecycle check before checkpoint or attempt creation | `T3` |
| Split-brain supervisors | Single active lease invariant with expiration and optimistic check | `T6`, `T9`, `T12` |
| Stale supervisor recovering active run | Versioned lease fencing check in `recoverMission` | `T16` |
| Stale worker mutating recovered run | Supervisor updates run lease binding; old worker fails fencing | `T22` |
| Crashed worker leaving in-flight attempt | Idempotent reconciliation to `UNKNOWN` with attempt preservation | `T21`, `T24` |
| Partial recovery on database failure | SQLite `BEGIN IMMEDIATE` atomic transaction rollback | `T17` |
| Out-of-order checkpoint version replay | Monotonic sequence check (`checkpointVersion > max`) | `T5` |

---

### 17. Architectural Decisions & Boundaries

1. **Two-Tier Leasing Boundary**: Decoupling worker leases from supervisor leases preserves low-level action execution fencing while allowing high-level supervisor lifecycle governance.
2. **Deterministic Hash Identity**: Embedding `contentHash` in contract bindings ensures that contracts are tamper-evident at every layer of the persistence hierarchy.
3. **Audit History $\neq$ Current Authority**: Never mutating historical attempts ensures that evidence bundles accurately represent what occurred physically during earlier failed attempts.
4. **No Exactly-Once Physical Claim**: Recovery guarantees deterministic state machine transitions and fencing; it does not claim to prevent an un-fenced network or hardware process from physically running, but guarantees its outputs will be rejected upon presentation.

---

### 18. Known Limitations

1. **Single-Node SQLite WAL Boundary**: Supervisor leases and checkpoint persistence currently operate within a single shared SQLite instance. High-availability multi-node clustering would require distributed lock managers or shared block storage with file locks.
2. **Clock Skew Sensitivity**: Heartbeat expiration relies on system clock timestamps (`nowIso`). In multi-machine deployments, NTP drift could cause premature lease expiration or delayed fencing.
3. **Workspace Re-use Policy**: When Attempt $N+1$ is created, workspace cleanup or branch resetting depends on external workspace provider capabilities; in-progress modifications from a crashed worker may require git clean/checkout.

---

### 19. Recommended Next Phase

**Phase 33: Governed Clean-Room Replay & Evidence Bundle Provenance**
- Synthesize historical execution records (Attempts $1..N$), checkpoints, and contract bindings into an immutable, self-contained, cryptographically signed Evidence Bundle.
- Implement an offline deterministic replay engine that validates mission correctness from the committed evidence bundle without re-executing non-deterministic model inference.
