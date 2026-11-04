# Checkpoint and Resume Gap Matrix
## Emerald Agent Fabric — Milestone 2.16

**Branch:** `master`  
**HEAD:** `e31e845217e25754a4e25b0cd7b5c56f105411f9`  
**Date:** 2026-11-04  
**Status:** Read-only design assessment — no implementation changes

---

## 1. Executive Summary

The existing Emerald implementation has a durable SQLite schema (`mission_checkpoints`), a typed domain model (`MissionCheckpoint`), and a checkpoint persistence API (`RunCoordinator.saveCheckpoint`). However, `AgentStepController` and `WorkerRuntime` **never invoke `saveCheckpoint` during the reasoning loop**. Checkpoints are written only as a supervisor-recovery audit stamp inside `recoverMission`.

The result is that all in-flight agent reasoning state — step budgets, loop counters, the post-pass verification latch, reflex evidence, and the last context snapshot — is entirely ephemeral. A worker crash resets all of this to zero regardless of how many steps have already executed.

The smallest safe improvement is not a new checkpoint database or a new recovery engine. It is:

1. Serializing six in-memory step-controller fields into the existing `durableState` column of the existing `mission_checkpoints` table after each completed step.
2. Reading that checkpoint back at the start of `runStepLoop` and restoring those fields before resuming.
3. Adding a fallback latch reconstruction path from the durable `run_events` log.
4. Recording the artifact baseline commit SHA in the existing `run_workspace_bindings` table.

No schema migration is required for items 1–3. Item 4 requires one new nullable column.

---

## 2. Baseline Verification

| Fact | Verified |
|---|---|
| Branch | `master` |
| HEAD SHA | `e31e845217e25754a4e25b0cd7b5c56f105411f9` |
| Working tree | Clean (zero modifications, zero untracked files) |
| `docs/research/` exists | Created in this milestone |
| `mission_checkpoints` table in schema | ✅ `src/adapters/persistence/schema.ts` lines 179–197 |
| `insertCheckpoint` / `getLatestCheckpoint` in `StateStorePort` | ✅ `src/ports/state-store.port.ts` lines 57–68, 186–190, 276–278 |
| `saveCheckpoint` in `RunCoordinator` | ✅ `src/application/run-coordinator.ts` lines 1701–1740 |
| `saveCheckpoint` called from `AgentStepController` | ❌ Never |
| `saveCheckpoint` called from `WorkerRuntime` | ❌ Never |
| Checkpoint read on `runStepLoop` entry | ❌ Never |

---

## 3. Component Inventory

> [!NOTE]
> Status labels used throughout this document:
> - ✅ **Implemented and verified** on the governed repair route
> - ⚠️ **Implemented but not verified** on the governed repair route
> - 🔶 **Partially implemented**
> - ❌ **Not implemented**
> - ❓ **Unknown — insufficient evidence**

