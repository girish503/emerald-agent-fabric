import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { INITIAL_SCHEMA_SQL, migrateDatabase } from "./schema.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };

export interface SqliteClientConfig {
  readonly location?: string; // ":memory:" or path
  readonly synchronous?: "NORMAL" | "FULL" | "EXTRA" | "OFF";
  readonly busyTimeoutMs?: number;
}

/**
 * Initializes and configures a SQLite connection with WAL mode, foreign keys,
 * and busy timeout settings matching ADR-0002.
 */
export function createSqliteClient(config: SqliteClientConfig = {}): DatabaseSync {
  const location = config.location ?? ":memory:";
  const synchronous = config.synchronous ?? "NORMAL";
  const busyTimeoutMs = config.busyTimeoutMs ?? 5000;

  const db = new NodeDatabaseSync(location);

  try {
    // Configure mandatory PRAGMAs
    // Note: in-memory databases use "memory" journal mode by default; file-based databases use WAL.
    if (location !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec(`PRAGMA synchronous = ${synchronous};`);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);

    // Initialize schema
    db.exec(INITIAL_SCHEMA_SQL);

    // Apply idempotent migrations for existing databases
    migrateDatabase(db);

    return db;
  } catch (err) {
    // Initialisation failed: release the partially initialised connection so the file is not left locked
    // (notably on Windows). A close failure must never mask the original error, which is rethrown unchanged.
    try {
      db.close();
    } catch {
      // ignore: the original initialisation error is the one callers need
    }
    throw err;
  }
}
