import type { DatabaseSync } from "node:sqlite";
import {
  activateMissionContract,
  canonicalJsonStringify,
  ContractStatus,
  InvalidMissionContractError,
  MissionContract,
  MissionContractLifecycle,
  MissionContractSpec,
  reconstituteMissionContract,
  revokeMissionContract,
} from "../../domain/index.js";
import {
  ContractIntegrityError,
  InvalidRunError,
  LeaseLostError,
  VersionConflictError,
} from "../../domain/errors.js";
import { DomainEvent } from "../../domain/events.js";
import {
  ContractBinding,
  createContractBinding,
  RunSnapshot,
  RunStatus,
  validateRunInvariants,
} from "../../domain/invariants.js";
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
  contract_id: string | null;
  contract_version: number | null;
  contract_hash: string | null;
  max_output_bytes: number | null;
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

function mapRunRowToSnapshot(row: DbRunRow, db?: DatabaseSync): RunSnapshot {
  let contractBinding: ContractBinding | null = null;
  let maxOutputBytes: number | null = null;

  if (row.contract_id !== null) {
    // Governed Run: all 4 fields must be present and valid
    if (
      row.contract_version === null ||
      row.contract_hash === null ||
      row.max_output_bytes === null
    ) {
      throw new InvalidRunError(row.run_id, [
        "Malformed partial contract binding in database: all 4 governance columns must be non-null for a governed Run.",
      ]);
    }

    if (!Number.isInteger(row.contract_version) || row.contract_version < 1) {
      throw new InvalidRunError(row.run_id, [
        `Invalid contract_version in database: expected integer >= 1, received ${String(row.contract_version)}.`,
      ]);
    }

    if (typeof row.contract_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.contract_hash)) {
      throw new InvalidRunError(row.run_id, [
        `Invalid contract_hash in database: expected 64 lowercase hexadecimal characters, received '${String(row.contract_hash)}'.`,
      ]);
    }

    if (!Number.isInteger(row.max_output_bytes) || row.max_output_bytes < 1) {
      throw new InvalidRunError(row.run_id, [
        `Invalid max_output_bytes in database: expected integer >= 1, received ${String(row.max_output_bytes)}.`,
      ]);
    }

    // Content Hash Integrity Check (Requirement 9)
    if (db) {
      const contractStmt = db.prepare(
        `SELECT * FROM mission_contracts WHERE contract_id = ? AND version = ?`
      );
      const contractRow = contractStmt.get(row.contract_id, row.contract_version) as
        | DbMissionContractRow
        | undefined;

      if (!contractRow) {
        throw new InvalidRunError(row.run_id, [
          `Referenced MissionContract '${row.contract_id}' v${row.contract_version} not found in database.`,
        ]);
      }

      // mapRowToMissionContract parses canonical_spec and reconstitutes the contract
      // reconstituteMissionContract verifies that computed hash matches contractRow.content_hash
      const contract = mapRowToMissionContract(contractRow);

      if (contract.contentHash.toLowerCase() !== row.contract_hash.toLowerCase()) {
        throw new ContractIntegrityError(
          row.run_id,
          row.contract_hash,
          contract.contentHash
        );
      }
    }

    contractBinding = createContractBinding({
      contractId: row.contract_id,
      version: row.contract_version,
      contentHash: row.contract_hash,
    });
    maxOutputBytes = row.max_output_bytes;
  } else {
    // Legacy Run: all 4 fields must be NULL
    if (
      row.contract_version !== null ||
      row.contract_hash !== null ||
      row.max_output_bytes !== null
    ) {
      throw new InvalidRunError(row.run_id, [
        "Malformed partial contract binding in database: legacy Run with null contract_id must have null version, hash, and max_output_bytes.",
      ]);
    }
    contractBinding = null;
    maxOutputBytes = null;
  }

  const snapshot: RunSnapshot = {
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
    contractBinding,
    maxOutputBytes,
  };

  validateRunInvariants(snapshot);
  return snapshot;
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

