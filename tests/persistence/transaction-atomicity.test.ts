import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { Run } from "../../src/domain/run.js";

describe("Transaction Atomicity (State Mutation + Event Append)", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-atomicity-test-"));
    dbPath = path.join(tempDir, "test.db");
    store = new SqliteStateStore({ location: dbPath });

    // Seed task
    store.transaction((tx) => {
      tx.insertTask({
        taskId: "task-atomic-1",
        title: "Atomic Test Task",
        description: "Testing ACID guarantees",
        inputPayload: { val: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("commits state mutation and event append atomically", () => {
    const { run, event } = Run.create({
      runId: "run-atom-1",
      taskId: "task-atomic-1",
    });

    store.transaction((tx) => {
      tx.insertRun(run.snapshot, event);
    });

    const persistedRun = store.getRun("run-atom-1");
    expect(persistedRun).not.toBeNull();
    expect(persistedRun?.status).toBe("CREATED");

    const events = store.getEventsForRun("run-atom-1");
    expect(events.length).toBe(1);
    expect(events[0]?.eventType).toBe("run.created");
    expect(events[0]?.sequence).toBe(1);
  });

  it("rolls back both state mutation and event append if an exception occurs during the transaction", () => {
    const { run, event } = Run.create({
      runId: "run-rollback-1",
      taskId: "task-atomic-1",
    });

    expect(() => {
      store.transaction((tx) => {
        tx.insertRun(run.snapshot, event);
        throw new Error("Simulated failure mid-transaction before commit");
      });
    }).toThrow("Simulated failure mid-transaction before commit");

    // Verify neither run nor event was persisted
    const persistedRun = store.getRun("run-rollback-1");
    expect(persistedRun).toBeNull();

    const events = store.getEventsForRun("run-rollback-1");
    expect(events.length).toBe(0);
  });
});