| Component | File | Status | Notes |
|---|---|---|---|
| `MissionCheckpoint` domain model | `src/ports/state-store.port.ts` | ✅ | Fields: `checkpointId`, `runId`, `checkpointVersion`, `contractBinding`, `actionId`, `attemptNumber`, `durableState`, `eventSequence`, `createdAt`, `updatedAt` |
| `mission_checkpoints` SQLite table | `src/adapters/persistence/schema.ts` | ✅ | `UNIQUE(run_id, checkpoint_version)`, strictly monotonic version enforced |
| `insertCheckpoint` | `src/adapters/persistence/sqlite-state-store.ts` lines 1920–2035 | ✅ | Validates foreign keys, enforces `contractBinding` match, enforces monotonic version, serializes `durableState` with byte ceiling |
| `getLatestCheckpoint` | `src/adapters/persistence/sqlite-state-store.ts` line 3085 | ✅ | `ORDER BY checkpoint_version DESC LIMIT 1` |
| `RunCoordinator.saveCheckpoint` | `src/application/run-coordinator.ts` lines 1701–1740 | ✅ | Atomic transaction with optional supervisor lease fencing |
| `RunCoordinator.recoverMission` | `src/application/run-coordinator.ts` lines 2101–2127 | ✅ | Writes checkpoint with `durableState: { status: "RECOVERED" }` after supervisor recovery — this is the **only** call site |
| Step budgets in `AgentStepController` | `src/application/agent-step-controller.ts` lines 918–950 | ❌ | `stepCount`, `actionCount`, `consecutiveFailures`, `proposalRejections`, `consecutiveIdenticalReads`, `consecutiveIdenticalWrites` are local variables only |
| Checkpoint write on step completion | `src/application/agent-step-controller.ts` | ❌ | Never called |
| Checkpoint read on `runStepLoop` entry | `src/application/agent-step-controller.ts` | ❌ | Never called |
| `PostPassVerificationLatch` | `src/application/post-pass-verification-latch.ts` | 🔶 | Implements latch correctly; explicitly cleared on `runStepLoop` start; not persisted |
| Latch reconstruction from events | `src/application/post-pass-verification-latch.ts` | ❌ | No `reconstructFromEvents` method |
| `ContextSource` reads checkpoint | `src/application/context/context-source.ts` | ❌ | Reads `runs`, `mission_contracts`, `actions`, `attempts` only |
| Artifact baseline SHA in SQLite | `src/adapters/persistence/schema.ts` | ❌ | `run_workspace_bindings` does not store baseline commit SHA |
| `ProductionRecoveryService.safeToResume` | `src/recovery/production-recovery-service.ts` line 107 | ⚠️ | Hardcoded `false`; interruptions go to `FAILED` on the control-plane route |

---

## 4. Field-Level Checkpoint Completeness Matrix