interface DbMissionContractRow {
  contract_id: string;
  version: number;
  task_id: string;
  status: string;
  content_hash: string;
  canonical_spec: string;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

function mapRowToMissionContract(row: DbMissionContractRow): MissionContract {
  let parsedSpec: unknown;
  try {
    parsedSpec = JSON.parse(row.canonical_spec);
  } catch {
    throw new InvalidMissionContractError(
      `Corrupted canonical_spec JSON in database for contract '${row.contract_id}' v${row.version}`
    );
  }

  const lifecycle: MissionContractLifecycle = {
    status: row.status as ContractStatus,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  };

  // Fail-closed reconstitution with content hash verification
  return reconstituteMissionContract(
    parsedSpec as MissionContractSpec,
    row.content_hash,
    lifecycle
  );
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

    const contractId = snapshot.contractBinding?.contractId ?? null;
    const contractVersion = snapshot.contractBinding?.version ?? null;
    const contractHash = snapshot.contractBinding?.contentHash ?? null;
    const maxOutputBytes = snapshot.maxOutputBytes ?? null;

    if (
      (contractId !== null || contractVersion !== null || contractHash !== null || maxOutputBytes !== null) &&
      (contractId === null || contractVersion === null || contractHash === null || maxOutputBytes === null)
    ) {
      throw new InvalidRunError(snapshot.runId, [
        "Cannot persist partial contract binding: all 4 governance columns must be non-null for governed runs, or all null for legacy runs.",
      ]);
    }

    const stmt = this.db.prepare(
      `INSERT INTO runs (
         run_id, task_id, status, idempotency_key, current_worker_id,
         lease_id, lease_expires_at, attempt_count, max_attempts, timeout_ms,
         result_payload, error_payload, version, created_at, updated_at,
         contract_id, contract_version, contract_hash, max_output_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      snapshot.updatedAt,
      contractId,
      contractVersion,
      contractHash,
      maxOutputBytes
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

    const contractId = nextSnapshot.contractBinding?.contractId ?? null;
    const contractVersion = nextSnapshot.contractBinding?.version ?? null;
    const contractHash = nextSnapshot.contractBinding?.contentHash ?? null;
    const maxOutputBytes = nextSnapshot.maxOutputBytes ?? null;

    if (
      (contractId !== null || contractVersion !== null || contractHash !== null || maxOutputBytes !== null) &&
      (contractId === null || contractVersion === null || contractHash === null || maxOutputBytes === null)
    ) {
      throw new InvalidRunError(nextSnapshot.runId, [
        "Cannot persist partial contract binding: all 4 governance columns must be non-null for governed runs, or all null for legacy runs.",
      ]);
    }

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
    return mapRunRowToSnapshot(row, this.db);
  }

  getRunRaw(runId: string): RunSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`);
    const row = stmt.get(runId) as DbRunRow | undefined;
    if (!row) return null;
    return mapRunRowToSnapshot(row, undefined);
  }

