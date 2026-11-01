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
  LeaseExpiredError,
  LeaseLostError,
  AttemptNotOwnedError,
  SupervisorLeaseExpiredError,
  SupervisorLeaseLostError,
  InvalidCheckpointError,
  CheckpointVersionConflictError,
  PayloadLimitExceededError,
  TerminalStateError,
  VersionConflictError,
  MutationIntentNotFoundError,
  InvalidMutationTransitionError,
  UnauthorizedMutationTransitionError,
  MissingMutationAuthorityError,
  WorkspaceBindingConflictError,
  TenantLaunchGateConflictError,
} from "../../domain/errors.js";
import type { TenantLaunchGate } from "../../ports/tenant-launch-coordinator.port.js";
import { AnyActionEvent, AnyAttemptEvent, DomainEvent } from "../../domain/events.js";
import {
  MutationIntent,
  MutationLifecycleStatus,
  PathRollbackProgress,
  PathRollbackStatus,
  RunRollback,
  RunRollbackStatus,
  isLegalMutationTransition,
  validateMutationIntentInvariants,
} from "../../domain/mutation-intent.js";
import {
  MutationIntentStorePort,
  TransitionMutationStatusParams,
} from "../../ports/mutation-intent-store.port.js";
import {
  ContractBinding,
  createContractBinding,
  isTerminalState,
  RunSnapshot,
  RunStatus,
  validateRunInvariants,
} from "../../domain/invariants.js";
import {
  LeaseFencingCheck,
  LeaseRecord,
  LeaseState,
  SupervisorLease,
  SupervisorFencingCheck,
  MissionCheckpoint,
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
  dedup_token?: string | null;
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

interface DbSupervisorLeaseRow {
  lease_id: string;
  run_id: string;
  supervisor_id: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
  state: string;
}

interface DbCheckpointRow {
  checkpoint_id: string;
  run_id: string;
  checkpoint_version: number;
  contract_id: string;
  contract_version: number;
  contract_hash: string;
  action_id: string | null;
  attempt_number: number | null;
  durable_state: string;
  event_sequence: number;
  created_at: string;
  updated_at: string;
}

function mapSupervisorLeaseRow(row: DbSupervisorLeaseRow): SupervisorLease {
  return {
    leaseId: row.lease_id,
    runId: row.run_id,
    supervisorId: row.supervisor_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    state: row.state as "ACTIVE" | "EXPIRED" | "RELEASED",
  };
}

interface DbMutationIntentRow {
  mutation_id: string;
  run_id: string;
  worker_lease_id: string;
  relative_path: string;
  canonical_path: string;
  parent_mutation_id: string | null;
  path_mutation_version: number;
  base_digest: string;
  expected_resulting_digest: string;
  snapshot_ref: string;
  recovery_dedup_token: string;
  lifecycle_status: string;
  created_at: number;
  updated_at: number;
  conflict_details: string | null;
}

interface DbRunRollbackRow {
  run_id: string;
  status: string;
  initiated_by: string;
  created_at: number;
  completed_at: number | null;
  conflict_details: string | null;
}

interface DbPathRollbackProgressRow {
  run_id: string;
  relative_path: string;
  status: string;
  initial_base_digest: string;
  latest_expected_digest: string;
  baseline_snapshot_ref: string;
  updated_at: number;
  error_message: string | null;
}

function mapMutationIntentRow(row: DbMutationIntentRow): MutationIntent {
  return {
    mutationId: row.mutation_id,
    runId: row.run_id,
    workerLeaseId: row.worker_lease_id,
    relativePath: row.relative_path,
    canonicalPath: row.canonical_path,
    parentMutationId: row.parent_mutation_id,
    pathMutationVersion: row.path_mutation_version,
    baseDigest: row.base_digest,
    expectedResultingDigest: row.expected_resulting_digest,
    snapshotRef: row.snapshot_ref,
    recoveryDedupToken: row.recovery_dedup_token,
    lifecycleStatus: row.lifecycle_status as MutationLifecycleStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conflictDetails: row.conflict_details,
  };
}

function mapRunRollbackRow(row: DbRunRollbackRow): RunRollback {
  return {
    runId: row.run_id,
    status: row.status as RunRollbackStatus,
    initiatedBy: row.initiated_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    conflictDetails: row.conflict_details,
  };
}

function mapPathRollbackProgressRow(row: DbPathRollbackProgressRow): PathRollbackProgress {
  return {
    runId: row.run_id,
    relativePath: row.relative_path,
    status: row.status as PathRollbackStatus,
    initialBaseDigest: row.initial_base_digest,
    latestExpectedDigest: row.latest_expected_digest,
    baselineSnapshotRef: row.baseline_snapshot_ref,
    updatedAt: row.updated_at,
    errorMessage: row.error_message,
  };
}

function mapCheckpointRow(row: DbCheckpointRow): MissionCheckpoint {
  let durableState: Record<string, unknown> = {};
  try {
    durableState = JSON.parse(row.durable_state);
  } catch {
    durableState = {};
  }
  return {
    checkpointId: row.checkpoint_id,
    runId: row.run_id,
    checkpointVersion: row.checkpoint_version,
    contractBinding: {
      contractId: row.contract_id,
      version: row.contract_version,
      contentHash: row.contract_hash,
    },
    actionId: row.action_id,
    attemptNumber: row.attempt_number,
    durableState,
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    // Fail-closed: assume alive on unexpected error to prevent unsafe lock stealing
    return true;
  }
}

export class SqliteStorageTransaction implements StorageTransaction, MutationIntentStorePort {
  private readonly db: DatabaseSync;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    db: DatabaseSync,
    isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive
  ) {
    this.db = db;
    this.isProcessAlive = isProcessAlive;
  }

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

  findRecoveringRuns(limit = 100): readonly RunSnapshot[] {
    const stmt = this.db.prepare(
      `SELECT * FROM runs WHERE status = 'RECOVERING' ORDER BY updated_at ASC LIMIT ?`
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

  findRunIdForWorkspace(workspaceId: string): string | null {
    const stmt = this.db.prepare(
      `SELECT run_id FROM run_events WHERE payload LIKE ? ORDER BY sequence DESC LIMIT 1`
    );
    const row = stmt.get(`%"workspaceId":"${workspaceId}"%`) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  appendEvent(event: DomainEvent, dedupToken?: string | null): PersistedEvent {
    // Calculate gapless sequence inside BEGIN IMMEDIATE transaction
    const seqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?`
    );
    const seqRow = seqStmt.get(event.runId) as { next_seq: number };
    const sequence = seqRow.next_seq;

    const insertStmt = this.db.prepare(
      `INSERT INTO run_events (
         event_id, run_id, sequence, timestamp, event_type, schema_version, producer, payload, dedup_token
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertStmt.run(
      event.eventId,
      event.runId,
      sequence,
      event.timestamp,
      event.eventType,
      event.schemaVersion,
      event.producer,
      JSON.stringify(event.payload),
      dedupToken ?? null
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

  private validateLeaseFencing(runId: string, fencing: LeaseFencingCheck): void {
    const runStmt = this.db.prepare(`SELECT current_worker_id, lease_id FROM runs WHERE run_id = ?`);
    const runRow = runStmt.get(runId) as { current_worker_id: string | null; lease_id: string | null } | undefined;
    if (!runRow) {
      throw new Error(`Run '${runId}' not found`);
    }
    if (runRow.current_worker_id !== fencing.workerId || runRow.lease_id !== fencing.leaseId) {
      throw new LeaseLostError(runId, fencing.leaseId, runRow.lease_id);
    }
    const leaseStmt = this.db.prepare(`SELECT state, expires_at FROM leases WHERE lease_id = ?`);
    const leaseRow = leaseStmt.get(fencing.leaseId) as { state: string; expires_at: string } | undefined;
    if (leaseRow) {
      if (leaseRow.state !== "ACTIVE") {
        throw new LeaseLostError(runId, fencing.leaseId, runRow.lease_id);
      }
      if (fencing.nowIso && leaseRow.expires_at <= fencing.nowIso) {
        throw new LeaseExpiredError(fencing.leaseId, leaseRow.expires_at, fencing.nowIso);
      }
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
      this.validateLeaseFencing(snapshot.runId, fencing);
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
      this.validateLeaseFencing(nextSnapshot.runId, fencing);
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
    if (fencing) {
      this.validateLeaseFencing(current.runId, fencing);
    }
    // Idempotent duplicate SUCCEED check
    if (current.status === "SUCCEEDED" && command.type === "SUCCEED") {
      const events = this.getEventsForRun(current.runId);
      const existingEvent = events.find(
        (e) => e.eventType === "action.completed" && (e.payload as any)?.actionId === actionId
      );
      if (existingEvent) {
        return { snapshot: current, event: existingEvent };
      }
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

    const effectiveFencing = fencing ?? { workerId: snapshot.workerId, leaseId: snapshot.leaseId, nowIso: snapshot.startedAt };
    this.validateLeaseFencing(snapshot.runId, effectiveFencing);

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

    if (fencing) {
      this.validateLeaseFencing(nextSnapshot.runId, fencing);
      if (current.workerId !== fencing.workerId || current.leaseId !== fencing.leaseId) {
        throw new AttemptNotOwnedError(attemptId, current.workerId, fencing.workerId, current.leaseId, fencing.leaseId);
      }
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
       WHERE attempt_id = ? AND status = ?`
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
      current.status
    ) as { changes: number };

    if (result.changes === 0) {
      const fresh = this.getAttempt(attemptId);
      if (!fresh) {
        throw new AttemptNotFoundError(attemptId);
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

  findInFlightAttempts(limit: number = 50): readonly AttemptSnapshot[] {
    const stmt = this.db.prepare(
      `SELECT * FROM attempts WHERE status IN ('CREATED', 'DISPATCHED', 'RUNNING') ORDER BY started_at ASC LIMIT ?`
    );
    const rows = stmt.all(limit) as unknown as DbAttemptRow[];
    return rows.map(mapAttemptRowToSnapshot);
  }

  findInFlightActions(limit: number = 50): readonly ActionSnapshot[] {
    const stmt = this.db.prepare(
      `SELECT * FROM actions WHERE status IN ('CREATED', 'AUTHORIZED', 'RUNNING', 'RETRYING') ORDER BY created_at ASC LIMIT ?`
    );
    const rows = stmt.all(limit) as unknown as DbActionRow[];
    return rows.map((r) => mapActionRowToSnapshot(r, this.db));
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
    if (fencing) {
      this.validateLeaseFencing(current.runId, fencing);
      if (current.workerId !== fencing.workerId || current.leaseId !== fencing.leaseId) {
        throw new AttemptNotOwnedError(attemptId, current.workerId, fencing.workerId, current.leaseId, fencing.leaseId);
      }
    }
    // Idempotent duplicate COMPLETE check
    if (current.status === "SUCCEEDED" && command.type === "COMPLETE") {
      const events = this.getEventsForRun(current.runId);
      const existingEvent = events.find(
        (e) => e.eventType === "attempt.completed" && (e.payload as any)?.attemptId === attemptId
      );
      if (existingEvent) {
        return { snapshot: current, event: existingEvent };
      }
    }
    const { nextSnapshot, event } = applyAttemptTransition(current, command, eventIdGenerator);
    const persistedEvent = this.updateAttempt(attemptId, nextSnapshot, event, fencing);
    return { snapshot: nextSnapshot, event: persistedEvent };
  }

  // ---------------------------------------------------------------------------
  // Supervisor Lease Operations
  // ---------------------------------------------------------------------------

  validateSupervisorFencing(runId: string, fencing: SupervisorFencingCheck): void {
    const stmt = this.db.prepare(
      `SELECT * FROM supervisor_leases WHERE lease_id = ? AND run_id = ?`
    );
    const row = stmt.get(fencing.leaseId, runId) as DbSupervisorLeaseRow | undefined;
    if (!row) {
      throw new SupervisorLeaseLostError(runId, fencing.supervisorId, null, "Supervisor lease not found");
    }
    if (row.state !== "ACTIVE") {
      throw new SupervisorLeaseLostError(runId, fencing.supervisorId, row.supervisor_id, `Supervisor lease state is '${row.state}'`);
    }
    if (row.supervisor_id !== fencing.supervisorId) {
      throw new SupervisorLeaseLostError(runId, fencing.supervisorId, row.supervisor_id, "Supervisor identity mismatch");
    }
    const expiresMs = new Date(row.expires_at).getTime();
    if (isNaN(expiresMs)) {
      throw new SupervisorLeaseExpiredError(fencing.leaseId, row.expires_at, new Date().toISOString());
    }

    let effectiveNowMs = Date.now();
    if (fencing.nowIso !== undefined) {
      if (typeof fencing.nowIso !== "string" || fencing.nowIso.trim().length === 0) {
        throw new MissingMutationAuthorityError(runId, "Supervisor fencing nowIso must be a non-empty string when provided");
      }
      const callerNowMs = new Date(fencing.nowIso).getTime();
      if (isNaN(callerNowMs)) {
        throw new MissingMutationAuthorityError(runId, `Invalid supervisor fencing nowIso timestamp format: '${fencing.nowIso}'`);
      }
      effectiveNowMs = Math.max(Date.now(), callerNowMs);
    }

    if (effectiveNowMs >= expiresMs) {
      throw new SupervisorLeaseExpiredError(fencing.leaseId, row.expires_at, new Date(effectiveNowMs).toISOString());
    }
  }

  acquireSupervisorLease(params: {
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
  }): SupervisorLease {
    const run = this.getRun(params.runId);
    if (!run) {
      throw new Error(`Run '${params.runId}' not found`);
    }

    const activeStmt = this.db.prepare(
      `SELECT * FROM supervisor_leases WHERE run_id = ? AND state = 'ACTIVE' ORDER BY expires_at DESC LIMIT 1`
    );
    const existing = activeStmt.get(params.runId) as DbSupervisorLeaseRow | undefined;

    if (existing) {
      const nowMs = new Date(params.nowIso).getTime();
      const expiresMs = new Date(existing.expires_at).getTime();

      if (nowMs < expiresMs) {
        // Exclusive: a second ACTIVE lease is never issued, even to the same supervisor id
        // (a holder extends its own lease with renewSupervisorLease).
        throw new SupervisorLeaseLostError(
          params.runId,
          params.supervisorId,
          existing.supervisor_id,
          existing.supervisor_id === params.supervisorId
            ? `Supervisor '${existing.supervisor_id}' already holds an unexpired lease until ${existing.expires_at}; renew it or use a unique supervisor id`
            : `Active unexpired supervisor lease held by '${existing.supervisor_id}' until ${existing.expires_at}`
        );
      } else {
        this.db.prepare(`UPDATE supervisor_leases SET state = 'EXPIRED' WHERE lease_id = ?`).run(existing.lease_id);
      }
    }

    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(new Date(params.nowIso).getTime() + params.ttlMs).toISOString();

    const insertStmt = this.db.prepare(
      `INSERT INTO supervisor_leases (lease_id, run_id, supervisor_id, acquired_at, expires_at, state)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE')`
    );
    try {
      insertStmt.run(leaseId, params.runId, params.supervisorId, params.nowIso, expiresAt);
    } catch (err: unknown) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        throw new SupervisorLeaseLostError(
          params.runId,
          params.supervisorId,
          null,
          "Another supervisor acquired the run concurrently"
        );
      }
      throw err;
    }

    return {
      leaseId,
      runId: params.runId,
      supervisorId: params.supervisorId,
      acquiredAt: params.nowIso,
      expiresAt,
      releasedAt: null,
      state: "ACTIVE",
    };
  }

  renewSupervisorLease(params: {
    leaseId: string;
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
  }): SupervisorLease {
    const stmt = this.db.prepare(`SELECT * FROM supervisor_leases WHERE lease_id = ?`);
    const row = stmt.get(params.leaseId) as DbSupervisorLeaseRow | undefined;

    if (!row || row.run_id !== params.runId) {
      throw new SupervisorLeaseLostError(
        params.runId,
        params.supervisorId,
        row?.supervisor_id ?? null,
        "Supervisor lease not found or run mismatch"
      );
    }

    if (row.supervisor_id !== params.supervisorId) {
      throw new SupervisorLeaseLostError(
        params.runId,
        params.supervisorId,
        row.supervisor_id,
        "Supervisor identity mismatch"
      );
    }

    if (row.state !== "ACTIVE") {
      throw new SupervisorLeaseLostError(
        params.runId,
        params.supervisorId,
        row.supervisor_id,
        `Cannot renew supervisor lease in state '${row.state}'`
      );
    }

    const nowMs = new Date(params.nowIso).getTime();
    const expiresMs = new Date(row.expires_at).getTime();

    if (nowMs >= expiresMs) {
      this.db.prepare(`UPDATE supervisor_leases SET state = 'EXPIRED' WHERE lease_id = ?`).run(params.leaseId);
      throw new SupervisorLeaseExpiredError(params.leaseId, row.expires_at, params.nowIso);
    }

    const usurperStmt = this.db.prepare(
      `SELECT * FROM supervisor_leases WHERE run_id = ? AND state = 'ACTIVE' AND lease_id != ?`
    );
    const usurper = usurperStmt.get(params.runId, params.leaseId) as DbSupervisorLeaseRow | undefined;
    if (usurper) {
      throw new SupervisorLeaseLostError(
        params.runId,
        params.supervisorId,
        usurper.supervisor_id,
        "Supervisor lease usurped by another supervisor"
      );
    }

    const newExpiresAt = new Date(nowMs + params.ttlMs).toISOString();
    this.db.prepare(`UPDATE supervisor_leases SET expires_at = ? WHERE lease_id = ?`).run(newExpiresAt, params.leaseId);

    return {
      leaseId: params.leaseId,
      runId: params.runId,
      supervisorId: params.supervisorId,
      acquiredAt: row.acquired_at,
      expiresAt: newExpiresAt,
      releasedAt: row.released_at,
      state: "ACTIVE",
    };
  }

  releaseSupervisorLease(leaseId: string, nowIso: string): void {
    this.db.prepare(`UPDATE supervisor_leases SET state = 'RELEASED', released_at = ? WHERE lease_id = ?`).run(nowIso, leaseId);
  }

  expireSupervisorLease(leaseId: string, _nowIso: string): void {
    this.db.prepare(`UPDATE supervisor_leases SET state = 'EXPIRED' WHERE lease_id = ?`).run(leaseId);
  }

  getSupervisorLease(leaseId: string): SupervisorLease | null {
    const stmt = this.db.prepare(`SELECT * FROM supervisor_leases WHERE lease_id = ?`);
    const row = stmt.get(leaseId) as DbSupervisorLeaseRow | undefined;
    return row ? mapSupervisorLeaseRow(row) : null;
  }

  findActiveSupervisorLease(runId: string, nowIso?: string): SupervisorLease | null {
    const stmt = this.db.prepare(
      `SELECT * FROM supervisor_leases WHERE run_id = ? AND state = 'ACTIVE' ORDER BY expires_at DESC LIMIT 1`
    );
    const row = stmt.get(runId) as DbSupervisorLeaseRow | undefined;
    if (!row) return null;
    if (nowIso && new Date(nowIso).getTime() >= new Date(row.expires_at).getTime()) {
      return null;
    }
    return mapSupervisorLeaseRow(row);
  }

  getSupervisorLeasesForRun(runId: string): readonly SupervisorLease[] {
    const stmt = this.db.prepare(
      `SELECT * FROM supervisor_leases WHERE run_id = ? ORDER BY acquired_at ASC`
    );
    const rows = stmt.all(runId) as unknown as DbSupervisorLeaseRow[];
    return rows.map(mapSupervisorLeaseRow);
  }

  // ---------------------------------------------------------------------------
  // Checkpoint Operations
  // ---------------------------------------------------------------------------

  insertCheckpoint(checkpoint: MissionCheckpoint): void {
    const run = this.getRun(checkpoint.runId);
    if (!run) {
      throw new InvalidCheckpointError(checkpoint.runId, [`Run '${checkpoint.runId}' not found`]);
    }

    if (run.contractBinding) {
      if (
        run.contractBinding.contractId !== checkpoint.contractBinding.contractId ||
        run.contractBinding.version !== checkpoint.contractBinding.version ||
        run.contractBinding.contentHash.toLowerCase() !== checkpoint.contractBinding.contentHash.toLowerCase()
      ) {
        throw new ContractIntegrityError(
          checkpoint.runId,
          run.contractBinding.contentHash,
          checkpoint.contractBinding.contentHash
        );
      }
    }

    const contractStmt = this.db.prepare(
      `SELECT content_hash, status FROM mission_contracts WHERE contract_id = ? AND version = ?`
    );
    const contractRow = contractStmt.get(
      checkpoint.contractBinding.contractId,
      checkpoint.contractBinding.version
    ) as { content_hash: string; status: string } | undefined;

    if (!contractRow) {
      throw new InvalidCheckpointError(checkpoint.runId, [
        `Referenced MissionContract '${checkpoint.contractBinding.contractId}' v${checkpoint.contractBinding.version} not found in database`,
      ]);
    }

    if (contractRow.content_hash.toLowerCase() !== checkpoint.contractBinding.contentHash.toLowerCase()) {
      throw new ContractIntegrityError(
        checkpoint.runId,
        checkpoint.contractBinding.contentHash,
        contractRow.content_hash
      );
    }

    if (contractRow.status === "REVOKED") {
      throw new InvalidMissionContractError(
        `Bound MissionContract '${checkpoint.contractBinding.contractId}' v${checkpoint.contractBinding.version} has been REVOKED`
      );
    }

    const maxVerStmt = this.db.prepare(
      `SELECT MAX(checkpoint_version) as max_version FROM mission_checkpoints WHERE run_id = ?`
    );
    const maxVerRow = maxVerStmt.get(checkpoint.runId) as { max_version: number | null } | undefined;
    const currentMax = maxVerRow?.max_version;

    if (currentMax !== null && currentMax !== undefined) {
      if (checkpoint.checkpointVersion <= currentMax) {
        throw new CheckpointVersionConflictError(
          checkpoint.runId,
          checkpoint.checkpointVersion,
          currentMax
        );
      }
    } else {
      if (checkpoint.checkpointVersion < 1) {
        throw new InvalidCheckpointError(checkpoint.runId, [
          `checkpointVersion must be an integer >= 1, received ${checkpoint.checkpointVersion}`,
        ]);
      }
    }

    const serializedState = serializeBoundedPayload(checkpoint.durableState, "durableState") ?? "{}";

    const insertStmt = this.db.prepare(
      `INSERT INTO mission_checkpoints (
        checkpoint_id, run_id, checkpoint_version, contract_id, contract_version, contract_hash,
        action_id, attempt_number, durable_state, event_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertStmt.run(
      checkpoint.checkpointId,
      checkpoint.runId,
      checkpoint.checkpointVersion,
      checkpoint.contractBinding.contractId,
      checkpoint.contractBinding.version,
      checkpoint.contractBinding.contentHash,
      checkpoint.actionId ?? null,
      checkpoint.attemptNumber ?? null,
      serializedState,
      checkpoint.eventSequence,
      checkpoint.createdAt,
      checkpoint.updatedAt
    );
  }

  getLatestCheckpoint(runId: string): MissionCheckpoint | null {
    const stmt = this.db.prepare(
      `SELECT * FROM mission_checkpoints WHERE run_id = ? ORDER BY checkpoint_version DESC LIMIT 1`
    );
    const row = stmt.get(runId) as DbCheckpointRow | undefined;
    return row ? mapCheckpointRow(row) : null;
  }

  getCheckpoints(runId: string): readonly MissionCheckpoint[] {
    const stmt = this.db.prepare(
      `SELECT * FROM mission_checkpoints WHERE run_id = ? ORDER BY checkpoint_version ASC`
    );
    const rows = stmt.all(runId) as unknown as DbCheckpointRow[];
    return rows.map(mapCheckpointRow);
  }

  // ---------------------------------------------------------------------------
  // Mutation Intent Operations (ADR-0036)
  // ---------------------------------------------------------------------------

  recordIntent(intent: MutationIntent): void {
    validateMutationIntentInvariants(intent);

    // 1. Authoritative run existence & worker/lease assignment check
    const runStmt = this.db.prepare(`SELECT current_worker_id, lease_id FROM runs WHERE run_id = ?`);
    const runRow = runStmt.get(intent.runId) as { current_worker_id: string | null; lease_id: string | null } | undefined;
    if (!runRow) {
      throw new LeaseLostError(intent.runId, intent.workerLeaseId, null);
    }
    if (runRow.lease_id !== intent.workerLeaseId) {
      throw new LeaseLostError(intent.runId, intent.workerLeaseId, runRow.lease_id);
    }

    // 2. Authoritative lease validation per ADR-0036 Section 2.4 and Gate 0
    const leaseStmt = this.db.prepare(`SELECT run_id, worker_id, state, expires_at FROM leases WHERE lease_id = ?`);
    const leaseRow = leaseStmt.get(intent.workerLeaseId) as { run_id: string; worker_id: string; state: string; expires_at: string } | undefined;
    if (!leaseRow || leaseRow.state !== "ACTIVE") {
      throw new LeaseLostError(intent.runId, intent.workerLeaseId, runRow.lease_id);
    }
    if (leaseRow.run_id !== intent.runId) {
      throw new LeaseLostError(intent.runId, intent.workerLeaseId, runRow.lease_id);
    }
    if (runRow.current_worker_id !== leaseRow.worker_id) {
      throw new LeaseLostError(intent.runId, intent.workerLeaseId, runRow.lease_id);
    }

    const nowIso = new Date().toISOString();
    if (leaseRow.expires_at <= nowIso) {
      throw new LeaseExpiredError(intent.workerLeaseId, leaseRow.expires_at, nowIso);
    }

    const stmt = this.db.prepare(`
      INSERT INTO mutation_intents (
        mutation_id, run_id, worker_lease_id, relative_path, canonical_path,
        parent_mutation_id, path_mutation_version, base_digest, expected_resulting_digest,
        snapshot_ref, recovery_dedup_token, lifecycle_status, created_at, updated_at, conflict_details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      intent.mutationId,
      intent.runId,
      intent.workerLeaseId,
      intent.relativePath,
      intent.canonicalPath,
      intent.parentMutationId,
      intent.pathMutationVersion,
      intent.baseDigest,
      intent.expectedResultingDigest,
      intent.snapshotRef,
      intent.recoveryDedupToken,
      intent.lifecycleStatus,
      intent.createdAt,
      intent.updatedAt,
      intent.conflictDetails ?? null
    );
  }

  getIntent(mutationId: string): MutationIntent | null {
    const stmt = this.db.prepare(`SELECT * FROM mutation_intents WHERE mutation_id = ?`);
    const row = stmt.get(mutationId) as DbMutationIntentRow | undefined;
    return row ? mapMutationIntentRow(row) : null;
  }

  getIntentsForRun(runId: string): readonly MutationIntent[] {
    const stmt = this.db.prepare(
      `SELECT * FROM mutation_intents WHERE run_id = ? ORDER BY path_mutation_version ASC, created_at ASC`
    );
    const rows = stmt.all(runId) as unknown as DbMutationIntentRow[];
    return rows.map(mapMutationIntentRow);
  }

  getIntentsForPath(runId: string, relativePath: string): readonly MutationIntent[] {
    const stmt = this.db.prepare(
      `SELECT * FROM mutation_intents WHERE run_id = ? AND relative_path = ? ORDER BY path_mutation_version ASC`
    );
    const rows = stmt.all(runId, relativePath) as unknown as DbMutationIntentRow[];
    return rows.map(mapMutationIntentRow);
  }

  getLatestIntentForPath(runId: string, relativePath: string): MutationIntent | null {
    const stmt = this.db.prepare(
      `SELECT * FROM mutation_intents WHERE run_id = ? AND relative_path = ? ORDER BY path_mutation_version DESC LIMIT 1`
    );
    const row = stmt.get(runId, relativePath) as DbMutationIntentRow | undefined;
    return row ? mapMutationIntentRow(row) : null;
  }

  transitionMutationStatus(params: TransitionMutationStatusParams): PersistedEvent {
    // 0. Authority Context Validation (mandatory)
    if (
      !params.authorityContext ||
      typeof params.authorityContext !== "object" ||
      !("authority" in params.authorityContext)
    ) {
      throw new MissingMutationAuthorityError(params.mutationId);
    }
    const { authority } = params.authorityContext;
    if (authority !== "WORKER" && authority !== "SUPERVISOR") {
      throw new MissingMutationAuthorityError(
        params.mutationId,
        `Invalid mutation transition authority: '${String(authority)}'. Must be 'WORKER' or 'SUPERVISOR'`
      );
    }

    // 1. Validate legal status transition
    if (!isLegalMutationTransition(params.fromStatus, params.toStatus)) {
      throw new InvalidMutationTransitionError(
        params.mutationId,
        params.fromStatus,
        params.toStatus,
        `Illegal transition from '${params.fromStatus}' to '${params.toStatus}'`
      );
    }

    // 2. Query existing intent
    const intentStmt = this.db.prepare(`SELECT * FROM mutation_intents WHERE mutation_id = ?`);
    const intentRow = intentStmt.get(params.mutationId) as DbMutationIntentRow | undefined;
    if (!intentRow) {
      throw new MutationIntentNotFoundError(params.mutationId);
    }

    // 3. Query run row for identity, lease assignment, and lifecycle state
    const runStmt = this.db.prepare(`SELECT current_worker_id, lease_id, status FROM runs WHERE run_id = ?`);
    const runRow = runStmt.get(intentRow.run_id) as { current_worker_id: string | null; lease_id: string | null; status: string } | undefined;
    if (!runRow) {
      throw new Error(`Run '${intentRow.run_id}' not found`);
    }

    // Fail closed if run has reached terminal state
    if (isTerminalState(runRow.status as RunStatus)) {
      throw new TerminalStateError(runRow.status, `transitionMutationStatus(${params.toStatus})`);
    }

    // 4. Authority-specific transition permission, lifecycle binding, and fencing validation
    if (authority === "WORKER") {
      const workerAllowed: readonly MutationLifecycleStatus[] = [
        "SNAPSHOT_WRITTEN",
        "APPLYING_MUTATION",
        "COMMITTED",
      ];
      if (!workerAllowed.includes(params.toStatus)) {
        throw new UnauthorizedMutationTransitionError(
          params.mutationId,
          "WORKER",
          params.fromStatus,
          params.toStatus,
          `Worker authority is not permitted to transition mutation '${params.mutationId}' to status '${params.toStatus}'`
        );
      }

      const WORKER_PERMITTED_RUN_STATES: readonly RunStatus[] = ["RUNNING", "VERIFYING"];
      if (!WORKER_PERMITTED_RUN_STATES.includes(runRow.status as RunStatus)) {
        throw new UnauthorizedMutationTransitionError(
          params.mutationId,
          "WORKER",
          params.fromStatus,
          params.toStatus,
          `Worker authority cannot transition mutations when run '${intentRow.run_id}' is in '${runRow.status}' status`
        );
      }

      const { fencing } = params.authorityContext as { authority: "WORKER"; fencing: LeaseFencingCheck };
      if (!fencing || typeof fencing !== "object") {
        throw new MissingMutationAuthorityError(
          params.mutationId,
          `Worker authority context requires valid LeaseFencingCheck`
        );
      }
      if (!fencing.leaseId || typeof fencing.leaseId !== "string" || fencing.leaseId.trim().length === 0) {
        throw new MissingMutationAuthorityError(
          params.mutationId,
          `Worker authority context requires valid non-empty leaseId`
        );
      }
      if (!fencing.workerId || typeof fencing.workerId !== "string" || fencing.workerId.trim().length === 0) {
        throw new MissingMutationAuthorityError(
          params.mutationId,
          `Worker authority context requires valid non-empty workerId`
        );
      }

      // Check worker lease matches the lease recorded on the intent (worker cannot transition another worker's intent)
      if (intentRow.worker_lease_id !== fencing.leaseId) {
        throw new LeaseLostError(intentRow.run_id, fencing.leaseId, intentRow.worker_lease_id);
      }

      // Check run row assignments with strict unconditional equality
      if (runRow.lease_id !== fencing.leaseId) {
        throw new LeaseLostError(intentRow.run_id, fencing.leaseId, runRow.lease_id);
      }
      if (runRow.current_worker_id !== fencing.workerId) {
        throw new LeaseLostError(intentRow.run_id, fencing.leaseId, runRow.lease_id);
      }

      // Check lease row
      const leaseStmt = this.db.prepare(`SELECT run_id, worker_id, state, expires_at FROM leases WHERE lease_id = ?`);
      const leaseRow = leaseStmt.get(fencing.leaseId) as { run_id: string; worker_id: string; state: string; expires_at: string } | undefined;
      if (!leaseRow || leaseRow.state !== "ACTIVE" || leaseRow.run_id !== intentRow.run_id) {
        throw new LeaseLostError(intentRow.run_id, fencing.leaseId, runRow.lease_id);
      }
      if (leaseRow.worker_id !== fencing.workerId) {
        throw new LeaseLostError(intentRow.run_id, fencing.leaseId, runRow.lease_id);
      }

      const leaseExpiresMs = new Date(leaseRow.expires_at).getTime();
      if (isNaN(leaseExpiresMs)) {
        throw new LeaseExpiredError(fencing.leaseId, leaseRow.expires_at, new Date().toISOString());
      }

      let effectiveNowMs = Date.now();
      if (fencing.nowIso !== undefined) {
        if (typeof fencing.nowIso !== "string" || fencing.nowIso.trim().length === 0) {
          throw new MissingMutationAuthorityError(params.mutationId, "Worker fencing nowIso must be a non-empty string when provided");
        }
        const callerNowMs = new Date(fencing.nowIso).getTime();
        if (isNaN(callerNowMs)) {
          throw new MissingMutationAuthorityError(params.mutationId, `Invalid worker fencing nowIso timestamp format: '${fencing.nowIso}'`);
        }
        effectiveNowMs = Math.max(Date.now(), callerNowMs);
      }

      if (effectiveNowMs >= leaseExpiresMs) {
        throw new LeaseExpiredError(fencing.leaseId, leaseRow.expires_at, new Date(effectiveNowMs).toISOString());
      }
    } else {
      // SUPERVISOR
      const supervisorAllowed: readonly MutationLifecycleStatus[] = [
        "ABORTED_UNMUTATED",
        "ROLLING_BACK",
        "ROLLED_BACK",
        "ROLLBACK_CONFLICT_LOST_UPDATE",
        "ROLLBACK_CONFLICT_HASH_MISMATCH",
        "RESTORE_FAILED",
      ];
      if (!supervisorAllowed.includes(params.toStatus)) {
        throw new UnauthorizedMutationTransitionError(
          params.mutationId,
          "SUPERVISOR",
          params.fromStatus,
          params.toStatus,
          `Supervisor authority is not permitted to transition mutation '${params.mutationId}' to status '${params.toStatus}'`
        );
      }

      const SUPERVISOR_PERMITTED_RUN_STATES: readonly RunStatus[] = ["RECOVERING", "RUNNING", "LEASED"];
      if (!SUPERVISOR_PERMITTED_RUN_STATES.includes(runRow.status as RunStatus)) {
        throw new UnauthorizedMutationTransitionError(
          params.mutationId,
          "SUPERVISOR",
          params.fromStatus,
          params.toStatus,
          `Supervisor authority cannot transition mutations when run '${intentRow.run_id}' is in '${runRow.status}' status`
        );
      }

      const { supervisorFencing } = params.authorityContext as { authority: "SUPERVISOR"; supervisorFencing: SupervisorFencingCheck };
      if (!supervisorFencing || typeof supervisorFencing !== "object") {
        throw new MissingMutationAuthorityError(
          params.mutationId,
          `Supervisor authority context requires valid SupervisorFencingCheck`
        );
      }
      if (!supervisorFencing.leaseId || typeof supervisorFencing.leaseId !== "string" || supervisorFencing.leaseId.trim().length === 0) {
        throw new MissingMutationAuthorityError(
          params.mutationId,
          `Supervisor authority context requires valid non-empty leaseId`
        );
      }
      if (!supervisorFencing.supervisorId || typeof supervisorFencing.supervisorId !== "string" || supervisorFencing.supervisorId.trim().length === 0) {
        throw new MissingMutationAuthorityError(
          params.mutationId,
          `Supervisor authority context requires valid non-empty supervisorId`
        );
      }

      // Authoritative supervisor fencing check against supervisor_leases table
      this.validateSupervisorFencing(intentRow.run_id, supervisorFencing);
    }

    // 4. Idempotency check: if already at toStatus and dedupToken matches
    if (intentRow.lifecycle_status === params.toStatus && intentRow.recovery_dedup_token === params.nextDedupToken) {
      const eventStmt = this.db.prepare(`SELECT * FROM run_events WHERE dedup_token = ?`);
      const eventRow = eventStmt.get(params.nextDedupToken) as DbEventRow | undefined;
      if (eventRow) {
        return mapEventRowToPersistedEvent(eventRow);
      }
    }

    // 5. Current status check
    if (intentRow.lifecycle_status !== params.fromStatus) {
      throw new InvalidMutationTransitionError(
        params.mutationId,
        intentRow.lifecycle_status,
        params.toStatus,
        `Expected current status '${params.fromStatus}' but found '${intentRow.lifecycle_status}'`
      );
    }

    const nowMs = params.nowMs ?? Date.now();

    // 6. Update mutation_intents
    const updateStmt = this.db.prepare(`
      UPDATE mutation_intents
      SET lifecycle_status = ?,
          recovery_dedup_token = ?,
          updated_at = ?,
          conflict_details = COALESCE(?, conflict_details)
      WHERE mutation_id = ? AND lifecycle_status = ?
    `);
    updateStmt.run(
      params.toStatus,
      params.nextDedupToken,
      nowMs,
      params.conflictDetails ?? null,
      params.mutationId,
      params.fromStatus
    );

    // 7. Append domain event with dedupToken
    return this.appendEvent(params.event, params.nextDedupToken);
  }

  recordRunRollback(rollback: RunRollback, pathProgressList: readonly PathRollbackProgress[]): void {
    const runRow = this.db.prepare(`SELECT run_id FROM runs WHERE run_id = ?`).get(rollback.runId);
    if (!runRow) {
      throw new Error(`Run '${rollback.runId}' not found`);
    }

    const rollbackStmt = this.db.prepare(`
      INSERT INTO run_rollbacks (
        run_id, status, initiated_by, created_at, completed_at, conflict_details
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    rollbackStmt.run(
      rollback.runId,
      rollback.status,
      rollback.initiatedBy,
      rollback.createdAt,
      rollback.completedAt ?? null,
      rollback.conflictDetails ?? null
    );

    const progressStmt = this.db.prepare(`
      INSERT INTO path_rollback_progress (
        run_id, relative_path, status, initial_base_digest, latest_expected_digest,
        baseline_snapshot_ref, updated_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const progress of pathProgressList) {
      if (progress.runId !== rollback.runId) {
        throw new Error(`Path progress runId '${progress.runId}' does not match rollback runId '${rollback.runId}'`);
      }
      progressStmt.run(
        progress.runId,
        progress.relativePath,
        progress.status,
        progress.initialBaseDigest,
        progress.latestExpectedDigest,
        progress.baselineSnapshotRef,
        progress.updatedAt,
        progress.errorMessage ?? null
      );
    }
  }

  resetCompletedRunRollback(runId: string): void {
    const row = this.db.prepare(`SELECT status FROM run_rollbacks WHERE run_id = ?`).get(runId) as
      | { status: string }
      | undefined;
    if (!row || row.status !== "COMPLETED") {
      throw new Error(
        `Cannot reset rollback for run '${runId}': record is ${row ? row.status : "absent"}, not COMPLETED`
      );
    }
    this.db.prepare(`DELETE FROM path_rollback_progress WHERE run_id = ?`).run(runId);
    this.db.prepare(`DELETE FROM run_rollbacks WHERE run_id = ?`).run(runId);
  }

  getRunRollback(runId: string): RunRollback | null {
    const stmt = this.db.prepare(`SELECT * FROM run_rollbacks WHERE run_id = ?`);
    const row = stmt.get(runId) as DbRunRollbackRow | undefined;
    return row ? mapRunRollbackRow(row) : null;
  }

  updateRunRollbackStatus(
    runId: string,
    status: RunRollbackStatus,
    completedAt?: number | null,
    conflictDetails?: string | null
  ): void {
    const stmt = this.db.prepare(`
      UPDATE run_rollbacks
      SET status = ?,
          completed_at = COALESCE(?, completed_at),
          conflict_details = COALESCE(?, conflict_details)
      WHERE run_id = ?
    `);
    stmt.run(status, completedAt ?? null, conflictDetails ?? null, runId);
  }

  getPathRollbackProgress(runId: string, relativePath: string): PathRollbackProgress | null {
    const stmt = this.db.prepare(
      `SELECT * FROM path_rollback_progress WHERE run_id = ? AND relative_path = ?`
    );
    const row = stmt.get(runId, relativePath) as DbPathRollbackProgressRow | undefined;
    return row ? mapPathRollbackProgressRow(row) : null;
  }

  listPathRollbackProgress(runId: string): readonly PathRollbackProgress[] {
    const stmt = this.db.prepare(
      `SELECT * FROM path_rollback_progress WHERE run_id = ? ORDER BY relative_path ASC`
    );
    const rows = stmt.all(runId) as unknown as DbPathRollbackProgressRow[];
    return rows.map(mapPathRollbackProgressRow);
  }

  updatePathRollbackProgress(
    runId: string,
    relativePath: string,
    status: PathRollbackStatus,
    errorMessage?: string | null,
    nowMs?: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE path_rollback_progress
      SET status = ?,
          error_message = COALESCE(?, error_message),
          updated_at = ?
      WHERE run_id = ? AND relative_path = ?
    `);
    stmt.run(status, errorMessage ?? null, nowMs ?? Date.now(), runId, relativePath);
  }

  acquireTenantLaunchGate(params: {
    runId: string;
    holderType: "WORKER" | "RECOVERY";
    holderId: string;
    leaseId: string;
    nowIso: string;
    ttlMs?: number;
    ownerPid?: number;
  }): TenantLaunchGate {
    const row = this.db
      .prepare(`SELECT * FROM tenant_launch_gates WHERE run_id = ?`)
      .get(params.runId) as
      | {
          run_id: string;
          holder_type: "WORKER" | "RECOVERY";
          holder_id: string;
          lease_id: string;
          token: string;
          acquired_at: string;
          expires_at: string;
          released_at: string | null;
          state: "ACQUIRED" | "RELEASED";
          owner_pid: number | null;
        }
      | undefined;

    const ttlMs = params.ttlMs ?? 30_000;
    const expiresAt = new Date(new Date(params.nowIso).getTime() + ttlMs).toISOString();
    const token = crypto.randomUUID();

    if (row && row.state === "ACQUIRED") {
      const nowMs = new Date(params.nowIso).getTime();
      const expiresMs = new Date(row.expires_at).getTime();

      // If the gate has not reached its nominal TTL, reject acquisition immediately.
      if (nowMs < expiresMs) {
        throw new TenantLaunchGateConflictError(
          params.runId,
          row.holder_type,
          row.holder_id,
          row.expires_at
        );
      }

      // Gate has reached or exceeded its nominal TTL.
      // Under ADR-0038 Remediation (F-01/F-02/F-05), time-based lock stealing is eliminated.
      // A gate can NEVER be stolen from a live owner process (Worker or Recovery).
      if (row.holder_id !== params.holderId || row.holder_type !== params.holderType) {
        if (row.holder_type === "WORKER") {
          const pid = row.owner_pid ?? this.getWorker(row.holder_id)?.pid;
          if (!pid) {
            // Missing owner process identity: fail closed per Requirement 8
            throw new TenantLaunchGateConflictError(
              params.runId,
              row.holder_type,
              row.holder_id,
              row.expires_at,
              `Worker '${row.holder_id}' process identity is unknown or unrecorded; tenant launch gate stealing refused fail-closed.`
            );
          }
          let isAlive = true;
          try {
            isAlive = this.isProcessAlive(pid);
          } catch {
            isAlive = true; // indeterminate: fail closed
          }
          if (isAlive) {
            throw new TenantLaunchGateConflictError(
              params.runId,
              row.holder_type,
              row.holder_id,
              row.expires_at,
              `Worker '${row.holder_id}' (PID ${pid}) is still alive; tenant launch gate stealing refused.`
            );
          }
        } else if (row.holder_type === "RECOVERY") {
          const pid = row.owner_pid;
          if (!pid) {
            // Missing owner process identity: fail closed per Requirement 8
            throw new TenantLaunchGateConflictError(
              params.runId,
              row.holder_type,
              row.holder_id,
              row.expires_at,
              `Recovery supervisor '${row.holder_id}' process identity is unknown or unrecorded; tenant launch gate stealing refused fail-closed.`
            );
          }
          let isAlive = true;
          try {
            isAlive = this.isProcessAlive(pid);
          } catch {
            isAlive = true; // indeterminate: fail closed
          }
          if (isAlive) {
            throw new TenantLaunchGateConflictError(
              params.runId,
              row.holder_type,
              row.holder_id,
              row.expires_at,
              `Recovery supervisor '${row.holder_id}' (PID ${pid}) is still alive; tenant launch gate stealing refused.`
            );
          }

          // In addition to process liveness, check supervisor lease fencing per Requirement 5
          const activeSupervisorLease = this.findActiveSupervisorLease(params.runId, params.nowIso);
          if (activeSupervisorLease && activeSupervisorLease.supervisorId === row.holder_id) {
            throw new TenantLaunchGateConflictError(
              params.runId,
              row.holder_type,
              row.holder_id,
              row.expires_at,
              `Recovery supervisor '${row.holder_id}' lease is still active; tenant launch gate stealing refused.`
            );
          }
        }
      }
    }

    const ownerPid =
      params.ownerPid ??
      (params.holderType === "WORKER"
        ? this.getWorker(params.holderId)?.pid ?? null
        : typeof process !== "undefined" && process.pid
          ? process.pid
          : null);

    this.db
      .prepare(`
        INSERT INTO tenant_launch_gates (run_id, holder_type, holder_id, lease_id, token, acquired_at, expires_at, state, owner_pid)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACQUIRED', ?)
        ON CONFLICT(run_id) DO UPDATE SET
          holder_type = excluded.holder_type,
          holder_id = excluded.holder_id,
          lease_id = excluded.lease_id,
          token = excluded.token,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at,
          released_at = NULL,
          state = 'ACQUIRED',
          owner_pid = excluded.owner_pid
      `)
      .run(params.runId, params.holderType, params.holderId, params.leaseId, token, params.nowIso, expiresAt, ownerPid);

    return {
      runId: params.runId,
      holderType: params.holderType,
      holderId: params.holderId,
      leaseId: params.leaseId,
      token,
      acquiredAt: params.nowIso,
      expiresAt,
      state: "ACQUIRED",
      ownerPid: ownerPid ?? undefined,
    };
  }

  releaseTenantLaunchGate(params: {
    runId: string;
    token: string;
    nowIso: string;
  }): void {
    this.db
      .prepare(`
        UPDATE tenant_launch_gates
        SET state = 'RELEASED', released_at = ?
        WHERE run_id = ? AND token = ? AND state = 'ACQUIRED'
      `)
      .run(params.nowIso, params.runId, params.token);
  }

  getTenantLaunchGate(runId: string): TenantLaunchGate | null {
    const row = this.db
      .prepare(`SELECT * FROM tenant_launch_gates WHERE run_id = ?`)
      .get(runId) as any;
    if (!row) return null;
    return {
      runId: row.run_id,
      holderType: row.holder_type,
      holderId: row.holder_id,
      leaseId: row.lease_id,
      token: row.token,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      releasedAt: row.released_at ?? undefined,
      state: row.state,
      ownerPid: row.owner_pid ?? undefined,
    };
  }
}

export interface SqliteStateStoreOptions {
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class SqliteStateStore implements StateStorePort, MutationIntentStorePort {
  private readonly db: DatabaseSync;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    dbOrConfig?: DatabaseSync | (SqliteClientConfig & SqliteStateStoreOptions),
    options?: SqliteStateStoreOptions
  ) {
    if (dbOrConfig && typeof (dbOrConfig as DatabaseSync).exec === "function") {
      this.db = dbOrConfig as DatabaseSync;
      this.isProcessAlive = options?.isProcessAlive ?? defaultIsProcessAlive;
    } else {
      const config = dbOrConfig as (SqliteClientConfig & SqliteStateStoreOptions) | undefined;
      this.db = createSqliteClient(config);
      this.isProcessAlive = config?.isProcessAlive ?? options?.isProcessAlive ?? defaultIsProcessAlive;
    }
  }

  transaction<T>(operation: (tx: StorageTransaction) => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const tx = new SqliteStorageTransaction(this.db, this.isProcessAlive);
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

  findRecoveringRuns(limit?: number): readonly RunSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findRecoveringRuns(limit);
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

  findInFlightAttempts(limit: number = 50): readonly AttemptSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findInFlightAttempts(limit);
  }

  findInFlightActions(limit: number = 50): readonly ActionSnapshot[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findInFlightActions(limit);
  }

  getSupervisorLease(leaseId: string): SupervisorLease | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getSupervisorLease(leaseId);
  }

  findActiveSupervisorLease(runId: string, nowIso?: string): SupervisorLease | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.findActiveSupervisorLease(runId, nowIso);
  }

  getSupervisorLeasesForRun(runId: string): readonly SupervisorLease[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getSupervisorLeasesForRun(runId);
  }

  releaseSupervisorLease(leaseId: string, nowIso?: string): void {
    const tx = new SqliteStorageTransaction(this.db);
    tx.releaseSupervisorLease(leaseId, nowIso ?? new Date().toISOString());
  }

  expireSupervisorLease(leaseId: string, nowIso?: string): void {
    const tx = new SqliteStorageTransaction(this.db);
    tx.expireSupervisorLease(leaseId, nowIso ?? new Date().toISOString());
  }

  getLatestCheckpoint(runId: string): MissionCheckpoint | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getLatestCheckpoint(runId);
  }

  getCheckpoints(runId: string): readonly MissionCheckpoint[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getCheckpoints(runId);
  }

  // ---------------------------------------------------------------------------
  // Mutation Intent Operations (ADR-0036)
  // ---------------------------------------------------------------------------

  recordIntent(intent: MutationIntent): void {
    this.transaction((tx) => {
      tx.recordIntent(intent);
    });
  }

  getIntent(mutationId: string): MutationIntent | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getIntent(mutationId);
  }

  getIntentsForRun(runId: string): readonly MutationIntent[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getIntentsForRun(runId);
  }

  getIntentsForPath(runId: string, relativePath: string): readonly MutationIntent[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getIntentsForPath(runId, relativePath);
  }

  getLatestIntentForPath(runId: string, relativePath: string): MutationIntent | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getLatestIntentForPath(runId, relativePath);
  }

  transitionMutationStatus(params: TransitionMutationStatusParams): PersistedEvent {
    return this.transaction((tx) => {
      return tx.transitionMutationStatus(params);
    });
  }

  recordRunRollback(rollback: RunRollback, pathProgressList: readonly PathRollbackProgress[]): void {
    this.transaction((tx) => {
      tx.recordRunRollback(rollback, pathProgressList);
    });
  }

  resetCompletedRunRollback(runId: string): void {
    this.transaction((tx) => {
      tx.resetCompletedRunRollback(runId);
    });
  }

  getRunRollback(runId: string): RunRollback | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getRunRollback(runId);
  }

  updateRunRollbackStatus(
    runId: string,
    status: RunRollbackStatus,
    completedAt?: number | null,
    conflictDetails?: string | null
  ): void {
    this.transaction((tx) => {
      tx.updateRunRollbackStatus(runId, status, completedAt, conflictDetails);
    });
  }

  getPathRollbackProgress(runId: string, relativePath: string): PathRollbackProgress | null {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.getPathRollbackProgress(runId, relativePath);
  }

  listPathRollbackProgress(runId: string): readonly PathRollbackProgress[] {
    const tx = new SqliteStorageTransaction(this.db);
    return tx.listPathRollbackProgress(runId);
  }

  updatePathRollbackProgress(
    runId: string,
    relativePath: string,
    status: PathRollbackStatus,
    errorMessage?: string | null,
    nowMs?: number
  ): void {
    this.transaction((tx) => {
      tx.updatePathRollbackProgress(runId, relativePath, status, errorMessage, nowMs);
    });
  }

  acquireSupervisorLease(params: {
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
  }): SupervisorLease {
    return this.transaction((tx) => {
      return tx.acquireSupervisorLease(params);
    });
  }

  renewSupervisorLease(params: {
    leaseId: string;
    runId: string;
    supervisorId: string;
    ttlMs: number;
    nowIso: string;
  }): SupervisorLease {
    return this.transaction((tx) => {
      return tx.renewSupervisorLease(params);
    });
  }

  validateSupervisorFencing(runId: string, fencing: SupervisorFencingCheck): void {
    const tx = new SqliteStorageTransaction(this.db);
    tx.validateSupervisorFencing(runId, fencing);
  }

  bindRunWorkspace(runId: string, workspaceRoot: string, nowIso: string): string {
    if (!this.getRun(runId)) {
      throw new Error(`Run '${runId}' not found`);
    }
    if (!workspaceRoot || typeof workspaceRoot !== "string") {
      throw new Error("workspaceRoot must be a non-empty string");
    }
    this.db
      .prepare(
        `INSERT INTO run_workspace_bindings (run_id, workspace_root, bound_at)
         VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING`
      )
      .run(runId, workspaceRoot, nowIso);
    const bound = this.getRunWorkspaceBinding(runId) as string;
    if (bound !== workspaceRoot) {
      throw new WorkspaceBindingConflictError(runId, bound, workspaceRoot);
    }
    return bound;
  }

  getRunWorkspaceBinding(runId: string): string | null {
    const row = this.db
      .prepare(`SELECT workspace_root FROM run_workspace_bindings WHERE run_id = ?`)
      .get(runId) as { workspace_root: string } | undefined;
    return row ? row.workspace_root : null;
  }

  acquireTenantLaunchGate(params: {
    runId: string;
    holderType: "WORKER" | "RECOVERY";
    holderId: string;
    leaseId: string;
    nowIso: string;
    ttlMs?: number;
    ownerPid?: number;
  }): TenantLaunchGate {
    return this.transaction((tx) => tx.acquireTenantLaunchGate(params));
  }

  releaseTenantLaunchGate(params: {
    runId: string;
    token: string;
    nowIso: string;
  }): void {
    this.transaction((tx) => tx.releaseTenantLaunchGate(params));
  }

  getTenantLaunchGate(runId: string): TenantLaunchGate | null {
    const tx = new SqliteStorageTransaction(this.db, this.isProcessAlive);
    return tx.getTenantLaunchGate(runId);
  }

  close(): void {
    this.db.close();
  }
}