| Field | Current Location | Durable? | Authoritative? | Reconstructible? | Can Become Stale? | If Missing or Inconsistent |
|---|---|---|---|---|---|---|
| Run ID, Task ID | `runs`, `tasks` SQLite | ✅ | ✅ | ❌ Primary | No | Fails fast: `Run not found` |
| Mission contract ID, version, hash | `runs(contract_id, version, contract_hash)`, `mission_contracts` | ✅ | ✅ | ✅ Via `computeCanonicalHash` | ✅ If revoked | `ContractIntegrityError` or `MissingBoundContractError` |
| Workspace ID, path, ownership token | `run_workspace_bindings`, `.emerald-workspace` marker | ✅ | ✅ | ✅ ID is `ws-${runId}` | ✅ If lease lapses | `WorkspaceOwnershipError` or `WorkspaceBindingConflictError` |
| Repository import identity | `tasks.input_payload.repositoryPath` | ✅ | ✅ | ✅ | No | Re-import on retry |
| Artifact baseline identity (commit SHA) | `<artifactRoot>/<runId>/attempt-<n>/baseline.git` — **disk only** | 🔶 | 🔶 Split | 🔶 From Git if disk intact | No | `exportArtifact` throws `no baseline exists for this attempt` |
| Current Action ID, status | `actions` SQLite | ✅ | ✅ | ✅ | ✅ If crashed mid-transition | Sweeper reconciles `RUNNING` → `FAILED`/`RETRYING` |
| Current Attempt ID, status | `attempts` SQLite | ✅ | ✅ | ✅ | ✅ If crashed | Reconciled to `UNKNOWN` or `CANCELLED` |
| Completed Action history | `actions`, `run_events` SQLite | ✅ | ✅ | ✅ Query by `run_id` | No | Serial continuity enforced |
| UNKNOWN / nonterminal Attempt handling | `attempts(status = 'UNKNOWN')`, `run_events` | ✅ | ✅ | ✅ | No (terminal) | Replay gate blocks re-dispatch |
| **Step count** | `AgentStepController` local variable | ❌ | ❌ | 🔶 Approximate: count `actions` + scan events | ✅ Resets on crash | Budgets reset to 0; looping tasks consume more steps than permitted |
| **Action count** | `AgentStepController` local variable | ❌ | ❌ | ✅ Count `actions WHERE run_id = ?` | ✅ Resets on crash | Same risk |
| **`consecutiveFailures`** | `AgentStepController` local variable | ❌ | ❌ | 🔶 Scan recent `actions` events | ✅ Resets on crash | Consecutive-failure guard evaded across crashes |
| **`proposalRejections`** | `AgentStepController` local variable | ❌ | ❌ | 🔶 Scan `proposal.rejected` events | ✅ Resets on crash | Same |
| **`consecutiveIdenticalReads`** | `AgentStepController` local variable | ❌ | ❌ | ❌ Not in event log | ✅ Resets on crash | Read-stagnation guard evaded across crashes |
| **`consecutiveIdenticalWrites`** | `AgentStepController` local variable | ❌ | ❌ | ❌ Not in event log | ✅ Resets on crash | Write-stagnation / identical-loop guard evaded across crashes |
| Last accepted proposal, raw observations | `AgentStepController` in-memory transcript | ❌ | ❌ | 🔶 Observations re-gathered from SQLite; raw proposal body lost | ✅ Resets | Next model turn re-queries without prior-step feedback |
| Context snapshot ID, content hash | `ContextSnapshot.snapshotId`, `contextHash` (memory) | ❌ | ❌ | 🔶 Recomputed if inputs identical | Yes (ephemeral) | New snapshot built with current timestamp |
| Model provider, model name, config | CLI flags at startup; contract policy in DB | 🔶 | 🔶 | ✅ From startup args + contract | No | Worker fails at startup if mismatch |
| Reflex state and evidence | `ReflexEvidence` in controller transcript (memory) | ❌ | ❌ | ❌ Not in events | Yes | Prior reflex decisions lost on restart |
| **Post-pass latch state** | `PostPassVerificationLatch` (memory) | ❌ | ❌ | ✅ **Via `run_events` scan** (`clean_room.verified`) | ✅ Clears on restart | Agent may re-edit a file whose tests already passed |
| Artifact attempt number | `runs.attempt_count` SQLite | ✅ | ✅ | ✅ | No | Retry increments to `attempt-<n+1>` |
| Artifact baseline ref (SHA) | Disk: `baseline.git` — **not in SQLite** | 🔶 | 🔶 | 🔶 Git only | No | Cannot verify provenance if disk path changes |
| Exported artifact reference | `workspace.cleaning` event payload (`patchSha256`, `patchBytes`) | ✅ | ✅ | ✅ From event log | No | Re-export is idempotent |
| Event sequence number | `run_events.sequence` SQLite | ✅ | ✅ | ✅ Strictly monotonic | No | Conflicts rejected |
| Checkpoint schema version | `mission_checkpoints.checkpoint_version` SQLite | ✅ | ✅ | ✅ | No | `CheckpointVersionConflictError` |

**Bold rows** are the fields currently missing from the checkpoint contract. They are the target of the minimal implementation plan.

---

## 5. Gap Analysis

### Gap 1 — CRITICAL: Step Controller Budgets Are Ephemeral
- **File:** `src/application/agent-step-controller.ts` lines 918–950
- **Detail:** `stepCount`, `actionCount`, `consecutiveFailures`, `proposalRejections`, `consecutiveIdenticalReads`, `consecutiveIdenticalWrites` live in local variables within `runStepLoop`. They are never written to any durable store.
- **Risk:** Every worker crash resets all loop guards to zero. A failing task cycling across multiple crashes consumes more model calls, more elapsed time, and more filesystem mutations than any single-run budget permits. The step loop's bounded-execution guarantee does not survive process boundaries.
- **Severity:** CRITICAL — safety invariant broken across crashes.

### Gap 2 — CRITICAL: `AgentStepController` Never Calls `saveCheckpoint`
- **File:** `src/application/agent-step-controller.ts`, `src/application/worker-runtime.ts`
- **Detail:** The `saveCheckpoint` API in `RunCoordinator` is production-ready. No call site exists in the agent step loop. The checkpoint table exists in SQLite with zero rows from normal execution.
- **Risk:** No warm resume is possible. Every retry is a cold restart from step 0.
- **Severity:** CRITICAL — checkpoint primitive exists but is disconnected.

