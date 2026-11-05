# Emerald Agent Fabric — Operator Observability & Durable Run Inspection Guide (Milestone 2.21)

## 1. Overview & Architectural Principles

Emerald Agent Fabric implements a durable, governed, zero-cost, local-first runtime for autonomous software engineering tasks. While Milestones 2.16 through 2.20 established durable checkpointing, lease fencing, continuous routing, worker execution, and artifact generation, Milestone 2.21 introduces the **Operator Observability Layer**.

The goal of operator observability is to enable engineers and operators to inspect, diagnose, and understand the complete lifecycle of any agent run, task hierarchy, or event stream without requiring manual SQLite queries, custom scripts, or log diving.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Operator CLI Commands                           │
│   emerald run inspect   │   emerald task tree   │  emerald run events  │
└───────────────┬─────────────────────────┬──────────────────────┬───────┘
                │                         │                      │
                ▼                         ▼                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Operator Observability Module                      │
│             (src/application/operator-observability.ts)                 │
│                                                                        │
│  ┌─────────────────────────┐  ┌─────────────────────────────────────┐  │
│  │ Read-Only Preflight &   │  │ Redaction & Payload Allowlisting    │  │
│  │ Connection Guard        │  │ (Keys: secret, token, prompt, env)  │  │
│  │ - File existence check  │  │ - String truncation (> 160 chars)   │  │
│  │ - readOnly: true        │  │ - Safe JSON serialization           │  │
│  │ - PRAGMA query_only=ON  │  └─────────────────────────────────────┘  │
│  └─────────────────────────┘  ┌─────────────────────────────────────┐  │
│  ┌─────────────────────────┐  │ Failure Explanation Engine          │  │
│  │ Dispatch Eligibility    │  │ - LEASE_LOST / LEASE_EXPIRED        │  │
│  │ Evaluator (Read-Only)   │  │ - VERIFICATION_FAILED               │  │
│  │ - Reuses Router Policy  │  │ - REPLAY_BLOCKED_UNCERTAIN_ATTEMPT  │  │
│  │ - No mutation of state  │  │ - SQLITE_BUSY / SQLITE_LOCKED       │  │
│  └─────────────────────────┘  │ - MODEL_PROVIDER_FAILURE            │  │
│                               └─────────────────────────────────────┘  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ (PRAGMA query_only = ON)
                                     ▼
                     ┌───────────────────────────────┐
                     │   Durable SQLite Database     │
                     │  (tasks, runs, events, etc.)  │
                     └───────────────────────────────┘
```

### Core Invariants & Guarantees
1. **Strictly Read-Only Guarantee**:
   - Preflight file existence check: If the target database file does not exist, the CLI immediately fails closed with an error and **never creates a missing database file**.
   - Zero Migrations: Inspection commands never run DDL, never apply schema migrations, and never alter database metadata.
   - Connection Mode: Database connections are opened using Node.js `DatabaseSync(dbPath, { readOnly: true })` and explicitly execute `PRAGMA query_only = ON;`.
   - Zero Side-Effects: Inspection commands never acquire leases, never claim or complete runs, never trigger recovery, never dispatch router tasks, and never execute model inference or tools.
2. **Security & Redaction**:
   - Stored payloads and event data are treated as untrusted.
   - Sensitive fields containing patterns like `token`, `key`, `secret`, `password`, `credential`, `prompt`, `response`, `env`, or `auth` are automatically redacted (`[REDACTED]`).
   - Long string fields are truncated to at most 160 characters (`... (truncated)`).
3. **Deterministic Diagnosis**:
   - The diagnostic engine distinguishes between **Confirmed Fact** (from persisted records and events), **Inference** (derived from status and event semantics), and **Unknown Information** (when evidence is incomplete).
   - If a failure does not match an established signature, it is reported as `UNKNOWN_FAILURE` with a safe operator instruction to inspect the event stream rather than inventing speculative causes.

---

## 2. CLI Command Reference

### 2.1 Inspecting a Durable Run (`emerald run inspect`)

Inspects the durable state, execution attempts, actions, latch verification outcome, artifacts, and diagnostic failure explanation for a specific run.

```bash
emerald run inspect --db ./emerald.sqlite --run-id <RUN_ID> [--artifact-root <DIR>] [--json]
```

Also supports backward compatibility:
- `emerald inspect --db ./emerald.sqlite --run-id <RUN_ID>`
- In-memory fallback if `--db` is omitted.

#### Options
- `--db <path>`: Path to the durable SQLite database (must already exist).
- `--run-id <uuid>`: The unique identifier of the run to inspect.
- `--artifact-root <dir>`: Optional root directory containing exported workspace artifacts (defaults to `./artifacts`).
- `--json`: Emit machine-readable JSON output to stdout.

#### Example Text Output (Failed Run)
```text
Run ID:          8316608d-40cc-4e64-b494-0fce9e9e1955
Task ID:         task-2026-fix-01
Contract ID:     contract-2026-fix-01
Submission Key:  sub-key-42... [Redacted/Truncated]
Status:          FAILED
Created At:      2026-11-05T12:00:00.000Z
Completed At:    2026-11-05T12:02:15.000Z