  getRunByIdempotencyKey(key: string): RunSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM runs WHERE idempotency_key = ?`);
    const row = stmt.get(key) as DbRunRow | undefined;
    if (!row) return null;
    return mapRunRowToSnapshot(row, this.db);
  }

  findQueuedRuns(limit: number = 10): readonly RunSnapshot[] {
    const stmt = this.db.prepare(
      `SELECT * FROM runs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT ?`
    );
    const rows = stmt.all(limit) as unknown as DbRunRow[];
    const result: RunSnapshot[] = [];
    for (const r of rows) {
      try {
        result.push(mapRunRowToSnapshot(r, this.db));
      } catch {
        result.push(mapRunRowToSnapshot(r, undefined));
      }
    }
    return result;
  }

  findExpiredRuns(nowIso: string): readonly RunSnapshot[] {
    const stmt = this.db.prepare(
      `SELECT * FROM runs WHERE (status = 'RUNNING' OR status = 'LEASED') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? ORDER BY lease_expires_at ASC`
    );
    const rows = stmt.all(nowIso) as unknown as DbRunRow[];
    const result: RunSnapshot[] = [];
    for (const r of rows) {
      try {
        result.push(mapRunRowToSnapshot(r, this.db));
      } catch {
        result.push(mapRunRowToSnapshot(r, undefined));
      }
    }
    return result;
  }

  findRunIdForWorkspace(workspaceId: string): string | null {
    const stmt = this.db.prepare(
      `SELECT run_id FROM run_events WHERE payload LIKE ? ORDER BY sequence DESC LIMIT 1`
    );
    const row = stmt.get(`%"workspaceId":"${workspaceId}"%`) as { run_id: string } | undefined;
    return row?.run_id ?? null;
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

  updateLeaseExpiresAt(leaseId: string, expiresAt: string): void {
    const stmt = this.db.prepare(`UPDATE leases SET expires_at = ? WHERE lease_id = ?`);
    stmt.run(expiresAt, leaseId);
  }

  updateRunLeaseExpiresAt(runId: string, leaseExpiresAt: string): void {
    const stmt = this.db.prepare(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`);
    stmt.run(leaseExpiresAt, runId);
  }

  insertContract(contract: MissionContract): void {
    const existing = this.getContract(contract.spec.contractId, contract.spec.version);
    if (existing) {
      throw new InvalidMissionContractError(
        `Mission contract '${contract.spec.contractId}' version ${contract.spec.version} already exists.`
      );
    }

    const canonicalSpec = canonicalJsonStringify(contract.spec);

    const stmt = this.db.prepare(
      `INSERT INTO mission_contracts (
         contract_id, version, task_id, status, content_hash, canonical_spec,
         created_at, activated_at, revoked_at, revocation_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      contract.spec.contractId,
      contract.spec.version,
      contract.spec.taskId,
      contract.lifecycle.status,
      contract.contentHash,
      canonicalSpec,
      contract.lifecycle.createdAt,
      contract.lifecycle.activatedAt,
      contract.lifecycle.revokedAt,
      contract.lifecycle.revocationReason
    );
  }

  getContract(contractId: string, version: number): MissionContract | null {
    const stmt = this.db.prepare(
      `SELECT * FROM mission_contracts WHERE contract_id = ? AND version = ?`
    );
    const row = stmt.get(contractId, version) as DbMissionContractRow | undefined;
    if (!row) return null;
    return mapRowToMissionContract(row);
  }

  findContractsByHash(contentHash: string): readonly MissionContract[] {
    const stmt = this.db.prepare(
      `SELECT * FROM mission_contracts WHERE content_hash = ? ORDER BY version ASC`
    );
    const rows = stmt.all(contentHash) as unknown as DbMissionContractRow[];
    return rows.map((row) => mapRowToMissionContract(row));
  }

  findContractsByTaskId(taskId: string, status?: ContractStatus): readonly MissionContract[] {
    let stmt;
    let rows: DbMissionContractRow[];
    if (status) {
      stmt = this.db.prepare(
        `SELECT * FROM mission_contracts WHERE task_id = ? AND status = ? ORDER BY version ASC`
      );
      rows = stmt.all(taskId, status) as unknown as DbMissionContractRow[];
    } else {
      stmt = this.db.prepare(
        `SELECT * FROM mission_contracts WHERE task_id = ? ORDER BY version ASC`
      );
      rows = stmt.all(taskId) as unknown as DbMissionContractRow[];
    }
    return rows.map((row) => mapRowToMissionContract(row));
  }

  activateContract(contractId: string, version: number, activatedAt?: string): MissionContract {
    const existing = this.getContract(contractId, version);
    if (!existing) {
      throw new InvalidMissionContractError(
        `Cannot activate contract '${contractId}' v${version}: contract not found.`
      );
    }

    const activated = activateMissionContract(existing, activatedAt);

    const stmt = this.db.prepare(
      `UPDATE mission_contracts
       SET status = ?, activated_at = ?
       WHERE contract_id = ? AND version = ? AND status = 'DRAFT'`
    );
    const result = stmt.run(
      activated.lifecycle.status,
      activated.lifecycle.activatedAt,
      contractId,
      version
    );

    if (result.changes === 0) {
      throw new InvalidMissionContractError(
        `Failed to activate contract '${contractId}' v${version}: status was modified concurrently.`
      );
    }

    return activated;
  }

  revokeContract(
    contractId: string,
    version: number,
    reason?: string,
    revokedAt?: string
  ): MissionContract {
    const existing = this.getContract(contractId, version);
    if (!existing) {
      throw new InvalidMissionContractError(
        `Cannot revoke contract '${contractId}' v${version}: contract not found.`
      );
    }

    const revoked = revokeMissionContract(existing, reason, revokedAt);

    const stmt = this.db.prepare(
      `UPDATE mission_contracts
       SET status = ?, revoked_at = ?, revocation_reason = ?
       WHERE contract_id = ? AND version = ? AND status = 'ACTIVE'`
    );
    const result = stmt.run(
      revoked.lifecycle.status,
      revoked.lifecycle.revokedAt,
      revoked.lifecycle.revocationReason,
      contractId,
      version
    );

    if (result.changes === 0) {
      throw new InvalidMissionContractError(
        `Failed to revoke contract '${contractId}' v${version}: status was modified concurrently.`
      );
    }

    return revoked;
  }

  updateContractLifecycle(contract: MissionContract): void {
    const stmt = this.db.prepare(
      `UPDATE mission_contracts
       SET status = ?, activated_at = ?, revoked_at = ?, revocation_reason = ?
       WHERE contract_id = ? AND version = ? AND content_hash = ?`
    );
    const result = stmt.run(
      contract.lifecycle.status,
      contract.lifecycle.activatedAt,
      contract.lifecycle.revokedAt,
      contract.lifecycle.revocationReason,
      contract.spec.contractId,
      contract.spec.version,
      contract.contentHash
    );

    if (result.changes === 0) {
      throw new InvalidMissionContractError(
        `Failed to update lifecycle for contract '${contract.spec.contractId}' v${contract.spec.version}: contract not found or specification hash mismatch.`
      );
    }
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

  getRunRaw(runId: string): RunSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getRunRaw(runId);
  }

  getRunByIdempotencyKey(key: string): RunSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getRunByIdempotencyKey(key);
  }

  findQueuedRuns(limit: number = 10): readonly RunSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findQueuedRuns(limit);
  }

  findExpiredRuns(nowIso: string): readonly RunSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findExpiredRuns(nowIso);
  }

  findRunIdForWorkspace(workspaceId: string): string | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findRunIdForWorkspace(workspaceId);
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

  insertContract(contract: MissionContract): void {
    this.transaction((tx) => tx.insertContract(contract));
  }

  getContract(contractId: string, version: number): MissionContract | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getContract(contractId, version);
  }

  findContractsByHash(contentHash: string): readonly MissionContract[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findContractsByHash(contentHash);
  }

  findContractsByTaskId(taskId: string, status?: ContractStatus): readonly MissionContract[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findContractsByTaskId(taskId, status);
  }

  activateContract(contractId: string, version: number, activatedAt?: string): MissionContract {
    return this.transaction((tx) => tx.activateContract(contractId, version, activatedAt));
  }

  revokeContract(contractId: string, version: number, reason?: string, revokedAt?: string): MissionContract {
    return this.transaction((tx) => tx.revokeContract(contractId, version, reason, revokedAt));
  }

  updateContractLifecycle(contract: MissionContract): void {
    this.transaction((tx) => tx.updateContractLifecycle(contract));
  }

  close(): void {
    this.db.close();
  }
}