### Gap 3 — HIGH: Post-Pass Latch Not Persisted
- **File:** `src/application/post-pass-verification-latch.ts`
- **Detail:** The latch is explicitly cleared at `runStepLoop` start. If the worker crashes after intermediate tests pass but before task completion, the latch is gone on re-entry and the agent may mutate a verified file.
- **Mitigation path:** Scan `run_events` for `clean_room.verified` or `verification.completed` to reconstruct the locked file set. This reconstruction path does not currently exist.
- **Severity:** HIGH — correctness regression is possible on interrupted runs.

### Gap 4 — HIGH: Artifact Baseline SHA Not in SQLite
- **File:** `src/adapters/workspace/git-artifact-exporter.ts`, `src/adapters/persistence/schema.ts`
- **Detail:** `captureBaseline` creates `baseline.git` on disk. Neither `runs`, `run_workspace_bindings`, nor `mission_checkpoints` stores the resulting commit SHA. The database has no cryptographic reference to the baseline.
- **Risk:** If the artifact root path changes or the disk is replaced, there is no way to verify the patch against its baseline from durable state alone.
- **Severity:** HIGH — provenance chain is broken between SQLite and artifact export.

### Gap 5 — MEDIUM: `ProductionRecoveryService` Hardcodes `safeToResume = false`
- **File:** `src/recovery/production-recovery-service.ts` line 107
- **Detail:** The comment at that line reads: *"In local-first zero-cost execution, there is no automatic checkpoint resume engine for interrupted runs. Interrupted execution is fenced and transitioned to terminal FAILED."*
- **Risk:** Even after Gaps 1–4 are resolved, the control-plane recovery path will not use the checkpoint resume capability until this policy is updated.
- **Severity:** MEDIUM — blocked by upstream gaps; must be addressed in a subsequent sub-milestone.

### Gap 6 — LOW: `ContextSource` Does Not Read Checkpoints
- **File:** `src/application/context/context-source.ts`
- **Detail:** `ContextSource` reads `runs`, `mission_contracts`, `actions`, `attempts`. It does not read `mission_checkpoints`. Context reconstruction is therefore always cold: re-gathered from raw tables every step.
- **Risk:** No impact on correctness. After implementing Gap 2, a resumed agent can seed `ContextSource` using the checkpoint's `eventSequence` to bound how much history it re-reads.
- **Severity:** LOW — optimization only after Gaps 1–3 are closed.

---

## 6. Working Memory Evaluation

| File | Durable Equivalent | Useful? | Authoritative or Advisory? | Rebuildable? | Location |
|---|---|---|---|---|---|
| `task.md` | ✅ `tasks`, `mission_contracts` SQLite | Advisory | Advisory only — danger if model treats as authoritative | 100% from DB | Disposable workspace (advisory copy) |
| `progress.md` | ✅ `actions`, `attempts`, `run_events` | Advisory | Advisory | 100% from DB | Disposable workspace or evidence bundle |
| `findings.md` | 🔶 Partial — tool outputs in `attempts.output_payload`; synthesized reasoning not stored | Useful for long-horizon planning | Advisory | ❌ Not deterministically rebuildable | Disposable workspace; preserved in `patch.diff` if committed |
| `files-read.json` | ✅ `actions WHERE tool_name = 'read_file'` | Largely redundant | Advisory | 100% from DB | Omit; use `ContextEngine` |
| `project-index.json` | ❌ No AST index in SQLite | ✅ Useful tool cache | Advisory | 100% from filesystem scan | `.emerald/cache/` — excluded from artifacts |
| `artifacts/` | ✅ `GitArtifactExporter` external path | ⚠️ **PROHIBITED inside workspace** | Authoritative | ✅ From baseline.git + diff | Strictly outside workspace: `artifactRoot/<runId>/attempt-<n>/` |
| `logs/` | ✅ `run_events` SQLite | Advisory | Advisory | 100% from events | External host log path |
| `repository/` | ✅ Imported by `NodeFsRepositoryImporter` | ✅ Core execution tree | Disposable working copy | 100% from source repo | Disposable workspace (`workspaceHandle.hostPath`) |

