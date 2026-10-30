# Phase 33A — Existing Evidence Audit & Semantics Analysis
## Audit of Durable State, Invariants, and Provenance Foundation

---

### 1. What Data is Already Durable?

In the current Emerald Agent Fabric SQLite storage schema:
- **`tasks`**: `task_id`, `title`, `description`, `input_payload`, `created_at`, `updated_at`.
- **`runs`**: `run_id`, `task_id`, `status`, `idempotency_key`, `current_worker_id`, `lease_id`, `lease_expires_at`, `attempt_count`, `max_attempts`, `timeout_ms`, `result_payload`, `error_payload`, `version`, `contract_id`, `contract_version`, `contract_hash`, `max_output_bytes`, `created_at`, `updated_at`.
- **`run_events`**: `event_id`, `run_id`, `sequence` (1-indexed gapless integer), `timestamp`, `event_type`, `schema_version`, `producer`, `payload` (JSON string).
- **`mission_contracts`**: `contract_id`, `version`, `task_id`, `status`, `content_hash`, `canonical_spec` (canonical JSON), `created_at`, `activated_at`, `revoked_at`, `revocation_reason`.
- **`workers`**: `worker_id`, `hostname`, `pid`, `status`, `last_heartbeat_at`, `created_at`.
- **`leases`**: `lease_id`, `run_id`, `worker_id`, `acquired_at`, `expires_at`, `released_at`, `state`.
- **`supervisor_leases`**: `lease_id`, `run_id`, `supervisor_id`, `acquired_at`, `expires_at`, `released_at`, `state`.
- **`actions`**: `action_id`, `run_id`, `sequence_number`, `tool_name`, `status`, `idempotency_type`, `input_hash`, `input_payload`, `result_payload`, `error_payload`, `contract_id`, `contract_version`, `contract_hash`, `active_attempt_number`, `total_attempts`, `max_attempts`, `created_at`, `updated_at`, `completed_at`.
- **`attempts`**: `attempt_id`, `action_id`, `run_id`, `attempt_number`, `worker_id`, `lease_id`, `status`, `idempotency_token`, `started_at`, `completed_at`, `duration_ms`, `exit_code`, `output_payload`, `error_payload`, `evidence_ids` (comma-delimited), `provider_metadata`.
- **`mission_checkpoints`**: `checkpoint_id`, `run_id`, `checkpoint_version`, `contract_id`, `contract_version`, `contract_hash`, `action_id`, `attempt_number`, `durable_state` (JSON string), `event_sequence`, `created_at`, `updated_at`.

---

### 2. What is Authoritative?

- **The relational state store and event log** are authoritative for all execution lifecycle state.
- **Model proposals are untrusted**: `isGoalReached: true` emitted by an LLM is strictly an untrusted proposal. It has zero authority to mark a mission completed without satisfying contract verification gates.
- **Worker leases and supervisor leases**: Authority to perform mutations requires holding an active, unexpired lease matching the run's current lease binding.
- **Contract specification**: `MissionContractSpec` with its cryptographic `contentHash` defines authoritative policy, tool permissions, and verification requirements.

---

### 3. Which Records are Immutable?

