# ADR-0038: Close the Late-Start Tenant Race with a Durable Coordination Gate

## 1. Status
- **Status**: PROPOSED.
- **Date**: 2026-10-31
- **Relates to**: ADR-0037 (tenant quiescence before workspace mutation), ADR-0036 (crash recovery and workspace ownership)
- **Not a claim**: this design does not provide distributed consensus across partitioned networks; it coordinates local-first processes accessing a shared SQLite database in WAL mode.

## 2. Problem (The Late-Start Race)
ADR-0037 Step 5 verified that recovery can positively discover, terminate, and verify the absence of Docker containers when they exist. However, it exposed a time-of-check to time-of-use (TOCTOU) late-start race:

```
Worker (Attempt N)                                  Recovery Sweeper
------------------                                  ----------------
1. Passes lease check (assertLeaseHeld)
2. Pauses (GC, thread scheduling, I/O pause)
                                                    3. Queries Docker ps (finds 0 containers)
                                                    4. Verifies listing (0 containers -> QUIESCENT)
                                                    5. Disposes workspace ws-<runId>
                                                    6. Advances attempt N -> N+1 (requeues run)
7. Resumes and spawns docker run
   -> Container starts with mount ws-<runId>!
```

In this sequence:
- Recovery's quiescence check is truthful at the moment of inspection (no container existed).
- But because tenant launch authorization was separated from container creation without mutual exclusion, a stale worker can start a container *after* recovery verified absence and mutated the workspace.
- The existing lease check in the worker occurred before the pause; container labels cannot protect against containers that have not yet been created; and `--workers-stopped` is an operator assertion rather than an enforcement barrier.

## 3. Required Safety Invariant
> After recovery has established the right to mutate or dispose a run's workspace, no stale worker may subsequently start a tenant process authorized to use that workspace.

Corollaries:
1. Tenant container creation must not proceed without atomic verification of the active attempt inside a mutual-exclusion boundary shared with recovery.
2. Recovery must not verify quiescence or mutate a workspace while tenant container creation for that run is in flight.
3. If coordination cannot be obtained, or times out, both worker launch and recovery mutation must fail closed.

## 4. Design: Per-Run Tenant Launch Coordination Gate

### 4.1 Primitive Selection
- **Rejected: OS File Locking (`flock` / `LockFileEx`)**: Node.js standard library lacks a cross-platform file locking API without native C++ addons (which violates the dependency-free, zero-cost constraint). Platform semantics differ radically (mandatory locking on Windows vs advisory on POSIX).
- **Rejected: Open SQLite Transaction across `docker run`**: Holding a SQLite `BEGIN IMMEDIATE` write transaction open across `docker run` (which takes seconds) blocks all other database writes in WAL mode and causes deadlock or database lock timeouts.
- **Selected: Durable SQLite-backed Coordination Gate**: A lightweight, row-level lease table `tenant_launch_gates` in the shared SQLite database. Acquisition and release are sub-millisecond atomic transactions. The gate state survives process crashes and works across independent worker and recovery CLI processes.

### 4.2 Schema Contract
```sql
CREATE TABLE IF NOT EXISTS tenant_launch_gates (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
    holder_type TEXT NOT NULL,           -- 'WORKER' | 'RECOVERY'
    holder_id TEXT NOT NULL,             -- workerId | supervisorId
    lease_id TEXT NOT NULL,              -- worker leaseId | supervisor leaseId
    token TEXT NOT NULL,                 -- unique acquisition token
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    state TEXT NOT NULL                  -- 'ACQUIRED' | 'RELEASED'
);

CREATE INDEX IF NOT EXISTS idx_launch_gates_run_state ON tenant_launch_gates(run_id, state);
```

### 4.3 Coordination Protocol

#### A. Worker Tenant Launch Protocol
Before starting a tenant container for `runId`:
1. **Acquire Gate**: Worker calls `launchCoordinator.acquire({ runId, holderType: 'WORKER', holderId: workerId, leaseId, ttlMs: 30000 })`.
   - If held by another active, unexpired process, waits up to `timeoutMs` (default 5000ms).
   - If timeout expires: aborts launch, fails closed (`LAUNCH_COORDINATION_TIMEOUT`).
2. **Fenced Validation inside the Gate**:
   - Worker queries authoritative run state from SQLite:
     Asserts `run.status === 'RUNNING'` AND `run.leaseId === leaseId` AND `run.workerId === workerId`.
   - If validation fails (lease expired, attempt advanced, or run reclaimed):
     Worker releases the gate immediately and aborts (`LEASE_LOST`). Container is **never spawned**.
3. **Provider Execution inside Gate Boundary**:
   - Worker invokes `executionProvider.execute(request)` while holding the launch gate.
   - The gate is held continuously through container creation, execution, and provider cleanup.
