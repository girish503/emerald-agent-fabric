# Checkpoint and Resume — State Transition Matrix
## Emerald Agent Fabric — Milestone 2.16

**Branch:** `master`  
**HEAD:** `e31e845217e25754a4e25b0cd7b5c56f105411f9`  
**Date:** 2026-11-04  
**Status:** Read-only design assessment — no implementation changes

---

## 1. Purpose

This document is the companion to `checkpoint-resume-gap-matrix.md`.  
It enumerates every crash point in the governed repair lifecycle, records what the **current code actually does**, specifies what **safe behavior** requires, and identifies the authoritative persisted evidence for each decision.

The goal is a decision table that future implementation can be verified against. Each row is a contract, not a suggestion.

---

## 2. Reading This Document

### Status Labels

| Symbol | Meaning |
|---|---|
| ✅ | Existing code behavior matches safe behavior |
| 🔶 | Existing code is partially correct or conditionally safe |
| ❌ | Existing code does not meet safe behavior requirement |
| ❓ | Unknown — insufficient source evidence |

### Column Definitions

- **Scenario** — The exact process crash or interruption point.
- **Existing behavior** — What the current implementation does, with source references.
- **Safe behavior** — What the system must do to preserve correctness invariants.
- **Model again?** — Whether the model may be re-invoked for this reasoning turn.
- **Operation dispatched again?** — Whether the tool may be re-executed against the filesystem or sandbox.
- **Verification again?** — Whether the verification step must be repeated.
- **Workspace access?** — Whether the workspace directory may be accessed.
- **Artifact export again?** — Whether `exportArtifact` may be re-run.
- **Authoritative evidence** — The specific persisted record or event that makes the decision deterministic.
- **Status** — Whether existing behavior satisfies the safe behavior requirement.

---

## 3. Pre-Execution Crash Scenarios

### Scenario 1 — Crash Before Model Invocation

The worker claimed the run, provisioned the workspace, imported the repository, captured the artifact baseline, initialized `AgentStepController`, and then crashed before the first model call returned.

| Attribute | Value |
|---|---|
| **Existing behavior** | Run stays `RUNNING` (or `LEASED`) until `lease_expires_at`. Sweeper detects expiry, marks lease `EXPIRED`, transitions run `RECOVERING` → `QUEUED`. On retry, worker re-enters from scratch; workspace is disposed and re-provisioned. Source: `src/application/run-coordinator.ts:802–845`, `src/recovery/recovery-sweeper.ts:90–135` |
| **Safe behavior** | Same. No action row exists; re-entry is fully safe. If a checkpoint was previously written (after prior steps), restore it. Otherwise cold-start. |
| **Model again?** | ✅ Yes |
| **Operation dispatched again?** | N/A (no action proposed) |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes (after quiescence and rollback) |
| **Artifact export again?** | N/A (no artifact produced) |
| **Authoritative evidence** | Zero rows in `actions` for this run; `runs.lease_expires_at < nowIso` |
| **Status** | ✅ Existing behavior is safe |

---

### Scenario 2 — Crash During Model Invocation (No Response Received)

The model HTTP call was in-flight when the process died. No response body was received or persisted.

| Attribute | Value |
|---|---|
| **Existing behavior** | Identical to Scenario 1 — lease expires, run requeued. Source: `src/application/run-coordinator.ts:802–845` |
| **Safe behavior** | Same. No proposal was recorded; re-invoke the model on re-entry. |
| **Model again?** | ✅ Yes |
| **Operation dispatched again?** | N/A |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | Absence of `proposal.rejected` or `action.created` events for this step |
| **Status** | ✅ Existing behavior is safe |

---

### Scenario 3 — Model Response Received, Proposal Not Persisted

The model returned a response. The step controller began evaluating it. The process died before any database write (before `proposal.rejected` or `action.created` events).

| Attribute | Value |
|---|---|
| **Existing behavior** | Response lost in memory. Lease expires, run requeued. Sweeper finds no action row for this step. Source: `src/application/run-coordinator.ts:802–845` |
| **Safe behavior** | Same. Re-invoke model on next step. The model will re-propose; the ContextEngine will rebuild the same observations. |
| **Model again?** | ✅ Yes |
| **Operation dispatched again?** | N/A |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | Absence of `action.created` or `proposal.rejected` event in `run_events` for this step sequence |
| **Status** | ✅ Existing behavior is safe |

