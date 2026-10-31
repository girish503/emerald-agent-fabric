# HANDOFF — Emerald Agent Fabric (recovery hardening, Phase 0 gate)

Read `GEMINI.md` first (binding rules). Hard rules: local Ollama only, no paid/cloud inference, no model
downloads, no Git operations (stage/commit/push) without explicit owner authorization, never run live
(Ollama) tests without authorization, preserve historical benchmark evidence.

## Where we are
Phase 0 (discovery) of the master prompt is done; Phase 1 (PRD/SLOs/threat model) is NOT started and stays
blocked until the owner approves the Phase 0 report and the recovery audit. All work is in commit `40abeec`
on `master` (it also contains the owner's earlier uncommitted tool-contract/ADR/research files).

## What changed and why (crash recovery, ADR-0036 / audit 48AG.4.1)
- `src/recovery/recovery-supervisor.ts`: never falls back to `process.cwd()`; resolves the run's bound workspace,
  rejects drifted/too-broad/relative roots; exclusive lease; `RECOVERED_UNVERIFIED` for zero-intent runs; hands a
  cleanly rolled-back run to the coordinator (leaves it RECOVERING) while attempts remain.
- `src/recovery/durable-rollback-engine.ts`: real-path + snapshot containment, store-backed authority fence before
  every fs write, per-intent workspace ownership check, rollback generations (second crash after retry),
  chained-mutation digests, VERIFIED_PASS rolled back, pre-mutation intents -> ABORTED_UNMUTATED.
- `src/application/run-coordinator.ts`: retry gate (`requiresRollbackBeforeRetry`), `bindRunWorkspace`,
  `workspaceCleanupFailedRunIds`; `worker-runtime.ts`: stable `ws-<runId>` id, binds workspace at provisioning.
- `src/adapters/persistence/{schema,sqlite-state-store}.ts`: `run_workspace_bindings`, UNIQUE active supervisor
  lease per run (migration demotes duplicates), `resetCompletedRunRollback`. `src/domain/mutation-intent.ts`:
  VERIFIED_PASS -> ROLLED_BACK legal (supervisor only), `isRollbackPendingStatus`.
- `src/recovery/recovery-sweeper.ts` + `recovery-host.ts` + `src/cli/emerald-cli.ts`:
  `emerald recovery sweep|watch --db <file> --workers-stopped [--workspace-root <dir>] [--interval-ms n]`.
- Tests: `tests/recovery/*`, `tests/application/{coordinator-retry-gate,recovery-sweeper,worker-runtime-workspace-binding}.test.ts`.

## Key decisions
- ADR-0036 is the contract. One workspace per RUN (retries reuse the same path); coordinator retries are gated on
  supervisor rollback; rollback record is per generation; recovery fails closed; no exactly-once claim.
- Recovery host must run only while NO worker is active (`--workers-stopped` is an operator assertion, not a fence). Worker
  lease renewal now exists (see "Worker lease renewal"), but the requirement is deliberately NOT relaxed: dropping it is an
  owner decision, and the supervisor lease is still not renewed.
- Host never creates/migrates a DB; `--db` has no default (interactive CLI uses an in-memory control plane).

## Recovery-host database validation (Gate A) — owner decision
- `openRecoveryRuntime` validates the schema (tables, columns, types, nullability, PK, indexes, partial predicates,
  foreign keys vs. a fresh in-memory current schema) on a PRIVATE COPY (main + `-wal` + `-journal`); a rejected
  database is never opened, so its bytes and sidecars are unchanged. Accepted databases are opened without migration
  or journal-mode change; SQLite may replay a leftover WAL / roll back a hot journal on them.
- Accepted limitations (owner accepted the file-swap risk, single trusted operator): the database directory must not be
  writable by other users; identity (dev/inode) is checked before SQLite's first read but sidecars are path-resolved and
  not re-checked; a file deleted mid-validation leaves an empty file; the copy is not atomic against a live writer
  (`--workers-stopped` is an operator assertion, not a fence); a read-only database with a hot journal is refused until
  made writable; CHECK constraints/defaults/collations are not compared; multi-database (ATTACH) transactions are unused.
- Test counts, each tied to its exact command (last run in the final Gate A audit; NOT re-run when this section was edited):
  - `npx vitest run tests/recovery/recovery-host.test.ts` — 37 passed, 0 failed, 0 skipped.
  - `npx vitest run tests/recovery` (standard recovery suite) — 10 files, 146 passed, 0 failed, 0 skipped.
  - Extended recovery-related suite: `npx vitest run tests/recovery tests/application/recovery-sweeper.test.ts tests/application/coordinator-retry-gate.test.ts tests/application/worker-runtime-workspace-binding.test.ts tests/contract/rollback-safety.test.ts`
    — 14 files, 186 passed, 20 skipped, 0 failed. The 20 skips are `it.skip` contract scenarios in `tests/contract/rollback-safety.test.ts`
    (A1–A8, B6, B7, C2, C3, …), so they appear only in the extended run, never in the standard one.
- Gate A: PASS WITH CONDITIONS (final independent audit done). Phase 1 stays blocked on the other gates (worker lease
  renewal / stale-worker DB fencing: PASS WITH CONDITIONS, see its section; workspace disposal, signal/watch tests, skipped
  ADR-0036 scenarios and production-database integration still open).

## Worker lease renewal and stale-worker fencing (Phase 1 gate) — implemented; DB fencing audited (PASS WITH CONDITIONS)
Audit status: the independent re-audit of the stale-worker database-fencing fix gave **PASS WITH CONDITIONS**; no remaining
database-fencing blocker was identified in the tested cases. The conditions are the open items listed at the end of this section.

**Heartbeat (`src/application/lease-renewal.ts`, `LeaseRenewalLoop`, wired in `WorkerRuntime.runOnce`, option `leaseRenewal`)**
- Started right after `startRun`; stopped in a `finally` before any terminal transition releases the lease. Renews through the
  existing `coordinator.renewLease` (one BEGIN IMMEDIATE transaction, serialized with the sweeper; never revives an expired or
  released lease; does not bump the run version; emits no audit event). Every TTL/3 (default TTL 10s), injectable scheduler.
- Renewal errors: `LeaseLost` and `LeaseExpired` are recorded by the loop as loss signals (`lostError`) and stop the loop. Any
  other error is retried only while the lease has not expired; after expiry it is recorded as a loss. Renewal stops after the run's
  `timeoutMs` plus a grace period (default one TTL) so a hung run's lease lapses.
- The loop's loss signal is NOT what decides the final outcome; the post-provider ownership check below is a separate decision.

**Post-provider ownership check (`WorkerRuntime`, right after the provider returns)**
- It reads the run and returns `FENCED` unless the run is still `RUNNING` AND its current worker id and lease id are still this
  worker's. It is an ownership check, not a lease-expiry check: a lease that expired by time but was not reclaimed does NOT fence the
  worker, and the run can still complete (an earlier `isLeaseActive`-based version discarded such work and was relaxed by owner
  decision). If a sweeper or another worker reclaimed the run, or an operator moved it out of `RUNNING`, the stale worker returns
  `FENCED`, writes no terminal state and does not dispose the workspace. It does not depend on the heartbeat timer having run.
- `timeoutRun` and `cancelRun` accept an optional `fencing` argument (worker id + lease id). A stale holder gets `LeaseLostError`
  and nothing is written; the worker passes its own fencing. Calls without it (operator, sweeper) are unchanged. `completeRun`
  and `failRun` were already fenced. Reason: the first audit reproduced that a worker whose heartbeat was starved could, after the
  sweeper reclaimed the run and another worker started it, time out or cancel the newer attempt's run and release its lease.

**What is guaranteed, and what is not**
- Database guarantee: terminal transitions are fenced transactionally (the check inside the transaction and the `UPDATE ... WHERE
  lease_id = ? AND current_worker_id = ?` both apply), so a race after the post-provider check cannot overwrite a newer attempt's
  run or release its lease. Verified by the audit's takeover cases (success, FAILED, TIMED_OUT, CANCELLED) and a gap-race probe.
- Filesystem guarantee: database fencing does not make filesystem effects atomic. `disposeWorkspaceSafely` fails closed (ownership read
  must succeed; only `LeaseLostError` (and, for the delete itself, `WorkspaceOwnershipError`) stops quietly; the `workspace.failed` event is fenced) AND the delete itself is now
  ownership-aware - see "Phase 1 completion pass" below (marker + rename-to-tombstone). The earlier "residual race" description in this
  paragraph is superseded.

**Test commands and results** (the first four were run fresh by the latest independent re-audit; the workspace-disposal results were
run fresh in the implementing session; none were re-run for this handoff edit)
- `npx vitest run tests/application/worker-lease-renewal.test.ts` — 20 passed.
- `npx vitest run tests/application/worker-runtime.test.ts tests/persistence/phase31-recovery-fencing.test.ts` — 29 passed.
- Extended recovery command (documented above): 14 files, 186 passed, 20 skipped, 0 failed.
- `git diff --check` — exit 0, with only the LF-to-CRLF warning.
- Workspace disposal (implementing session, after the re-audit): `npx vitest run tests/application/worker-workspace-disposal.test.ts` — 9 passed (real
  `NodeFsWorkspaceAdapter`, directory presence asserted). Focused set `npx vitest run tests/application/worker-workspace-disposal.test.ts
  tests/application/worker-runtime.test.ts tests/application/worker-runtime-workspace-binding.test.ts
  tests/application/workspace-crash-recovery-and-security.test.ts tests/application/worker-lease-renewal.test.ts
  tests/application/worker-runtime-recovery-integration.test.ts tests/persistence/phase31-recovery-fencing.test.ts` — 7 files, 96 passed.
  Extended recovery command re-run afterwards: 14 files, 186 passed, 20 skipped, 0 failed. `tsc` was not run, so the new
  `ReturnType<RunCoordinator["getRun"]>` annotation in `worker-runtime.ts` is not compiler-checked.
- Historical, NOT freshly rerun in that audit: a broader run of `tests/application` + `tests/persistence` (excluding live tests) reported
  25 baseline failures (phase32-contract-checkpoint-supervisor 14, post-pass-verification-latch 8, phase48o-contract-remediation 2,
  controlled-baseline-reflex 1); `tsc --noEmit` reported 575 errors.

**Still open (Phase 1 blockers and remaining limits)**
- See "Phase 1 completion pass" below for the current status of every gate (D graceful signals unverified on Windows; E needs owner dispositions).
- Workspace disposal: ownership-aware protocol implemented (see completion pass); NOT yet independently audited.
- Lease-renewal limits: `ExecutionProvider.execute` has no abort signal, so loss cannot cancel an in-flight provider; node:sqlite is
  synchronous, so a long synchronous stretch can starve the heartbeat timer (TTL must exceed it); a non-ACTIVE lease (released early)
  is treated as transient until its nominal expiry, so loss detection can lag by up to one TTL; `LeaseRenewalLoop` timing options are
  now validated at construction (see completion pass); no `assertLeaseHeld` before filesystem mutations; renewal emits no audit event.
- Supervisor lease (30s) is still not renewed during long rollbacks, and `--workers-stopped` remains required (an operator
  assertion, not a fence).

## Phase 1 completion pass — status by gate (implementing session; NOT independently audited)
Everything below was implemented and run in one implementing pass. No separate independent review of these changes has happened;
the earlier independent audits cover only what their own sections say. Phase 1 is NOT complete (Gate E needs owner dispositions;
Gate D graceful-signal tests are unverified on Windows).

**Gate A - workspace disposal race: implemented, tested, unaudited.**
- `WorkspacePort.provisionWorkspace(spec, owner?)` writes `.emerald-owner.json` `{runId, leaseId}` (not best-effort when an owner is given);
  `disposeWorkspace(id, expectedOwner?)` with an owner (the worker passes `{runId, leaseId}`) does: early marker check -> atomic rename to
  `.disposing-<id>-<uuid>` -> re-read the marker INSIDE that private directory (authoritative; a mismatch renames it back, or preserves it
  under the `.disposing-` name if the path was taken again, and throws `WorkspaceOwnershipError`) -> rename to `.disposed-<id>-<uuid>` -> recursive
  delete. Recursive delete therefore only touches a directory verified as the caller's after it left the shared path. Missing marker, symlink or
  non-directory => refused. Without an owner (operator/recovery-sweeper paths) behaviour is unchanged. `cleanupOrphanedWorkspaces` finishes
  `.disposed-*` leftovers and never deletes `.disposing-*` (unverified). The worker treats `WorkspaceOwnershipError` like fencing (quiet return).
- Why lease id: the workspace id is stable per run (`ws-<runId>`), so run id cannot tell attempts apart; each claim has a unique lease id.
- Windows facts measured: concurrent renames can report success without moving anything, and a sharing violation (EPERM) occurs while another
  actor has a handle inside the directory; both are handled (idempotent return / bounded retry).
- Limits: the marker is inside the workspace, so code running inside the workspace could forge it; a stale attempt can move a newer attempt's
  directory aside for the instant before it is restored (never deleted); cross-DB/filesystem atomicity is not claimed. Follow-up fixes after the review of this pass
  (implementing session, NOT re-audited): (F1) workspace ids starting with "." or longer than 128 characters are rejected by provision/dispose (the `.disposing-*` / `.disposed-*` namespace is reserved; the
  orphan sweep deletes `.disposed-*` without consulting the active set); (F2) the orphan sweep reads the ownership marker and disposes with it, so a directory replaced by a newer attempt between the active check
  and the delete is restored/preserved, not deleted - a marker-LESS legacy directory still gets the unowned delete, so that case keeps the check-then-delete window; (F3) the worker's two handle-validation/bind-failure
  disposals pass the owner, and `disposeWorkspaceSync` accepts an owner (same protocol, sync) which the coordinator passes (fenced dispose; crash cleanup uses the crashed attempt's lease). `WorkspaceOwner.tolerateMissingMarker`
  lets those coordinator paths still clean marker-less legacy directories, but a marker naming a different lease is ALWAYS refused. A symlink/junction at the path is refused when an owner is given. Link-following fix (after the Round 3 re-audit; implementing session, NOT re-audited): the permission fix-ups `ensureWritableRecursive`/`ensureWritableRecursiveSync` used `chmod`/`readdir`, which follow links, so a link or junction swapped in after the owner check made the code chmod files OUTSIDE the root (proven on Windows with a verbatim copy of the old logic: a read-only outside file became writable). They now `lstat` the top path and return unless it is a real directory, and skip link entries; and after the atomic move-aside the tombstone must be a real directory (not a link or file) BEFORE its marker is read, otherwise it is handled like a mismatch (restored/preserved, never read through, never chmod'ed, never deleted). Tests (Windows only; POSIX symlink behaviour still UNVERIFIED): a junction swapped in after the owner check is refused and an outside read-only file keeps its read-only attribute (permissions AND contents), plus direct tests that both fix-ups ignore a link at the top path and link entries. One run of the adapter/disposal set showed a `docker-execution-provider` failure (known load-dependent flake, passed in the next two runs and in the broader run). Still open from that re-audit: marker forgeability (tenant-writable marker), no production wiring or reporting of sweep leftovers, no coordinator-level test of the lease-tied owner branch, the first sweep activity check can throw outside the try, protected test seams on the async path only, POSIX empty-directory rename-back.
  Round 3 (third review; implementing session, NOT re-audited): the orphan sweep now REFUSES marker-less directories by default (`OrphanSweepOptions.reclaimUnowned: true` opts in; existing legacy-directory tests were updated to pass it); its second activity check asks `isWorkspaceAuthoritativelyActive(ws, {runId, leaseId})`, which treats an ACTIVE unexpired lease named by the marker as live; the sweep reports `.disposing-*`/`.provisioning-*` leftovers and skipped directories through `onUnverifiedLeftover`/`onSkipped` callbacks (nothing wires them to a log yet); the magic `"unknown-lease"` string was replaced by `WorkspaceOwner.unknownLease` (a marker whose lease is literally `unknown-lease` is no longer deletable); empty owner ids are rejected at provision; the provisioning escape rollback now removes the created path, not the resolved real path; `executeAction`'s per-action workspace is provisioned with an owner; `RS-C7` maps to ADR D3 (not D5). The null-lease branch of coordinator crash cleanup is unreachable through the state machine: a RUNNING run without a lease id fails the domain invariant, so recovery throws before cleanup (tested). Test-only caveats: the junction-swap test asserts only that nothing outside the root is deleted and was run on Windows only; POSIX rename-over-empty-directory and symlink semantics remain UNVERIFIED. Round 2 (second review of F1-F3; implementing session, NOT re-audited):
  the orphan sweep now checks activity AGAIN after reading the marker (a replacement between the first check and the marker read is skipped if the new attempt is active) and treats an
  unreadable/corrupt/symlinked/wrong-shape marker as UNPROVABLE (never deleted; only a genuinely absent marker is "missing"; sync and async `tolerateMissingMarker` behave alike); owned
  provisioning builds the directory under `.provisioning-<id>-<uuid>` with its marker inside and renames it into place, so a marker-less `<id>` directory is no longer visible during an owned provision;
  `getWorkspaceMetadata(Sync)` reject unsafe ids (they previously read `../outside`); ids that are Windows device names (con/prn/aux/nul/comN/lptN, with any extension) or end in "." are rejected;
  coordinator crash cleanup passes the crashed lease, or an unmatchable sentinel when the lease is unknown, so a marker-bearing directory is refused (cleanup reported failed) instead of
  deleted by an unowned fallback. NEW real-adapter coordinator test file `tests/application/coordinator-crash-cleanup-ownership.test.ts` (4: own workspace discarded; newer-lease marker survives and cleanup is
  reported failed; corrupt marker survives; marker-less legacy workspace still cleaned). STILL OPEN (updated in round 3): marker-less directories are now skipped by default, but an explicit `reclaimUnowned` sweep still has the check-then-delete window for them; the non-worker callers (clean-room verifier, evaluation runner, local eval harness, benchmark runner) still provision without an owner but use their own temp roots, and NO production code runs the sweep (`cleanupOrphanedWorkspacesSafely` has no caller in src/);
  the symlink-swap and POSIX rename-over-empty-directory races (F4/F5); marker forgeability (F6); the protected test seams in production code (F8); any `.provisioning-*` / `.disposing-*` leftovers are never auto-cleaned
  and nothing reports them; `.disposed-*` is finished regardless of the active set (safe now that ids cannot start with ".", but a pre-existing dot-named directory would be removed).
- Tests: `tests/adapters/node-fs-workspace-owned-disposal.test.ts` (65 now incl. rounds 2 and 3, real filesystem, stable over 3 runs; hooks interleave a takeover at both race points, concurrent
  disposals, crash leftovers) and `tests/application/worker-workspace-disposal.test.ts` (9; the former residual-race test now asserts the newer
  attempt's workspace SURVIVES).

**Gate B - stale-worker DB fencing:** unchanged this pass (PASS WITH CONDITIONS earlier). Re-run green: `worker-lease-renewal` (now 39 with the validation tests, run fresh),
`worker-runtime`, `phase31-recovery-fencing`.

**Gate C - lease renewal config: implemented, tested, unaudited.** `validateLeaseRenewalConfig` (called in the `WorkerRuntime` constructor, before any
claim, and in `LeaseRenewalLoop`) throws `RangeError` for NaN/Infinity/zero/negative TTL or interval, interval < 10ms or >= TTL, TTL < 30ms, values above the
Node timer maximum, negative grace/NaN retry delay. Unchanged limits: no provider abort signal, synchronous work can starve the heartbeat timer,
non-ACTIVE lease is transient until nominal expiry, no `assertLeaseHeld` before filesystem mutations, supervisor lease not renewed, `--workers-stopped` still required.

**Gate D - process-level tests: partially verified.** `tests/recovery/recovery-watch-process.test.ts` bundles the real CLI (esbuild to a temp file, no dist writes)
and spawns it. Windows (this machine, fresh): 6 passed / 4 skipped - arg refusals, watch stays alive, SIGKILL then sweep, two hosts coexist. The 4 POSIX tests
(SIGINT, SIGTERM, repeated SIGINT, graceful then sweep) are SKIPPED on Windows (Node cannot deliver signals to a child there) and were NOT executed by vitest.
Real POSIX evidence was gathered instead by running the same bundled CLI in the local `node:22-alpine` image (Node 22.23, not the project's Node 24; scratch script,
not in the repo): SIGINT and SIGTERM while idle => exit 0 with one `recovery.host.stopped` record; repeated SIGINT => exit 0, one record; SIGKILL => 137 and a
later sweep exit 0; two hosts on one DB, 6 rounds => both exit 0. NOT covered: a signal during a sweep/renewal/cleanup (no deterministic hook), watch-mode
restart after abnormal exit (no supervisor process exists), duplicate-host PREVENTION (hosts coexist; per-run supervisor lease exclusivity is the guard).
Two real defects were found only by running the real process and fixed in `src/recovery/recovery-host.ts`: (1) `recovery watch` exited by itself (code 0, no
stop record) because every timer is unref'd - now a ref'd keep-alive interval holds it until abort; (2) a second host starting during another's sweep failed with
"database is locked" because `busy_timeout` was set after the first read - now set right after open.

**Gate E - ADR-0036 scenarios: OWNER CHOSE THE ADR IDS (ADR-0036 section 7.2) AS AUTHORITATIVE. The six scenarios A6, B6, B7, C2, C3, C5 are COVERED under that scheme (implementing session; NOT independently
audited). Test labels relabelled and 9 legacy-only placeholders retired (see below). Awaiting independent audit.**
Evidence per ADR id (what the ADR says the scenario proves -> where it is proven):
- A6 post-read UTF-8 validation: COVERED - `tests/integration/editor-mutation-intent.test.ts` Scenario 11 (read: invalid UTF-8 `0xC3 0x28` rejected with `/Invalid UTF-8 encoding in target file/`, no intent recorded). Scenario 10 covers ADR A7 (null byte).
- B6 pre-rename verification narrows the race: COVERED - implemented (`assertTargetStillExpected` + fence before rename, `durable-rollback-engine.ts` ~345/~985) and now directly tested by NEW
  `restore-rename-failure.test.ts` "ADR-0036 B6": a foreign write landing after the restore temp file is verified but before the rename is detected, preserved (never overwritten), temp removed,
  intent not marked rolled back. As the ADR says, this narrows but does not eliminate the TOCTOU window (an uncooperative writer between check and rename is still possible).
- B7 Windows file-lock (EBUSY) retry and fail-safe: COVERED - `atomicRenameWithRetry` (3 attempts, 50/100ms backoff) now tested both ways by NEW tests: two EBUSY failures then success => restore COMPLETED;
  persistent EBUSY => exactly 3 attempts, target untouched, `RESTORE_FAILED` recorded. (D2 already covered EPERM.) Does not prevent external file locking.
- C2 CP1 recovery (RECORDED, no snapshot -> abort unmutated): COVERED - `crash-point-recovery.test.ts` "CP2: intent RECORDED, no snapshot, file untouched -> ABORTED_UNMUTATED" (the test file's CP numbers differ from the ADR table).
- C3 CP3 recovery (rollback an applying mutation): COVERED - `crash-point-recovery.test.ts` "CP3: APPLYING_MUTATION with file already replaced -> original restored via snapshot, intent ROLLED_BACK" and the "rename never happened" variant.
- C5 restart recovery idempotency: COVERED - `durable-rollback-engine.test.ts` Test 13 (second rollback is a no-op: COMPLETED, same restored paths, content unchanged) and `crash-point-recovery.test.ts` CP7 (event committed idempotently).
  The recovery dedup token itself is exercised through those flows but is not asserted directly.
RELABEL DONE (owner approved; implementing session): all 37 titles in `tests/contract/rollback-safety.test.ts` now carry an `RS-` prefix so they no longer collide with the ADR ids, and the 20 skipped tests are tagged with the ADR-0036
section 7.2 row they correspond to, or `LEGACY - not an ADR-0036 section 7.2 scenario`. Only titles and one header comment changed (skip count still 20; no body or assertion edited). ADR-0036 gained section 7.3 (re-verified rows with
evidence level) and 7.4 (legacy-id mapping); the original 7.2 table was left as recorded, with a status note in 7.1.
RETIRED (owner decision, implementing session): the nine legacy-only skipped placeholders RS-A2, RS-A5, RS-A6, RS-B6, RS-B7, RS-C2, RS-C3, RS-C5 and RS-E6 were REMOVED from `tests/contract/rollback-safety.test.ts` (each was comment-only; a dry run checked no
executable statement was deleted). The file is now 17 passing + 11 skipped (28 tests). ADR-0036 section 7.4 records each retirement and its accepted consequence: no resume/re-enqueue of verification after a crash (rollback instead); no `VERIFICATION_CRASHED` event
reason (`RUN_ROLLBACK`); no lock files or PID-liveness check on takeover (`--workers-stopped` stays an operator assertion); no in-process path serializer (same-path safety rests on one workspace per run, digest preconditions and lease fencing - unproven,
and `ToolPreconditionFailedError` is still not exported); no auto-rollback on syntax error / P2P regression / stagnation (edits stay tracked on disk; STAGNATION halts without restoring). RS-A2/RS-E6 were duplicates of covered invariants.
Gate E status: owner dispositions are complete (6 ADR rows covered, 9 legacy items retired); NOT independently audited. The 11 remaining skips are comment-only markers tagged with the covering ADR row. Un-re-verified 7.2 rows keep their historical
classification (the "27 B-INTERFACE" count is stale). `crash-point-recovery.test.ts` and `restore-rename-failure.test.ts` header comments still use the old legacy ids.

**Gate F - production database (SQLite per ADR-0001/data.md): evidence gathered.** Fresh: 10 persistence files / 145 tests green (WAL + foreign keys + busy timeout on file DBs, reopen
durability, idempotent schema init, migration from an earlier schema, OCC, lease fencing, transaction atomicity) plus new `tests/persistence/two-connection-claim-race.test.ts` (2: two
connections to one file - exactly one claim wins, the loser changes nothing; reclaim by one connection fences the other). Process-level restart recovery: SIGKILL then sweep (Gate D).
Not verified: a configured default production database path (the interactive CLI uses an in-memory control plane and the recovery CLI requires an explicit `--db`; there is no
default), cross-process claim races (only two connections in one process), durability under power loss.

**Gate G - fresh verification (this pass).** Full non-live suite `npx vitest run --exclude "**/*live*.test.ts"`: exit 1, 5825 passed, 26 failed, 25 skipped (5876). Failures: the 25 baseline
(phase32-contract-checkpoint-supervisor 14, post-pass-verification-latch 8, phase48o-contract-remediation 2, controlled-baseline-reflex 1) + `production-components` 10.14 (Ollama
reachability; 40/40 pass in isolation). The same 25 failed before any of this pass's changes (earlier full run in this session), so they are not caused by it; whether they predate commit 40abeec is
UNVERIFIED. `npx tsc --noEmit`: exit 2, 575 errors (unchanged; none in files touched this pass). `npx tsc -p tsconfig.build.json --noEmit`: exit 2, 46 errors (unchanged). `npm run build` NOT run.

**Files changed this pass:** src/domain/errors.ts, src/ports/workspace.port.ts, src/adapters/workspace/node-fs-workspace-adapter.ts, src/application/worker-runtime.ts, src/application/lease-renewal.ts,
src/recovery/recovery-host.ts; new tests: tests/adapters/node-fs-workspace-owned-disposal.test.ts, tests/persistence/two-connection-claim-race.test.ts, tests/recovery/recovery-watch-process.test.ts;
extended: tests/application/worker-lease-renewal.test.ts, tests/application/worker-workspace-disposal.test.ts.

## Commands
- Tests (non-live): `npx vitest run --exclude "**/*live*.test.ts"`   (recovery only: `npx vitest run tests/recovery`)
- Types: `npx tsc --noEmit`      Build: `npm run build` (NOT verified; `bin/emerald.js` needs `dist/`)
- Last result (HISTORICAL, from the original recovery work): 5736 passed, 27 failed (25 baseline + 2 flakes), 575 type errors. Latest fresh numbers are in "Gate G" of the Phase 1 completion pass (and a later broader run: 1321 passed / 25 baseline failures / tsc 575).

## Not done / known issues
- 575 pre-existing `tsc` errors (mostly `durable-rollback-engine.ts`, tests, `counterfactual-replay.ts`).
- 25 baseline failures: 14 `phase32-contract-checkpoint-supervisor` (hard-coded 2026-10-18 dates), 8
  `post-pass-verification-latch`, 2 `phase48o-contract-remediation`, 1 `controlled-baseline-reflex`.
- Flakes that pass in isolation: `docker-execution-provider` (Docker now running, timeouts under load),
  `production-components` 10.14 (Ollama reachability). The `*live*` tests were never run (need authorization).
- Supervisor lease (30s) not renewed during long rollbacks (worker lease renewal is implemented, see above); the six legacy skipped contract tests that were listed here (RS-A6, B6, B7, C2, C3, C5) were RETIRED by owner decision (see Gate E); ADR gaps: temp-file cleanup, RESTORE_FAILED intents, ROLLING_BACK.
- Open design: stable `ws-<runId>` can block a retry if an old directory was not disposed.
- Missing product pieces per Phase 0: HTTP API, UI, model router, kill switch, deployment/backup docs.
- 7 stray junk files in repo root (`({`, `h.`, `pect…`) are untracked; ask the owner before deleting.

## Next step
Present the Phase 0 report + recovery audit to the owner for the gate. If approved: (1) optional final read-only
recovery audit, (2) Phase 1 (PRD, SLOs measured on this i3-N305/7.6 GB/no-GPU box, threat model), (3) decide the
Phase 2 items above (host process, workspace disposal policy, supervisor-lease renewal; worker lease renewal needs an independent audit). Create `docs/PROGRESS.md` only if
the owner wants one.

## Round 4 — bounded fixes (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
**Marker forgeability (F6): mitigated, with stated trust assumptions.** The `.emerald-owner.json` marker is now `{runId, leaseId, mac}` where `mac` =
HMAC-SHA256(workspaceId, runId, leaseId) keyed by `<workspaceRoot>/.emerald-owner-key` (32 random bytes, created at first owned provision, outside every
workspace directory; new module `src/adapters/workspace/owner-marker.ts`). A marker without a valid MAC is "invalid" -> refused/skipped, never deleted through.
It is NOT a security boundary against every tenant: it holds only if tenant code cannot read the key file (true for container-isolated tools that mount only
the workspace; false for a native tool running as the same OS user); a tenant can replay an older marker of the same workspace id; a missing/replaced key makes
all markers unverifiable (fail closed: leaks directories, never deletes). Pre-existing unsigned markers become "invalid" (operator cleanup required).
**Orphan sweep:** an exception from the first activity check now skips that directory (fail closed), is reported via `onSkipped` ("activity check failed: ..."), and the sweep
continues; swallowed per-directory disposal failures are now reported through `onSkipped` too. **Sweep call sites:** no production caller exists
(`cleanupOrphanedWorkspacesSafely` is referenced only by tests), so no logger wiring or production cleanup path was added; callers must supply `onSkipped`/`onUnverifiedLeftover`.
**Restore guard:** the rename-back after a mismatch no longer restores onto any existing path (POSIX `rename(2)` replaces an EMPTY directory; Windows fails); it preserves under `.disposing-*` instead.
**Test seams:** `afterOwnerCheck`/`afterTombstoneRename` stay `protected` no-ops (not on `WorkspacePort`, subclass-only); judged acceptable, no hook added to the sync path.
**`ToolPreconditionFailedError`:** was imported by `edit-file.tool-adapter.ts` and two test files but never defined (root cause of the 2 `phase48o` failures). Now defined in `src/domain/errors.ts`
as a `ToolExecutionFailedError` subclass (`code` TOOL_EXECUTION_FAILED, `subcode` STALE_PRECONDITION; `ToolErrorPayload.subcode` added so the gateway payload carries it).
**Evidence:** targeted run (25 files) exit 0: 458 passed, 15 skipped, 0 failed (adapter, workspace, worker, recovery, phase31, phase48o, editor-mutation-intent, rollback-safety). New:
`tests/application/coordinator-orphan-sweep-ownership.test.ts` (5, coordinator-level, lease-tied), plus 11 adapter tests (authenticated marker, fail-closed sweep, restore guard).
**POSIX:** WSL2 Ubuntu has no Node, and the repo's Windows `node_modules` cannot run there, so the project's POSIX signal tests (4, skipped on Windows) and symlink tests were NOT run on POSIX.
Only the OS primitive was probed with Python in WSL2 (scratch script, not in repo): rename dir over empty dir -> OK (replaces), over non-empty -> ENOTEMPTY, over symlink -> ENOTDIR, rename(symlink) moves the link.
`tsc` and the full suite were not run this round (not authorized).

## Persistent submission-to-recovery vertical slice (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
New: `src/application/durable-submission.ts` (`submitDurableTask`: task + ACTIVE default in-process contract + QUEUED run via RunCoordinator; idempotency-key dedup), CLI `emerald submit --db <file> --operation <name> [--input <json>] [--max-attempts n] [--timeout-ms n] [--idempotency-key k]`
(the only command that creates the DB) and read-only `emerald inspect --db <file> --run-id <id>` (run, result, events). Tests: `tests/e2e/durable-submission-recovery.test.ts` (3 real processes + 1 temp SQLite file: submit CLI -> worker A killed with SIGKILL
while RUNNING under a live lease -> `emerald recovery sweep --workers-stopped --workspace-root` after lease expiry -> worker B claims attempt 2, a stale identity (worker A + old lease) is refused with LeaseLostError while B is RUNNING, B completes -> result 10, gapless events, one terminal
event, second sweep a no-op), `tests/e2e/durable-submit-cli.test.ts` (4), child `tests/e2e/support/durable-worker-child.ts` (production classes; only the `sum` operation is test code).
Proves at-least-once re-execution (operation ran twice), NOT exactly-once. Does not prove: live-zombie fencing (the killed process cannot write), POSIX, the agent-step/tool-gateway loop, models, power-loss durability. No product worker entry point exists (the child is test code).
Result: `npx vitest run` of the 2 new files + recovery/worker/ownership/production-components regression set: 18 files, 311 passed, 4 skipped (POSIX signal tests), exit 0; the e2e test passed 3 consecutive runs. tsc/full suite/build NOT run.

## Production worker CLI (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
New: `emerald worker --db <file> [--once] [--workspace-root <dir>] [--worker-id id] [--lease-ttl-ms n] [--poll-interval-ms n] [--max-runs n]` (`src/application/worker-host.ts`, CLI in `emerald-cli.ts`). It only opens an EXISTING db (never creates/defaults one),
loops `WorkerRuntime.runOnce()` (all claiming, lease renewal, fencing, terminal transitions stay there), logs JSON lines (`worker.started|run.finished|error|stopped`), and never performs recovery. First SIGINT/SIGTERM stops claiming and lets the in-flight run finish
(no provider abort exists); a second signal exits 130 and recovery takes over after lease expiry. Stock operations: `echo`, `sum`, and new `slow` (`SlowOperation`, `{ms<=60000, value}`; named `slow` because the policy layer already maps only echo/sum/slow/fail to capabilities - a first attempt named `delay` was
denied with POLICY_DENIED/UNKNOWN_CAPABILITY, a real lifecycle gap: new operations need a capability mapping in `src/domain/capability.ts` + the default policy). `emerald inspect` now also prints workerId, leaseId, leaseExpiresAt.
Test: `tests/e2e/production-worker-cli.test.ts` (only `emerald` processes: submit -> worker A SIGKILLed while RUNNING -> recovery sweep -> worker B --once, stale-identity fencing while B is RUNNING, result, gapless history, repeated sweep no-op; plus a pre-started worker picking up a later submission, argument/never-create refusals,
--once idle exit; POSIX SIGTERM-graceful test SKIPPED on Windows). `durable-submission-recovery.test.ts` retained as regression. Results: new file 4 passed / 1 skipped, stable over 3 runs; regression set (tests/e2e, tests/recovery, worker-runtime*, lease-renewal, production-components, phase48o) 20 files, 290 passed, 5 skipped, exit 0. tsc/full suite/build not run.
Gaps: no worker heartbeat/registry cleanup, no cancel CLI for durable runs, operations are built-ins only (no agent-step/tool-gateway loop, no model), graceful shutdown unverified on POSIX, supervisor lease still not renewed.

## Worker lifecycle and security audit (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
No production code changed. Added `tests/application/worker-host.test.ts` (4: run > lease TTL keeps its lease and cannot be reclaimed while another connection runs `recoverExpiredRuns`; first abort stops new claims and finishes the in-flight run, queued run left claimable; idle worker stops promptly; config errors claim nothing)
and a POSIX-only second-signal test in `tests/e2e/production-worker-cli.test.ts` (skipped on Windows, never run by vitest on POSIX). Findings (class):
- LIMITATION owner-marker.ts: no key rotation (rotating invalidates every marker, fail closed); (SUPERSEDED: the key mode/type/size check is now enforced on every load, see 'Ownership key permission hardening'); Windows has no ACL hardening.
- LIMITATION marker replay: a tenant can restore an older marker of the same workspace id; the MAC binds id+run+lease, not an attempt counter. Harm is confined to that run's own workspace.
- KNOWN, intentional: `tolerateMissingMarker: true` at run-coordinator.ts ~l.275/859 (crash cleanup) lets a marker-less directory be deleted; a present-but-unauthenticated marker is always refused. A tenant deleting its own marker only enables cleanup of its own directory. `reclaimUnowned` stays opt-in and unused in src.
- LIMITATION supervisor lease (recovery-supervisor.ts l.115, 30s default) is renewed only via `renewSupervisorLease`, not automatically during long rollbacks; `--workers-stopped` remains an operator assertion.
- FALSE POSITIVE "second signal leaves inconsistent state": `process.exit(130)` (emerald-cli.ts ~l.511) writes nothing; the run stays RUNNING until the lease expires, equivalent to SIGKILL (covered by E2E).
- No confirmed defect found in worker-host, renewal, or disposal paths this round.
POSIX evidence (container-level, NOT project vitest): the SAME esbuild bundle of src/cli/main.ts (built on Windows) was run in the local `node:22-alpine` image (Node 22.23.3, not 24; DB on container fs; scratch script outside the repo): SIGTERM -> in-flight run completes, exit 0;
SIGINT then SIGINT -> first waits (still running after 500ms), second exits 130, run still RUNNING, sweep -> QUEUED, worker --once -> COMPLETED with workspace discarded; SIGKILL -> 137, sweep, worker -> COMPLETED; key file mode 600.
The project's own POSIX vitest tests could not run: node_modules holds only win32 esbuild/rollup binaries, WSL has no Node, and installing is not permitted. Linux reproduction: on a Linux machine with Node 24 run `npm ci && npx vitest run tests/e2e/production-worker-cli.test.ts tests/recovery/recovery-watch-process.test.ts tests/adapters/node-fs-workspace-owned-disposal.test.ts`.
Results (Windows): `npx vitest run tests/application/worker-host.test.ts tests/e2e tests/application/worker-lease-renewal.test.ts tests/adapters/node-fs-workspace-owned-disposal.test.ts tests/application/coordinator-orphan-sweep-ownership.test.ts tests/application/coordinator-crash-cleanup-ownership.test.ts tests/recovery`: 20 files, 295 passed, 6 skipped, exit 0.

## Ownership key permission hardening (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
`src/adapters/workspace/owner-marker.ts`: `loadOwnerKey` (called on EVERY marker authentication and every owned provision - no caching) now trusts an existing key only if it is a regular, non-symlink, exactly-32-byte file whose POSIX mode has no group/other bits (`ownerKeyModeProblem`, mode & 0o077 == 0).
The key is opened with O_NOFOLLOW where available and type/mode/size are taken from `fstat` of the same descriptor that is read (no validate-then-use gap). Violations throw `OwnerKeyError` (actionable: `chmod 600`, or delete the key to invalidate all markers); the key is never chmod'ed, repaired or overwritten (also with create=true).
Only a MISSING key yields null (markers then fail verification). The adapter's marker readers rethrow `OwnerKeyError` instead of mapping it to "invalid", so disposal (async and sync, including `tolerateMissingMarker`), provisioning and the orphan sweep (`onSkipped`: "not deleted: ... cannot be trusted ...") refuse with the real reason; nothing is deleted. A directory with no marker at all never consults the key (unchanged legacy path).
Windows: the mode check is NOT performed (POSIX bits are meaningless); protection rests on the root directory's ACL, which is unverified. Compatibility: keys written by earlier versions have mode 0600 on POSIX and stay valid; markers unchanged. A hand-made wider-mode key is now refused until fixed. Not covered: key owner uid, a writer with access to the root, replay of an older marker, TOCTOU between marker verification and the later delete.
Tests: `tests/adapters/owner-marker-key.test.ts` (29 passed / 13 skipped on Windows; the skips are the POSIX real-file mode tests). Targeted regression `npx vitest run tests/adapters tests/application/{worker-workspace-disposal,coordinator-crash-cleanup-ownership,coordinator-orphan-sweep-ownership,workspace-crash-recovery-and-security,workspace-runtime-integration,worker-host}.test.ts tests/e2e tests/recovery`: 34 files, 531 passed, 20 skipped, exit 0 (Windows).
POSIX evidence is container-level only (scratch probe bundling the real modules, node:22-alpine as root; not vitest): modes 640/604/620/602/660/644/666 refused and untouched, insecure key refuses async+sync dispose and sweep skips with reason, chmod 600 restores authentication, symlink key refused, created key mode 600. Mode-000 (unreadable) was untestable as root. The POSIX vitest cases still need a Linux Node 24 run.

## Ownership/disposal adversarial review (read-only; reviewer was a separate model agent that I briefed, NOT an independent human/external review; Phase 1 remains BLOCKED)
No production code changed. The agent ran probes on Windows (Node 24) in scratch; I re-checked findings 1 and 2 against the code. Nothing was verified on POSIX.
No path found that lets a tenant, stale worker or sweep delete another RUN's workspace (MAC binds id; ownership is re-read after rename-aside). Findings:
1. CONFIRMED (code path; latent, medium): `cleanupOrphanedWorkspacesSafely` would dispose a workspace of a run HELD for rollback (`recoverExpiredRuns` holds it, status stays RUNNING with expired lease, run-coordinator.ts ~l.801; `isWorkspaceAuthoritativelyActive` ~l.1453 returns false). Unreachable today (no production caller). Fix before wiring the sweep: treat requiresRollbackBeforeRetry / RECOVERING as active + test.
2. CONFIRMED (probe, low-medium): `ensureWritableRecursive(Sync)` chmods regular files (adapter ~l.818/1018); a hard link inside a workspace to an outside file changes the outside file's mode (444 -> 666 on Windows; POSIX would set 0600). Mitigation: skip when nlink > 1, or skip file chmod on POSIX. Needs a native same-user tenant.
3. PLAUSIBLE (POSIX, unverified): rename-aside does not lock out a live tenant (cwd/open handle/bind mount keeps working inside `.disposing-*`/`.disposed-*`), so symlink swaps during the chmod walk or `rm` traversal are possible; Windows blocks it (rename fails EBUSY/EPERM, fails closed - measured). Reachable if crash cleanup runs while tenant processes survive (`--workers-stopped` is unverified). Mitigation: stop/verify the tenant process tree before owned disposal; O_NOFOLLOW fd-based walk or no file chmod on POSIX. The comment in disposeOwnedWorkspace claiming no other actor can reach the directory holds only for path-based actors.
4. KNOWN LIMITATION, reproduced: replaying attempt L1's genuine marker into L2's workspace (same run id) lets a stale L1 disposal delete L2's workspace; the MAC has no attempt/nonce. Callers with an old lease: stale worker after its fencing txn, the sweep (its first check reads the tenant-writable `.emerald-workspace.json`). Mitigation: per-provision nonce stored outside the workspace in the MAC. NO existing test.
5. PLAUSIBLE (low): a moved-aside newer directory can fail to restore (path retaken); data is stranded under `.disposing-*` (never deleted, never re-adopted). POSIX empty-dir window between the restore's lstat and rename remains.
6. KNOWN: sync path with `tolerateMissingMarker` and no marker uses the legacy unowned delete without rename-aside (async re-checks with lstat; sync does not).
False positives verified: copied marker (MAC), junction inside a workspace (rm removes the link only), symlink/junction/file at the workspace path, tombstone reuse (UUID names), key replaced/truncated/symlinked/widened, repeated recovery sweeps (second finds workspace.disposed). Not verified: POSIX anything, `fs.rm` symlink-swap safety mid-traversal, protected_hardlinks, SQLite locking between hosts, tool-process cleanup before disposal.
Missing tests (invariant): L1-marker replay vs L2 (stale L1 must not delete L2); hard-link outside file mode unchanged; POSIX symlink swap during chmod/rm touches nothing outside root; sweep vs rollback-held run keeps workspace; failure of rename-to-`.disposed-`/rm surfaces, touches nothing outside the tombstone, later sweep finishes; sync-path takeover mid-flight (no hook); POSIX restore-race empty dir; two crash cleanups on one workspace.
Recommendation: cross-run isolation is adequately evidenced on Windows; disposal is NOT sufficiently verified for a Phase 2 production claim until findings 2-4 are decided/fixed and the POSIX tests run.

### Review findings 1 and 2 fixed (owner-authorized; implementing session; not independently audited)
Finding 1: `RunCoordinator.isWorkspaceAuthoritativelyActive` now returns true for a non-terminal run that is RECOVERING or has unreconciled mutations (`requiresRollbackBeforeRetry`, evaluated in its own short transaction - the method must not be called inside a transaction; no current caller does), so the orphan sweep cannot discard a rollback-held workspace.
Finding 2: `ensureWritableRecursive(Sync)` skips files with `nlink > 1`, so a hard link no longer lets disposal chmod a file that also lives outside the workspace (a lstat-then-chmod gap remains for a link created in between). Tests: coordinator-orphan-sweep-ownership (+2: held run survives and agrees with the retry gate; control reclaims), owned-disposal (+2: hard-linked outside file keeps mode/contents, async and sync). Each new test was shown to FAIL with its fix disabled (3 failures), then the fix was restored.
Not tested directly: the RECOVERING branch (simple, but no test); findings 3-6 unchanged and open. Results (Windows): 36 of 37 files passed in the targeted run (564 passed, 20 skipped); the one failure, `docker-execution-provider` "executes deterministic echo operation" (22s), is the known load-dependent flake and passed 16/16 when re-run alone (exit 0). tsc/full suite not run.

### Review finding 4 fixed: stale-attempt marker replay (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
Invariant: a workspace is authenticated as owned only if (a) the marker inside it carries a valid MAC over (workspaceId, runId, leaseId, nonce) AND (b) the OWNERSHIP LEDGER entry `<root>/.emerald-owner-ledger/<workspaceId>.json` (outside every workspace directory, same MAC/key) holds the identical run, lease and nonce. Each owned provisioning draws a fresh random nonce
and atomically replaces the ledger entry (`issueOwnership` in owner-marker.ts, used by `provisionWorkspace`), which retires every earlier marker of that workspace id - nonce included, since the old nonce no longer matches the ledger. Expected ownership is therefore established from the ledger, not the tenant-writable directory. A verified disposal removes the ledger entry if it still names the disposed nonce (`clearOwnership`).
Trust boundary: the ledger shares the key's boundary - a tenant that cannot read the key cannot forge either file; a native same-user tenant that can read the key can forge both (unchanged limitation). A tenant can still make its OWN run's disposal fail (tampering) - fail closed, never a wrong deletion.
Compatibility (breaking, fail closed): markers written before this change (3-field MAC, no nonce) and workspaces with a missing/invalid ledger entry are refused (reader returns "invalid": disposal throws WorkspaceOwnershipError, the sweep skips with "not authenticated"). They are never deleted automatically and need operator cleanup. Nothing in production used them yet. Ledger writes happen BEFORE the rename into place (a crash leaves an inert orphan entry); concurrent provisioning of one id is not supported (a losing provisioner would overwrite the ledger and leave the winner unauthenticatable = leak, not deletion).
Tests: new `tests/adapters/owner-ledger-replay.test.ts` (9: own disposal OK + ledger retired; replay of an older genuine marker refused async/sync/sweep with workspace data, metadata, marker, ledger and root listing byte-identical; old marker + nonce and four splice forgeries refused, genuine marker still works afterwards; wrong run/lease/workspace id; missing ledger and pre-nonce marker refused; tampered ledger refused; crash cleanup -> next attempt -> later attempt works).
Non-vacuous: with the ledger cross-check disabled 6 of the 9 fail; restored, 9 pass. Existing ownership tests were adapted to `issueOwnership`/ledger-aware root listings. Targeted run (Windows): `npx vitest run tests/adapters` + ownership/disposal/coordinator/recovery/worker/worker-host tests + `tests/e2e` + `tests/recovery`: 38 files, 574 passed, 20 skipped, exit 0. tsc/full suite not run; POSIX not run.
Still open: finding 3 (POSIX live-tenant race), 5 (failed restore strands a tombstone), 6 (sync marker-less legacy delete), POSIX project tests, independent human review of the marker design.

### Review finding 3: POSIX live-tenant disposal (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
Process-ownership trace (code paths): the CLI worker uses only `InProcessExecutionProvider` (operations run inside the worker process; tool adapters read/write/edit/search/git are "zero subprocess"). The only tenant-process path is `DockerExecutionProvider` (not wired into `emerald worker`): `docker run --name <c>` with the workspace bind-mounted rw, killed only by the worker's own timeout/output-limit timers and removed in a `finally`; NO labels, no recorded container id, no max lifetime, and nothing in recovery looks for containers. If the worker dies, the container survives and keeps writing through its bind mount into the (renamed-aside) directory. Crash cleanup runs SYNCHRONOUSLY inside the recovery DB transaction (`disposeWorkspaceSync`), so an async docker check cannot be added there without restructuring. `--workers-stopped` remains an operator assertion with no enforcement. => There is NO verified-termination contract; the invariant "no live tenant at disposal" is NOT established anywhere.
Reproduced (Linux container, node:22-alpine/Node 22.23.3, tenant = child process with cwd inside the workspace swapping subdirectories for symlinks while `disposeWorkspace` runs; scratch harness + shim-run of the test file, NOT vitest): (a) disposal against a live tenant fails closed in 100% of 185 trials (ENOTEMPTY, leaving only the verified `.disposed-*` tombstone, which a later sweep removes after the tenant is killed); (b) deletion outside the root: 0 of 185; (c) CONFIRMED DEFECT: the path-based chmod walk (`ensureWritableRecursive`, lstat-then-chmod) changed the mode of an OUTSIDE directory in 4 of 60 trials (0755 -> 0700).
Fix (justified by (c)): on POSIX the permission walk is skipped entirely (`process.platform !== "win32"` early return in both `ensureWritableRecursive` variants) - unlinking needs only parent write permission. After the fix: 0 of 80 trials changed an outside mode. Trade-off: a read-only DIRECTORY inside a workspace now makes POSIX disposal fail closed (EACCES) and the tombstone stays; the sweep reports it via `onSkipped` ("verified tombstone not removable yet") and finishes once an operator fixes the permission. Windows keeps the walk (live handles block the rename there; chmod only toggles the read-only attribute). This does NOT make disposal safe against a live tenant: rm-traversal swap races were not reproduced (0/185) but are not excluded, and Node has no fd-relative (openat) API.
Tests: new `tests/adapters/node-fs-workspace-live-tenant.test.ts` (POSIX only, 2 tests: live-tenant swap trials leave outside files/dir modes/newer attempt's marker+ledger untouched and a post-kill sweep clears all residue; read-only dir fails closed and the sweep reports then finishes). SKIPPED under Windows vitest (2 skipped). Executed on real POSIX only through the esbuild+shim harness in node:22-alpine (root: 1 test run, 1 passed; uid 1000: 2 of 2 passed); with the chmod walk restored the first test FAILED in 3 of 3 container runs ("outside directory mode changed"). Windows targeted run: 38 files passed, 1 skipped, 574 passed, 22 skipped, exit 0. Not run: vitest on POSIX, tsc, full suite.
Missing contract and smallest architectural change (not implemented): (1) label/record every tenant (docker `--label emerald.run=<runId> --label emerald.lease=<leaseId>`, and a bounded container lifetime), (2) a `TenantQuiescence` step that kills and VERIFIES absence of the attempt's tenants BEFORE any owned disposal, failing closed otherwise, (3) run it as an async pre-pass before the recovery transaction (crash cleanup cannot await inside it) and before the worker's own disposal, (4) keep `--workers-stopped` as an additional operator assertion, not the proof. Until then, any provider that can leave tenant processes must not be used with automatic disposal.
Still open: findings 5 and 6, POSIX vitest run, Windows ACLs, independent human review, tsc/full-suite baseline.

Design for the missing contract (finding 3): `docs/adr/ADR-0037-tenant-quiescence-before-workspace-mutation-by-recovery.md` (PROPOSED, design only, owner decisions D1-D5 listed; nothing implemented).

### ADR-0037 rollout steps 1-2 implemented (implementing session; NOT independently audited; Phase 1 remains BLOCKED)
Added `src/ports/tenant-quiescence.port.ts` (port, `TenantModel`, `resolveProviderTenantModel`), `src/recovery/tenant-quiescence-gate.ts` (pre-pass + `tenantModelFromContract`), provider descriptors (`InProcessExecutionProvider.tenantModel = "NONE"`, `DockerExecutionProvider.tenantModel = "ISOLATED_PROCESSES"`, optional `ExecutionProvider.tenantModel/quiescence`),
`excludeRunIds` on `RecoverySupervisor.scanAndRecover` and `RunCoordinator.recoverExpiredRuns`, sweeper option `tenantQuiescence` (result gains `heldForTenantsRunIds`, `needsAttention` status `TENANTS_NOT_QUIESCED`, `summarizeSweep().heldForTenants`) and `RecoveryHostOptions.tenantQuiescence`.
BEHAVIOUR CHANGE: `emerald recovery sweep|watch` now holds (exit 2) any expired/RECOVERING run whose bound contract policy is not IN_PROCESS (or has no binding/contract) because the CLI has no quiescence port yet; in-process runs (the whole E2E milestone) recover as before. No Docker quiescence implementation exists (step 3), no worker-side check (step 4), no real-docker test (step 5).
Tests: new `tests/recovery/tenant-quiescence.test.ts` (10: descriptors; model-from-contract incl. fail-closed cases; pre-pass with fake ports; real store/supervisor/coordinator/NodeFs adapter: isolated crashed run held with state, events and workspace untouched for no port / UNVERIFIED / throwing port; released and recovered on a later QUIESCENT sweep; a held run does not block an in-process run; a live-lease run is never queried).
Non-vacuous: with the exclude set disabled in the sweeper 3 integration tests fail. Windows targeted run (recovery, e2e, adapters, recovery/coordinator/worker/persistence-fencing suites): first run: 39 of 42 files passed, 1 skipped, 2 live-Docker tests timed out (25s/32s, known load flake; `docker-execution-provider` and `sandboxed-command-tool-adapter` passed 40/40 when re-run alone), all else passed (618 passed, 22 skipped). tsc not run: the new code is not compiler-checked.
Open: ADR-0037 steps 3-5 and owner decisions D1-D5, findings 5-6, POSIX vitest run, independent review, tsc/full-suite baseline.

