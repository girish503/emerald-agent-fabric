# Emerald Agent Fabric — Long-Running Durable Router Host (Milestone 2.19)

## 1. Overview & Mission

Milestone 2.19 implements the long-running Router Host daemon (`emerald router host`), transforming the existing one-shot router CLI commands (`emerald router submit|tick|status|cancel`) into a durable, continuously running scheduling service.

The Router Host continuously inspects durable routing state in SQLite, dispatches eligible tasks into `QUEUED` runs up to configured concurrency limits, handles transient SQLite lock contention with bounded exponential backoff, and shuts down safely on termination signals.

---

## 2. Separation of Concerns: Router vs. Worker

Emerald strictly separates scheduling/routing from execution:

| Responsibility | Router Host (`emerald router host`) | Worker Host (`emerald worker`) |
| :--- | :--- | :--- |
| **Primary Role** | Dispatch and concurrency governance | Run claiming and task execution |
| **Input State** | `CREATED` runs from durable task submissions | `QUEUED` runs ready for execution |
| **Output State** | Transitions runs to `QUEUED` (Phase B) | Transitions runs to `RUNNING` -> `COMPLETED`/`FAILED` |
| **Topology** | Cascades cancellation across task trees (Phase A) | Executes leaf tasks independently |
| **Concurrency** | Enforces global cap (`maxConcurrentRuns`: 1 or 2) | Executes within worker lease budget |
| **Worker Process** | **Never executes or starts worker runtime** | Claims runs with lease TTL and renews heartbeat |

---

## 3. Database Contention & Exponential Backoff

When multiple processes (Router Host, Worker Host, durable task submission, recovery sweep) access the shared SQLite WAL database, transient lock contention may occur.

### Retryable Errors
The Router Host classifies errors via `isDatabaseBusyError`:
- Error codes: `SQLITE_BUSY`, `SQLITE_LOCKED`, `EBUSY`
- Error messages matching: `/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i`

### Backoff Schedule
Upon encountering transient lock contention:
1. Increment `consecutiveBusyRetries`.
2. Compute delay:
   $$\text{backoffMs} = \min(\text{busyBackoffMs} \times 2^{\text{consecutiveBusyRetries} - 1}, \text{maxBusyBackoffMs})$$
3. Emit structured log: `router.host.database_busy`.
4. Sleep with interruptible delay (`abortableSleep`).
5. Upon the first successful tick, reset `consecutiveBusyRetries` to 0.

### Fail-Closed Principle
Non-transient errors (such as disk corruption, syntax errors, constraint violations, invalid configurations) fail immediately without retry, emit `router.host.failed`, close resources, and terminate.

---

## 4. Graceful Shutdown & Resource Management

Router Host responds to `SIGINT`, `SIGTERM`, and programmatic `AbortSignal`:
1. **Synchronous Transaction Integrity**: The current tick transaction completes atomically; cancellation is never half-applied.
2. **Interruptible Sleep**: Any active delay (polling delay or busy backoff delay) is interrupted immediately upon abort without waiting for the timer to expire.
3. **Single-Close Invariant**: The database connection is closed exactly once (`closeStoreOnce`) in the `finally` block.
4. **Structured Observability**: Structured JSON logs are emitted on startup, tick completion, idle transitions (deduplicated to prevent log spam), contention, shutdown request, and final termination.
5. **Repeated Signal Idempotence**: Repeated `SIGINT` or `SIGTERM` signals are handled idempotently via the `AbortController` and do not invoke `process.exit()`, ensuring resource cleanup and SQLite closure are never bypassed.

---

## 5. CLI Interface

```bash
emerald router host --db <file> [options]
```

### Options:
- `--db <file>`: Required path to an existing SQLite database file. (Router host never creates the database).
- `--max-concurrent <1|2>`: Maximum in-flight runs permitted (default: `2`).
- `--poll-interval-ms <n>`: Interval between dispatch ticks when idle or running (default: `1000`).
- `--busy-backoff-ms <n>`: Initial retry backoff for SQLite contention (default: `100`).
- `--max-busy-backoff-ms <n>`: Ceiling for exponential backoff (default: `5000`).
- `--workspace-root <dir>`: Optional path to an existing workspace root directory.
- `--once`: Execute a single tick and terminate immediately (exit code 0).
