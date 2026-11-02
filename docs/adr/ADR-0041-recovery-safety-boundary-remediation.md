# ADR-0041: Recovery Safety Boundary Remediation: Direct Invocations, Durable Quarantine, and Fenced Re-Execution

## 1. Status
- **Status**: ACCEPTED.
- **Date**: 2026-11-01
- **Relates to**: ADR-0036 (crash recovery and workspace ownership), ADR-0037 (tenant quiescence before workspace mutation), ADR-0038 (close late-start race with coordination gate), ADR-0040 (Docker create/start split)
- **Not a claim**: This design does not claim to replace external process orchestrators or implement distributed Paxos/Raft; it establishes durable fail-closed safety invariants across worker and recovery processes interacting through SQLite in WAL mode on a local host.

---

## 2. Context & Problem Statement

Following the live Docker rehearsal in Milestone 2.4A.7, an adversarial architecture review (Milestone 2.4A.8) uncovered three critical safety boundary vulnerabilities in the execution-quiescence coordination contract:

1. **Direct Invocation Vulnerability in `RetryCoordinator.recoverExpiredRuns` (Finding C-01)**:
   `RecoverySweeper.sweep()` coordinated with `TenantQuiescenceGate` before calling retry/recovery. However, `RetryCoordinator.recoverExpiredRuns` was exposed as a public service method on `RunCoordinator`. If invoked directly (by an external controller, scheduler, CLI command, or maintenance job), it expired leases, cleaned up workspaces (`cleanupCrashedWorkspace`), and requeued runs without asserting that tenant execution was quiescent. A live background container could thus be actively writing to the workspace while recovery erased files or a subsequent attempt started.

2. **Direct Invocation Vulnerability in `RecoverySupervisor.scanAndRecover` (Finding H-01)**:
   `RecoverySupervisor` was intended to roll back partial or uncommitted filesystem mutations. If `scanAndRecover()` or `recoverRun()` was called directly without establishing execution quiescence, the rollback engine would revert file digests on disk while the prior container might still be executing, corrupting both the active execution and the rollback ledger.

3. **Quarantine Gap & Premature Gate Release after `TERMINATION_UNVERIFIED` (Finding M-01)**:
   When `DockerExecutionProvider` encountered an unverified termination (e.g., Docker daemon failure, CLI crash, or query failure), `WorkerRuntime` released the per-run launch gate in its `finally` block. Because the gate was marked `RELEASED`, a subsequent worker or retry sweep could immediately acquire execution authorization and launch another container for that run—violating mutual exclusion and risking concurrent execution across attempts against the same workspace. Furthermore, gate TTL expiry permitted worker lock stealing even when container termination had never been established.

---

## 3. Required Safety Invariants

- **Invariant A (Execution Quiescence Prerequisite)**:
  No recovery service (`RetryCoordinator`, `RecoverySupervisor`, or `RecoverySweeper`) may dispose, roll back, mutate, or requeue an isolated run's workspace unless tenant quiescence has been affirmatively verified (`status === "QUIESCENT"` with zero live containers) within the current recovery epoch.
- **Invariant B (In-Process Exemption)**:
  Runs configured with in-process execution (`tenantModel === "NONE"`) create no external tenant containers; their recovery proceeds immediately without external quiescence probes.
- **Invariant C (Durable Quarantine Enforcement)**:
  When a worker or recovery process encounters `TERMINATION_UNVERIFIED`, the run's tenant launch gate must transition to `QUARANTINED` in durable storage. While quarantined, worker acquisition must fail closed.
- **Invariant D (Anti-Stealing under Quarantine)**:
  Gate TTL expiration must never allow a worker to steal or bypass a `QUARANTINED` gate. Quarantined status persists across worker crashes, host restarts, and lease expirations.
- **Invariant E (Exclusive Remediation Ownership)**:
  Only an authorized `RECOVERY` supervisor may acquire a quarantined gate to probe Docker daemon status and verify physical quiescence. Once zero containers are verified, recovery clears quarantine and completes the recovery cycle.