4. **Release Gate in Finally**:
   - After `execute(request)` resolves or throws, worker releases the gate in a `finally` block:
     `await this.launchCoordinator.release(launchGate)`.

#### B. Recovery Quiescence & Mutation Protocol
When recovery sweeps an isolated candidate run:
1. **Acquire Gate**: Recovery calls `launchCoordinator.acquire({ runId, holderType: 'RECOVERY', holderId: supervisorId, leaseId, ttlMs: 30000 })`.
   - If worker is currently creating a container, recovery waits for the worker to finish and release.
   - If acquisition times out: run is held (`TENANTS_NOT_QUIESCED`, reason: gate timeout). Workspace is untouched.
2. **Quiescence Verification inside the Gate**:
   - Recovery calls `quiesceRun(runId)`.
   - If `UNVERIFIED`: releases gate, holds run. Workspace is untouched.
3. **Attempt Invalidation & Mutation inside the Gate**:
   - While still holding the gate, recovery commits the SQLite transaction:
     - Expires worker lease.
     - Advances attempt or marks run `RECOVERING` / `FAILED`.
   - Synchronously or under supervisor authority, rolls back or disposes the workspace.
4. **Release Gate**:
   - Recovery calls `launchCoordinator.release(acquisition)`.

### 4.4 Race Closure Analysis
- **Worker pauses before Gate**: Recovery acquires gate, verifies 0 containers, invalidates lease in SQLite, disposes workspace, releases gate. Stale worker unpauses, acquires gate, validates lease in SQLite, sees lease is expired/revoked, aborts without spawning container.
- **Worker inside Gate**: Worker holds gate. Recovery tries to acquire gate and waits. Worker spawns container, releases gate. Recovery acquires gate, calls `quiesceRun(runId)`, discovers the running container, terminates it, verifies 0, then mutates workspace.
- **Worker crashes inside Gate**: Gate TTL (30s) expires. Recovery reclaims the gate, executes `quiesceRun(runId)` (terminating any container the worker managed to start before dying), invalidates lease, and mutates workspace.
- **Recovery crashes inside Gate**: Gate TTL expires. The next recovery sweep reclaims the gate. Stale worker cannot launch because its lease expired.

## 5. Failure Modes
| Scenario | Behavior | Invariant Maintained? |
|---|---|---|
| Worker pauses before Docker launch | Attempt invalidated while gate held by recovery; worker rejected on resume | Yes |
| Worker crashes holding gate | Gate TTL expires; recovery reclaims gate, re-verifies quiescence before mutation | Yes |
| Recovery crashes holding gate | Gate TTL expires; next sweep reclaims gate; no stale worker can launch | Yes |
| SQLite database busy/locked | Acquisition times out after bounded wait -> fails closed | Yes |
| Concurrent workers attempt launch | Gate enforces single-holder mutual exclusion; only verified lease holder spawns | Yes |

## 6. Implementation Plan
1. Schema & Store: Add `tenant_launch_gates` table to `src/adapters/persistence/schema.ts` and port methods to `StateStorePort` / `SqliteStateStore`.
2. Port: Define `TenantLaunchCoordinatorPort` in `src/ports/tenant-launch-coordinator.port.ts`.
3. Worker integration: Wrap isolated container launch in `WorkerRuntime` with gate acquisition and lease re-validation.
4. Recovery integration: Wrap `runTenantQuiescencePrePass` / sweeper workspace disposal in `RecoverySweeper` with gate acquisition.
5. Deterministic Unit & Concurrency Tests: Verify all 11 test scenarios specified in the task description.

## 7. Remediation: Elimination of Unsafe Lock Stealing (Audit Findings F-01 to F-04)

### 7.1 The Audit Vulnerability (Case D2)
The independent audit identified a critical gap in time-based lock stealing:
If a worker validated its lease inside the gate, then paused for $> 30\,\text{s}$ prior to `docker run`, recovery observed `nowMs >= expiresMs` and stole the gate. Recovery queried Docker (finding 0 containers because the worker had not yet spawned), concluded `QUIESCENT`, disposed the workspace, and advanced the attempt. When the paused worker resumed, it was already past its inside-gate check and spawned Docker against the mutated or missing workspace.

