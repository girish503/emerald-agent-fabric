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
    UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_run_seq ON run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_type ON run_events(event_type);

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
}