[Execution Summary]
Attempts:        1
Actions Total:   3 (Succeeded: 2, Failed: 1)
Last Worker ID:  worker-11536-80bb9e31
Active Lease ID: none

[Verification]
Latch Status:    REJECTED
Verified:        No
Clean Room:      No
Authoritative:   Yes

[Artifacts]
Export Present:  Yes
Attempt Number:  1
Manifest Path:   artifacts/8316608d-40cc-4e64-b494-0fce9e9e1955/manifest.json
Patch Path:      artifacts/8316608d-40cc-4e64-b494-0fce9e9e1955/patch.diff

[Diagnostic Explanation]
Diagnostic Code: VERIFICATION_FAILED
Stage:           VERIFICATION
Terminal:        Yes
Persisted State: Contract verification latch rejected the result or reported verification errors.
Confirmed Fact:  Verification status evaluated to REJECTED.
Recommended Next: Inspect verification errors and failing test criteria before resubmitting.
```

#### Example JSON Output (`--json`)
```json
{
  "runId": "8316608d-40cc-4e64-b494-0fce9e9e1955",
  "taskId": "task-2026-fix-01",
  "contractId": "contract-2026-fix-01",
  "submissionKey": "sub-key-42",
  "status": "FAILED",
  "createdAt": "2026-11-05T12:00:00.000Z",
  "completedAt": "2026-11-05T12:02:15.000Z",
  "attempts": {
    "count": 1,
    "lastAttemptNumber": 1,
    "lastWorkerId": "worker-11536-80bb9e31",
    "activeLeaseId": null
  },
  "actions": {
    "total": 3,
    "succeeded": 2,
    "failed": 1
  },
  "verification": {
    "latchStatus": "REJECTED",
    "verified": false,
    "cleanRoom": false,
    "authoritativeEvidence": true
  },
  "artifacts": {
    "present": true,
    "attemptNumber": 1,
    "manifestPath": "artifacts/8316608d-40cc-4e64-b494-0fce9e9e1955/manifest.json",
    "patchPath": "artifacts/8316608d-40cc-4e64-b494-0fce9e9e1955/patch.diff"
  },
  "explanation": {
    "code": "VERIFICATION_FAILED",
    "stage": "VERIFICATION",
    "terminal": true,
    "persistedState": "Contract verification latch rejected the result or reported verification errors.",
    "confirmedFact": "Verification status evaluated to REJECTED.",
    "safeOperatorNextStep": "Inspect verification errors and failing test criteria before resubmitting."
  }
}
```

---

### 2.2 Inspecting Task Hierarchy & Dispatch Eligibility (`emerald task tree`)

Displays the full parent-child hierarchy for a task, including root, parent, child tasks, sibling order, associated run statuses, child execution history, and read-only dispatch eligibility.

```bash
emerald task tree --db ./emerald.sqlite --task-id <TASK_ID> [--json]
```

#### Options
- `--db <path>`: Path to durable SQLite database.
- `--task-id <string>`: The identifier of the root or intermediate task.
- `--json`: Emit machine-readable JSON representation.

#### Dispatch Eligibility States
Dispatch eligibility is evaluated using Emerald's existing router policy logic in a strictly read-only manner:
- `COMPLETED`: The task run has already reached `COMPLETED`.
- `CANCELLED`: The task run was `CANCELLED`.
- `FAILED`: The task run has `FAILED`.
- `DISPATCHED`: The task run has been admitted (`QUEUED`, `LEASED`, or `RUNNING`).
- `READY`: All parent/ancestor dependencies have reached `COMPLETED`, so this task is immediately eligible for dispatch.
- `BLOCKED`: One or more parent tasks have not yet reached `COMPLETED` (e.g. parent is `RUNNING` or `QUEUED`).

#### Example Text Output
```text
Task Tree for: task-root
--------------------------------------------------
* [task-root] Status: COMPLETED | Run: run-001 (COMPLETED) | Eligibility: COMPLETED
  |
  +-- [task-child-1] Status: COMPLETED | Run: run-002 (COMPLETED) | Eligibility: COMPLETED
  |     |
  |     +-- [task-grandchild-1] Status: CREATED | Run: run-003 (CREATED) | Eligibility: READY
  |
  +-- [task-child-2] Status: QUEUED | Run: run-004 (QUEUED) | Eligibility: DISPATCHED
