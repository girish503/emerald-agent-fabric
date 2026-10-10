import type { DatabaseSync } from "node:sqlite";
import { LeaseLostError, VersionConflictError } from "../../domain/errors.js";
import { DomainEvent } from "../../domain/events.js";
import { RunSnapshot, RunStatus } from "../../domain/invariants.js";
import {
  LeaseFencingCheck,
  LeaseRecord,
  LeaseState,
  PersistedEvent,
  StateStorePort,
  StorageTransaction,
  TaskRecord,
  WorkerRecord,
  WorkerStatus,
} from "../../ports/state-store.port.js";
import { createSqliteClient, SqliteClientConfig } from "./sqlite-client.js";

interface DbTaskRow {
  task_id: string;
  title: string;
  description: string;
  input_payload: string;
  created_at: string;
  updated_at: string;
}

interface DbRunRow {
  run_id: string;
  task_id: string;
  status: string;
  idempotency_key: string | null;
  current_worker_id: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  timeout_ms: number;
  result_payload: string | null;
  error_payload: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface DbEventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  schema_version: number;
  producer: string;
  payload: string;
}

interface DbWorkerRow {
  worker_id: string;
  hostname: string;
  pid: number;
  status: string;
  last_heartbeat_at: string;
  created_at: string;
}

interface DbLeaseRow {
  lease_id: string;
  run_id: string;
  worker_id: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
  state: string;
}

function mapRunRowToSnapshot(row: DbRunRow): RunSnapshot {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status as RunStatus,
    version: row.version,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    idempotencyKey: row.idempotency_key,
    currentWorkerId: row.current_worker_id,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    resultPayload: row.result_payload !== null ? JSON.parse(row.result_payload) : null,
    errorPayload: row.error_payload !== null ? JSON.parse(row.error_payload) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEventRowToPersistedEvent(row: DbEventRow): PersistedEvent {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    producer: row.producer,
    payload: JSON.parse(row.payload),
  };
}

export class SqliteStorageTransaction implements StorageTransaction {
  constructor(private readonly db: DatabaseSync) {}

  insertTask(task: TaskRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (task_id, title, description, input_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      task.taskId,
      task.title,
      task.description,
      JSON.stringify(task.inputPayload),
      task.createdAt,
      task.updatedAt
    );
  }

  getTask(taskId: string): TaskRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`);
    const row = stmt.get(taskId) as DbTaskRow | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      title: row.title,
      description: row.description,
      inputPayload: JSON.parse(row.input_payload),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  insertRun(snapshot: RunSnapshot, event: DomainEvent): PersistedEvent {
    // Request idempotency: if idempotencyKey exists, check if already recorded
    if (snapshot.idempotencyKey) {
      const existing = this.getRunByIdempotencyKey(snapshot.idempotencyKey);
      if (existing) {
        const events = this.getEventsForRun(existing.runId);
        const initialEvent = events[0];
        if (initialEvent) {
          return initialEvent;
        }
      }
    }

    const stmt = this.db.prepare(
      `INSERT INTO runs (
         run_id, task_id, status, idempotency_key, current_worker_id,
         lease_id, lease_expires_at, attempt_count, max_attempts, timeout_ms,
         result_payload, error_payload, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      snapshot.runId,
      snapshot.taskId,
      snapshot.status,
      snapshot.idempotencyKey,
      snapshot.currentWorkerId,
      snapshot.leaseId,
      snapshot.leaseExpiresAt,
      snapshot.attemptCount,
      snapshot.maxAttempts,
      snapshot.timeoutMs,
      snapshot.resultPayload !== null ? JSON.stringify(snapshot.resultPayload) : null,
      snapshot.errorPayload !== null ? JSON.stringify(snapshot.errorPayload) : null,
      snapshot.version,
      snapshot.createdAt,
      snapshot.updatedAt
    );