---

### Scenario 4 — Proposal Persisted, Action Not Created

The proposal passed all 11 validation stages and reflex evaluation. The process died before `WorkerRuntime.executeAction` wrote to the `actions` table.

| Attribute | Value |
|---|---|
| **Existing behavior** | A `proposal.rejected` event exists (if rejected) or no action row exists (if approved but not yet written). Lease expires; run requeued. Worker re-enters and model re-proposes. Source: `src/application/agent-step-controller.ts:1167–2050` |
| **Safe behavior** | Re-run the turn; allow the model to re-propose. The new proposal may differ; this is acceptable. |
| **Model again?** | ✅ Yes |
| **Operation dispatched again?** | N/A |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | Absence of `action.created` event in `run_events`; presence of valid workspace binding |
| **Status** | ✅ Existing behavior is safe |

---

## 4. Action and Attempt Crash Scenarios

### Scenario 5 — Action Created, Attempt Not Inserted

The action row was inserted (`status: "RUNNING"`, `activeAttemptNumber: 1`) and the `action.started` event was persisted. The process died before the attempt row was inserted.

| Attribute | Value |
|---|---|
| **Existing behavior** | `isStartedAttemptRowMissing` returns `true` from `decideRecovery`. Decision: `NO_ACTION` for idempotent operations (re-entry allowed); fail-closed for non-idempotent. Source: `src/application/recovery-decision-policy.ts:109`, `src/application/worker-runtime.ts` |
| **Safe behavior** | For **idempotent** tools: re-enter `executeAction`, insert the missing attempt row, and dispatch. For **non-idempotent** tools: fail action with `EXECUTION_UNCERTAIN` — the tool may already have run. |
| **Model again?** | ❌ Not until action is resolved |
| **Operation dispatched again?** | ✅ Yes for IDEMPOTENT; ❌ Strictly NO for NON_IDEMPOTENT |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | `actions.active_attempt_number === 1` AND `SELECT COUNT(*) FROM attempts WHERE action_id = ? === 0` |
| **Status** | 🔶 Recovery decision is correct; re-entry path for idempotent needs explicit test coverage |

---

### Scenario 6 — Attempt `CREATED`

The attempt row was inserted. The process died before `attempt.dispatched` was written (before the tool was handed to `ToolExecutionGateway`).

| Attribute | Value |
|---|---|
| **Existing behavior** | `decideRecovery` transitions attempt to `CANCELLED`. Idempotent action transitions to `RETRYING`; non-idempotent transitions to `FAILED` with `WORKER_CRASHED`. Source: `src/application/recovery-decision-policy.ts:1–168` |
| **Safe behavior** | Same. Tool was never physically dispatched; cancellation is safe. Idempotent operations may retry as Attempt 2. |
| **Model again?** | ✅ Yes (once action is `FAILED`, model receives observation and proposes next step) |
| **Operation dispatched again?** | ✅ Yes for IDEMPOTENT (as new Attempt); ❌ No for NON_IDEMPOTENT |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | `attempts.status === "CREATED"` and `attempt.dispatched` absent from `run_events` |
| **Status** | ✅ Existing behavior is correct |

---

### Scenario 7 — Attempt `DISPATCHED`

The attempt was handed to `ToolExecutionGateway`. The process died before `attempt.started` was recorded (the tool may or may not have begun physical execution).

| Attribute | Value |
|---|---|
| **Existing behavior** | `decideRecovery` transitions attempt to `UNKNOWN` (`LEASE_EXPIRED_DURING_EXECUTION`). Action transitions to `FAILED` (`EXECUTION_UNCERTAIN`). Replay gate (`REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT`) permanently blocks identical non-idempotent re-dispatch. Source: `src/application/recovery-decision-policy.ts:1–168`, `src/application/worker-runtime.ts` |
| **Safe behavior** | Fail closed. Side effect is uncertain. Model receives `UNKNOWN` observation and must reason about next step (e.g. inspect filesystem to verify whether the write occurred). |
| **Model again?** | ✅ Yes (with `UNKNOWN` context) |
| **Operation dispatched again?** | ❌ Strictly NO for NON_IDEMPOTENT; ✅ Yes for IDEMPOTENT only after tenant quiescence established |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Only after tenant quiescence confirmed (`tenant_launch_gates.state === "QUIESCED"`) |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | `attempts.status === "UNKNOWN"`; `actions.error_payload.code === "EXECUTION_UNCERTAIN"` |
| **Status** | ✅ Existing behavior is correct (fail-closed) |

