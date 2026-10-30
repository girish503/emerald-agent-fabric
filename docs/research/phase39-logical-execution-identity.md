# Phase 39 — Logical Execution Identity & Terminal Export Fencing

**Status**: Verified & Complete  
**Date**: 2026-10-18  
**Evaluation Scope**: Attack Matrix (L1–L16), Research Questions (R1–R12), Candidate Architectures (A–F)  
**Primary Outcome**: `PHASE39_STATUS: ARCHITECTURAL_GAP_CONFIRMED`  
**Recommended Identity Model**: `RECOMMENDED_IDENTITY_MODEL: OPTION_D_AUTHORITATIVE_TERMINAL_RECORD_INDEX`  
**Required Invariant**: `Invariant B: A run may have multiple immutable evidence snapshots, but at most one authoritative terminal record.`  
**Implementation Boundary**: `EvidenceArchivePort & FileSystemEvidenceArchive (Ingestion Boundary)`  
**Next Phase**: `Phase 40 — Authoritative Terminal Record Index Implementation`  
**Baseline Commit**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`  

---

## 1. Research Question

Phase 38 uncovered an architectural phenomenon termed `F22 LOGICAL_IDENTITY_GAP`:
Because Emerald's evidence archive is content-addressed:
$$\text{bundleId} = \text{SHA-256}(\text{CanonicalJson}(\text{EvidenceBundleContent}))$$
multiple structurally distinct evidence bundles can share the same logical `runId = X` while possessing distinct `bundleId`s, distinct export timestamps, distinct checkpoints, and even contradictory terminal states.

The central research question of Phase 39 is:
> **What is the authoritative identity of a logical Emerald execution, and where must Emerald prevent contradictory terminal outcomes from becoming accepted without destroying legitimate historical evidence?**

This evaluation rigorously analyzes whether the governing invariant belongs at:
1. The SQLite run lifecycle
2. The supervisor checkpoint lifecycle
3. The coordinator terminal transition
4. The evidence exporter
5. The ingestion gateway & evidence archive
6. A combination of distinct architectural layers.

---

## 2. Current Identity Model

The Emerald Agent Fabric architecture decomposes execution into nine distinct identity scopes:

| Identity Scope | Concrete Example | Immutable? | Scope Boundary | Current Authoritative Source |
|---|---|---|---|---|
| **missionId** | `task-p39-main` | **Yes** | Task Specification | `MissionContract` spec / User goal declaration |
| **runId** | `run-p39-main` | **Yes** | Logical Execution Lifecycle | SQLite `runs` table / `RunCoordinator` state machine |
| **actionId** | `act-p39-1` | **Yes** | Logical Action Sequence | Action Domain Model (`sequenceNumber: 1, 2...`) |
| **attemptId** | `att-p39-1` | **Yes** | Physical Execution Attempt | Attempt Domain Model (`attemptNumber: 1, 2...`, Worker Lease) |
| **checkpoint** | `checkpointVersion: 2` | **Yes** | Supervisor Recovery State | Supervisor Lease / SQLite `mission_checkpoints` table |
| **bundleId** | `4a71b...64hex` | **Yes** | Exact Evidence Bytes | SHA-256 of Canonical JSON `EvidenceBundleContent` |
| **provenanceRoot** | `8f3c...64hex` | **Yes** | Subsystem Merkle Chain | Merkle Root (Contract, Events, Checkpoints, Attempts, Verification) |
| **terminalState** | `status: COMPLETED` | **Yes** | Completion Evaluation | Run State Machine + Independent Verification Witness |
| **authorityIdentity** | `WORKER_PRODUCER` | **Yes** | Cryptographic Endorsement | `TrustedKeyring` / Asymmetric Ed25519 Public Key Quorum |

---

## 3. runId Semantics

Empirical analysis of `src/domain/run.ts`, `src/application/run-coordinator.ts`, and `src/adapters/persistence/sqlite-state-store.ts` demonstrates:
- `runId` represents a **single logical execution lifecycle** of a task under a specific bound contract.
- In the primary runtime database, a run transitions through explicit lifecycle states:
  $$\text{CREATED} \to \text{QUEUED} \to \text{LEASED} \to \text{RUNNING} \to \text{VERIFYING} \to \text{COMPLETED} \mid \text{FAILED} \mid \text{CANCELLED} \mid \text{TIMED\_OUT}$$
- **Local Finality**: In SQLite, terminal states are strictly final. Once a run transitions to `COMPLETED` or `FAILED`, all subsequent transitions are rejected (Scenario L9).
- However, `runId` is **not** an evidence identifier. A single `runId` may be observed, checkpointed, and exported at multiple points across its duration.

---

## 4. bundleId Semantics

Empirical analysis of `src/domain/evidence-bundle.ts` and `src/application/evidence-exporter.ts` demonstrates:
- `bundleId` represents **content identity**:
  $$\text{bundleId} = \text{SHA-256}(\text{CanonicalJson}(\text{content}))$$
  where `content` includes all state, contract, checkpoints, events, actions, attempts, supervisor leases, verification results, and provenance metadata (`exportedAt`, `exporterVersion`).
- Because `exportedAt` is part of the canonical payload, two exports of the exact same database state performed at different seconds yield **distinct `bundleId`s**.
- `bundleId` guarantees **tamper evidence of the snapshot bytes**, but possesses zero knowledge of logical run uniqueness.

---

## 5. Checkpoint Semantics

- Phase 32 introduced monotonic supervisor checkpoints (`checkpointVersion: 1, 2, 3...`).
- A checkpoint captures the durable recovery state of a run at a specific logical point in time.
- Multiple checkpoints for a single `runId` are expected, legitimate, and essential for crash recovery (Phase 31/32).

---

## 6. Terminal State Semantics

- A run's `terminalState` is the durable conclusion of the mission: `COMPLETED`, `FAILED`, `CANCELLED`, or `TIMED_OUT`.
- In Emerald's fourfold evaluation model, `COMPLETED` requires:
  1. `taskSatisfied: true`
  2. `verificationPassed: true`
  3. `policySatisfied: true`
  4. `evidenceComplete: true`
- A single run cannot legitimately succeed and fail simultaneously.

---

## 7. Evidence Snapshot Semantics

Is an `EvidenceBundle` an execution itself, or a snapshot of an execution?
- **Conclusion**: An `EvidenceBundle` is an **immutable, self-contained snapshot** of an execution trace.
- Intermediate evidence bundles exported during a run (e.g. after Checkpoint 1) represent valid, observable records of progress.
- Conflating an evidence bundle with the logical execution itself would forbid intermediate progress auditing.

---

## 8. Attack Matrix (L1–L16 Evaluation)

The 16 attack and failure scenarios were implemented and executed in `tests/integration/phase39-logical-execution-identity.test.ts`:

| Test ID | Injection Scenario | Setup & Capabilities | Observed Result | Classification | Security Impact |
|---|---|---|---|---|---|
| **L1** | Two Valid Terminal Bundles | Same `runId`, both `COMPLETED`, different export times | Both accepted into `archive/accepted/` | `DEMONSTRATED` | Multiple certificates exist for 1 run |
| **L2** | Contradictory Terminal Outcomes | Same `runId`, one `COMPLETED`, one `FAILED` (both 2-of-3 valid) | Both accepted into `archive/accepted/` | `ARCHITECTURAL_GAP` | **Decisive Gap**: Conflicting outcomes accepted |
| **L3** | Reverse Checkpoint Ingestion | Newer Checkpoint 2 ingested, followed by older Checkpoint 1 | Both accepted into `archive/accepted/` | `DEMONSTRATED` | Older evidence accepted post-newer |
| **L4** | Terminal Followed by Non-Terminal | `COMPLETED` bundle ingested, then `RUNNING` snapshot ingested | Both accepted into `archive/accepted/` | `DEMONSTRATED` | Terminal state does not seal archive |
| **L5** | Non-Terminal Followed by Terminal | `RUNNING` snapshot ingested, then `COMPLETED` bundle ingested | Both accepted into `archive/accepted/` | `DEMONSTRATED` | Legitimate progression supported |
| **L6** | Duplicate Terminal Ingestion | Exact identical `bundleId` submitted twice | Second returns `DUPLICATE` | `EXPECTED` | Content idempotency intact |
| **L7** | Crash Recovery Re-Exports | Pre-recovery and post-recovery terminal bundles exported | Both accepted into `archive/accepted/` | `DEMONSTRATED` | Recovery generates distinct bundles |
| **L8** | Multi-Supervisor Conflict | Two supervisors endorse separate bundles for same `runId` | Both accepted under 2-of-3 threshold | `DEMONSTRATED` | Threshold signing lacks cross-bundle lock |
| **L9** | Post-Terminal Retry in Store | Worker attempts transition on terminal run in SQLite | Rejected by SQLite state machine | `EXPECTED` | SQLite enforces terminal finality |
| **L10** | Stale Worker Submits Evidence | Stale worker signs bundle without supervisor endorsement | Quarantined (`INSUFFICIENT_AUTHORITIES`) | `EXPECTED` | Threshold rejects 1-of-3 |
| **L11** | Quorum on Stale Snapshot | Valid 2-of-3 quorum signs older Checkpoint 1 snapshot | Accepted into `archive/accepted/` | `DEMONSTRATED` | Signatures bind bytes, not freshness |
| **L12** | Quorum on Conflicting Outcomes | Valid 2-of-3 quorum signs `COMPLETED` and `FAILED` bundles | Both accepted into `archive/accepted/` | `ARCHITECTURAL_GAP` | Quorum does not solve semantic conflict |
| **L13** | Mutated Contract Content Hash | Bundle claiming `runId` has tampered `contractHash` | Quarantined (`CONTRACT_INTEGRITY_FAILURE`) | `EXPECTED` | Contract continuity enforced |
| **L14** | Mutated Contract Version | Bundle claiming `runId` has tampered `spec.version` | Quarantined (`CONTRACT_INTEGRITY_FAILURE`) | `EXPECTED` | Contract version binding enforced |
| **L15** | Mutated Provenance Root | Bundle has tampered Merkle `provenanceRoot` | Quarantined (`INVALID_PROVENANCE_ROOT`) | `EXPECTED` | Provenance tree enforced |
| **L16** | Failed Verification Witness | Attempt exitCode 1 but terminalState claims `COMPLETED` | Quarantined (`REPLAY_VERIFICATION_FAILURE`) | `EXPECTED` | Fourfold replay derivation enforced |

---

## 9. Contradictory Terminal Evidence (Deep Dive on L2)

Scenario **L2** is the decisive exploitability demonstration:
1. Producer executes `run-p39-main`.
2. Bundle A is exported with `terminalState.status = "COMPLETED"`, exit code 0, passing clean-room dual-gate verification.
3. Bundle A is signed by `WORKER_PRODUCER` and `SUPERVISOR` (2-of-3 threshold satisfied).
4. Bundle B is constructed claiming the exact same `runId = "run-p39-main"`, but with `terminalState.status = "FAILED"`, exit code 1.
5. Bundle B is signed by `WORKER_PRODUCER` and `SUPERVISOR` (2-of-3 threshold satisfied).
6. Gateway evaluates Bundle A:
   - Schema valid
   - Signatures valid
   - Threshold satisfied (2 distinct trusted authorities)
   - Replay valid (derives `COMPLETED`)
   - Outcome: **`ACCEPTED`** $\to$ stored in `archive/accepted/{bundleId_A}.json`.
7. Gateway evaluates Bundle B:
   - Schema valid
   - Signatures valid
   - Threshold satisfied (2 distinct trusted authorities)
   - Replay valid (derives `FAILED`)
   - Outcome: **`ACCEPTED`** $\to$ stored in `archive/accepted/{bundleId_B}.json`.

**The Breach**: An air-gapped downstream auditor querying the archive for `run-p39-main` finds **two cryptographically authenticated, replay-valid certificates that directly contradict each other**. Content addressing alone cannot detect or prevent this contradiction.

---

## 10. Recovery Interaction (L7 & L8)

In crash recovery:
- Worker 1 executes Attempt 1 and crashes.
- Supervisor recovers the run, marks Attempt 1 as `UNKNOWN`, and assigns Attempt 2 to Worker 2.
- If Worker 1 recovers independently and attempts to complete the run in SQLite, Phase 31 lease fencing rejects Worker 1.
- However, if Worker 1 had already exported and signed an evidence bundle locally prior to crashing, and the Supervisor later exports and signs a recovered evidence bundle, both bundles may cross the ingestion boundary into the archive.
- The evidence archive must be able to recognize which terminal certificate is authoritative.

---

## 11. Candidate Architecture A: Strict runId Uniqueness in Archive

- **Model**: `archive.hasAcceptedRun(runId)` rejects any incoming bundle if `runId` already exists in `archive/accepted/`.
- **Safety**: Prevents conflicting terminal bundles.
- **Flaw**: **Destroys multi-checkpoint auditing**. If an intermediate snapshot (Checkpoint 1) is archived during execution, the final terminal bundle (Checkpoint 2, `COMPLETED`) is rejected as a duplicate run!
- **Verdict**: **`FAIL`** (Breaks liveness and intermediate monitoring).

---

## 12. Candidate Architecture B: runId + Terminal Outcome Uniqueness

- **Model**: Allow unlimited non-terminal evidence bundles (`terminalState.status in ["CREATED", "RUNNING", "VERIFYING"]`), but permit at most one terminal bundle (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) per `runId`.
- **Safety**: Prevents contradictory terminal certificates.
- **Tradeoff**: Does not define how crash-recovered terminal certificates or idempotent re-exports with different timestamps should be indexed.
- **Verdict**: **`TRADEOFF`**.

---

## 13. Candidate Architecture C: Monotonic Terminal Sequence

- **Model**: Introduce a `terminalSequence: number` in the bundle terminal state.
- **Analysis**: Unnecessary conceptual overhead. Emerald's run lifecycle in SQLite is strictly terminal; runs do not transition through multiple terminal sequences.
- **Verdict**: **`TRADEOFF`** (Unjustified complexity).

---

## 14. Candidate Architecture D: Authoritative Terminal Record Index

- **Model**:
  Two distinct indices at the archival boundary:
  ```text
  1. Content-Addressed Evidence Store (Existing):
     archive/accepted/{bundleId}.json
     -> Stores ALL valid, tamper-evident evidence snapshots (intermediate + terminal).
     -> Guarantees byte-level immutability and offline replay.

  2. Authoritative Terminal Record Index (New):
     archive/runs/{runId}/terminal.json
     -> Records:
        {
          "runId": "run-p39-main",
          "terminalOutcome": "COMPLETED",
          "authoritativeBundleId": "4a71b...64hex",
          "recordedAt": "2026-10-18T12:05:00.000Z"
        }
  ```
- **Ingestion Policy**:
  1. Bundle is verified (schema, secret scan, signatures, threshold, replay).
  2. If valid, bundle bytes are stored in `archive/accepted/{bundleId}.json`.
  3. If bundle is terminal:
     - Check `archive/runs/{runId}/terminal.json`.
     - If no terminal record exists $\to$ create it.
     - If terminal record exists with identical `bundleId` $\to$ return `ALREADY_ARCHIVED` / `DUPLICATE`.
     - If terminal record exists with different `bundleId` or conflicting outcome $\to$ quarantine bundle with `TERMINAL_RECORD_CONFLICT` or `DUPLICATE_TERMINAL_REJECTED`.
- **Verdict**: **`PASS`** (Cleanest separation of content identity and logical execution identity).

---

## 15. Candidate Architecture E: Producer Terminal Export Fencing

- **Model**: The producing SQLite database records an authoritative export lease or token when exporting.
- **Analysis**: Protects against duplicate local exports, but completely fails to protect untrusted cross-host ingestion gateways when an adversary constructs synthetic evidence bundles offline. The gateway must be self-protecting.
- **Verdict**: **`TRADEOFF`**.

---

## 16. Candidate Architecture F: Checkpoint-Bound Evidence

- **Model**: Index evidence by `(runId, checkpointVersion)`.
- **Analysis**: Allows intermediate checkpoints, but fails if two contradictory terminal bundles claim the same terminal `checkpointVersion`.
- **Verdict**: **`TRADEOFF`**.

---

## 17. Security Comparison

| Threat Vector | Pure Content-Addressing (Current) | Option A (runId Unique) | Option D (Authoritative Terminal Record) |
|---|---|---|---|
| **Contradictory Terminal Outcomes (L2)** | **Vulnerable** (Both accepted) | Blocked (Second rejected) | **Blocked** (`TERMINAL_RECORD_CONFLICT`) |
| **Intermediate Checkpoint Auditing (L3-L5)**| **Supported** | Broken (Blocks terminal) | **Supported** (All snapshots preserved) |
| **Idempotent Re-Ingestion (L6)** | Supported (`DUPLICATE`) | Supported | **Supported** |
| **Forensic Preservation of Conflicting Data** | Preserved in accepted archive | Lost / Rejected | **Preserved in Quarantine with Manifest** |
| **Offline Air-Gapped Verification** | Supported | Supported | **Supported** |

---

## 18. Liveness Comparison

- **Option A**: Catastrophic liveness failure for multi-stage tasks. A system monitoring long-running runs cannot ingest intermediate telemetry without breaking the final completion export.
- **Option D**: Zero impact on liveness. Intermediate snapshots flow freely; only contradictory terminal outcomes are fenced.

---

## 19. Historical Evidence Comparison

- In Option D, historical evidence bytes remain permanently queryable by content address (`bundleId`).
- Auditors can retrieve the exact intermediate snapshots and the authoritative terminal certificate independently.

---

## 20. Recommended Identity Model

Emerald must adopt **Option D (Authoritative Terminal Record Index)**:

```text
======================= LOGICAL EXECUTION IDENTITY LAYER =======================
                                   runId
                                     │
                                     ▼
                      [Authoritative Terminal Record]
                     archive/runs/{runId}/terminal.json
                     - terminalOutcome: COMPLETED | FAILED | ...
                     - authoritativeBundleId: <bundleId>
                     - authorityQuorum: 2-of-3
                                     │
                                     ▼