- **`run_events`**: Append-only log. Events once committed are never updated or deleted.
- **`mission_contracts.canonical_spec` & `content_hash`**: Immutable for a given `(contract_id, version)`. Only status transitions (`DRAFT` $\to$ `ACTIVE` $\to$ `REVOKED`) are recorded in lifecycle columns.
- **Completed or Reconciled `attempts`**: Attempt records for prior attempts ($1..N-1$) are permanently frozen in terminal states (`SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `UNKNOWN`).
- **`mission_checkpoints`**: Append-only records with strictly monotonic `checkpoint_version`. Checkpoints are never updated in place.
- **Domain `Evidence`**: Content-hashed with SHA-256 and deep-frozen upon instantiation.

---

### 4. Which Records are Mutable State Projections?

- **`runs`**: Current state row tracking current lifecycle status, current lease, current worker, version counter, and result/error payloads.
- **`actions`**: Current status transitions (`CREATED` $\to$ `AUTHORIZED` $\to$ `RETRYING` $\to$ `SUCCEEDED`/`FAILED`).
- **`leases` & `supervisor_leases`**: State transitions (`ACTIVE` $\to$ `EXPIRED`/`RELEASED`) and expiration timestamp extensions.
- **`workers`**: Heartbeat updates and status flags.

---

### 5. Which Events are Sufficient to Reconstruct State?

The sequence of typed domain events in `run_events` contains the complete operational history:
- `run.created`: Initial run parameters, bounds, contract binding.
- `run.queued`: Queue placement.
- `worker.claimed`: Lease acquisition by worker.
- `run.started`: Transition to running state.
- `action.created` / `action.authorized`: Tool proposal registration and governance approval.
- `attempt.created` / `attempt.dispatched` / `attempt.started` / `attempt.completed` / `attempt.failed` / `attempt.unknown`: Attempt lifecycle and execution results.
- `evidence.recorded`: Content-hashed observation artifacts.
- `verification.completed`: Independent or physical verification evaluation.
- `run.recovered`: Supervisor lease re-binding and crash recovery.
- `run.completed` / `run.failed`: Terminal run transition.

---

### 6. Which Evidence Exists Outside Events?

- **Physical repository files and disk workspace**: Workspace contents and filesystem modifications.
- **Raw candidate patch diffs**: Clean-room verification diffs generated during completion checks.
- **External OS process execution**: Exit codes, stdout, and stderr produced by external tools before being captured into attempt output payloads.
- **Summary**: All cryptographically relevant digests of these external artifacts are captured into `attempts.output_payload`, `actions.result_payload`, `evidence.contentHash`, and `verification.completed` event payloads.

---

### 7. Which Fields Require Canonical Serialization?

To achieve deterministic hashing:
- All keys must be sorted lexicographically at every nesting depth.
- Arrays must retain their semantic order (or sorted if representing sets, e.g. `evidenceIds` or `credentialScopes`).
- `undefined`, functions, and non-JSON values must be omitted.
- Numbers must serialize consistently without floating-point formatting drift.
- Explicit `null` handling must be preserved.
- The repository's `canonicalJsonStringify()` utility in `src/domain/canonical-hash.ts` already implements this standard.

---

### 8. Which Hashes Already Exist?

1. `contract.contentHash`: SHA-256 of canonical redacted `MissionContractSpec`.
2. `action.inputHash`: SHA-256 of canonical redacted input payload.
3. `evidence.contentHash`: SHA-256 of canonical redacted raw evidence content.
4. `attempt.idempotencyToken`: Deterministic identifier combining `runId`, `actionId`, and `attemptNumber`.
5. `patchDigest`: SHA-256 digest of clean-room patch diff in Phase 14 verification.

---

### 9. Which Hashes Need to be Added?

1. **Event Hash Chain (`eventHash` / `previousEventHash`)**:
   Chains every event $1..M$ to its immediate predecessor, binding sequence, timestamp, type, producer, and payload:
   $$H_0 = \text{sha256Hex}(\text{"genesis:"} + \text{runId})$$
   $$H_i = \text{sha256Hex}(\text{canonicalJsonStringify}(\{ \text{sequence}, \text{eventId}, \text{eventType}, \text{timestamp}, \text{producer}, \text{payload}, \text{previousEventHash}: H_{i-1} \}))$$
2. **Subsystem Roots**:
   - `contractHash`: The bound contract content hash.
   - `eventRoot`: The final event hash $H_M$.
   - `checkpointRoot`: SHA-256 of canonical checkpoints array.
   - `attemptRoot`: SHA-256 of canonical attempts array.
   - `verificationRoot`: SHA-256 of canonical verification evidence items.
3. **`provenanceRoot`**:
   $$\text{provenanceRoot} = \text{sha256Hex}(\text{canonicalJsonStringify}(\{ \text{contractHash}, \text{eventRoot}, \text{checkpointRoot}, \text{attemptRoot}, \text{verificationRoot} \}))$$
4. **`bundleId`**:
   $$\text{bundleId} = \text{sha256Hex}(\text{canonicalJsonStringify}(\text{bundle content excluding bundleId}))$$

---

### 10. Can Replay Reconstruct Authoritative State Without Executing Tools?

**YES**.
- The replay engine is pure and deterministic:
  - Validates schema versions and recomputes `bundleId`.
  - Re-verifies `contract.contentHash` from `contract.spec`.
  - Re-computes the entire event hash chain and verifies sequence continuity ($1..M$).
  - Reconstructs action and attempt state machines from the event log and verifies attempt monotonicity.
  - Re-evaluates verification specs against bundled evidence records via `DeterministicVerifier`.
  - Derives the fourfold completion components (`TaskSatisfied`, `VerificationPassed`, `PolicySatisfied`, `EvidenceComplete`) and terminal state (`COMPLETED` or `FAILED`).
- Replay requires **zero network, zero Ollama, zero shell execution, and zero database access**.