- **Invariant F (Token Fencing on Release)**:
  Gate release operations must validate the unique acquisition token. A stale holder cannot release or mutate a gate acquired or quarantined by another process.

---

## 4. Decision & Architecture

### 4.1 Durable Quarantine in `tenant_launch_gates`
We extend the schema contract and SQLite state store to represent quarantine as an explicit state machine value:
- `holder_type`: `'WORKER' | 'RECOVERY' | 'QUARANTINE'`
- `state`: `'ACQUIRED' | 'RELEASED' | 'QUARANTINED'`
- `reason`: Machine and operator diagnostic string explaining the quarantine condition.

When `WorkerRuntime` encounters `TERMINATION_UNVERIFIED`, it does not release the launch gate. Instead, it invokes:
```ts
await this.launchCoordinator.quarantine(launchGate, "Worker termination unverified");
```
and clears its internal reference so the subsequent `finally` block does not release the gate.

### 4.2 Anti-Stealing Acquisition Protocol
In `SqliteStateStore.acquireTenantLaunchGate`:
1. If `row.state === "QUARANTINED"`:
   - If `holderType === "WORKER"`: Acquisition is strictly rejected (`TenantLaunchGateConflictError`: `"Tenant execution is QUARANTINED... worker launch refused"`), regardless of whether `nowIso > row.expires_at`.
   - If `holderType === "RECOVERY"`: Acquisition is permitted to allow the recovery supervisor to take ownership of the quarantined run, probe daemon state, and terminate lingering processes.
2. If `row.state === "ACQUIRED"` and `nowIso > row.expires_at`:
   - Recovery may reclaim the gate if the prior holder process is dead (`isProcessAlive(pid) === false`).
   - Workers cannot steal gates from active supervisors.

### 4.3 Service-Layer Verification Boundaries

#### A. `RunCoordinator.recoverExpiredRuns`
Before expiring leases, deleting workspaces, or incrementing attempt counts:
1. Inspects the run's policy via `runRequiresTenantQuiescence(snapshot)`.
2. Checks whether `options?.quiescedRunIds?.has(runId)` is true.
3. Queries `store.getTenantLaunchGate(runId)` to verify the gate is not `QUARANTINED`.
4. If quiescence is unverified or the gate is quarantined, the run is skipped from mutation/retry and recorded in `heldForQuiescenceRunIds`.

#### B. `RecoverySupervisor.scanAndRecover` & `recoverRun`
Before rolling back mutation intents or touching workspace files:
1. Inspects `runRequiresTenantQuiescence(snapshot)`.
2. Asserts `options?.quiescedRunIds?.has(runId)` and asserts gate is not `QUARANTINED`.
3. If unverified, the run is skipped with status `SKIPPED_TENANTS_NOT_QUIESCED`, leaving the filesystem untouched and preserving mutation intents.

#### C. `RecoverySweeper.sweep`
Coordinates the two-phase recovery sequence:
1. Gathers candidate expired runs.
2. Quiesces isolated tenants via `TenantQuiescenceGate`, collecting `quiescedRunIds`. If a run fails quiescence, the gate is transitioned to `QUARANTINED`.
3. Invokes `recoverySupervisor.scanAndRecover({ quiescedRunIds })`.
4. Invokes `runCoordinator.recoverExpiredRuns({ quiescedRunIds })`.
5. Surfaces any unverified or quarantined runs in `heldForTenantsRunIds` and sets `needsAttention: true`.

---

## 5. Consequences & Research Trade-offs

- **Zero-Cost & Local-First**: Relies entirely on SQLite WAL mode row transactions; introduces zero network dependencies, daemons, or native locking extensions.
- **Fail-Closed Safety**: In the event of Docker daemon drops, CLI cancellations, or unexpected aborts, runs fail into a safe quarantined state rather than risking split-brain workspace corruption.
- **At-Least-Once Delivery**: Requeuing and retries occur strictly after quiescence is verified, honoring at-least-once execution guarantees without claiming impossible exactly-once execution.
- **Explicit Visibility**: Quarantined runs are inspectable in the SQLite state store and reportable via CLI and telemetry, providing full auditability for human operators.
