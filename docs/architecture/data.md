# Emerald Agent Fabric: Data Architecture

## 1. Data Segregation
The system strictly decouples the following data domains:
1. **Operational State**: SQLite (WAL mode) tracking runs, leases, workers, and tasks.
2. **Event Log**: Append-only event store capturing run lifecycle, tool calls, and policy audits.
3. **Artifacts & Evidence**: Filesystem-backed storage for diffs, evidence bundles, and execution outputs.
4. **Research & Benchmarks**: Decoupled datasets, experiment configs, evaluation scores, and traces.
5. **Model Metadata**: Token counts, prompt cache hits, latency metrics, and provider costs.

---

## 2. SQLite Configuration & Storage Engine

### PRAGMA Configuration
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

### Division of Responsibilities
| Responsibility | SQLite Layer | Application / Domain Layer |
| :--- | :--- | :--- |
| **Atomicity & Durability** | ACID transaction commit, WAL write-ahead log. | Groups state mutation + event append into single transaction. |
| **Referential Integrity** | Foreign key constraints (`tasks`, `runs`, `leases`, `run_events`). | Domain ensures valid entity lifecycles. |
| **Concurrency Control** | Serialized write transactions (`BEGIN IMMEDIATE`). | Optimistic Concurrency Control (`version = version + 1`). |
| **Event Uniqueness** | `UNIQUE(run_id, sequence)` constraint. | Computes monotonic sequence inside write lock. |
| **Business Logic** | None (pure relational store; no triggers, no stored procs). | Validates state transitions, enforces fencing tokens. |

---

## 3. Schema Definitions

### 3.1 `tasks`
Stores immutable task definitions.
```sql
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_payload TEXT NOT NULL, -- JSON
    created_at TEXT NOT NULL,    -- ISO 8601 UTC
    updated_at TEXT NOT NULL
);
```

### 3.2 `runs`
Tracks run lifecycle, leases, and operational state.
```sql
CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    status TEXT NOT NULL, -- CREATED, QUEUED, LEASED, RUNNING, COMPLETED, FAILED, CANCELLED, TIMED_OUT, RECOVERING
    idempotency_key TEXT UNIQUE,
    current_worker_id TEXT REFERENCES workers(worker_id),
    lease_id TEXT,
    lease_expires_at TEXT, -- ISO 8601 UTC
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    result_payload TEXT,   -- JSON
    error_payload TEXT,    -- JSON
    version INTEGER NOT NULL DEFAULT 1, -- Optimistic concurrency control
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_task_id ON runs(task_id);
CREATE INDEX idx_runs_lease_expires ON runs(lease_expires_at);
```

### 3.3 `run_events`
Append-only immutable audit trail and replay stream.
```sql
CREATE TABLE run_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    producer TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON
    UNIQUE(run_id, sequence)
);

CREATE INDEX idx_events_run_seq ON run_events(run_id, sequence);
CREATE INDEX idx_events_type ON run_events(event_type);
```

### 3.4 `workers`
Active and historic worker node registry.
```sql
CREATE TABLE workers (
    worker_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    pid INTEGER NOT NULL,
    status TEXT NOT NULL, -- ACTIVE, DRAINING, STOPPED
    last_heartbeat_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

### 3.5 `leases`
Audit trail of lease acquisitions and releases.
```sql
CREATE TABLE leases (
    lease_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    worker_id TEXT NOT NULL REFERENCES workers(worker_id),
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    state TEXT NOT NULL -- ACTIVE, EXPIRED, RELEASED, REVOKED
);

CREATE INDEX idx_leases_run_active ON leases(run_id, state);
```

---

## 4. Telemetry & Correlation IDs
Every record and event in the system is correlated across five canonical identifiers:
1. `task_id`: Top-level user/client task specification.
2. `run_id`: Specific execution lifecycle instance.
3. `worker_id`: Executing process/host identity.
4. `lease_id`: Time-bounded exclusive fencing token.
5. `event_id`: Specific immutable audit event in the lifecycle stream.
