# ADR-0036: Durable Mutation Intent, Crash Recovery, and Workspace Ownership Contract

## 1. Status and Scope

### 1.1 Document Status
- **Status**: PROPOSED (Awaiting User Review and Formal Acceptance)
- **Date**: 2026-10-28
- **Authors**: Emerald Agent Fabric Core Infrastructure Team
- **Preceding Architecture Decisions**:
  - [ADR-0002: Runtime Kernel and Durable State Machine](./ADR-0002-runtime-kernel-and-durable-state-machine.md)
  - [ADR-0003: Workspace and Typed Tools](./ADR-0003-workspace-and-typed-tools.md)
  - [ADR-0004: Tool Execution Gateway and Adapter Boundary](./ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
  - [ADR-0005: Action and Attempt Domain Architecture](./ADR-0005-action-and-attempt-domain-architecture.md)
  - [ADR-0006: Crash Recovery, UNKNOWN Reconciliation, and Retry Safety](./ADR-0006-crash-recovery-unknown-reconciliation-retry-safety.md)
  - [ADR-0034: Governed Rejection Feedback and Local Model Recovery Boundaries](./ADR-0034-governed-rejection-feedback-and-local-model-recovery-boundaries.md)

### 1.2 Context and Problem Statement
During iterative automated software repair trials (Phases 48A–48Z), the agent execution loop exhibited a fundamental architectural deficiency: **filesystem mutations and verification outcomes are transactionally decoupled**. When an edit tool mutates a file on disk:
1. The mutation is immediately visible on the host filesystem.
2. If intermediate test verification fails (e.g., in a multi-step repair attempt), the failed mutation remains on disk.
3. Subsequent reasoning steps and model prompts observe the corrupted or ineffective intermediate state, compounding failures.
4. If the process crashes or is killed during or after a mutation, the runtime has no durable, structured intent record to determine whether the target file contains the pre-mutation baseline, the intended mutation, or an unexpected external modification.

Restoring workspace files cannot be treated as an in-memory editor convenience. In a local-first, low-resource autonomous agent runtime, workspace mutation affects crash consistency, multi-worker lease validity, multi-file atomic boundaries, and audit durability.

### 1.3 Decoupled Implementation Scope
Formal review and acceptance of this ADR does **NOT** authorize unrestricted full-system implementation. Implementation is divided into five strictly gated workstreams:
1. **Workstream 1 (Phase 48AE - Persistence Seam Only)**:
   - Durable SQLite tables (`mutation_intents`, `run_rollbacks`, `path_rollback_progress`), domain entities, ports, and persistence unit/integration tests.
   - *Excludes*: File system rollback execution, editor integration, supervisor loops, and live inference.
2. **Workstream 2 (Editor Integration & Pre-Mutation Intent)**:
   - Integration of `LineAnchoredEditor` with pre-read validation, pre-mutation intent persistence, pre-edit snapshot creation, and expected digest computation.
   - *Requires*: Prior user review and authorization following Phase 48AE.
3. **Workstream 3 (Rollback Execution Engine)**:
   - Direct-to-baseline restoration engine, sequential per-path execution with pre-rename digest checks, atomic renames, and conflict preservation.
   - *Requires*: Prior user review and authorization following Workstream 2.
4. **Workstream 4 (Crash Recovery & Lease Supervision)**:
   - Integration with `RunCoordinator` and worker crash-recovery loops (CP1–CP7 recovery matrix, recovery deduplication tokens, orphan temp file correlation).
   - *Requires*: Prior user review and authorization following Workstream 3.
5. **Workstream 5 (Benchmark & Repair Loop Integration)**:
   - Integration with autonomous repair benchmarks (e.g., EAF-BM-02) and multi-step repair rollbacks.
   - *Requires*: Complete offline contract test suite passing across all 37 scenarios.

---

## 2. Mutation-Intent Contract

### 2.1 Intent Lifecycle State Machine
Every workspace modification must follow a durable Write-Ahead Mutation Intent (WAMI) protocol. The intent state machine defines explicit, non-skippable transitions:

```
                  ┌──────────────────────┐
                  │       RECORDED       │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │   SNAPSHOT_WRITTEN   │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  APPLYING_MUTATION   │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │      COMMITTED       │
                  └─────┬──────────┬─────┘
                        │          │
   (Verification Pass)  │          │ (Verification Fail / Revert Request)
                        ▼          ▼
            ┌──────────────┐   ┌──────────────────────┐
            │VERIFIED_PASS │   │     ROLLING_BACK     │
            └──────────────┘   └─────┬──────────┬─────┘
                                     │          │
           (Restoration Succeeded)   │          │ (Pre-rename Digest Mismatch / Error)
                                     ▼          ▼
                           ┌────────────┐   ┌────────────────────────────────┐
                           │ROLLED_BACK │   │ ROLLBACK_CONFLICT_LOST_UPDATE  │
                           │            │   │ ROLLBACK_CONFLICT_HASH_MISMATCH│
                           └────────────┘   └────────────────────────────────┘
```

#### Lifecycle State Definitions
- `RECORDED`: Intent persisted to SQLite before any filesystem interaction. Pre-read checks passed.
- `SNAPSHOT_WRITTEN`: Pre-mutation snapshot file written to immutable snapshot directory, verified by SHA-256 digest matching `base_digest`.
- `APPLYING_MUTATION`: Filesystem atomic write/rename in progress. Target file transition from `base_digest` to `expected_resulting_digest` initiated.
- `COMMITTED`: Filesystem mutation completed; target file matches `expected_resulting_digest`. State persisted to SQLite.
- `ROLLING_BACK`: Active rollback initiated by verification failure or supervisory abort. Target file is being reverted to `base_digest`.
- `ROLLED_BACK`: Target file successfully restored to `base_digest` and verified.
- `VERIFIED_PASS`: Multi-step repair or test suite verified clean pass; mutation promoted to permanent.
- `ROLLBACK_CONFLICT_LOST_UPDATE`: Pre-rename verification detected that target file does not match `expected_resulting_digest` (uncooperative external modification).
- `ROLLBACK_CONFLICT_HASH_MISMATCH`: Snapshot corruption or post-restore digest mismatch.
- `ABORTED_UNMUTATED`: Intent cancelled before filesystem was touched (e.g., worker lease expired during snapshot preparation).

### 2.2 Relational Data Model and Schema

```sql
-- Mutation Intent Journal: Tracks individual file mutation operations
CREATE TABLE IF NOT EXISTS mutation_intents (
    mutation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    parent_mutation_id TEXT NULL,
    path_mutation_version INTEGER NOT NULL,
    base_digest TEXT NOT NULL,                  -- SHA-256 hex (64 chars) of target before mutation
    expected_resulting_digest TEXT NOT NULL,     -- SHA-256 hex (64 chars) of target after mutation
    snapshot_ref TEXT NOT NULL,                 -- Absolute path to immutable snapshot file
    recovery_dedup_token TEXT NOT NULL UNIQUE,  -- SHA-256(run_id + ":" + mutation_id + ":" + target_state)
    lifecycle_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,                -- Epoch milliseconds
    updated_at INTEGER NOT NULL,                -- Epoch milliseconds
    conflict_details TEXT NULL,                 -- JSON payload describing conflict evidence
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_mutation_id) REFERENCES mutation_intents(mutation_id) ON DELETE RESTRICT,
    UNIQUE (run_id, relative_path, path_mutation_version)
);

CREATE INDEX IF NOT EXISTS idx_mutation_intents_run_path 
ON mutation_intents(run_id, relative_path, path_mutation_version ASC);

CREATE INDEX IF NOT EXISTS idx_mutation_intents_status 
ON mutation_intents(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_mutation_intents_lease 
ON mutation_intents(worker_lease_id);
```

### 2.3 Per-Path Digest Chains
When a single relative path is edited multiple times within a run, mutations form a strictly chained directed acyclic graph:
$$D_0 \xrightarrow{\text{mut-1}} D_1 \xrightarrow{\text{mut-2}} D_2 \xrightarrow{\text{mut-3}} D_3$$

#### Invariants:
1. **Initial Baseline ($D_0$)**: For `path_mutation_version = 1`, `parent_mutation_id IS NULL`, and `base_digest = D_0`.
2. **Chain Continuity**: For `path_mutation_version = k` ($k > 1$):
   $$\text{base\_digest}_k = \text{expected\_resulting\_digest}_{k-1} = D_{k-1}$$
   $$\text{parent\_mutation\_id}_k = \text{mutation\_id}_{k-1}$$
3. **Monotonicity**: `path_mutation_version` increments by exactly $1$ for each subsequent mutation to that path.

### 2.4 Transaction Boundaries and Event Dual-Commit
Every mutation lifecycle status transition in SQLite MUST be executed atomically with its corresponding domain event append inside a single SQLite transaction:

```sql
BEGIN IMMEDIATE;
-- 1. Validate active worker lease
SELECT lease_id FROM worker_leases 
WHERE lease_id = ? AND expires_at > ? AND status = 'ACTIVE';

-- 2. Update mutation intent status
UPDATE mutation_intents 
SET lifecycle_status = ?, updated_at = ?
WHERE mutation_id = ? AND lifecycle_status = ?;

-- 3. Insert domain event with unique UUID and deterministic deduplication token
INSERT INTO domain_events (
    event_id, run_id, event_type, schema_version, 
    producer, timestamp, payload, dedup_token
) VALUES (?, ?, ?, 1, 'MUTATION_ENGINE', ?, ?, ?);

COMMIT;
```

If SQLite fails, locks, or rolls back, neither the intent state nor the domain event is committed. SQLite and the host filesystem do **NOT** share a distributed two-phase commit (2PC) protocol; the crash-consistency protocol (Section 4) bridges this gap.

### 2.5 Permanent Retention and Archival Integrity
- **Foreign Key Rule**: `FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT`. A run record CANNOT be deleted while mutation intent records or rollback logs exist.
- **Audit Immutability**: Mutation intent rows are NEVER deleted during normal operation, run completion, or crash recovery.
- **Administrative Retention**: Purging or archiving historical runs requires a formal archival process that migrates mutation intents and associated snapshots to immutable cold storage together with the run evidence bundle.

---

## 3. Per-Path and Run-Level Rollback

### 3.1 Concrete Multi-File, Multi-Mutation Example
Consider a run `run-8821` performing repairs across two files in workspace:
- File 1: `src/utils.ts`
  - Baseline on disk: $D_0$
  - Step 1: `mut-001` ($D_0 \to D_1$), `path_mutation_version = 1`
  - Step 2: `mut-002` ($D_1 \to D_2$), `path_mutation_version = 2`, `parent_mutation_id = 'mut-001'`
- File 2: `src/index.ts`
  - Baseline on disk: $K_0$
  - Step 3: `mut-003` ($K_0 \to K_1$), `path_mutation_version = 1`

At Step 4, verification fails. The runtime initiates a run-level rollback.

### 3.2 Run-Level and Per-Path Rollback Tracking Schemas

```sql
-- Run-Level Rollback State Table
CREATE TABLE IF NOT EXISTS run_rollbacks (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                      -- IDLE, RESTORING_PATHS, COMPLETED, PARTIALLY_ROLLED_BACK_CONFLICT, FAILED
    initiated_by TEXT NOT NULL,                -- VERIFICATION_FAILURE, SUPERVISOR_TIMEOUT, MANUAL_ABORT
    created_at INTEGER NOT NULL,
    completed_at INTEGER NULL,
    conflict_details TEXT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);

-- Per-Path Rollback Progress Table: Tracks granular progress across paths
CREATE TABLE IF NOT EXISTS path_rollback_progress (
    run_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    status TEXT NOT NULL,                      -- PENDING, IN_PROGRESS, RESTORED, CONFLICT_SKIPPED, RESTORE_FAILED
    initial_base_digest TEXT NOT NULL,         -- D_0 (the true pre-run baseline)
    latest_expected_digest TEXT NOT NULL,      -- D_2 or K_1 (expected current state)
    baseline_snapshot_ref TEXT NOT NULL,       -- Snapshot corresponding to D_0
    updated_at INTEGER NOT NULL,
    error_message TEXT NULL,
    PRIMARY KEY (run_id, relative_path),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);
```

### 3.3 Direct-to-Baseline Restoration
Rather than unrolling intermediate mutations sequentially on disk ($D_2 \to D_1 \to D_0$), which causes excessive I/O, disk thrashing, and repeated TOCTOU exposure windows, the rollback engine restores the target file **directly to its initial baseline $D_0$ in a single atomic rename**:
1. For path `src/utils.ts`, lookup `path_mutation_version = 1` to find initial baseline snapshot $S_0$ ($D_0$).
2. Pre-flight check: compute `sha256(src/utils.ts)`. Validate it matches latest expected digest $D_2$.
3. Prepare temp file `.emerald.tmp.restore.<nonce>` populated from snapshot $S_0$.
4. Immediate pre-rename verification: re-check `sha256(src/utils.ts) === D_2`.
5. Atomic replacement: `fs.renameSync(tempPath, targetPath)`.
6. Result: Disk moves directly from $D_2$ to $D_0$ in one atomic filesystem operation.
7. Mark `src/utils.ts` as `RESTORED` in `path_rollback_progress`.
8. Transition all mutations for this path (`mut-001`, `mut-002`) to `ROLLED_BACK` in SQLite.

### 3.4 Multi-File Rollback Policy and Deterministic Partial Conflict State
POSIX and Windows filesystems do **NOT** provide multi-file atomic rename primitives. Restoring multiple files is inherently sequential.

#### Two-Layer Defense:
1. **Layer 1 (Pre-Flight Run Validation)**: Before any filesystem rename begins, the rollback engine checks all target paths:
   - Does `sha256(path)` match the latest expected digest for every path in the run?
   - If any path exhibits a pre-flight mismatch, rollback does NOT proceed to rename. The run transitions immediately to `PARTIALLY_ROLLED_BACK_CONFLICT` with zero filesystem modifications.
2. **Layer 2 (Per-Rename Verification)**: Immediately before each individual file rename, `sha256(path)` is re-verified.

#### Deterministic Partial Conflict Policy:
If during sequential execution:
- Path 1 (`src/utils.ts`) is restored cleanly ($D_2 \to D_0$) and marked `RESTORED`.
- Path 2 (`src/index.ts`) exhibits a digest mismatch immediately before rename (an external editor or tool modified it, so `sha256 !== K_1`).

**The Policy Rule**:
> **HALT IMMEDIATELY. DO NOT PROCEED TO SUBSEQUENT PATHS. PRESERVE CONFLICTING FILE UNTOUCHED. RECORD RUN AS `PARTIALLY_ROLLED_BACK_CONFLICT`.**

#### Architectural Justification:
Continuing to restore subsequent files when an earlier dependent file has conflicted would leave the workspace in a semantically broken hybrid state. Halting provides an unambiguous, observable, and restartable boundary:
- Path 1 remains `RESTORED` in `path_rollback_progress`.
- Path 2 is marked `CONFLICT_SKIPPED` in `path_rollback_progress`.
- Remaining paths remain `PENDING`.
- `run_rollbacks.status` transitions to `PARTIALLY_ROLLED_BACK_CONFLICT`.
- Target file for Path 2 is left byte-for-byte untouched on disk.
- Supervisory review is requested; no automated process blindly overwrites unknown user changes.

---

## 4. Crash-Consistency Matrix

The crash-consistency matrix covers every discrete execution phase and crash point (CP1–CP7) and defines recovery actions when SQLite and filesystem states diverge across process restarts.

| Boundary | SQLite Durable State | Target File Disk State | Snapshot State | Temporary File State | Recovery Authority | Deterministic Recovery Action | Resulting SQLite State | Event & Dedup Token Behavior | Restart Idempotency |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CP1** (Crash before snapshot write) | `RECORDED` | Base ($D_0$) | Absent | Absent | Crash Recovery Supervisor | Discard intent. Disk is untouched. | `ABORTED_UNMUTATED` | `file.mutation_aborted`, dedup token `sha256(runId:mutId:ABORTED)` | Safe no-op on re-run; status already terminal. |
| **CP2** (Crash during snapshot write) | `RECORDED` | Base ($D_0$) | Incomplete / invalid digest | Temp file may exist | Crash Recovery Supervisor | Unlink incomplete temp file. Discard intent. Target untouched. | `ABORTED_UNMUTATED` | `file.mutation_aborted`, dedup token `sha256(runId:mutId:ABORTED)` | Safe no-op on re-run. |
| **CP3** (Crash after snapshot, before mutation applied) | `SNAPSHOT_WRITTEN` | Base ($D_0$) | Valid ($D_0$) | Absent | Crash Recovery Supervisor | Inspect disk: digest is $D_0$. Target was never modified. Mark aborted. | `ABORTED_UNMUTATED` | `file.mutation_aborted`, dedup token `sha256(runId:mutId:ABORTED)` | Safe no-op on re-run. |
| **CP4** (Crash during mutation rename: file was mutated) | `APPLYING_MUTATION` | Resulting ($D_1$) | Valid ($D_0$) | Absent | Crash Recovery Supervisor | Deterministic Rollback: Restore target from snapshot ($D_1 \to D_0$) via atomic rename. | `ROLLED_BACK` | `file.mutation_rolled_back` (`reason: CRASH_RECOVERY_CP4`), dedup token `sha256(runId:mutId:ROLLED_BACK)` | If restarted, disk is now $D_0$, detected as post-rename completed (see CP6a). |
| **CP4a** (Crash during mutation rename: file was NOT mutated) | `APPLYING_MUTATION` | Base ($D_0$) | Valid ($D_0$) | Temp file may exist | Crash Recovery Supervisor | Unlink correlated temp file. Target is already at baseline. Mark aborted. | `ABORTED_UNMUTATED` | `file.mutation_aborted`, dedup token `sha256(runId:mutId:ABORTED)` | Safe no-op on re-run. |
| **CP5** (Crash during normal verification) | `COMMITTED` | Resulting ($D_1$) | Valid ($D_0$) | Absent | Test Runner / Supervisor | Resume verification or initiate rollback if verification fails. | `COMMITTED` or `ROLLING_BACK` | Standard execution events. | Safe no-op. |
| **CP6** (Crash during rollback rename: file was NOT restored) | `ROLLING_BACK` | Resulting ($D_1$) | Valid ($D_0$) | Temp file may exist | Crash Recovery Supervisor | Pre-rename check confirms target is $D_1$. Execute atomic rename from snapshot ($D_1 \to D_0$). | `ROLLED_BACK` | `file.mutation_rolled_back`, dedup token `sha256(runId:mutId:ROLLED_BACK)` | Transitions to CP6a handling if crash occurs after rename. |
| **CP6a** (Crash AFTER rollback rename, BEFORE SQLite commit) | `ROLLING_BACK` or `COMMITTED` | Base ($D_0$) | Valid ($D_0$) | Absent | Crash Recovery Supervisor | Target digest matches $D_0$. Rename succeeded prior to crash! **Do NOT touch disk.** Commit status update to SQLite. | `ROLLED_BACK` | `file.mutation_rolled_back` (`reason: CRASH_RECOVERY_POST_RENAME_COMPLETED`), dedup token `sha256(runId:mutId:ROLLED_BACK)` | Re-running recovery detects $D_0$ and status `ROLLED_BACK`; no-op. |
| **CP7** (Crash after rollback committed) | `ROLLED_BACK` | Base ($D_0$) | Valid ($D_0$) | Absent | Crash Recovery Supervisor | Terminal state reached. Zero filesystem or database action. | `ROLLED_BACK` | None. | No-op. |
| **CP-CONF-1** (Rollback conflict: external modification) | `ROLLING_BACK` or `APPLYING_MUTATION` | Foreign ($D_x \neq D_0, D_1$) | Valid ($D_0$) | Absent | Crash Recovery Supervisor | **Zero physical file modification.** Preserve foreign target untouched. Log conflict details. | `ROLLBACK_CONFLICT_LOST_UPDATE` | `file.rollback_conflict`, dedup token `sha256(runId:mutId:CONFLICT)` | Re-running recovery finds terminal conflict status; preserves file. |
| **CP-CONF-2** (Rollback conflict: file locked by OS) | `ROLLING_BACK` | Resulting ($D_1$) | Valid ($D_0$) | Temp file exists | Crash Recovery Supervisor | Bounded retries with exponential backoff. If exhausted, preserve temp file, mark failed. | `RESTORE_FAILED` | `file.rollback_failed`, dedup token `sha256(runId:mutId:LOCKED)` | Re-running retries lock acquisition up to limit. |

---

## 5. Filesystem Ownership and Safety Boundary

### 5.1 Workspace Containment and Path Validation
1. **Canonical Path Resolution**: Target paths must resolve strictly within the configured workspace root via `fs.realpathSync`.
2. **Symlink and Junction Rejection**: Symlinks, hardlinks, and directory junctions pointing outside the workspace boundary are strictly rejected before any intent is recorded.
3. **Drive-Relative and Traversal Guard**: Windows drive-relative syntax (e.g., `C:file.txt`) and path traversal sequences (`..`) are normalized and validated against workspace boundaries.

### 5.2 Pre-Read and Post-Read Safety Checks
1. **Pre-Read Size Guard**: Before opening or snapshotting any file:
   $$\text{fs.statSync}(path).\text{size} \le 1,048,576\text{ bytes (1 MiB)}$$
   Files exceeding 1 MiB are rejected from line-anchored mutation to protect process memory and maintain ₹0-cost local execution.
2. **Post-Read Content Validation**:
   - The file content must be valid UTF-8.
   - The file must contain zero null bytes (`0x00`). Any binary detection immediately rejects the file from mutation.

### 5.3 Existing Files vs Newly Created Files
- **Existing File**: Pre-mutation baseline is snapshot file $S_0$ with digest $D_0$. Rollback restores $S_0 \to \text{target}$.
- **Newly Created File**: Target did not exist prior to run. Baseline is recorded as `ABSENT` (`base_digest = "ABSENT"`).
  - Rollback behavior: If `sha256(target) === expected_resulting_digest`, rollback unlinks the newly created file.
  - Conflict behavior: If `sha256(target) !== expected_resulting_digest`, the file was externally modified; rollback preserves it untouched and records `ROLLBACK_CONFLICT_LOST_UPDATE`.

### 5.4 Temporary File Correlation and Safe Cleanup Limits
- **Naming Convention**: Temporary files are named `.emerald.tmp.<mutationId>.<nonce>` in the same directory as the target file (ensuring same-filesystem atomic rename).
- **Ownership Limitations**: A filename and nonce constitute correlation evidence, **NOT cryptographic proof of ownership**.
- **Safe Cleanup Rules**:
  1. A temp file is unlinked only if `mutationId` is actively recorded in SQLite under an active or recovering run.
  2. The temp file must reside within the canonical workspace.
  3. If ownership is ambiguous, the temp file is **PRESERVED** rather than deleted, preventing accidental loss of user data.

### 5.5 Windows NTFS File Locks and Rename Semantics
- On Windows systems, open file handles (from antivirus scanners, background indexing, IDE language servers, or lingering Node.js handles) cause `fs.renameSync` to fail with `EPERM` or `EBUSY`.
- **Mitigation**: File access routines must close handles immediately. Rollback renames execute with bounded retries (3 attempts, 50ms exponential backoff + jitter).
- If retries fail, the operation fails safely, leaving target and snapshot files intact, and escalates to `RESTORE_FAILED`.

### 5.6 Conflict Preservation Policy
When an uncooperative external process or user modifies a target file during an agent run, the target file digest will deviate from the expected value.
> **RULE**: The conflicting file on disk MUST NOT be moved, deleted, overwritten, or truncated. It remains byte-for-byte untouched in place. All conflict metadata (timestamp, expected digest, observed foreign digest) is recorded in SQLite and the evidence bundle.

### 5.7 Concurrency and Single-Writer Assumption
- SQLite database transactions and worker leases enforce mutual exclusion across cooperative Emerald Agent Fabric worker processes.
- **Limitation**: Neither SQLite leases nor SHA-256 pre-rename checks can physically fence an uncooperative host process (e.g., developer typing in an external editor, git checkout, or external scripts).
- Pre-rename digest validation narrows the race window to microseconds, but does NOT create an OS-level atomic compare-and-swap.
- The system explicitly operates under the **Cooperative Single-Writer Host Lease Assumption**.

---

## 6. Events, Idempotency, and Audit Retention

### 6.1 Event Identity and Deduplication
1. **Event IDs**: Generated using cryptographically random UUID v4 at the time of transaction execution.
2. **Recovery Deduplication Token**:
   $$\text{recovery\_dedup\_token} = \text{sha256}(\text{run\_id} + \text{":"} + \text{mutation\_id} + \text{":"} + \text{target\_lifecycle\_status})$$
3. **Atomic Dual-Commit**:
   The transition of a mutation record in `mutation_intents` and the insertion of the corresponding domain event in `domain_events` occur in the same SQLite transaction.
4. **Idempotency Across Crashes**:
   If a crash occurs during crash recovery and the supervisor re-executes recovery, the `recovery_dedup_token` in `mutation_intents` and `domain_events` prevents duplicate logical events from being recorded.

### 6.2 Event Schemas

#### 1. `file.mutation_recorded`
```json
{
  "eventId": "uuid-v4",
  "eventType": "file.mutation_recorded",
  "runId": "run-8821",
  "timestamp": 1729900000000,
  "payload": {
    "mutationId": "mut-001",
    "relativePath": "src/utils.ts",
    "pathMutationVersion": 1,
    "baseDigest": "a1b2c3...",
    "expectedResultingDigest": "d4e5f6..."
  }
}
```

#### 2. `file.mutation_committed`
```json
{
  "eventId": "uuid-v4",
  "eventType": "file.mutation_committed",
  "runId": "run-8821",
  "timestamp": 1729900001000,
  "payload": {
    "mutationId": "mut-001",
    "relativePath": "src/utils.ts",
    "resultingDigest": "d4e5f6..."
  }
}
```

#### 3. `file.mutation_rolled_back`
```json
{
  "eventId": "uuid-v4",
  "eventType": "file.mutation_rolled_back",
  "runId": "run-8821",
  "timestamp": 1729900005000,
  "payload": {
    "mutationId": "mut-001",
    "relativePath": "src/utils.ts",
    "restoredDigest": "a1b2c3...",
    "reason": "CRASH_RECOVERY_POST_RENAME_COMPLETED"
  }
}
```

#### 4. `file.rollback_conflict`
```json
{
  "eventId": "uuid-v4",
  "eventType": "file.rollback_conflict",
  "runId": "run-8821",
  "timestamp": 1729900006000,
  "payload": {
    "mutationId": "mut-001",
    "relativePath": "src/utils.ts",
    "expectedDigest": "d4e5f6...",
    "actualDigest": "999999...",
    "conflictType": "LOST_UPDATE",
    "targetPreserved": true
  }
}
```

---

## 7. Contract-Test Traceability

The 37 rollback safety contract scenarios specified in `tests/contract/rollback-safety.test.ts` are categorized into four distinct technical classifications.

### 7.1 Classification Legend
- **V-EXISTING** (10 scenarios): Verified against existing runtime implementation. Exercises real, currently active production classes.
- **B-INTERFACE** (27 scenarios): Blocked by missing production interfaces. These tests define binding requirements for future implementation phases and are currently skipped.
- **DESIGN-ONLY**: Architectural assertions documenting systemic constraints.
- **INSUFFICIENT-FOR-GUARANTEE**: Tests demonstrating necessary conditions, but which alone cannot guarantee full system safety (e.g., passing a hash check does not guarantee absence of TOCTOU race).

### 7.2 Scenario-by-Scenario Traceability Matrix

| Test ID | Test Scenario Name | Current Classification | What It Actually Proves | What It Does NOT Prove | Missing Production Interface / Blocker |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A1** | Snapshot created before edit | B-INTERFACE | Validates interface requirement for pre-edit snapshot. | Does not prove filesystem durability or atomic disk flush. | Missing `MutationIntentStorePort` and snapshot engine. |
| **A2** | Snapshot contains exact pre-edit bytes | B-INTERFACE | Validates byte equality contract. | Does not prove snapshot cannot be corrupted after creation. | Missing snapshot capture port. |
| **A3** | Non-existent file baseline is ABSENT | V-EXISTING | Proves Node.js `fs.existsSync` correctly identifies absent file. | Does not prove rollback unlinking is atomic. | None. |
| **A4** | Snapshot path containment | V-EXISTING | Proves path normalization catches `..` traversal. | Does not prove protection against junction points. | None. |
| **A5** | Pre-read size limit (1 MiB) | B-INTERFACE | Tests file rejection policy above 1 MiB. | Does not test streaming large file mutations. | Missing pre-read size guard in editor. |
| **A6** | Post-read UTF-8 validation | B-INTERFACE | Tests rejection of invalid UTF-8 byte sequences. | Does not prove full character encoding conversion. | Missing UTF-8 validator in editor. |
| **A7** | Post-read binary null check | B-INTERFACE | Tests rejection of `0x00` byte files. | Does not detect binary files without null bytes. | Missing binary guard in editor. |
| **A8** | Atomic snapshot write with fsync | B-INTERFACE | Tests temp-file write + rename + flush sequence. | Does not prove OS cache flush on power loss. | Missing durable snapshot writer. |
| **B1** | Matching hash allows conditional restore | V-EXISTING | Proves hash comparison logic behaves deterministically. | **Does NOT prove writer identity or absence of TOCTOU race.** | None. |
| **B2** | Mismatched hash detects conflict | V-EXISTING | Proves hash difference triggers conflict branch. | Does not prove conflict quarantine durability. | None. |
| **B3** | Conflict preserves target untouched | B-INTERFACE | Validates that target file bytes are unchanged on conflict. | Does not prove external process will not overwrite file later. | Missing rollback execution engine. |
| **B4** | Hash collision impossibility (SHA-256) | V-EXISTING | Proves distinct contents generate distinct SHA-256 digests. | Does not protect against ABA modifications. | None. |
| **B5** | Lease fencing in SQLite | V-EXISTING | Proves SQLite transaction aborts on expired lease. | **Does NOT fence external host processes on filesystem.** | None. |
| **B6** | Pre-rename verification narrows race | B-INTERFACE | Tests that verification occurs immediately prior to rename. | Does not eliminate TOCTOU window entirely. | Missing rollback execution engine. |
| **B7** | Windows file lock retry and fail-safe | B-INTERFACE | Tests retry backoff and non-destructive failure on `EBUSY`. | Does not prevent external file locking. | Missing retry-enabled rename utility. |
| **C1** | Write-ahead intent record exists | B-INTERFACE | Validates intent persistence prior to file write. | Does not prove SQLite WAL flush before crash. | Missing `mutation_intents` table and port. |
| **C2** | CP1 recovery: abort unmutated | B-INTERFACE | Tests CP1 recovery handler in supervisor. | Does not test concurrent crash during recovery. | Missing crash recovery supervisor. |
| **C3** | CP3 recovery: rollback applying mutation | B-INTERFACE | Tests CP3 recovery handler. | Does not prove atomic recovery across reboot. | Missing crash recovery supervisor. |
| **C4** | Post-pass latch prevents rollback | V-EXISTING | Proves in-memory latch rejects rollback after verified pass. | Does not prove latch persistence across process restart. | None. |
| **C5** | Restart recovery idempotency | B-INTERFACE | Tests recovery re-run with deduplication token. | Does not prove filesystem state remains unchanged. | Missing recovery deduplication engine. |
| **C6** | Identical content edit rejected | V-EXISTING | Proves editor rejects no-op anchor edits. | Does not prevent external identical edits. | None. |
| **C7** | Terminal intent records retained | B-INTERFACE | Tests `ON DELETE RESTRICT` and query retention. | Does not prove immutable backup storage. | Missing `mutation_intents` table. |
| **C8** | Post-restore crash recovery (CP6a) | B-INTERFACE | Tests supervisor handling when file is restored but DB uncommitted. | Does not prove disk cache write completion. | Missing recovery supervisor. |
| **D1** | Single-step failed edit rollback | B-INTERFACE | Tests end-to-end single edit rollback. | Does not test multi-file cascades. | Missing rollback execution engine. |
| **D2** | Multi-step repair preserves progress | B-INTERFACE | Tests rollback of step 2 while preserving step 1. | Does not evaluate semantic validity of step 1. | Missing multi-step rollback controller. |
| **D3** | Multi-file direct-to-baseline rollback | B-INTERFACE | Tests direct restoration to $D_0$ in multi-file run. | Does not provide multi-file atomic filesystem commit. | Missing direct-to-baseline engine. |
| **D4** | Partial multi-file rollback halts on conflict | B-INTERFACE | Tests deterministic halting on partial conflict. | Leaves remaining paths unrestored. | Missing multi-file rollback engine. |
| **D5** | Repeated mutation per-path digest chain | B-INTERFACE | Tests $D_0 \to D_1 \to D_2 \to D_3$ chain validation. | Does not detect out-of-order external mutations. | Missing digest chain validator. |
| **D6** | In-memory latch survives within process | B-INTERFACE | Tests latch integration with step loop. | Does not survive process crash. | Missing integrated step controller. |
| **D7** | Evidence bundle includes rollback audit | B-INTERFACE | Validates evidence bundle JSON schema with rollbacks. | Does not sign external filesystem state. | Missing evidence bundle exporter. |
| **E1** | ReadFile tool respects permissions | V-EXISTING | Proves tool adapter respects read permissions. | Does not prevent external unauthorized file read. | None. |
| **E2** | Rollback disabled in read-only mode | B-INTERFACE | Tests policy interceptor disallowing rollback on read runs. | Does not prove sandbox read-only enforcement. | Missing policy gate on rollback engine. |
| **E3** | Rollback event emitted with full audit | B-INTERFACE | Tests event schema and payload completeness. | Does not guarantee event delivery to external sink. | Missing domain event emitter for rollbacks. |
| **E4** | Rollback conflict event emitted | B-INTERFACE | Tests conflict event generation and payload. | Does not resolve the physical conflict. | Missing conflict event emitter. |
| **E5** | Orphan temp file correlated or preserved | B-INTERFACE | Tests safe temp file cleanup heuristic. | Ambiguous files remain on disk. | Missing temp file cleanup utility. |
| **E6** | Unrelated files unmodified | V-EXISTING | Proves scoped editing does not modify adjacent files. | Does not test multi-process file access. | None. |
| **E7** | Event dedup token stable across retries | B-INTERFACE | Tests deterministic hash for transition events. | Does not prove distributed message deduplication. | Missing dedup token generator. |

---

## 8. Phase 48AE Persistence-Only Acceptance Criteria

Phase 48AE is the immediate next implementation phase, strictly constrained to the persistence seam.

### 8.1 Scope and Deliverables
1. **Schema Definition**: Add `mutation_intents`, `run_rollbacks`, and `path_rollback_progress` tables to SQLite persistence schema.
2. **Domain Port**: Define `MutationIntentStorePort` in `src/ports/mutation-intent-store.port.ts`:
   - `recordIntent(intent: MutationIntent): Promise<void>`
   - `transitionStatus(mutationId: string, from: MutationStatus, to: MutationStatus, event: DomainEvent, dedupToken: string): Promise<void>`
   - `getIntentsForRun(runId: string): Promise<MutationIntent[]>`
   - `getIntentsForPath(runId: string, relativePath: string): Promise<MutationIntent[]>`
   - `getLatestIntentForPath(runId: string, relativePath: string): Promise<MutationIntent | null>`
   - `recordRunRollback(rollback: RunRollback): Promise<void>`
   - `updatePathProgress(progress: PathRollbackProgress): Promise<void>`
3. **SQLite Adapter Implementation**: Implement methods in `SqliteStateStore` inside strict `BEGIN IMMEDIATE ... COMMIT` transaction blocks.
4. **Integration Test Suite**: Create `tests/integration/mutation-intent-persistence.test.ts`.

### 8.2 Strict Acceptance Criteria
- [ ] **Table Creation**: Tables, indices, foreign keys, and unique constraints create cleanly in both in-memory and file-backed SQLite databases.
- [ ] **FK Enforcement**: Attempting to delete a run with existing mutation intents throws a foreign-key restriction error (`ON DELETE RESTRICT`).
- [ ] **Chain Uniqueness**: Attempting to insert duplicate `(run_id, relative_path, path_mutation_version)` throws a unique constraint error.
- [ ] **Deduplication Enforcement**: Attempting to insert duplicate `recovery_dedup_token` throws a unique constraint error.
- [ ] **Dual-Commit Atomicity**: Intent transition and domain event insertion commit together. If an error occurs during transition, no event is persisted.
- [ ] **Lease Validation**: State transitions validate active worker lease; expired leases are rejected with `LEASE_EXPIRED`.
- [ ] **Zero Runtime Code Modification**: Zero changes to `LineAnchoredEditor`, `WorkerRuntime`, `RunCoordinator`, or tools.
- [ ] **Zero Live Inference**: Zero network operations, Ollama model calls, or benchmark executions.

---

## 9. Risks and Unresolved Guarantees

The mechanisms specified in this ADR mitigate significant failure modes but do not eliminate fundamental operating system and distributed systems limitations. The following guarantees remain unresolved:

| # | Unresolved Guarantee / Risk Area | Precise Limitation | Operational Assumption | Required Mitigation | Verification Phase |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **External Writer TOCTOU Race** | The gap between `sha256(path)` calculation and `fs.renameSync` is non-zero (microseconds). An uncooperative external process can modify the file in this window. | **Cooperative Single-Writer Host Lease Assumption**: The workspace is dedicated to the agent during execution; no human or external script edits active files concurrently. | Keep race window minimal. Detect conflicts post-rename where possible. Document host limitation. | Phase 48AF (Adversarial stress testing with external thread). |
| **2** | **Filesystem vs SQLite Crash Consistency** | Filesystem renames and SQLite transactions cannot participate in a shared atomic 2PC. A crash between filesystem rename and SQLite commit leaves states temporarily diverged. | **Idempotent Crash Recovery**: Crash recovery supervisor will run upon next system boot and reconcile SQLite with filesystem. | CP6a recovery protocol: supervisor inspects disk digest, recognizes successful rename, commits database without touching disk. | Phase 48AH (Simulated crash injection tests). |
| **3** | **Temporary-File Ownership Proof** | Filename, nonce, and mutation ID do not constitute cryptographic proof of ownership. External processes could create similarly named files. | **Workspace Isolation**: External processes do not inject mock temporary files into the agent workspace. | Ambiguous temporary files are PRESERVED rather than deleted. Temp files must be listed in active SQLite intents before cleanup. | Phase 48AG (Orphan cleaner contract tests). |
| **4** | **Partial Multi-File Rollback Integrity** | If Path 1 is restored and Path 2 conflicts, the workspace is left in a partially rolled-back state across files. | **Semantic Brokenness Acknowledgment**: A partially rolled back repository is non-atomic across files. | Deterministic halt policy: immediately stop restoration, preserve conflicting file untouched, mark run `PARTIALLY_ROLLED_BACK_CONFLICT`, alert human. | Phase 48AG (Multi-file fault injection tests). |
| **5** | **Platform-Specific Rename & Lock Semantics** | Windows NTFS locks files during antivirus scan or IDE indexing, causing `EPERM`/`EBUSY`. Linux POSIX allows atomic rename over open files. | **Platform Divergence**: File operations behave differently on Windows vs Linux/macOS. | Bounded retries with exponential backoff and jitter on Windows. Fallback to safe non-destructive failure. | Phase 48AF (Cross-platform Windows/Linux CI matrix). |

---

## 10. Decision and Implementation Gates

To ensure rigorous engineering discipline, adherence to GEMINI.md, and absolute preservation of historical benchmark integrity, the following sequential gates are established:

```
┌────────────────────────────────────────────────────────┐
│ GATE 1: User Review and Acceptance of ADR-0036         │
│ (Current State: Specification authored; pending user)  │
└───────────────────────────┬────────────────────────────┘
                            │ (Explicit User GO)
                            ▼
┌────────────────────────────────────────────────────────┐
│ GATE 2: Phase 48AE — Persistence Seam Implementation   │
│ (Tables, Port, SQLite Adapter, Persistence Tests Only) │
└───────────────────────────┬────────────────────────────┘
                            │ (Persistence Tests 100% Pass)
                            ▼
┌────────────────────────────────────────────────────────┐
│ GATE 3: Phase 48AF — Editor Integration Review         │
│ (Pre-read checks, pre-edit snapshots, WAMI creation)   │
└───────────────────────────┬────────────────────────────┘
                            │ (Design Review & Approval)
                            ▼
┌────────────────────────────────────────────────────────┐
│ GATE 4: Phase 48AG — Rollback & Recovery Supervision   │
│ (Direct-to-baseline engine, supervisor recovery loops) │
└───────────────────────────┬────────────────────────────┘
                            │ (All 37 Contract Tests Pass)
                            ▼
┌────────────────────────────────────────────────────────┐
│ GATE 5: Phase 48AH — Live Benchmark Trial Authorization│
│ (Live Ollama repair trials unblocked under safety net) │
└────────────────────────────────────────────────────────┘
```

**Live benchmark trials (including EAF-BM-02) remain completely frozen until Gates 1 through 4 are fully verified and approved.**
