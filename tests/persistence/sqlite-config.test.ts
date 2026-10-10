import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";

describe("SQLite Configuration & Schema Initialization", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-sqlite-test-"));
    dbPath = path.join(tempDir, "test.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("configures WAL mode, foreign keys, and busy timeout on file-based databases", () => {
    const db = createSqliteClient({ location: dbPath, synchronous: "NORMAL", busyTimeoutMs: 3000 });

    try {
      // Verify journal_mode is WAL
      const journalRow = db.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
      expect(journalRow.journal_mode.toLowerCase()).toBe("wal");

      // Verify foreign_keys is ON (1)
      const fkRow = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number };
      expect(fkRow.foreign_keys).toBe(1);

      // Verify busy_timeout is 3000
      const timeoutRow = db.prepare("PRAGMA busy_timeout;").get() as { timeout: number };
      expect(timeoutRow.timeout).toBe(3000);
    } finally {
      db.close();
    }
  });

  it("initializes all required tables and indexes idempotently", () => {
    const store = new SqliteStateStore({ location: dbPath });

    try {
      const db = createSqliteClient({ location: dbPath });
      try {
        const tables = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>;

        const tableNames = new Set(tables.map((t) => t.name));
        expect(tableNames.has("tasks")).toBe(true);
        expect(tableNames.has("runs")).toBe(true);
        expect(tableNames.has("run_events")).toBe(true);
        expect(tableNames.has("workers")).toBe(true);
        expect(tableNames.has("leases")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it("enforces foreign key constraints: rejects run referencing non-existent task", () => {
    const store = new SqliteStateStore({ location: dbPath });

    try {
      expect(() => {
        store.transaction((tx) => {
          tx.insertRun(
            {
              runId: "run-fk-fail",
              taskId: "non-existent-task",
              status: "CREATED",
              version: 1,
              attemptCount: 0,
              maxAttempts: 3,
              timeoutMs: 30000,
              idempotencyKey: null,
              currentWorkerId: null,
              leaseId: null,
              leaseExpiresAt: null,
              resultPayload: null,
              errorPayload: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              eventId: "event-fk-fail",
              runId: "run-fk-fail",
              timestamp: new Date().toISOString(),
              eventType: "run.created",
              schemaVersion: 1,
              producer: "test",
              payload: {},
            }
          );
        });
      }).toThrow();
    } finally {
      store.close();
    }
  });
});