```

#### Example JSON Output (`--json`)
```json
{
  "requestedTaskId": "task-root",
  "root": {
    "taskId": "task-root",
    "parentId": null,
    "status": "COMPLETED",
    "runId": "run-001",
    "runStatus": "COMPLETED",
    "eligibility": "COMPLETED",
    "eligibilityReason": "Task run is already COMPLETED",
    "children": [
      {
        "taskId": "task-child-1",
        "parentId": "task-root",
        "status": "COMPLETED",
        "runId": "run-002",
        "runStatus": "COMPLETED",
        "eligibility": "COMPLETED",
        "eligibilityReason": "Task run is already COMPLETED",
        "children": [
          {
            "taskId": "task-grandchild-1",
            "parentId": "task-child-1",
            "status": "CREATED",
            "runId": "run-003",
            "runStatus": "CREATED",
            "eligibility": "READY",
            "eligibilityReason": "All parent task dependencies are completed; eligible for router dispatch",
            "children": []
          }
        ]
      },
      {
        "taskId": "task-child-2",
        "parentId": "task-root",
        "status": "QUEUED",
        "runId": "run-004",
        "runStatus": "QUEUED",
        "eligibility": "DISPATCHED",
        "eligibilityReason": "Run is already QUEUED, LEASED, or RUNNING",
        "children": []
      }
    ]
  }
}
```

---

### 2.3 Inspecting the Durable Event Timeline (`emerald run events`)

Inspects chronological execution events persisted for a run in deterministic sequence order.

```bash
emerald run events --db ./emerald.sqlite --run-id <RUN_ID> [--limit <n>] [--after-sequence <n>] [--json]
```

#### Options
- `--db <path>`: Path to durable SQLite database.
- `--run-id <uuid>`: The identifier of the run.
- `--limit <n>`: Maximum number of events to return (default: `100`, max bounded: `1000`).
- `--after-sequence <n>`: Return events strictly after this sequence number (for pagination).
- `--json`: Output as machine-readable JSON array.

#### Example Text Output
```text
Event Timeline for Run: 8316608d-40cc-4e64-b494-0fce9e9e1955
Total events displayed: 4 (after sequence: 0, limit: 100)
--------------------------------------------------------------------------------
Seq  Timestamp                 Actor      Type                     Summary
--------------------------------------------------------------------------------
1    2026-11-05T12:00:00.000Z  router     run.created              Run initialized
2    2026-11-05T12:00:01.000Z  router     run.queued               Run queued for worker
3    2026-11-05T12:00:02.000Z  worker-1   worker.claimed           Lease acquired
4    2026-11-05T12:00:05.000Z  worker-1   tool.requested           tool: read_file
```

---

## 3. Diagnostic Failure Explanation Catalog

The failure explanation engine classifies failures using actual durable state, failure codes, and persisted event signatures.

| Diagnostic Code | Trigger Condition / Persisted Signatures | Stage Affected | Terminal? | Operator Safe Next Step |
|---|---|---|---|---|
| `LEASE_LOST` | `LeaseLostError`, lease fencing violation event, or stale lease mismatch during state write. | `EXECUTION` | Yes | Check if another worker acquired the lease; verify worker health before retrying. |
| `LEASE_EXPIRED` | `LeaseExpiredError`, `worker.lease.expired`, or heartbeat timeout. | `EXECUTION` | Yes | Verify worker process responsiveness and check heartbeat interval settings. |
| `VERIFICATION_FAILED` | Latch status `REJECTED`, verification failed event, or exit code non-zero in verification spec. | `VERIFICATION` | Yes | Inspect verification errors and failing test criteria before resubmitting. |
| `REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT` | `REPLAY_BLOCKED_UNCERTAIN_PRIOR_ATTEMPT`, non-idempotent action in uncertain status during retry. | `EXECUTION` | Yes | Inspect partial state and manually clear or mark the uncertain attempt before retry. |
| `SQLITE_BUSY` | `SQLITE_BUSY`, `SQLITE_LOCKED`, or SQLite contention failure. | `PERSISTENCE` | No (if retrying) / Yes (if exhausted) | Check concurrent database writers and tune busy backoff parameters. |
| `MODEL_PROVIDER_FAILURE` | Model provider error, timeout, malformed JSON, or invalid tool proposal. | `INFERENCE` | Yes | Inspect local model server (Ollama/vLLM) availability, context length, and prompt limits. |
| `CANCELLED` | Run status is `CANCELLED` or `run.cancelled` event present. | `ROUTING` / `EXECUTION` | Yes | Operator or parent task cancelled this run. No further execution required. |
| `TIMED_OUT` | Run status is `TIMED_OUT` or `run.timed_out` event present. | `EXECUTION` | Yes | Increase contract timeout duration or inspect execution loop for deadlocks. |
| `UNKNOWN_FAILURE` | Failure code or event does not match known signatures. | `UNKNOWN` | Derived from run status | Inspect raw run events with `emerald run events` to identify root cause. |

---

## 4. Operator Troubleshooting Workflows

### Scenario A: A Task Run Is Stuck in `CREATED`
1. Run `emerald task tree --db ./emerald.sqlite --task-id <TASK_ID>`.
2. Inspect the **Eligibility** column:
   - If `BLOCKED`: Check the status of parent tasks. The router host will not admit child tasks until the parent run reaches `COMPLETED`.
   - If `READY`: The router host has not executed a tick since the parent completed, or the concurrency ceiling (`--max-concurrent`) has been reached. Verify that `emerald router host` is running.

### Scenario B: A Run Failed Unexpectedly
1. Run `emerald run inspect --db ./emerald.sqlite --run-id <RUN_ID>`.
2. Review the `[Diagnostic Explanation]` section:
   - Note the **Diagnostic Code** and **Confirmed Fact**.
   - Review **Attempts** and **Actions Total** to see how far the agent progressed.
3. Run `emerald run events --db ./emerald.sqlite --run-id <RUN_ID>` to see the exact sequence of events leading up to the failure.
4. If the failure is `VERIFICATION_FAILED`, inspect the exported artifact diff:
   - Look at `artifacts/<RUN_ID>/patch.diff` and `manifest.json`.

### Scenario C: A Worker Lost Lease
1. Inspect the run: `emerald run inspect --db ./emerald.sqlite --run-id <RUN_ID>`.
2. If `LEASE_LOST` or `LEASE_EXPIRED` is reported:
   - Verify if the worker host process crashed, stalled, or suffered extreme disk I/O delay exceeding the heartbeat threshold.
   - Ensure only authorized workers possess active leases on the database.

---

## 5. Security & Redaction Behavior

Emerald operator commands are safe to run in automated pipelines and support sensitive environment compliance:
- **Zero Ingestion of Untrusted Code**: Inspection never imports or executes code from target repositories.
- **Sensitive Key Masking**: Any JSON object key containing `key`, `secret`, `token`, `password`, `credential`, `prompt`, `response`, `env`, or `auth` is masked with `[REDACTED]`.
- **String Length Caps**: Non-redacted string payloads in events and summaries are capped at 160 characters to prevent terminal memory bloat or accidental prompt leakages.
- **Fail-Closed Read-Only Mode**: Commands fail before opening SQLite if the database file does not exist, preventing the creation of accidental empty database files.
