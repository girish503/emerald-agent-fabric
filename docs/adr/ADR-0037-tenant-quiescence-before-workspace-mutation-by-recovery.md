# ADR-0037: Tenant Quiescence Before Recovery Mutates or Disposes a Workspace

## 1. Status
- **Status**: PROPOSED. Rollout steps 1-2 are implemented (see section 9); steps 3-5 are not.
- **Date**: 2026-10-31
- **Relates to**: ADR-0036 (crash recovery and workspace ownership), ADR-0006 (crash recovery and retry safety), `docs/HANDOFF.md` review finding 3
- **Not a claim**: this design does not provide exactly-once execution and does not remove the need for lease fencing.

## 2. Problem (evidence from the code, 2026-10-31)
Recovery assumes that when a run's lease has expired, nothing that belongs to that attempt can still write to its workspace. Nothing establishes this:

| Fact | Where |
|---|---|
| The CLI worker (`emerald worker`) uses only `InProcessExecutionProvider`; operations run inside the worker process. | `src/application/worker-host.ts` |
| The only provider that creates tenant processes is `DockerExecutionProvider`: `docker run --name emerald-run-<id>`, workspace bind-mounted `rw`. | `src/adapters/execution/docker-execution-provider.ts` |
| That container is stopped only by timers inside the worker (timeout, output limit) and removed in a `finally` inside the worker. It has no labels, no recorded id and no maximum lifetime. | same file, `killContainer` / `cleanupContainer` |
| If the worker dies, the container survives and keeps writing through its bind mount, including into a directory that disposal has renamed aside. | reasoning + Linux measurement in HANDOFF finding 3 |
| Crash cleanup (`disposeWorkspaceSync`) runs synchronously inside the recovery database transaction, so it cannot await anything. | `run-coordinator.ts` `recoverExpiredRuns` |
| The supervisor's rollback engine also writes into the workspace (restores files) and has no tenant check either. | `src/recovery/durable-rollback-engine.ts` |
| `--workers-stopped` is an operator assertion; nothing enforces it. | `recovery-host.ts` |

Measured consequence (Linux, live tenant, HANDOFF finding 3): disposal against a live tenant fails closed (ENOTEMPTY, tombstone left), and one escape was found and fixed (chmod walk). That is availability and residue, not safety: rename-aside does not stop a process holding a working directory or bind mount, and Node has no `openat`.

## 3. Invariant
> Recovery MUST NOT roll back, restore into, or dispose of a run's workspace while any process started on behalf of that run's earlier attempts might still be running. If absence cannot be verified, recovery MUST leave the workspace and the run untouched (held), report it, and retry later.

Corollaries: lease expiry is never proof of death; a failed or unavailable check is "unverified", never "quiescent"; the check gates rollback AND disposal AND requeue-with-cleanup.

## 4. Design

### 4.1 Port (application layer, no infrastructure types)
```ts
export type QuiescenceResult =
  | { status: "QUIESCENT"; stopped: number }          // verified: no tenant of this run remains
  | { status: "UNVERIFIED"; reason: string };           // could not stop or could not verify -> fail closed

export interface TenantQuiescencePort {
  /** Stops every tenant process that was started for `runId` (any attempt) and returns only after verifying none remain. Idempotent. */
  quiesceRun(runId: string): Promise<QuiescenceResult>;
}
```
`ExecutionProvider` gains an optional descriptor `tenantModel: "NONE" | "ISOLATED_PROCESSES"` and, when `ISOLATED_PROCESSES`, a `quiescence: TenantQuiescencePort`. A provider that omits the descriptor is treated as `ISOLATED_PROCESSES` without a port, i.e. automatic disposal is refused for it (fail closed). `InProcessExecutionProvider` declares `NONE`: its operations live in the worker process, so a dead worker has no tenants. (A live-but-starved worker is a different problem, covered by lease fencing and the `--workers-stopped` assertion; this ADR does not claim to solve it.)