**Key invariant:** `artifacts/` must never reside inside the workspace directory. Untrusted agent tools (`write_file`, shell) could corrupt or falsify baselines and exported patches.

---

## 7. Architecture Recommendation

### Principle
Reconstruct from durable records wherever possible. Checkpoint only what cannot be reconstructed. Never duplicate the event log or state store.

### What to Checkpoint (write into `durableState`)
After each completed step in `AgentStepController.runStepLoop`:

```typescript
// Minimal durable state — proposed shape for durableState JSON
{
  "checkpointSchemaVersion": 1,
  "stepCount": number,
  "actionCount": number,
  "consecutiveFailures": number,
  "proposalRejections": number,
  "consecutiveIdenticalReads": number,
  "consecutiveIdenticalWrites": number,
  "postPassLatchSnapshot": PostPassLatchSnapshot | null,
  "duplicateProposalDetectorSnapshot": string[] | null
}
```

All other state is reconstructed from existing durable records (runs, actions, attempts, events).

### What to Reconstruct (not checkpoint)
| Field | Reconstruction source |
|---|---|
| Run, mission contract, workspace | `runs`, `mission_contracts`, `run_workspace_bindings` |
| Completed actions and their outcomes | `actions` table |
| Attempt outcomes | `attempts` table |
| Model observations | `ContextSource` re-gather |
| Post-pass latch (fallback) | Scan `run_events` for `clean_room.verified` |
| Context snapshot | Re-build via `ContextEngine` |

### Component Changes (Minimal)

| Component | Change | Type |
|---|---|---|
| `AgentStepController` | Call `saveCheckpoint` after each completed step | Integration |
| `AgentStepController` | On `runStepLoop` entry: call `getLatestCheckpoint`, restore counters | Integration |
| `PostPassVerificationLatch` | Add `getSnapshot()` and `reconstructFromEvents(events)` | Extension |
| `run_workspace_bindings` schema | Add nullable `baseline_commit_sha TEXT` column | Schema migration |
| `GitArtifactExporter` | Write `baseline_commit_sha` to DB after `captureBaseline` | Integration |
| `ProductionRecoveryService` | Update `safeToResume` policy after above gaps are closed | Policy update |

### What Stays Unchanged
- `StateStorePort` interface — no new methods needed
- `WorkerRuntime` — no structural changes
- `RunCoordinator` — `saveCheckpoint` already exists; only the call site is new
- `RecoveryDecisionPolicy` — no changes
- `TenantQuiescenceGate` — no changes
- `DurableRollbackEngine` — no changes
- Delivery semantics: at-least-once remains

### Schema Migration
Only one new column: `baseline_commit_sha TEXT` on `run_workspace_bindings`.  
Existing `mission_checkpoints` table requires no changes — `durableState` is an open JSON field.

### Compatibility
Existing checkpoints written by `recoverMission` have `durableState: { status: "RECOVERED" }`. Resume logic must gracefully handle checkpoints where the new fields are absent (treat as cold start, log a warning).

---

## 8. Minimum Implementation Plan

> [!IMPORTANT]
> Each sub-milestone is a focused pull request with a single clear purpose. Do not combine them.

### Sub-milestone 2.16-A: Post-Pass Latch Persistence and Reconstruction
**Purpose:** Eliminate the highest-correctness risk (Gap 3) with zero schema changes.  
**Files changed:**
- `src/application/post-pass-verification-latch.ts` — add `getSnapshot(): PostPassLatchSnapshot | null` and `reconstructFromEvents(events: readonly PersistedEvent[]): void`
- `tests/unit/post-pass-verification-latch.test.ts` — add reconstruction tests  

**Tests:** Unit tests for `reconstructFromEvents` using synthetic `clean_room.verified` and `verification.completed` event fixtures.  
**Out of scope:** Checkpoint writes, schema migration, `ProductionRecoveryService`.

---

### Sub-milestone 2.16-B: Step Budget Checkpointing
**Purpose:** Eliminate Gaps 1 and 2 — make step budgets and loop counters survive process boundaries.  
**Files changed:**
- `src/application/agent-step-controller.ts` — write checkpoint after each step; restore on entry
- `src/application/post-pass-verification-latch.ts` (depends on 2.16-A)
- `tests/integration/agent-step-controller-resume.test.ts` — new test: simulate crash mid-loop, verify resumed controller restores counters

