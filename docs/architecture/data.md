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

### Durability Characteristics of `synchronous = NORMAL` in WAL Mode
- **Process Crash** (e.g. Node.js uncaught exception, SIGKILL): 100% durable. Committed WAL frames in OS page cache survive application crashes.
- **OS Failure** (e.g. Kernel Panic): Transactions committed since the last OS flush or WAL checkpoint may be lost if not yet written to physical disk. Database file remains uncorrupted via WAL frame checksums.
- **Machine Power Loss**: Recent transactions in volatile OS disk cache before power loss may not be recovered.
- **Storage Failure**: Hardware-level drive destruction requires backups/replication.
- **Stronger Durability**: Environments requiring per-commit power-loss guarantees should configure `synchronous = FULL`.

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

---

## 5. Evidence Bundle & Cryptographic Provenance Architecture (Phase 33)

### 5.1 Evidence Bundle Structure
An `EvidenceBundle` (`emerald-evidence-bundle-v1`) is an immutable, content-hashed artifact representing the complete execution history of a mission:
- `bundleId`: SHA-256 digest of canonical bundle content (excluding `bundleId`).
- `provenanceRoot`: SHA-256 digest of subsystem roots (`attemptRoot`, `checkpointRoot`, `contractHash`, `eventRoot`, `verificationRoot`).
- `run`: Run snapshot and operational metadata.
- `contract`: Complete `MissionContract` specification, lifecycle, and content hash.
- `checkpoints`: Monotonically ordered `MissionCheckpoint` records.
- `events`: Contiguous, gapless event stream ($1..M$) augmented with cryptographic hash chain pointers (`previousEventHash`, `eventHash`).
- `actions`: Complete `ActionSnapshot` collection.
- `attempts`: Monotonically numbered `AttemptSnapshot` collection preserving historical immutability.
- `supervisorEvidence`: `SupervisorLease` records proving recovery and supervision authority.
- `verificationEvidence`: Content-hashed `Evidence` records.
- `verificationResults`: Independent verification evaluations.
- `terminalState`: Derived or recorded terminal status and outputs.
- `provenance`: Export timestamp, exporter version, and provenance metadata.

### 5.2 Cryptographic Event Hash Chaining
Every event $i \in \{1 \dots M\}$ binds its predecessor:
- $e_1.\text{previousEventHash} = \text{SHA256}(\text{"genesis:"} + \text{runId})$
- $e_i.\text{previousEventHash} = e_{i-1}.\text{eventHash}$ for $i > 1$
- $e_i.\text{eventHash} = \text{SHA256}(\text{canonicalJsonStringify}(\{ \text{sequence}, \text{eventId}, \text{eventType}, \text{timestamp}, \text{producer}, \text{payload}, \text{previousEventHash} \}))$

### 5.3 Deterministic Canonicalization
All hashed data structures utilize `canonicalJsonStringify` (RFC-8785 conforming recursive key sorting, array stability, and explicit null preservation) to guarantee byte-for-byte serialization determinism across diverse runtimes.

---

## 6. Content-Addressed Immutable Evidence Archive & Ingestion Schemas (Phase 34)

### 6.1 Content-Addressed Archival Layout
Accepted evidence bundles are archived in a deterministic, content-addressed directory structure:
- `archive/accepted/<bundleId>.json`: Formatted as canonical JSON where `<bundleId>` is the strict 64-character lowercase hex SHA-256 digest of the bundle content (`^[0-9a-f]{64}$`).
- Once written, files in `archive/accepted/` are immutable and read-only. Ingestion never overwrites an existing accepted file.

### 6.2 Isolated Quarantine Hierarchy
Unverified, malformed, or tampered bundles are stored in an isolated quarantine hierarchy:
- `archive/quarantine/<reasonCode>/<quarantineId>.json`: Grouped by failure reason code (`BUNDLE_TOO_LARGE`, `INVALID_JSON`, `UNSUPPORTED_SCHEMA`, `INVALID_BUNDLE_ID`, `INVALID_PROVENANCE_ROOT`, `CONTRACT_INTEGRITY_FAILURE`, `EVENT_INTEGRITY_FAILURE`, `CHECKPOINT_INTEGRITY_FAILURE`, `ATTEMPT_INTEGRITY_FAILURE`, `AUTHORITY_INTEGRITY_FAILURE`, `VERIFICATION_INTEGRITY_FAILURE`, `REPLAY_VERIFICATION_FAILURE`, `IDENTITY_CONFLICT`, `SECURITY_POLICY_FAILURE`).
- Quarantined bundles are strictly segregated from accepted bundles and never treated as verified evidence.

### 6.3 Ingestion Domain Types
- `IngestionStatus`: `'ACCEPTED' | 'DUPLICATE' | 'QUARANTINED'`
- `IngestionReasonCode`: Deterministic failure taxonomy codes.
- `IngestionResult`: Complete receipt containing `status`, `bundleId`, `reasonCodes`, `ingestedAt`, `sizeBytes`, `replayValid`, and optional `archivePath` or `quarantinePath`.

---

## 7. Asymmetric Evidence Signing & Cryptographic Authority Schema (Phase 35)

### 7.1 Evidence Signature Structure
An `EvidenceBundle` may carry an optional Ed25519 signature object:
- `algorithm`: Strictly `"Ed25519"`.
- `keyId`: Non-empty producer key identifier resolved against local authority.
- `publicKeyFingerprint`: Deterministic 64-character lowercase hex SHA-256 digest of the public key's SPKI DER representation (`^[0-9a-f]{64}$`).
- `signature`: 128-character lowercase hex representation of the 64-byte Ed25519 signature (`^[0-9a-f]{128}$`).
- `signedContentDigest`: 64-character lowercase hex SHA-256 digest of the canonical JSON string of the signing payload.

### 7.2 Deterministic Signing Payload
The signature is computed strictly over the canonical serialization of the identity tuple:
$$\text{signingPayload} = \{ \text{bundleId}, \text{formatVersion}, \text{provenanceRoot}, \text{schemaVersion} \}$$
Because `bundleId` is a SHA-256 commitment over the entire canonical bundle content and `provenanceRoot` commits to all subsystem Merkle roots, this tuple transitively protects the entire accepted evidence bundle without circular hash dependencies.

### 7.3 Authority & Signature Ingestion Domain Types
- `KeyAuthorityStatus`: `'TRUSTED' | 'REVOKED'`
- `SignatureStatus`: `'VALID' | 'INVALID' | 'UNSIGNED_LEGACY'`
- `AuthorityStatus`: `'TRUSTED' | 'REVOKED' | 'UNKNOWN' | 'NOT_ESTABLISHED'`
