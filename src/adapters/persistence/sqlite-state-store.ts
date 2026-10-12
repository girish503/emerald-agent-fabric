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
  ActionCommand,
  ActionSnapshot,
  ActionStatus,
  applyActionTransition,
  isTerminalActionStatus,
  validateActionInvariants,
  AttemptCommand,
  AttemptSnapshot,
  AttemptStatus,
  applyAttemptTransition,
  isTerminalAttemptStatus,
  validateAttemptInvariants,
  ToolName,
  ToolIdempotency,
  redactSensitiveData,
} from "../../domain/index.js";
import {
  ActionNotFoundError,
  ActiveAttemptConflictError,
  AttemptNotFoundError,
  ContractIntegrityError,
  DuplicateActionSequenceError,
  DuplicateAttemptError,
  DuplicateAttemptTokenError,
  InvalidActionError,
  InvalidActionTransitionError,
  InvalidAttemptError,
  InvalidAttemptTransitionError,
  InvalidContractBindingError,
  InvalidRunError,
  LeaseLostError,
  PayloadLimitExceededError,
  TerminalStateError,
  VersionConflictError,
} from "../../domain/errors.js";
import { AnyActionEvent, AnyAttemptEvent, DomainEvent } from "../../domain/events.js";
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

interface DbActionRow {
  action_id: string;
  run_id: string;
  sequence_number: number;
  tool_name: string;
  status: string;
  idempotency_type: string;
  input_hash: string;
  input_payload: string;
  result_payload: string | null;
  error_payload: string | null;
  contract_id: string;
  contract_version: number;
  contract_hash: string;
  active_attempt_number: number | null;
  total_attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface DbAttemptRow {
  attempt_id: string;
  action_id: string;
  run_id: string;
  attempt_number: number;
  worker_id: string;
  lease_id: string;
  status: string;
  idempotency_token: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  output_payload: string | null;
  error_payload: string | null;
  evidence_ids: string;
  provider_metadata: string | null;
}

export const MAX_PERSISTED_PAYLOAD_BYTES = 1024 * 1024; // 1 MB boundary

function serializeBoundedPayload(val: unknown, fieldName: string): string | null {
  if (val === null || val === undefined) return null;
  const redacted = redactSensitiveData(val);
  const json = JSON.stringify(redacted);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PERSISTED_PAYLOAD_BYTES) {
    throw new PayloadLimitExceededError(fieldName, byteLength, MAX_PERSISTED_PAYLOAD_BYTES);
  }
  return json;
}

function mapActionRowToSnapshot(row: DbActionRow, db?: DatabaseSync): ActionSnapshot {
  if (db) {
    const contractStmt = db.prepare(
      `SELECT content_hash FROM mission_contracts WHERE contract_id = ? AND version = ?`
    );
    const contractRow = contractStmt.get(row.contract_id, row.contract_version) as
      | { content_hash: string }
      | undefined;

    if (!contractRow) {
      throw new InvalidActionError(row.action_id, [
        `Referenced MissionContract '${row.contract_id}' v${row.contract_version} not found in database.`,
      ]);
    }

    if (contractRow.content_hash.toLowerCase() !== row.contract_hash.toLowerCase()) {
      throw new ContractIntegrityError(
        row.run_id,
        row.contract_hash,
        contractRow.content_hash
      );
    }
  }

  const contractBinding = createContractBinding({
    contractId: row.contract_id,
    version: row.contract_version,
    contentHash: row.contract_hash,
  });

  const snapshot: ActionSnapshot = {
    actionId: row.action_id,
    runId: row.run_id,
    sequenceNumber: row.sequence_number,
    toolName: row.tool_name as ToolName,
    inputPayload: JSON.parse(row.input_payload),
    inputHash: row.input_hash,
    idempotency: row.idempotency_type as ToolIdempotency,
    contractBinding,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    status: row.status as ActionStatus,
    activeAttemptNumber: row.active_attempt_number,
    totalAttempts: row.total_attempts,
    resultPayload: row.result_payload !== null ? JSON.parse(row.result_payload) : null,
    errorPayload: row.error_payload !== null ? JSON.parse(row.error_payload) : null,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };

  validateActionInvariants(snapshot);
  return snapshot;
}