**Tests:** Integration test using an in-memory `StateStorePort` stub — simulate N steps, return a checkpoint, verify restored `stepCount`, `consecutiveFailures`, and latch state.  
**Out of scope:** Schema migration, `ProductionRecoveryService`, real SQLite integration.

---

### Sub-milestone 2.16-C: Artifact Baseline SHA in SQLite
**Purpose:** Close Gap 4 — link the durable run record to the artifact baseline cryptographically.  
**Files changed:**
- `src/adapters/persistence/schema.ts` — add `baseline_commit_sha TEXT` column to `run_workspace_bindings`; add migration guard
- `src/ports/state-store.port.ts` — extend `WorkspaceBindingRecord` type with optional `baselineCommitSha`
- `src/adapters/workspace/git-artifact-exporter.ts` — write `baselineCommitSha` to DB after `captureBaseline`
- `tests/integration/artifact-baseline-sha.test.ts` — verify SHA is stored and readable

**Tests:** Integration test using in-memory Git + SQLite fixture.  
**Out of scope:** Resume path, `ProductionRecoveryService`.

---

### Sub-milestone 2.16-D: `ProductionRecoveryService` Resume Policy
**Purpose:** Close Gap 5 — allow the control-plane recovery path to use warm checkpoints.  
**Prerequisite:** 2.16-A, 2.16-B, 2.16-C completed and merged.  
**Files changed:**
- `src/recovery/production-recovery-service.ts` — replace `safeToResume = false` with checkpoint-based decision; query `getLatestCheckpoint`; validate contract binding and latch snapshot before returning `safeToResume = true`

**Tests:** Unit test for the resume decision — checkpoint present vs. absent vs. mismatched contract.  
**Out of scope:** Live model execution, full end-to-end repair.

---

## 9. Stop Conditions

Stop and escalate for review if:
- The `durableState` JSON column in existing production databases contains checkpoint rows whose structure conflicts with the proposed `checkpointSchemaVersion: 1` shape (inspect `mission_checkpoints` rows before proceeding).
- `PostPassVerificationLatch` reconstruction from events produces a latch set that disagrees with in-memory state on a live run (indicates an event-log integrity problem, not a latch problem).
- The `run_workspace_bindings` schema migration cannot be applied in WAL mode without locking running workers (verify with an in-memory DB migration test before merging 2.16-C).
- Any sub-milestone test reveals that `ContextSource` re-gather produces a different observation set than the checkpoint sequence implies (indicates a durable observation ordering problem).

---

## 10. Sources

| Claim | Source |
|---|---|
| `MissionCheckpoint` schema | `src/ports/state-store.port.ts:57–68, 186–190, 276–278` |
| `mission_checkpoints` table | `src/adapters/persistence/schema.ts:179–197` |
| `insertCheckpoint` monotonic enforcement | `src/adapters/persistence/sqlite-state-store.ts:1920–2035` |
| `saveCheckpoint` only called from `recoverMission` | `src/application/run-coordinator.ts:1701–1740, 2101–2127` |
| Step counters as local variables | `src/application/agent-step-controller.ts:918–950` |
| Latch cleared on `runStepLoop` entry | `src/application/post-pass-verification-latch.ts:99` |
| Baseline git on disk only | `src/adapters/workspace/git-artifact-exporter.ts:99` |
| `safeToResume = false` | `src/recovery/production-recovery-service.ts:107` |
| `ContextSource` reads only actions/attempts | `src/application/context/context-source.ts` |
| `REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT` | `src/application/worker-runtime.ts` |
| `decideRecovery` decision table | `src/application/recovery-decision-policy.ts:1–168` |
| Tenant quiescence gate | `src/recovery/tenant-quiescence-gate.ts:60` |
| `DurableRollbackEngine` path progress | `src/recovery/durable-rollback-engine.ts:1–1250` |