---

### Scenario 8 — Attempt `RUNNING`

The tool began physical execution. The process died mid-execution (filesystem write partially applied, or shell command partially executed).

| Attribute | Value |
|---|---|
| **Existing behavior** | `decideRecovery` transitions attempt to `UNKNOWN`. Action transitions to `FAILED` (`EXECUTION_UNCERTAIN`). `RESUME_BLOCKED_PRIOR_DISPATCH` guard prevents re-dispatch. Source: `src/application/worker-runtime.ts` |
| **Safe behavior** | Same. The tool's side effect cannot be determined. Model receives `UNKNOWN`; rollback engine should revert any `mutation_intents` that were committed but whose completion was not confirmed. |
| **Model again?** | ✅ Yes (with `UNKNOWN` context) |
| **Operation dispatched again?** | ❌ NO for NON_IDEMPOTENT |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Only after tenant quiescence |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | `attempts.status === "UNKNOWN"`; `actions.status === "FAILED"`; partial `mutation_intents` rows |
| **Status** | ✅ Existing behavior is correct; `DurableRollbackEngine` handles partial mutations |

---

### Scenario 9 — Attempt `UNKNOWN`

The attempt reached terminal state `UNKNOWN` from a prior crash cycle and is now in a stable but unresolved state.

| Attribute | Value |
|---|---|
| **Existing behavior** | `UNKNOWN` is a terminal state in `attempts`. Replay gate permanently blocks re-dispatch of the identical non-idempotent proposal. Run proceeds to next agent step (model receives `UNKNOWN` observation). Source: `src/application/worker-runtime.ts` |
| **Safe behavior** | Same. Never automatically retry. The model must reason from the `UNKNOWN` observation and choose a verification or correction step. |
| **Model again?** | ✅ Yes (must inspect and reason) |
| **Operation dispatched again?** | ❌ NO for identical NON_IDEMPOTENT proposal |
| **Verification again?** | N/A (not in verification phase) |
| **Workspace access?** | ✅ Yes (under supervisor authority after quiescence) |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | `attempts.status === "UNKNOWN"` (permanent terminal record) |
| **Status** | ✅ Existing behavior is correct |

---

### Scenario 10 — Attempt `SUCCEEDED`, Action Not Reconciled

The attempt row reached `SUCCEEDED` (tool returned a result), but the outer action reconciliation transaction did not complete before the process died.

| Attribute | Value |
|---|---|
| **Existing behavior** | `decideRecovery` detects `attempts.status === "SUCCEEDED"` with `actions.status === "RUNNING"`. Decision: `actionTransition: "SUCCEED"` — reconcile action to match attempt outcome. Source: `src/application/recovery-decision-policy.ts:1–168` |
| **Safe behavior** | Reconcile action to `SUCCEEDED` using the attempt's `outputPayload`. Never re-dispatch. Resume step loop with this action's output as the most recent observation. |
| **Model again?** | ✅ Yes (step succeeded; proceed to next turn) |
| **Operation dispatched again?** | ❌ NO (already succeeded) |
| **Verification again?** | N/A |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | `attempts.status === "SUCCEEDED"`; `attempts.output_payload`; `actions.status === "RUNNING"` (unreconciled) |
| **Status** | ✅ Existing behavior is correct |

---

## 5. Verification Phase Crash Scenarios

### Scenario 11 — Verification Started, Not Completed

The verification pass was triggered (test execution dispatched). The process died before the final verdict event was written.