function mapAttemptRowToSnapshot(row: DbAttemptRow): AttemptSnapshot {
  const snapshot: AttemptSnapshot = {
    attemptId: row.attempt_id,
    actionId: row.action_id,
    runId: row.run_id,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    leaseId: row.lease_id,
    idempotencyToken: row.idempotency_token,
    status: row.status as AttemptStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    outputPayload: row.output_payload !== null ? JSON.parse(row.output_payload) : null,
    errorPayload: row.error_payload !== null ? JSON.parse(row.error_payload) : null,
    evidenceIds: JSON.parse(row.evidence_ids ?? "[]"),
    providerMetadata: row.provider_metadata !== null ? JSON.parse(row.provider_metadata) : null,
  };

  validateAttemptInvariants(snapshot);
  return snapshot;
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

  // Action Operations
  insertAction(snapshot: ActionSnapshot, event: AnyActionEvent, fencing?: LeaseFencingCheck): PersistedEvent {
    validateActionInvariants(snapshot);

    const runStmt = this.db.prepare(
      `SELECT current_worker_id, lease_id, contract_id, contract_version, contract_hash, status FROM runs WHERE run_id = ?`
    );
    const runRow = runStmt.get(snapshot.runId) as {
      current_worker_id: string | null;
      lease_id: string | null;
      contract_id: string | null;
      contract_version: number | null;
      contract_hash: string | null;
      status: string;
    } | undefined;

    if (!runRow) {
      throw new Error(`Run '${snapshot.runId}' not found`);
    }

    if (
      runRow.contract_id === null ||
      runRow.contract_version === null ||
      runRow.contract_hash === null
    ) {
      throw new InvalidContractBindingError(
        `Cannot create Action on legacy run '${snapshot.runId}': Action requires governed Run with active Mission Contract`
      );
    }

    if (
      runRow.contract_id !== snapshot.contractBinding.contractId ||
      runRow.contract_version !== snapshot.contractBinding.version ||
      runRow.contract_hash.toLowerCase() !== snapshot.contractBinding.contentHash.toLowerCase()
    ) {
      throw new InvalidContractBindingError(
        `Action contract binding (${snapshot.contractBinding.contractId} v${snapshot.contractBinding.version}) does not match Run contract binding (${runRow.contract_id} v${runRow.contract_version})`
      );
    }

    if (fencing) {
      if (runRow.current_worker_id !== fencing.workerId || runRow.lease_id !== fencing.leaseId) {
        throw new LeaseLostError(snapshot.runId, fencing.leaseId, runRow.lease_id);
      }
    }

    const seqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM actions WHERE run_id = ?`
    );
    const seqRow = seqStmt.get(snapshot.runId) as { max_seq: number };
    const expectedSeq = seqRow.max_seq + 1;
    if (snapshot.sequenceNumber !== expectedSeq) {
      throw new InvalidActionError(snapshot.actionId, [
        `Sequence gap or non-monotonic sequence for run '${snapshot.runId}': expected ${expectedSeq}, received ${snapshot.sequenceNumber}`,
      ]);
    }

    const serializedInput = serializeBoundedPayload(snapshot.inputPayload, "inputPayload")!;
    const serializedResult = serializeBoundedPayload(snapshot.resultPayload, "resultPayload");
    const serializedError = serializeBoundedPayload(snapshot.errorPayload, "errorPayload");

    try {
      const stmt = this.db.prepare(
        `INSERT INTO actions (
           action_id, run_id, sequence_number, tool_name, status,
           idempotency_type, input_hash, input_payload, result_payload,
           error_payload, contract_id, contract_version, contract_hash,
           active_attempt_number, total_attempts, max_attempts,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(
        snapshot.actionId,
        snapshot.runId,
        snapshot.sequenceNumber,
        snapshot.toolName,
        snapshot.status,
        snapshot.idempotency,
        snapshot.inputHash,
        serializedInput,
        serializedResult,
        serializedError,
        snapshot.contractBinding.contractId,
        snapshot.contractBinding.version,
        snapshot.contractBinding.contentHash,
        snapshot.activeAttemptNumber,
        snapshot.totalAttempts,
        snapshot.maxAttempts,
        snapshot.createdAt,
        snapshot.updatedAt,
        snapshot.completedAt
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("actions.run_id, actions.sequence_number") || (msg.includes("UNIQUE constraint failed") && msg.includes("sequence_number"))) {
        throw new DuplicateActionSequenceError(snapshot.runId, snapshot.sequenceNumber);
      }
      throw err;
    }

    return this.appendEvent(event);
  }

  updateAction(
    actionId: string,
    nextSnapshot: ActionSnapshot,
    event: AnyActionEvent,
    fencing?: LeaseFencingCheck
  ): PersistedEvent {
    const current = this.getAction(actionId);
    if (!current) {
      throw new ActionNotFoundError(actionId);
    }

    if (isTerminalActionStatus(current.status)) {
      throw new TerminalStateError(current.status, `updateAction to '${nextSnapshot.status}'`);
    }

    validateActionInvariants(nextSnapshot);

    if (fencing) {
      const runStmt = this.db.prepare(`SELECT current_worker_id, lease_id FROM runs WHERE run_id = ?`);
      const runRow = runStmt.get(nextSnapshot.runId) as { current_worker_id: string | null; lease_id: string | null } | undefined;
      if (!runRow) {
        throw new Error(`Run '${nextSnapshot.runId}' not found`);
      }
      if (runRow.current_worker_id !== fencing.workerId || runRow.lease_id !== fencing.leaseId) {
        throw new LeaseLostError(nextSnapshot.runId, fencing.leaseId, runRow.lease_id);
      }
    }

    // Intent immutability check
    if (
      current.runId !== nextSnapshot.runId ||
      current.sequenceNumber !== nextSnapshot.sequenceNumber ||
      current.toolName !== nextSnapshot.toolName ||
      current.inputHash !== nextSnapshot.inputHash ||
      current.contractBinding.contractId !== nextSnapshot.contractBinding.contractId ||
      current.contractBinding.version !== nextSnapshot.contractBinding.version ||
      current.contractBinding.contentHash !== nextSnapshot.contractBinding.contentHash ||
      current.maxAttempts !== nextSnapshot.maxAttempts ||
      current.createdAt !== nextSnapshot.createdAt
    ) {
      throw new InvalidActionError(actionId, ["Intent fields of Action are immutable and cannot be modified"]);
    }

    const serializedResult = serializeBoundedPayload(nextSnapshot.resultPayload, "resultPayload");
    const serializedError = serializeBoundedPayload(nextSnapshot.errorPayload, "errorPayload");

    const stmt = this.db.prepare(
      `UPDATE actions SET
         status = ?, active_attempt_number = ?, total_attempts = ?,
         result_payload = ?, error_payload = ?, updated_at = ?, completed_at = ?
       WHERE action_id = ? AND status = ?`
    );
    const result = stmt.run(
      nextSnapshot.status,
      nextSnapshot.activeAttemptNumber,
      nextSnapshot.totalAttempts,
      serializedResult,
      serializedError,
      nextSnapshot.updatedAt,
      nextSnapshot.completedAt,
      actionId,
      current.status
    ) as { changes: number };

    if (result.changes === 0) {
      const fresh = this.getAction(actionId);
      if (!fresh) {
        throw new ActionNotFoundError(actionId);
      }
      if (fresh.status !== current.status) {
        throw new InvalidActionTransitionError(
          fresh.status,
          `updateAction to '${nextSnapshot.status}'`,
          "Concurrent status modification detected"
        );
      }
      throw new Error(`Optimistic update failed unexpectedly for action '${actionId}'`);
    }

    return this.appendEvent(event);
  }

  getAction(actionId: string): ActionSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM actions WHERE action_id = ?`);
    const row = stmt.get(actionId) as DbActionRow | undefined;
    if (!row) return null;
    return mapActionRowToSnapshot(row, this.db);
  }

  getActionsForRun(runId: string): readonly ActionSnapshot[] {
    const stmt = this.db.prepare(`SELECT * FROM actions WHERE run_id = ? ORDER BY sequence_number ASC`);
    const rows = stmt.all(runId) as unknown as DbActionRow[];
    return rows.map((r) => mapActionRowToSnapshot(r, this.db));
  }

  getActionBySequence(runId: string, sequenceNumber: number): ActionSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM actions WHERE run_id = ? AND sequence_number = ?`);
    const row = stmt.get(runId, sequenceNumber) as DbActionRow | undefined;
    if (!row) return null;
    return mapActionRowToSnapshot(row, this.db);
  }

  transitionAction(
    actionId: string,
    command: ActionCommand,
    eventIdGenerator: () => string,
    fencing?: LeaseFencingCheck
  ): { snapshot: ActionSnapshot; event: PersistedEvent } {
    const current = this.getAction(actionId);
    if (!current) {
      throw new ActionNotFoundError(actionId);
    }
    const { nextSnapshot, event } = applyActionTransition(current, command, eventIdGenerator);
    const persistedEvent = this.updateAction(actionId, nextSnapshot, event, fencing);
    return { snapshot: nextSnapshot, event: persistedEvent };
  }

  // Attempt Operations
  insertAttempt(snapshot: AttemptSnapshot, event: AnyAttemptEvent, fencing?: LeaseFencingCheck): PersistedEvent {
    validateAttemptInvariants(snapshot);

    const actionStmt = this.db.prepare(
      `SELECT action_id, run_id, status, max_attempts, total_attempts FROM actions WHERE action_id = ?`
    );
    const actionRow = actionStmt.get(snapshot.actionId) as {
      action_id: string;
      run_id: string;
      status: string;
      max_attempts: number;
      total_attempts: number;
    } | undefined;

    if (!actionRow) {
      throw new ActionNotFoundError(snapshot.actionId);
    }

    if (actionRow.run_id !== snapshot.runId) {
      throw new InvalidAttemptError(snapshot.attemptId, [
        `Attempt runId '${snapshot.runId}' does not match action runId '${actionRow.run_id}'`,
      ]);
    }

    if (isTerminalActionStatus(actionRow.status as ActionStatus)) {
      throw new TerminalStateError(
        actionRow.status,
        `Cannot create attempt '${snapshot.attemptId}' for terminal action '${snapshot.actionId}'`
      );
    }

    if (actionRow.status === "CREATED") {
      throw new InvalidActionTransitionError(
        actionRow.status,
        "createAttempt",
        "Action must be AUTHORIZED or RETRYING before creating attempts"
      );
    }

    if (snapshot.attemptNumber > actionRow.max_attempts) {
      throw new InvalidAttemptError(snapshot.attemptId, [
        `Attempt number ${snapshot.attemptNumber} exceeds max_attempts ceiling ${actionRow.max_attempts} for action '${snapshot.actionId}'`,
      ]);
    }

    const runStmt = this.db.prepare(`SELECT current_worker_id, lease_id FROM runs WHERE run_id = ?`);
    const runRow = runStmt.get(snapshot.runId) as { current_worker_id: string | null; lease_id: string | null } | undefined;
    if (!runRow) {
      throw new Error(`Run '${snapshot.runId}' not found`);
    }

    const effectiveFencing = fencing ?? { workerId: snapshot.workerId, leaseId: snapshot.leaseId };
    if (runRow.current_worker_id !== effectiveFencing.workerId || runRow.lease_id !== effectiveFencing.leaseId) {
      throw new LeaseLostError(snapshot.runId, effectiveFencing.leaseId, runRow.lease_id);
    }

    // Gapless attempt numbering check
    const attSeqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) AS max_att FROM attempts WHERE action_id = ?`
    );
    const attSeqRow = attSeqStmt.get(snapshot.actionId) as { max_att: number };
    const expectedAtt = attSeqRow.max_att + 1;
    if (snapshot.attemptNumber !== expectedAtt) {
      throw new InvalidAttemptError(snapshot.attemptId, [
        `Attempt number gap or non-monotonic sequence for action '${snapshot.actionId}': expected ${expectedAtt}, received ${snapshot.attemptNumber}`,
      ]);
    }

    // Active attempt check
    const activeCheckStmt = this.db.prepare(
      `SELECT attempt_id FROM attempts WHERE action_id = ? AND status IN ('CREATED', 'DISPATCHED', 'RUNNING')`
    );
    const activeRow = activeCheckStmt.get(snapshot.actionId) as { attempt_id: string } | undefined;
    if (activeRow) {
      throw new ActiveAttemptConflictError(snapshot.actionId);
    }

    const serializedOutput = serializeBoundedPayload(snapshot.outputPayload, "outputPayload");
    const serializedError = serializeBoundedPayload(snapshot.errorPayload, "errorPayload");
    const serializedMetadata = serializeBoundedPayload(snapshot.providerMetadata, "providerMetadata");

    try {
      const stmt = this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, action_id, run_id, attempt_number, worker_id, lease_id,
           status, idempotency_token, started_at, completed_at, duration_ms,
           exit_code, output_payload, error_payload, evidence_ids, provider_metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(
        snapshot.attemptId,
        snapshot.actionId,
        snapshot.runId,
        snapshot.attemptNumber,
        snapshot.workerId,
        snapshot.leaseId,
        snapshot.status,
        snapshot.idempotencyToken,
        snapshot.startedAt,
        snapshot.completedAt,
        snapshot.durationMs,
        snapshot.exitCode,
        serializedOutput,
        serializedError,
        JSON.stringify(snapshot.evidenceIds ?? []),
        serializedMetadata
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("attempts.action_id, attempts.attempt_number") || (msg.includes("UNIQUE constraint failed") && msg.includes("attempt_number"))) {
        throw new DuplicateAttemptError(snapshot.actionId, snapshot.attemptNumber);
      }
      if (msg.includes("attempts.idempotency_token") || (msg.includes("UNIQUE constraint failed") && msg.includes("idempotency_token"))) {
        throw new DuplicateAttemptTokenError(snapshot.idempotencyToken);
      }
      if (msg.includes("idx_attempts_action_active") || (msg.includes("UNIQUE constraint failed") && msg.includes("attempts.action_id"))) {
        throw new ActiveAttemptConflictError(snapshot.actionId);
      }
      throw err;
    }

    return this.appendEvent(event);
  }

  updateAttempt(
    attemptId: string,
    nextSnapshot: AttemptSnapshot,
    event: AnyAttemptEvent,
    fencing?: LeaseFencingCheck
  ): PersistedEvent {
    const current = this.getAttempt(attemptId);
    if (!current) {
      throw new AttemptNotFoundError(attemptId);
    }

    if (isTerminalAttemptStatus(current.status)) {
      throw new TerminalStateError(current.status, `updateAttempt to '${nextSnapshot.status}'`);
    }

    validateAttemptInvariants(nextSnapshot);

    const runStmt = this.db.prepare(`SELECT current_worker_id, lease_id FROM runs WHERE run_id = ?`);
    const runRow = runStmt.get(nextSnapshot.runId) as { current_worker_id: string | null; lease_id: string | null } | undefined;
    if (!runRow) {
      throw new Error(`Run '${nextSnapshot.runId}' not found`);
    }

    const effectiveFencing = fencing ?? { workerId: current.workerId, leaseId: current.leaseId };
    if (runRow.current_worker_id !== effectiveFencing.workerId || runRow.lease_id !== effectiveFencing.leaseId) {
      throw new LeaseLostError(nextSnapshot.runId, effectiveFencing.leaseId, runRow.lease_id);
    }

    // Identity immutability check
    if (
      current.actionId !== nextSnapshot.actionId ||
      current.runId !== nextSnapshot.runId ||
      current.attemptNumber !== nextSnapshot.attemptNumber ||
      current.workerId !== nextSnapshot.workerId ||
      current.leaseId !== nextSnapshot.leaseId ||
      current.idempotencyToken !== nextSnapshot.idempotencyToken
    ) {
      throw new InvalidAttemptError(attemptId, ["Core identity fields of Attempt are immutable and cannot be modified"]);
    }

    const serializedOutput = serializeBoundedPayload(nextSnapshot.outputPayload, "outputPayload");
    const serializedError = serializeBoundedPayload(nextSnapshot.errorPayload, "errorPayload");
    const serializedMetadata = serializeBoundedPayload(nextSnapshot.providerMetadata, "providerMetadata");

    const stmt = this.db.prepare(
      `UPDATE attempts SET
         status = ?, started_at = ?, completed_at = ?, duration_ms = ?, exit_code = ?,
         output_payload = ?, error_payload = ?, evidence_ids = ?, provider_metadata = ?
       WHERE attempt_id = ? AND status = ? AND lease_id = ? AND worker_id = ?`
    );
    const result = stmt.run(
      nextSnapshot.status,
      nextSnapshot.startedAt,
      nextSnapshot.completedAt,
      nextSnapshot.durationMs,
      nextSnapshot.exitCode,
      serializedOutput,
      serializedError,
      JSON.stringify(nextSnapshot.evidenceIds ?? []),
      serializedMetadata,
      attemptId,
      current.status,
      effectiveFencing.leaseId,
      effectiveFencing.workerId
    ) as { changes: number };

    if (result.changes === 0) {
      const fresh = this.getAttempt(attemptId);
      if (!fresh) {
        throw new AttemptNotFoundError(attemptId);
      }
      if (fresh.leaseId !== effectiveFencing.leaseId || fresh.workerId !== effectiveFencing.workerId) {
        throw new LeaseLostError(fresh.runId, effectiveFencing.leaseId, fresh.leaseId);
      }
      if (fresh.status !== current.status) {
        throw new InvalidAttemptTransitionError(
          fresh.status,
          `updateAttempt to '${nextSnapshot.status}'`,
          "Concurrent status modification detected"
        );
      }
      throw new Error(`Optimistic update failed unexpectedly for attempt '${attemptId}'`);
    }

    return this.appendEvent(event);
  }

  getAttempt(attemptId: string): AttemptSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`);
    const row = stmt.get(attemptId) as DbAttemptRow | undefined;
    if (!row) return null;
    return mapAttemptRowToSnapshot(row);
  }

  getAttemptsForAction(actionId: string): readonly AttemptSnapshot[] {
    const stmt = this.db.prepare(`SELECT * FROM attempts WHERE action_id = ? ORDER BY attempt_number ASC`);
    const rows = stmt.all(actionId) as unknown as DbAttemptRow[];
    return rows.map(mapAttemptRowToSnapshot);
  }

  getAttemptByNumber(actionId: string, attemptNumber: number): AttemptSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM attempts WHERE action_id = ? AND attempt_number = ?`);
    const row = stmt.get(actionId, attemptNumber) as DbAttemptRow | undefined;
    if (!row) return null;
    return mapAttemptRowToSnapshot(row);
  }

  getAttemptByIdempotencyToken(token: string): AttemptSnapshot | null {
    const stmt = this.db.prepare(`SELECT * FROM attempts WHERE idempotency_token = ?`);
    const row = stmt.get(token) as DbAttemptRow | undefined;
    if (!row) return null;
    return mapAttemptRowToSnapshot(row);
  }

  getActiveAttemptForAction(actionId: string): AttemptSnapshot | null {
    const stmt = this.db.prepare(
      `SELECT * FROM attempts WHERE action_id = ? AND status IN ('CREATED', 'DISPATCHED', 'RUNNING')`
    );
    const row = stmt.get(actionId) as DbAttemptRow | undefined;
    if (!row) return null;
    return mapAttemptRowToSnapshot(row);
  }

  transitionAttempt(
    attemptId: string,
    command: AttemptCommand,
    eventIdGenerator: () => string,
    fencing?: LeaseFencingCheck
  ): { snapshot: AttemptSnapshot; event: PersistedEvent } {
    const current = this.getAttempt(attemptId);
    if (!current) {
      throw new AttemptNotFoundError(attemptId);
    }
    const { nextSnapshot, event } = applyAttemptTransition(current, command, eventIdGenerator);
    const persistedEvent = this.updateAttempt(attemptId, nextSnapshot, event, fencing);
    return { snapshot: nextSnapshot, event: persistedEvent };
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

  getAction(actionId: string): ActionSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getAction(actionId);
  }

  getActionsForRun(runId: string): readonly ActionSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getActionsForRun(runId);
  }

  getActionBySequence(runId: string, sequenceNumber: number): ActionSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getActionBySequence(runId, sequenceNumber);
  }

  getAttempt(attemptId: string): AttemptSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getAttempt(attemptId);
  }

  getAttemptsForAction(actionId: string): readonly AttemptSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getAttemptsForAction(actionId);
  }

  getAttemptByNumber(actionId: string, attemptNumber: number): AttemptSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getAttemptByNumber(actionId, attemptNumber);
  }

  getAttemptByIdempotencyToken(token: string): AttemptSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getAttemptByIdempotencyToken(token);
  }

  getActiveAttemptForAction(actionId: string): AttemptSnapshot | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getActiveAttemptForAction(actionId);
  }

  close(): void {
    this.db.close();
  }
}
