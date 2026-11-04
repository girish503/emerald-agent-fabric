import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";

/**
 * createSqliteClient must not leak its connection when initialisation (schema/migration) throws, and must
 * surface the ORIGINAL error. On Windows an unreleased handle keeps the database file locked, so a successful
 * recursive delete of the temp directory is the observable proof that the handle was closed.
 */
describe("createSqliteClient — initialisation failure releases the connection", () => {
  let dir: string;
  let dbPath: string;

  /** A database whose migration fails deterministically: two ACTIVE contracts for one task (the unique ACTIVE-contract index cannot be recreated). */
  const makeConflictedDatabase = () => {
    const db = createSqliteClient({ location: dbPath });
    db.exec(`DROP INDEX idx_contracts_task_active;`);
    db.exec(
      `INSERT INTO tasks (task_id, title, description, input_payload, created_at, updated_at)
       VALUES ('t1', 't1', '', '{}', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`
    );
    for (const [id, version] of [["c1", 1], ["c2", 1]] as const) {
      db.exec(
        `INSERT INTO mission_contracts (contract_id, version, task_id, status, content_hash, canonical_spec, created_at)
         VALUES ('${id}', ${version}, 't1', 'ACTIVE', 'h', '{}', '2026-11-04T00:00:00.000Z')`
      );
    }
    db.close();
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-sqlite-init-"));
    dbPath = path.join(dir, "state.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("throws the original migration error and leaves the file deletable", () => {
    makeConflictedDatabase();

    let caught: unknown;
    try {
      createSqliteClient({ location: dbPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/UNIQUE constraint failed/);

    // The connection must have been closed: the whole directory (db, -wal, -shm) can be removed now.
    expect(() => fs.rmSync(dir, { recursive: true, force: false })).not.toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("still initialises a healthy database normally and returns a usable connection", () => {
    const db = createSqliteClient({ location: dbPath });
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number };
      expect(Number(row.n)).toBe(0);
    } finally {
      db.close();
    }
  });
});