| Attribute | Value |
|---|---|
| **Existing behavior** | No final `clean_room.verified` or `verification.rejected` event in `run_events`. Lease expires; run requeued. Worker re-enters step loop from scratch (including cleared post-pass latch). Source: `src/application/agent-step-controller.ts:1259–1442`, `src/application/post-pass-verification-latch.ts:99` |
| **Safe behavior** | Repeat verification from scratch on the candidate patch. Do not invoke the model for new edits until verification completes. The post-pass latch must be rebuilt from prior `clean_room.verified` events (earlier intermediate passes) before resuming. |
| **Model again?** | ❌ No — verify first |
| **Operation dispatched again?** | ✅ Yes (re-dispatch verification test execution) |
| **Verification again?** | ✅ YES — full dual-gate required |
| **Workspace access?** | ✅ Yes |
| **Artifact export again?** | N/A |
| **Authoritative evidence** | Absence of `clean_room.verified` or `verification.completed` event in `run_events` after the latest `action.started` event |
| **Status** | 🔶 Recovery re-queues correctly; **latch reconstruction from events is not yet implemented** (Gap 3 in gap matrix) |

---

### Scenario 12 — Verification Completed, Run Transition Not Committed

`clean_room.verified` was written to `run_events`. The final `run.completed` state transition was not committed before the process died.

| Attribute | Value |
|---|---|
| **Existing behavior** | `clean_room.verified` event exists but `runs.status` is still `RUNNING`. Lease expires; sweeper detects stale run. This case is not explicitly handled in `decideRecovery` — a re-entry without checkpoint awareness would re-run verification. Source: `src/application/recovery-decision-policy.ts:1–168` |
| **Safe behavior** | Detect the `clean_room.verified` event, verify its patch hash matches current workspace state, and reconcile `runs.status` to `COMPLETED` **without** re-invoking the model or re-running verification. |
| **Model again?** | ❌ NO (goal was verified) |
| **Operation dispatched again?** | ❌ NO |
| **Verification again?** | ❌ NO (authoritative proof exists — `clean_room.verified` with patch SHA) |
| **Workspace access?** | ✅ Read-only for artifact export |
| **Artifact export again?** | ✅ Yes (idempotent) |
| **Authoritative evidence** | `clean_room.verified` event in `run_events` with matching `patchSha256` and workspace diff |
| **Status** | ❌ **Not handled** — `decideRecovery` does not inspect `clean_room.verified` events; this run would be re-queued and verification would run again. This is a correctness gap. |

---

## 6. Post-Verification Crash Scenarios

### Scenario 13 — Crash During Artifact Export

Verification completed. `exportArtifact` began writing `patch.diff` and `manifest.json`. The process died before `workspace.cleaning` event was written.

| Attribute | Value |
|---|---|
| **Existing behavior** | `exportArtifact` failure causes workspace disposal to be **withheld** (workspace preserved). `workspace.cleaning` event is absent. Run may be in `RUNNING` or `COMPLETING` state. Source: `src/application/worker-runtime.ts:1091–1221`, `src/adapters/workspace/git-artifact-exporter.ts:121` |
| **Safe behavior** | Re-export artifact on re-entry. `exportArtifact` is idempotent — atomic file overwrite against `baseline.git`. Do not invoke the model. Do not re-run verification. |
| **Model again?** | ❌ NO |
| **Operation dispatched again?** | ❌ NO |
| **Verification again?** | ❌ NO |
| **Workspace access?** | ✅ Yes (for export and cleanup only) |
| **Artifact export again?** | ✅ YES — idempotent; safe to repeat |
| **Authoritative evidence** | `baseline.git` exists at `<artifactRoot>/<runId>/attempt-<n>/`; `workspace.cleaning` absent from `run_events` |
| **Status** | ✅ Existing behavior is correct (workspace preserved; re-export is safe) |

---

### Scenario 14 — Workspace Cleanup Started, Not Completed

`workspace.cleaning` event was written. The process died during directory deletion. The workspace directory partially remains.

| Attribute | Value |
|---|---|
| **Existing behavior** | Sweeper detects stale run (`workspace.cleaning` present, `workspace.disposed` absent). `disposeWorkspaceSync` is called on recovery to destroy the remaining directory. Source: `src/application/worker-runtime.ts:1091–1221` |
| **Safe behavior** | Same. Complete workspace disposal only. Do not re-export artifact (already exported). Do not invoke model. Do not run verification. If `attemptCount < maxAttempts`, transition to `QUEUED` for a retry with a fresh workspace. |
| **Model again?** | ✅ Only if run is retried with a new attempt |
| **Operation dispatched again?** | ❌ NO for the completed attempt |
| **Verification again?** | ❌ NO (artifact already exported) |
| **Workspace access?** | ✅ Yes (cleanup only) |
| **Artifact export again?** | ❌ NO (already exported; re-export would overwrite valid artifact) |
| **Authoritative evidence** | `workspace.cleaning` in `run_events`; `workspace.disposed` absent; artifact manifest already on disk |
| **Status** | ✅ Existing behavior is correct |