======================= CONTENT-ADDRESSED EVIDENCE LAYER =======================
                                 bundleId
                                     │
                                     ▼
                           [EvidenceBundle.json]
                     archive/accepted/{bundleId}.json
                     - Exact immutable bytes
                     - Verified signatures
                     - Offline deterministic replay
```

---

## 21. Required Invariants

1. **Content Address Immutability Invariant**: Every accepted evidence bundle is keyed and verified strictly by `bundleId = SHA-256(canonical(bundle))`.
2. **Snapshot Coexistence Invariant**: A run may produce multiple valid non-terminal evidence bundles without mutual exclusion.
3. **Authoritative Terminal Finality Invariant (`Invariant B`)**: A logical `runId` may possess at most one authoritative terminal record in the evidence archive. Any subsequent bundle claiming a contradictory or divergent terminal outcome for the same `runId` must be quarantined with `TERMINAL_RECORD_CONFLICT`.
4. **Idempotent Terminal Ingestion Invariant**: Re-ingesting an identical terminal bundle for an established terminal record must return `ALREADY_ARCHIVED` without error or mutation.

---

## 22. Implementation Boundary

The boundary for enforcing logical execution identity is:
- **Port**: `EvidenceArchivePort` (extending interface with `hasTerminalRecord(runId)`, `getTerminalRecord(runId)`, `storeTerminalRecord(record)`).
- **Adapter**: `FileSystemEvidenceArchive` (maintaining `archive/runs/{runId}/terminal.json`).
- **Application**: `EvidenceIngestionGateway` (evaluating terminal conflict before committing to accepted archive).
- **Core Runtime**: Remains **completely unmodified**. The SQLite state machine and leasing mechanisms remain decoupled from archival indexing.

---

## 23. Regression Results

### Phase 39 Test Execution
- **Test File**: `tests/integration/phase39-logical-execution-identity.test.ts`
- **Total Tests**: **24**
- **Passed**: **24 (100%)**
- **Failed**: **0**
- **Duration**: **1.36 seconds**

### Core Historical Regressions
- `phase38-authority-composition.test.ts`: **30/30 Passed**
- `phase37-threshold-signing.test.ts`: **38/38 Passed**
- `phase36-multi-authority-security.test.ts`: **32/32 Passed**
- `phase35-signature-authority.test.ts`: **30/30 Passed**
- `phase34-evidence-ingestion.test.ts`: **28/28 Passed**
- `phase33-evidence-replay.test.ts`: **23/23 Passed**
- `phase32-contract-checkpoint-supervisor.test.ts`: **24/24 Passed**
- `phase31-recovery-fencing.test.ts`: **18/18 Passed**
- `phase14-independent-verification.test.ts`: **11/11 Passed**
- **Phase 10H Verification Artifact Audit**: **36/36 Verified**
- **Static Typecheck (`tsc --noEmit`)**: **0 Errors**

---

## 24. Final Decision

```text
PHASE39_STATUS: ARCHITECTURAL_GAP_CONFIRMED
```

```text
RECOMMENDED_IDENTITY_MODEL: OPTION_D_AUTHORITATIVE_TERMINAL_RECORD_INDEX
```

```text
REQUIRED_INVARIANT: Invariant B — A run may have multiple immutable evidence snapshots, but at most one authoritative terminal record.
```

```text
IMPLEMENTATION_BOUNDARY: EvidenceArchivePort & FileSystemEvidenceArchive (Ingestion Boundary)
```

```text
NEXT_PHASE: Phase 40 — Authoritative Terminal Record Index Implementation
```
