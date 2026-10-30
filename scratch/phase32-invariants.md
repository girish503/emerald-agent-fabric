# Phase 32B: Mission Contract Checkpointing & Supervisor Heartbeat Invariants

## 1. Scope and Core Guarantee

Emerald Agent Fabric enforces strict distributed-style execution correctness within its durable state boundary:
> **A multi-attempt mission survives worker and supervisor crashes by restoring state strictly from the last durable checkpoint, preserving exact contract binding and historical attempt immutability, while enforcing supervisor lease fencing and gapless event sequencing.**

No speculative in-memory state becomes authoritative. No stale supervisor or worker can mutate durable state after lease expiration or reassignment.

---

## 2. Formal Invariants Specification

### Contract Invariants

#### C1 — Exact Contract Binding
A `RUNNING` or `RECOVERING` mission must remain bound to the exact triple:
$$\text{ContractBinding} = \langle \text{contractId}, \text{version}, \text{contentHash} \rangle$$
A recovery operation MUST NOT re-resolve or substitute the latest contract version from the task or catalog. Attempt $N+1$ and all recovered actions inherit the exact contract binding recorded at mission inception.

#### C2 — Contract Integrity
Prior to executing recovery or state advancement, the canonical hash of the persisted `MissionContractSpec` must be recomputed and compared against the recorded `contentHash`:
$$\text{computeCanonicalHash}(\text{contract.spec}) = \text{contract.contentHash} = \text{run.contractBinding.contentHash}$$
Any discrepancy MUST immediately fail closed with `ContractIntegrityError` (code `CONTRACT_INTEGRITY_MISMATCH`).

#### C3 — Contract Revocation
A contract in status `REVOKED` is strictly forbidden from authorizing new actions, attempts, or run recoveries. Historical evidence generated prior to revocation remains permanently valid and inspectable. Recovery attempted against a revoked contract MUST fail closed with error code `CONTRACT_REVOKED`.

---

### Checkpoint Invariants

#### CP1 — Durable Checkpoint Boundary
A `MissionCheckpoint` represents an authoritative, durable state boundary. It captures:
- `runId`: Bound mission run.
- `checkpointVersion`: Positive integer ($1, 2, 3, \dots$).
- `contractId`, `contractVersion`, `contractHash`: Exact bound contract identity.
- `actionId`: Logical action associated with the checkpoint (if applicable).
- `attemptNumber`: Authoritative attempt number active or completed at the boundary.
- `durableState`: Formal JSON payload of the verified checkpoint state.
- `eventSequence`: Event sequence number committed at or before this checkpoint.
- `createdAt`, `updatedAt`: ISO timestamps.

A checkpoint MUST NOT claim an action or attempt succeeded merely because a worker initiated or attempted it; success requires verified completion.

#### CP2 — Monotonic Checkpoints
Checkpoint versions must form a strictly increasing sequence per run:
$$\text{Checkpoint}_1, \text{Checkpoint}_2, \dots, \text{Checkpoint}_K \quad (v_K > v_{K-1})$$
An older checkpoint version MUST NOT overwrite or supersede a newer checkpoint. Enforced via SQLite unique constraint `UNIQUE(run_id, checkpoint_version)` and transaction-level monotonicity checks.

#### CP3 — Atomic Checkpoint
The creation or update of a `MissionCheckpoint` and its corresponding domain event / state transition must occur within the same immediate transaction (`BEGIN IMMEDIATE`):
$$\text{Atomic}(\text{Transition}, \text{Event Append}, \text{Checkpoint Persist})$$
State must never be left in a condition where a checkpoint exists without its underlying domain event, or an event exists without its corresponding checkpoint record.

#### CP4 — Recovery From Last Durable Checkpoint
When recovering after a worker crash, supervisor crash, or node restart, the system must restore state exclusively from the latest persisted `MissionCheckpoint` and authoritative attempt records in SQLite. All uncommitted or speculative in-memory state is discarded.

---

### Supervisor Invariants

#### S1 — Supervisor Identity
Every supervisor instance must have a unique, durable identifier (`supervisorId`, e.g. `supervisor-A`, `supervisor-B`).

#### S2 — Supervisor Lease
A supervisor may act as the authoritative recovery coordinator for a mission only while holding an `ACTIVE` supervisor lease:
$$\text{SupervisorLease} = \langle \text{leaseId}, \text{runId}, \text{supervisorId}, \text{acquiredAt}, \text{expiresAt}, \text{state} \rangle$$
Recovery operations attempted without an active lease must be rejected.

#### S3 — Supervisor Fencing
A stale supervisor must never successfully commit recovery transitions after:
- Its lease has expired (`nowIso >= expiresAt`).
- Its lease has been taken over by another supervisor.
- Its `supervisorId` or `leaseId` fails to match the authoritative active lease on the run.

Stale supervisor mutations must be rejected with `SupervisorLeaseExpiredError` or `SupervisorLeaseLostError`.

#### S4 — Single Authoritative Recovery
When two supervisors race to recover the same crashed or expired mission, exactly one supervisor may acquire the lease and commit the recovery transition. The losing supervisor's transaction must roll back cleanly without mutating state or introducing event gaps.

#### S5 — Supervisor Heartbeat
A supervisor heartbeat extends lease validity if and only if:
1. `lease.supervisorId === request.supervisorId`
2. `lease.leaseId === request.leaseId`
3. `lease.state === 'ACTIVE'`
4. `request.nowIso < lease.expiresAt` (the lease has NOT already expired)

An expired lease cannot be resurrected via heartbeat; it must be reclaimed through the formal acquisition process.

---

### Multi-Attempt Invariants

#### A1 — Attempt $N$ Immutability
When Attempt $N$ terminates (due to `FAILED`, `TIMED_OUT`, `CANCELLED`, or `UNKNOWN`), its record is frozen. Recovery creates Attempt $N+1$; it never rewrites, modifies, or deletes Attempt $N$.

#### A2 — Attempt $N+1$ Identity & Monotonicity
Attempt $N+1$ must have:
- A new UUIDv4 `attemptId`
- The same `actionId` and `runId`
- `attemptNumber = N + 1`
- A newly assigned worker ID and worker lease ID
- An idempotency token matching `${runId}:${actionId}:${N+1}`

Attempt numbers must never skip (e.g. Attempt 3 without Attempt 2) or duplicate.

#### A3 — Contract Continuity
Attempt $N+1$ inherits the exact `ContractBinding` from the parent run and Action. It cannot be rebound to a different contract.

---

### Event Invariants

#### E1 — Gapless Sequencing
Authoritative domain events committed during checkpoints and recoveries must maintain strictly contiguous, gapless sequence numbers ($1, 2, 3, \dots$).

#### E2 — Rollback on Rejection
Any rejected supervisor operation (due to fencing, contract mismatch, or concurrency conflict) must roll back the SQLite transaction completely. No partial events or sequence gaps may be leaked.

#### E3 — Transactional Atomicity
All validations (supervisor lease, contract binding, hash integrity, checkpoint version, attempt state), state transitions, event appends, and checkpoint updates must execute inside a single `BEGIN IMMEDIATE ... COMMIT` block.