### 7.2 Evaluated Strategies
1. **Strategy 1 (Eliminate Time-Based Lock Stealing)**: An expired timestamp alone is NOT permission to steal a gate. Reclaiming an unreleased gate from a worker is prohibited if that worker process is still alive.
2. **Strategy 2 (Process-Lifetime Coordination)**: Standard Node.js standard library primitive `process.kill(pid, 0)` provides deterministic local OS process liveness across POSIX and Windows without native addons or network dependencies.
3. **Strategy 3 (Full Provider Execution Gate Lifetime)**: Rather than attempting an asynchronous mid-provider launch handshake hook, `WorkerRuntime` holds the coordination gate across the entire `executionProvider.execute()` call (from initial inside-gate lease re-validation, through container execution, to post-execution cleanup in `finally`). This prevents recovery from acquiring coordination or initiating quiescence while the tenant container is executing.
4. **Strategy 4 (Supplementary SQLite State)**: Durable SQLite state records holder identity (`workerId`, `pid`, `leaseId`, `token`).

### 7.3 Remediated Invariant and Recovery Protocol
- **Liveness Gate Check**: When `acquireTenantLaunchGate` evaluates an active gate where `nowMs >= expiresMs`, it checks the holder process:
  - If `holder_type === "WORKER"`, looks up `pid` in `workers`. If `isProcessAlive(pid)` is true, lock stealing is **strictly refused**, throwing `TenantLaunchGateConflictError`.
  - Recovery pre-pass catches the conflict, marks the run `HELD`, and leaves the workspace completely untouched.
  - A gate is reclaimed ONLY when the holder process is verified dead (`ESRCH`), proving the holder can never resume to perform a late start.
- **Fail-Fast Isolated Worker Construction (F-03)**: `WorkerRuntime` rejects construction if isolated execution is requested without an authoritative durable launch coordinator or store.
- **Port Deduplication (F-04)**: Duplicate declarations in `StateStorePort` are removed.

## 8. Remediation: Recovery Ownership and Cross-Process Verification (Audit Findings F-05 and F-06)

### 8.1 Vulnerability Analysis (F-05)
Prior to this remediation, recovery gate holders relied purely on supervisor lease expiration times without verifying supervisor process liveness. If a recovery supervisor paused (e.g., during a prolonged quiescence scan or disk I/O), a competing recovery process could steal the launch gate based on clock expiration while the original recovery process was still performing workspace operations.

### 8.2 Architectural Changes
1. **Explicit Owner PID Column**: `owner_pid INTEGER` added to `tenant_launch_gates` in `INITIAL_SCHEMA_SQL` and via idempotent `ALTER TABLE tenant_launch_gates ADD COLUMN owner_pid INTEGER;` in `migrateDatabase`.
2. **Fail-Closed on Missing Process Identity**: If an unreleased gate has expired its nominal TTL but `owner_pid` is null (legacy records or unrecorded PID), lock stealing is refused fail-closed.
3. **Symmetric Recovery Liveness Verification**: When an expired recovery gate is contested, `isProcessAlive(owner_pid)` is evaluated. Stealing is prohibited if the prior supervisor process remains alive or indeterminate, and allowed ONLY if the process is verified dead AND its supervisor lease is expired/inactive.
4. **Token-Fenced Release**: Gate releases use `WHERE run_id = ? AND token = ? AND state = 'ACQUIRED'`, preventing a stale or waking owner from clearing a gate reclaimed by a subsequent owner.
5. **Supervisor and Worker PID Propagation**: `TenantQuiescenceConfig` accepts `supervisorPid`, forwarded from `RecoverySupervisor.getSupervisorPid()` through `RecoverySweeper`. `WorkerRuntime` passes `this.pid` on gate acquisition.

### 8.3 Genuine Cross-Process Verification (F-06)
Verified via `tests/integration/cross-process-sqlite-gate.integration.test.ts` running separate Node.js OS processes contending on a file-backed SQLite database in WAL mode:
- Independent processes enforce mutual exclusion.
- Live-owner pause safety holds across distinct OS processes.
- Stale-owner crash recovery successfully reclaims after process termination.
- Token fencing prevents stale owner release from clearing newer owner gate.

### 8.4 Known Limitations & Platform Trade-offs
- **Gate Lifetime & Safety vs Liveness**: The launch gate is held continuously across the entire `executionProvider.execute()` call (not merely a transient sub-second handshake). Because stealing is strictly forbidden while an owner PID is alive, a hung but live worker blocks recovery indefinitely. Recovery sweeps refuse stealing, mark the run `HELD` (`TENANTS_NOT_QUIESCED`), and leave the workspace untouched. This prioritizes workspace integrity and correctness over automated progress.
- **PID Reuse**: Under high process churn on Linux/Windows, an OS PID may be recycled. However, PID reuse produces only a false-positive (believing a dead owner is alive), resulting in a conservative hold (`HELD`) rather than unsafe reclamation. It can never authorize premature gate stealing.
- **Fail-Closed on Indeterminate State**: If `process.kill(pid, 0)` throws any error other than `ESRCH` (e.g. `EPERM`), the system treats the process as potentially alive and fails closed.