### 4.2 Identification must not depend on the dead worker
Tenants are found through an external, authoritative namespace, not through state the crashed worker would have had to write:
- Docker: every container gets `--label emerald.run=<runId> --label emerald.lease=<leaseId> --label emerald.worker=<workerId>` at creation (labels are set by the same `docker run`, so there is no window where a container exists unlabeled).
- Discovery: `docker ps -a --filter label=emerald.run=<runId> --format {{.ID}} {{.State}}`.
- No new SQLite table. Recording container ids in the DB would add a write that can be lost in exactly the crash this design covers.

### 4.3 Docker implementation
`quiesceRun(runId)`:
1. list containers with the run label (all states);
2. `docker kill` every running one, `docker rm -f` all;
3. list again; `QUIESCENT` only if the second listing is empty (or contains only `exited`/`created` containers, which hold no process);
4. any docker error, daemon unreachable, or non-empty second listing after a bounded wait (default 10 s, configurable) -> `UNVERIFIED` with the reason. A missing docker binary is `UNVERIFIED` only if the run's provider was docker; for `NONE` providers the port is never consulted.
Also set a container-side hard lifetime so a leaked container eventually ends on its own even if recovery never runs (candidate: `--stop-timeout` is not a lifetime; use an entrypoint wrapper `timeout <contract timeoutMs + grace>` for `run_command`, and the same for the in-container runner). Decision D3 below.

### 4.4 Where it runs (the sync-transaction problem)
Quiescence is async and must not run inside the recovery DB transaction. It becomes a **pre-pass in `RecoverySweeper.sweepOnce()`**, which is already async and already runs before the transaction:
```
sweepOnce():
  1. candidates = runs RUNNING/LEASED with expired lease, or RECOVERING     (read-only query)
  2. for each candidate, in sequence:  result = await quiesceRun(runId)
       QUIESCENT  -> add to `quiescedRunIds`
       UNVERIFIED -> add to `heldForTenants` (report in the sweep summary / needsAttention)
  3. supervisor.scanAndRecover({ excludeRunIds: heldForTenants })           (rollback writes files)
  4. coordinator.recoverExpiredRuns({ excludeRunIds: heldForTenants })      (requeue + disposeWorkspaceSync)
```
`scanAndRecover` and `recoverExpiredRuns` each get one optional argument. The implemented form is an EXCLUDE set rather than the originally drafted allow-list: an allow-list would silently skip any run the pre-pass did not enumerate, whereas an exclude set can only ever hold back runs the pre-pass explicitly refused. A run in the set is skipped exactly like `heldForRollback` is today (no state change, no event, no cleanup). Runs held for tenants keep their expired lease and are retried every sweep. No change to lease, claim or fencing semantics.

### 4.5 The worker's own disposal
A worker disposing its own finished run has already stopped its tenants (provider `finally`). It additionally calls `quiesceRun(runId)` before `disposeWorkspace` when the provider is `ISOLATED_PROCESSES`; `UNVERIFIED` -> the existing `workspace.failed` path (workspace preserved). This closes the case where `docker rm -f` itself failed silently today.

### 4.6 Zombie starts after verification
A stale worker could start a NEW container after recovery verified quiescence. Mitigation inside the provider: before `docker run`, assert the lease is still held (the worker already has `assertLeaseHeld`); re-run `quiesceRun` immediately before dispose is not repeated. Residual window: a stale worker that passed its lease check just before expiry and starts a container just after recovery's second listing. This is the same fencing-vs-side-effect gap as the rest of the runtime (no exactly-once claim); the labels make it detectable on the next sweep because the new container carries the stale lease label while the run holds a newer lease or none.

### 4.7 Relation to `--workers-stopped`
Unchanged as an operator assertion about WORKER processes. It is no longer the only safeguard for TENANT processes. Docs stop calling it a fence.

