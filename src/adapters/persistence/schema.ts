import type { DatabaseSync } from "node:sqlite";

export class MigrationConflictError extends Error {
  readonly taskIds: readonly string[];

  constructor(message: string, taskIds: readonly string[] = []) {
    super(message);
    this.name = "MigrationConflictError";
    this.taskIds = Object.freeze([...taskIds]);
  }
}

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
    worker_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    pid INTEGER NOT NULL,
    status TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_contracts (
    contract_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    canonical_spec TEXT NOT NULL,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    PRIMARY KEY(contract_id, version)
);

CREATE INDEX IF NOT EXISTS idx_contracts_task_status ON mission_contracts(task_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_hash ON mission_contracts(contract_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_contracts_hash ON mission_contracts(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_task_active ON mission_contracts(task_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    status TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    current_worker_id TEXT REFERENCES workers(worker_id),
    lease_id TEXT,
    lease_expires_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    result_payload TEXT,
    error_payload TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    contract_id TEXT,
    contract_version INTEGER,
    contract_hash TEXT,
    max_output_bytes INTEGER,
    FOREIGN KEY(contract_id, contract_version) REFERENCES mission_contracts(contract_id, version),
    CHECK (
        (contract_id IS NULL AND contract_version IS NULL AND contract_hash IS NULL AND max_output_bytes IS NULL)
        OR
        (contract_id IS NOT NULL AND contract_version IS NOT NULL AND contract_hash IS NOT NULL AND max_output_bytes IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_lease_expires ON runs(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_contract_binding ON runs(contract_id, contract_version);
CREATE INDEX IF NOT EXISTS idx_runs_contract_hash ON runs(contract_hash);

CREATE TABLE IF NOT EXISTS run_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    producer TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedup_token TEXT,
    UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_run_seq ON run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_type ON run_events(event_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_dedup ON run_events(dedup_token) WHERE dedup_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS leases (
    lease_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    worker_id TEXT NOT NULL REFERENCES workers(worker_id),
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    state TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leases_run_active ON leases(run_id, state);

CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    sequence_number INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    input_payload TEXT NOT NULL,
    result_payload TEXT,
    error_payload TEXT,
    contract_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    contract_hash TEXT NOT NULL,
    active_attempt_number INTEGER,
    total_attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(contract_id, contract_version) REFERENCES mission_contracts(contract_id, version),
    UNIQUE(run_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_actions_run_seq ON actions(run_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_contract ON actions(contract_id, contract_version);

CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt_number INTEGER NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(worker_id),
    lease_id TEXT NOT NULL REFERENCES leases(lease_id),
    status TEXT NOT NULL,
    idempotency_token TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    exit_code INTEGER,
    output_payload TEXT,
    error_payload TEXT,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    provider_metadata TEXT,
    UNIQUE(action_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_action_num ON attempts(action_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_attempts_run_lease ON attempts(run_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_action_active ON attempts(action_id) WHERE status IN ('CREATED', 'DISPATCHED', 'RUNNING');

CREATE TABLE IF NOT EXISTS supervisor_leases (
    lease_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    supervisor_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    state TEXT NOT NULL,
    owner_pid INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sup_leases_run_state ON supervisor_leases(run_id, state);

CREATE TABLE IF NOT EXISTS mission_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    checkpoint_version INTEGER NOT NULL,
    contract_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    contract_hash TEXT NOT NULL,
    action_id TEXT,
    attempt_number INTEGER,
    durable_state TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(contract_id, contract_version) REFERENCES mission_contracts(contract_id, version),
    UNIQUE(run_id, checkpoint_version)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_run_ver ON mission_checkpoints(run_id, checkpoint_version);

CREATE TABLE IF NOT EXISTS mutation_intents (
    mutation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    parent_mutation_id TEXT NULL,
    path_mutation_version INTEGER NOT NULL,
    base_digest TEXT NOT NULL,
    expected_resulting_digest TEXT NOT NULL,
    snapshot_ref TEXT NOT NULL,
    recovery_dedup_token TEXT NOT NULL UNIQUE,
    lifecycle_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    conflict_details TEXT NULL,
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

CREATE TABLE IF NOT EXISTS run_rollbacks (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    initiated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER NULL,
    conflict_details TEXT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS path_rollback_progress (
    run_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    status TEXT NOT NULL,
    initial_base_digest TEXT NOT NULL,
    latest_expected_digest TEXT NOT NULL,
    baseline_snapshot_ref TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    error_message TEXT NULL,
    PRIMARY KEY (run_id, relative_path),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS run_workspace_bindings (
    run_id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_launch_gates (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
    holder_type TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    token TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    state TEXT NOT NULL,
    owner_pid INTEGER
);

CREATE INDEX IF NOT EXISTS idx_launch_gates_run_state ON tenant_launch_gates(run_id, state);
`;

/**
 * Deterministic and idempotent migration mechanism for existing SQLite databases.
 * Upgrades pre-1.8C schemas without mutating legacy Run governance fields or fabricating contracts.
 */
export function migrateDatabase(db: DatabaseSync): void {
  // Step 1: Validate MissionContract authority state before creating the partial unique index
  const tableCheckStmt = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_contracts'`
  );
  const hasContractsTable = tableCheckStmt.get() !== undefined;

  if (hasContractsTable) {
    // Detect duplicate ACTIVE contracts for any task
    const duplicateStmt = db.prepare(`
      SELECT task_id, COUNT(*) AS active_count
      FROM mission_contracts
      WHERE status = 'ACTIVE'
      GROUP BY task_id
      HAVING active_count > 1
    `);
    const duplicateRows = duplicateStmt.all() as unknown as { task_id: string; active_count: number }[];

    if (duplicateRows.length > 0) {
      const taskIds = duplicateRows.map((r) => r.task_id);
      throw new MigrationConflictError(
        `Duplicate ACTIVE MissionContracts detected for task(s): ${taskIds.join(", ")}. ` +
        `Migration cannot establish the single-ACTIVE governance invariant automatically. ` +
        `Explicit operator resolution is required before Task 1.8C schema constraints can be applied.`,
        taskIds
      );
    }

    // Establish partial unique index if not exists
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_task_active
      ON mission_contracts(task_id)
      WHERE status = 'ACTIVE';
    `);
  }

  // Step 2: Check runs table for governance columns
  const runsCheckStmt = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'`
  );
  const hasRunsTable = runsCheckStmt.get() !== undefined;

  if (hasRunsTable) {
    const tableInfoStmt = db.prepare(`PRAGMA table_info(runs)`);
    const columns = (tableInfoStmt.all() as unknown as { name: string }[]).map((c) => c.name);

    if (!columns.includes("contract_id")) {
      db.exec(`ALTER TABLE runs ADD COLUMN contract_id TEXT;`);
    }
    if (!columns.includes("contract_version")) {
      db.exec(`ALTER TABLE runs ADD COLUMN contract_version INTEGER;`);
    }
    if (!columns.includes("contract_hash")) {
      db.exec(`ALTER TABLE runs ADD COLUMN contract_hash TEXT;`);
    }
    if (!columns.includes("max_output_bytes")) {
      db.exec(`ALTER TABLE runs ADD COLUMN max_output_bytes INTEGER;`);
    }

    // Step 3: Establish Run governance indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_contract_binding
      ON runs(contract_id, contract_version);
      CREATE INDEX IF NOT EXISTS idx_runs_contract_hash
      ON runs(contract_hash);
    `);
  }

  // Step 4: Ensure actions table and its indexes exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        sequence_number INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_type TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_payload TEXT NOT NULL,
        result_payload TEXT,
        error_payload TEXT,
        contract_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        contract_hash TEXT NOT NULL,
        active_attempt_number INTEGER,
        total_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(contract_id, contract_version) REFERENCES mission_contracts(contract_id, version),
        UNIQUE(run_id, sequence_number)
    );

    CREATE INDEX IF NOT EXISTS idx_actions_run_seq ON actions(run_id, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
    CREATE INDEX IF NOT EXISTS idx_actions_contract ON actions(contract_id, contract_version);
  `);

  // Step 5: Ensure attempts table and its indexes exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES actions(action_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        attempt_number INTEGER NOT NULL,
        worker_id TEXT NOT NULL REFERENCES workers(worker_id),
        lease_id TEXT NOT NULL REFERENCES leases(lease_id),
        status TEXT NOT NULL,
        idempotency_token TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        exit_code INTEGER,
        output_payload TEXT,
        error_payload TEXT,
        evidence_ids TEXT NOT NULL DEFAULT '[]',
        provider_metadata TEXT,
        UNIQUE(action_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_action_num ON attempts(action_id, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_attempts_run_lease ON attempts(run_id, lease_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_action_active ON attempts(action_id) WHERE status IN ('CREATED', 'DISPATCHED', 'RUNNING');
  `);

  // Step 6: Ensure supervisor_leases and mission_checkpoints tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_leases (
        lease_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        supervisor_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        state TEXT NOT NULL,
        owner_pid INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sup_leases_run_state ON supervisor_leases(run_id, state);

    CREATE TABLE IF NOT EXISTS mission_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        checkpoint_version INTEGER NOT NULL,
        contract_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        contract_hash TEXT NOT NULL,
        action_id TEXT,
        attempt_number INTEGER,
        durable_state TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(contract_id, contract_version) REFERENCES mission_contracts(contract_id, version),
        UNIQUE(run_id, checkpoint_version)
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_run_ver ON mission_checkpoints(run_id, checkpoint_version);
  `);

  // Step 7: Ensure dedup_token column and unique partial index on run_events
  const eventsCheckStmt = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_events'`
  );
  if (eventsCheckStmt.get() !== undefined) {
    const tableInfoStmt = db.prepare(`PRAGMA table_info(run_events)`);
    const columns = (tableInfoStmt.all() as unknown as { name: string }[]).map((c) => c.name);
    if (!columns.includes("dedup_token")) {
      db.exec(`ALTER TABLE run_events ADD COLUMN dedup_token TEXT;`);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_dedup
      ON run_events(dedup_token)
      WHERE dedup_token IS NOT NULL;
    `);
  }

  // Step 8: Ensure mutation_intents, run_rollbacks, and path_rollback_progress exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS mutation_intents (
        mutation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        worker_lease_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        parent_mutation_id TEXT NULL,
        path_mutation_version INTEGER NOT NULL,
        base_digest TEXT NOT NULL,
        expected_resulting_digest TEXT NOT NULL,
        snapshot_ref TEXT NOT NULL,
        recovery_dedup_token TEXT NOT NULL UNIQUE,
        lifecycle_status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        conflict_details TEXT NULL,
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

    CREATE TABLE IF NOT EXISTS run_rollbacks (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        initiated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER NULL,
        conflict_details TEXT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS path_rollback_progress (
        run_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL,
        initial_base_digest TEXT NOT NULL,
        latest_expected_digest TEXT NOT NULL,
        baseline_snapshot_ref TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        error_message TEXT NULL,
        PRIMARY KEY (run_id, relative_path),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS run_workspace_bindings (
            run_id TEXT PRIMARY KEY,
            workspace_root TEXT NOT NULL,
            bound_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
    );

    -- Exclusive supervisor authority: demote legacy duplicate ACTIVE leases (keep the latest
    -- expiry per run), then let the database enforce a single ACTIVE lease per run.
    UPDATE supervisor_leases SET state = 'EXPIRED'
    WHERE state = 'ACTIVE' AND rowid NOT IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY expires_at DESC, rowid DESC) AS rn
        FROM supervisor_leases WHERE state = 'ACTIVE'
      ) WHERE rn = 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sup_leases_one_active ON supervisor_leases(run_id) WHERE state = 'ACTIVE';

    -- Step 9: Tenant launch gates table (ADR-0038)
    CREATE TABLE IF NOT EXISTS tenant_launch_gates (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        holder_type TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        token TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        state TEXT NOT NULL,
        owner_pid INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_launch_gates_run_state ON tenant_launch_gates(run_id, state);
  `);

  // Ensure owner_pid column exists on pre-existing tenant_launch_gates tables
  const gateCols = (db.prepare("PRAGMA table_info(tenant_launch_gates)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!gateCols.includes("owner_pid")) {
    db.exec("ALTER TABLE tenant_launch_gates ADD COLUMN owner_pid INTEGER;");
  }

  // Ensure owner_pid column exists on pre-existing supervisor_leases tables
  const supCols = (db.prepare("PRAGMA table_info(supervisor_leases)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!supCols.includes("owner_pid")) {
    db.exec("ALTER TABLE supervisor_leases ADD COLUMN owner_pid INTEGER;");
  }
}