    return this.appendEvent(event);
  }

  updateRun(
    runId: string,
    expectedVersion: number,
    nextSnapshot: RunSnapshot,
    event: DomainEvent,
    fencing?: LeaseFencingCheck
  ): PersistedEvent {
    let result: { changes: number };

    if (fencing) {
      const stmt = this.db.prepare(
        `UPDATE runs SET
           status = ?, current_worker_id = ?, lease_id = ?, lease_expires_at = ?,
           attempt_count = ?, max_attempts = ?, timeout_ms = ?, result_payload = ?,
           error_payload = ?, version = ?, updated_at = ?
         WHERE run_id = ? AND version = ? AND lease_id = ? AND current_worker_id = ?`
      );
      result = stmt.run(
        nextSnapshot.status,
        nextSnapshot.currentWorkerId,
        nextSnapshot.leaseId,
        nextSnapshot.leaseExpiresAt,
        nextSnapshot.attemptCount,
        nextSnapshot.maxAttempts,
        nextSnapshot.timeoutMs,
        nextSnapshot.resultPayload !== null ? JSON.stringify(nextSnapshot.resultPayload) : null,
        nextSnapshot.errorPayload !== null ? JSON.stringify(nextSnapshot.errorPayload) : null,
        nextSnapshot.version,
        nextSnapshot.updatedAt,
        runId,
        expectedVersion,
        fencing.leaseId,
        fencing.workerId
      ) as { changes: number };
    } else {
      const stmt = this.db.prepare(
        `UPDATE runs SET
           status = ?, current_worker_id = ?, lease_id = ?, lease_expires_at = ?,
           attempt_count = ?, max_attempts = ?, timeout_ms = ?, result_payload = ?,
           error_payload = ?, version = ?, updated_at = ?
         WHERE run_id = ? AND version = ?`
      );
      result = stmt.run(
        nextSnapshot.status,
        nextSnapshot.currentWorkerId,
        nextSnapshot.leaseId,
        nextSnapshot.leaseExpiresAt,
        nextSnapshot.attemptCount,
        nextSnapshot.maxAttempts,
        nextSnapshot.timeoutMs,
        nextSnapshot.resultPayload !== null ? JSON.stringify(nextSnapshot.resultPayload) : null,
        nextSnapshot.errorPayload !== null ? JSON.stringify(nextSnapshot.errorPayload) : null,
        nextSnapshot.version,
        nextSnapshot.updatedAt,
        runId,
        expectedVersion
      ) as { changes: number };
    }

    if (result.changes === 0) {
      // Diagnostic inspection of failure reason
      const checkStmt = this.db.prepare(`SELECT version, lease_id, current_worker_id FROM runs WHERE run_id = ?`);
      const row = checkStmt.get(runId) as { version: number; lease_id: string | null; current_worker_id: string | null } | undefined;

      if (!row) {
        throw new Error(`Run '${runId}' not found`);
      }

      if (fencing && (row.lease_id !== fencing.leaseId || row.current_worker_id !== fencing.workerId)) {
        throw new LeaseLostError(runId, fencing.leaseId, row.lease_id);
      }

      if (row.version !== expectedVersion) {
        throw new VersionConflictError(runId, expectedVersion, row.version);
      }

      throw new Error(`Optimistic update failed unexpectedly for run '${runId}'`);
    }

    return this.appendEvent(event);
  }

  getRun(runId: string): RunSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`);
    const row = stmt.get(runId) as DbRunRow | undefined;
    if (!row) return null;
    return mapRunRowToSnapshot(row);
  }

  getRunByIdempotencyKey(key: string): RunSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM runs WHERE idempotency_key = ?`);
    const row = stmt.get(key) as DbRunRow | undefined;
    if (!row) return null;
    return mapRunRowToSnapshot(row);
  }

  appendEvent(event: DomainEvent): PersistedEvent {
    // Calculate gapless sequence inside BEGIN IMMEDIATE transaction
    const seqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?`
    );
    const seqRow = seqStmt.get(event.runId) as { next_seq: number };
    const sequence = seqRow.next_seq;

    const insertStmt = this.db.prepare(
      `INSERT INTO run_events (
         event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertStmt.run(
      event.eventId,
      event.runId,
      sequence,
      event.timestamp,
      event.eventType,
      event.schemaVersion,
      event.producer,
      JSON.stringify(event.payload)
    );

    return {
      eventId: event.eventId,
      runId: event.runId,
      sequence,
      timestamp: event.timestamp,
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      producer: event.producer,
      payload: event.payload,
    };
  }

  getEventsForRun(runId: string): readonly PersistedEvent[] {
    const stmt = this.db.prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC`);
    const rows = stmt.all(runId) as unknown as DbEventRow[];
    return rows.map(mapEventRowToPersistedEvent);
  }

  insertWorker(worker: WorkerRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO workers (worker_id, hostname, pid, status, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      worker.workerId,
      worker.hostname,
      worker.pid,
      worker.status,
      worker.lastHeartbeatAt,
      worker.createdAt
    );
  }

  getWorker(workerId: string): WorkerRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM workers WHERE worker_id = ?`);
    const row = stmt.get(workerId) as DbWorkerRow | undefined;
    if (!row) return null;
    return {
      workerId: row.worker_id,
      hostname: row.hostname,
      pid: row.pid,
      status: row.status as WorkerStatus,
      lastHeartbeatAt: row.last_heartbeat_at,
      createdAt: row.created_at,
    };
  }

  updateWorkerHeartbeat(workerId: string, heartbeatAt: string): void {
    const stmt = this.db.prepare(`UPDATE workers SET last_heartbeat_at = ? WHERE worker_id = ?`);
    stmt.run(heartbeatAt, workerId);
  }

  insertLease(lease: LeaseRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO leases (lease_id, run_id, worker_id, acquired_at, expires_at, released_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      lease.leaseId,
      lease.runId,
      lease.workerId,
      lease.acquiredAt,
      lease.expiresAt,
      lease.releasedAt,
      lease.state
    );
  }

  getLease(leaseId: string): LeaseRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM leases WHERE lease_id = ?`);
    const row = stmt.get(leaseId) as DbLeaseRow | undefined;
    if (!row) return null;
    return {
      leaseId: row.lease_id,
      runId: row.run_id,
      workerId: row.worker_id,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      releasedAt: row.released_at,
      state: row.state as LeaseState,
    };
  }

  updateLeaseState(leaseId: string, state: LeaseState, releasedAt?: string): void {
    const stmt = this.db.prepare(`UPDATE leases SET state = ?, released_at = ? WHERE lease_id = ?`);
    stmt.run(state, releasedAt ?? null, leaseId);
  }
}

export class SqliteStateStore implements StateStorePort {
  private readonly db: DatabaseSync;

  constructor(dbOrConfig?: DatabaseSync | SqliteClientConfig) {
    if (dbOrConfig && typeof (dbOrConfig as DatabaseSync).exec === "function") {
      this.db = dbOrConfig as DatabaseSync;
    } else {
      this.db = createSqliteClient(dbOrConfig as SqliteClientConfig | undefined);
    }
  }

  transaction<T>(operation: (tx: StorageTransaction) => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const tx = new SqliteStorageTransaction(this.db);
      const result = operation(tx);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Rollback might fail if transaction already aborted by SQLite constraint
      }
      throw error;
    }
  }

  getRun(runId: string): RunSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getRun(runId);
  }

  getRunByIdempotencyKey(key: string): RunSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getRunByIdempotencyKey(key);
  }

  getEventsForRun(runId: string): readonly PersistedEvent[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getEventsForRun(runId);
  }

  getTask(taskId: string): TaskRecord | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getTask(taskId);
  }

  getWorker(workerId: string): WorkerRecord | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getWorker(workerId);
  }

  getLease(leaseId: string): LeaseRecord | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getLease(leaseId);
  }

  close(): void {
    this.db.close();
  }
}