## 5. Failure modes
| Situation | Behaviour |
|---|---|
| Docker daemon down during recovery | every docker-backed candidate `UNVERIFIED`: held, reported, retried; in-process runs unaffected |
| `docker kill` succeeds, listing still shows running container | `UNVERIFIED`; never dispose |
| Quiescence takes longer than the bound | `UNVERIFIED`; the next sweep retries (idempotent) |
| Run has both a held tenant and an unreconciled mutation | stays held; rollback and requeue both wait |
| Operator wants to force cleanup | explicit CLI flag naming the run (`emerald recovery release --run-id`), recorded as an event; never automatic. Decision D5. |

## 6. Test plan
1. Unit (any OS): fake `TenantQuiescencePort`: QUIESCENT -> recovery proceeds exactly as today; UNVERIFIED/throwing -> no rollback, no requeue, no disposal, run held, reported; second sweep with QUIESCENT proceeds; set filtering for `scanAndRecover` and `recoverExpiredRuns`.
2. Unit: provider descriptor rules (`NONE` skips the port; missing descriptor refuses automatic disposal).
3. Docker adapter with a fake `docker` binary (script) asserting the exact command sequence and every failure branch above (no real docker needed).
4. Real docker integration (only when docker is available, explicitly authorized): start a labeled container bind-mounting a temp workspace, kill the "worker", run a sweep, assert the container is gone before the workspace is touched, and that a surviving writer cannot recreate files afterwards.
5. POSIX live-tenant tests from HANDOFF finding 3 remain as regression coverage.
6. E2E `emerald submit -> worker -> kill -> sweep -> worker` must keep passing unchanged (in-process provider, `NONE`).

## 7. Decisions needed from the owner
- **D1** Is the Docker provider in scope for the CLI worker soon? If not, the cheapest compliant step is only 4.1 plus the rule "ISOLATED_PROCESSES providers cannot be used with automatic disposal", without implementing 4.3.
- **D2** Labels on the container as the discovery mechanism (recommended) versus recording container ids in SQLite (needs a schema change and a migration the recovery host validates).
- **D3** Container-side maximum lifetime via an entrypoint `timeout` wrapper (changes the image contract) versus relying on recovery to reap.
- **D4** Quiescence bound (default 10 s) and whether a persistent `UNVERIFIED` should escalate (exit code 2 of `recovery sweep` already means "needs operator").
- **D5** Whether to provide the explicit operator override at all.

## 8. Not covered
Native (non-container) tenant processes (no provider creates them today; a future provider must implement the port or be refused for disposal); a live but lease-starved in-process worker still writing; Windows/Docker Desktop bind-mount semantics; kernel-level process-group tracking (rejected: pids can be reused and are meaningless across hosts).

## 9. Rollout (smallest first)
1. **DONE** Port (`src/ports/tenant-quiescence.port.ts`), provider descriptors (in-process `NONE`, docker `ISOLATED_PROCESSES` with no port), fail-closed rule: undeclared provider = isolated; a run's model is derived from its BOUND contract's `isolationRequirement` (`tenantModelFromContract`), missing binding/contract = isolated. Tests: `tests/recovery/tenant-quiescence.test.ts`.
2. **DONE** Sweeper pre-pass (`src/recovery/tenant-quiescence-gate.ts`, `RecoverySweeper` option `tenantQuiescence`) and the `excludeRunIds` filters on `scanAndRecover` / `recoverExpiredRuns`. The recovery host ALWAYS enables the pre-pass; the stock CLI supplies no port, so **runs whose contract requires isolation are now HELD (sweep exit code 2, status `TENANTS_NOT_QUIESCED`)** instead of rolled back/requeued/disposed. A bare `RecoverySweeper` without the option behaves as before. Only runs recovery would touch (expired lease or RECOVERING) are checked; a live worker's run is never queried. The worker-side disposal check (step 4) is NOT done: a worker still disposes its own isolated run without calling the port.
3. Docker labels and adapter with the fake-binary tests (test 3).
4. Worker-side disposal check (4.5).
5. Real-docker integration (test 4) after authorization, then update HANDOFF and ADR-0036 section on `--workers-stopped`.