---

## 7. Summary by Recovery Disposition

| Disposition | Scenarios | Current State |
|---|---|---|
| **Cold restart — safe and correct** | 1, 2, 3, 4 | ✅ All correct |
| **Fail-closed — uncertain execution** | 7, 8, 9 | ✅ All correct (replay gate enforced) |
| **Reconcile from durable attempt record** | 5, 6, 10 | ✅ Correct; Scenario 5 needs explicit idempotent re-entry test |
| **Re-run verification** | 11 | 🔶 Recovery correct; latch reconstruction not yet implemented |
| **Reconcile from verified event** | 12 | ❌ Not handled — verification is repeated unnecessarily |
| **Re-export artifact** | 13 | ✅ Correct |
| **Complete disposal only** | 14 | ✅ Correct |

---

## 8. Scenario 12 — Detailed Gap Analysis

Scenario 12 is the only scenario where **existing behavior diverges from safe behavior** in a way that could produce a correctness failure (re-running verification after it has already produced a proof).

### Current code path (incorrect)
1. Sweeper finds run with `lease_expires_at < nowIso`.
2. `decideRecovery` inspects `actions` and `attempts` only. No `clean_room.verified` event inspection.
3. No special handling — run transitions `RECOVERING` → `QUEUED`.
4. Worker re-enters, re-runs `AgentStepController.runStepLoop` from scratch.
5. Verification is re-dispatched (unnecessary, potentially wrong if workspace was partially mutated by the cleanup crash).

### Safe code path (required)
1. Sweeper finds run with `lease_expires_at < nowIso`.
2. Recovery policy inspects `run_events` for `clean_room.verified` event after the last `action.started` event.
3. If `clean_room.verified` exists: verify its `patchSha256` matches the current workspace state.
4. If match: transition run to `COMPLETED` directly, skip model re-invocation and verification.
5. If mismatch: escalate — do not silently re-verify or silently complete. This indicates a workspace integrity problem.

### Required change
Extend `RecoveryDecisionInput` with the latest `run_events` scan for verification events, and add a `COMPLETE_FROM_VERIFIED_EVENT` decision branch to `decideRecovery`.

This is a focused, additive change to `src/application/recovery-decision-policy.ts` and its call site in `RunCoordinator`.

---

## 9. Sources

| Claim | Source |
|---|---|
| `decideRecovery` decision table | `src/application/recovery-decision-policy.ts:1–168` |
| `isStartedAttemptRowMissing` logic | `src/application/recovery-decision-policy.ts:109` |
| `REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT` | `src/application/worker-runtime.ts` |
| `RESUME_BLOCKED_PRIOR_DISPATCH` | `src/application/worker-runtime.ts` |
| `recoverExpiredRuns` / `reconcileStaleActionsAndAttemptsForRun` | `src/application/run-coordinator.ts:788–1341` |
| `RecoverySupervisor.recoverRun` | `src/recovery/recovery-supervisor.ts:304–318` |
| `RecoverySweeper` sequence | `src/recovery/recovery-sweeper.ts:90–135` |
| `TenantQuiescenceGate.runTenantQuiescencePrePass` | `src/recovery/tenant-quiescence-gate.ts:60` |
| `DurableRollbackEngine` path progress | `src/recovery/durable-rollback-engine.ts:1–1250` |
| `PostPassVerificationLatch.clear()` on entry | `src/application/post-pass-verification-latch.ts:99` |
| `exportArtifact` withheld on failure | `src/application/worker-runtime.ts:1091–1221` |
| `workspace.cleaning` event | `src/application/worker-runtime.ts:1091–1221` |
| `captureBaseline` baseline.git path | `src/adapters/workspace/git-artifact-exporter.ts:99` |
