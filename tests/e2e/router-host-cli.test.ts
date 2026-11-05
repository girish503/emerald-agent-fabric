import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";

describe("emerald router host (CLI long-running continuous dispatch)", () => {
  let dir: string;
  let db: string;
  const cli = new EmeraldCli();

  const json = async (args: string[], expectedExit = 0) => {
    const r = await cli.run(args);
    expect(r.exitCode, r.output).toBe(expectedExit);
    return JSON.parse(r.output);
  };

  const submit = (key: string, extra: string[] = []) =>
    json(["router", "submit", "--db", db, "--key", key, "--operation", "sum", "--input", "[1,2]", ...extra]);

  const runStatus = (runId: string) => {
    const store = new SqliteStateStore({ location: db });
    try {
      return store.getRun(runId)!.status;
    } finally {
      store.close();
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-router-host-cli-"));
    db = path.join(dir, "emerald.sqlite");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("CLI argument validation", () => {
    it("fails when --db is missing", async () => {
      const r = await cli.run(["router", "host"]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/--db is required/);
    });

    it("fails when db file does not exist", async () => {
      const r = await cli.run(["router", "host", "--db", path.join(dir, "nonexistent.db")]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/database not found/);
    });

    it("fails when --max-concurrent is not 1 or 2", async () => {
      // Create empty db
      const s = new SqliteStateStore({ location: db });
      s.close();

      const r = await cli.run(["router", "host", "--db", db, "--max-concurrent", "3"]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/--max-concurrent must be 1 or 2/);
    });

    it("fails when timing flags are not positive integers", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const r = await cli.run(["router", "host", "--db", db, "--poll-interval-ms", "bad"]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/must be positive integers/);
    });

    it("fails when max-busy-backoff is less than busy-backoff", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const r = await cli.run([
        "router",
        "host",
        "--db",
        db,
        "--busy-backoff-ms",
        "500",
        "--max-busy-backoff-ms",
        "100",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/--max-busy-backoff-ms must be >= --busy-backoff-ms/);
    });

    it("fails when --workspace-root does not exist", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const r = await cli.run([
        "router",
        "host",
        "--db",
        db,
        "--workspace-root",
        path.join(dir, "no-such-workspace"),
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/--workspace-root directory not found/);
    });

    it("fails when --once is supplied more than once", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const r = await cli.run(["router", "host", "--db", db, "--once", "--once"]);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/--once given more than once/);
    });
  });

  describe("execution with --once", () => {
    it("runs a single tick and dispatches pending task into QUEUED", async () => {
      const sub = await submit("k-host-1");
      expect(runStatus(sub.runId)).toBe("CREATED");

      const r = await cli.run(["router", "host", "--db", db, "--once"]);
      expect(r.exitCode).toBe(0);
      expect(runStatus(sub.runId)).toBe("QUEUED");
    });

    it("enforces max-concurrent flag during dispatch", async () => {
      const s1 = await submit("k-1");
      const s2 = await submit("k-2");
      const s3 = await submit("k-3");

      const r = await cli.run(["router", "host", "--db", db, "--max-concurrent", "1", "--once"]);
      expect(r.exitCode).toBe(0);

      // Only 1 should be admitted to QUEUED, others remain CREATED
      const statuses = [runStatus(s1.runId), runStatus(s2.runId), runStatus(s3.runId)];
      const queuedCount = statuses.filter((st) => st === "QUEUED").length;
      const createdCount = statuses.filter((st) => st === "CREATED").length;

      expect(queuedCount).toBe(1);
      expect(createdCount).toBe(2);
    });
  });

  describe("end-to-end continuous workflow with worker", () => {
    it("dispatches task tree across router host ticks while worker executes", async () => {
      const root = await submit("k-tree-root");
      const child = await submit("k-tree-child", ["--parent-task", root.taskId]);

      expect(runStatus(root.runId)).toBe("CREATED");
      expect(runStatus(child.runId)).toBe("CREATED");

      // Tick 1 via router host
      const h1 = await cli.run(["router", "host", "--db", db, "--once", "--max-concurrent", "1"]);
      expect(h1.exitCode).toBe(0);
      expect(runStatus(root.runId)).toBe("QUEUED");
      expect(runStatus(child.runId)).toBe("CREATED");

      // Worker executes root task
      const w1 = await cli.run(["worker", "--db", db, "--once"]);
      expect(w1.exitCode).toBe(0);
      expect(runStatus(root.runId)).toBe("COMPLETED");

      // Tick 2 via router host admits child
      const h2 = await cli.run(["router", "host", "--db", db, "--once", "--max-concurrent", "1"]);
      expect(h2.exitCode).toBe(0);
      expect(runStatus(child.runId)).toBe("QUEUED");

      // Worker executes child task
      const w2 = await cli.run(["worker", "--db", db, "--once"]);
      expect(w2.exitCode).toBe(0);
      expect(runStatus(child.runId)).toBe("COMPLETED");

      // Final status check
      const statusRes = await json(["router", "status", "--db", db, "--root", root.taskId]);
      expect(statusRes.status).toBe("COMPLETED");
      expect(statusRes.counts.COMPLETED).toBe(2);
    });
  });

  describe("signal handling and repeated-signal shutdown lifecycle", () => {
    it("shuts down gracefully on first SIGINT and cleans up signal listeners", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const initialSigint = process.listenerCount("SIGINT");
      const initialSigterm = process.listenerCount("SIGTERM");

      const hostPromise = cli.run(["router", "host", "--db", db, "--poll-interval-ms", "1000"]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT");

      const r = await hostPromise;
      expect(r.exitCode).toBe(0);

      expect(process.listenerCount("SIGINT")).toBe(initialSigint);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigterm);

      const verifyStore = new SqliteStateStore({ location: db });
      verifyStore.close();
    });

    it("shuts down gracefully on first SIGTERM and cleans up signal listeners", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const initialSigint = process.listenerCount("SIGINT");
      const initialSigterm = process.listenerCount("SIGTERM");

      const hostPromise = cli.run(["router", "host", "--db", db, "--poll-interval-ms", "1000"]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      process.emit("SIGTERM");

      const r = await hostPromise;
      expect(r.exitCode).toBe(0);

      expect(process.listenerCount("SIGINT")).toBe(initialSigint);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigterm);
    });

    it("handles repeated SIGINT without calling process.exit() before cleanup", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as unknown as (code?: string | number | null | undefined) => never);
      const initialSigint = process.listenerCount("SIGINT");

      try {
        const hostPromise = cli.run(["router", "host", "--db", db, "--poll-interval-ms", "1000"]);
        await new Promise((resolve) => setTimeout(resolve, 50));

        process.emit("SIGINT");
        process.emit("SIGINT");
        process.emit("SIGINT");

        const r = await hostPromise;
        expect(r.exitCode).toBe(0);

        expect(exitSpy).not.toHaveBeenCalled();
        expect(process.listenerCount("SIGINT")).toBe(initialSigint);

        const verifyStore = new SqliteStateStore({ location: db });
        verifyStore.close();
      } finally {
        exitSpy.mockRestore();
      }
    });

    it("handles SIGINT followed by SIGTERM without calling process.exit()", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as unknown as (code?: string | number | null | undefined) => never);

      try {
        const hostPromise = cli.run(["router", "host", "--db", db, "--poll-interval-ms", "1000"]);
        await new Promise((resolve) => setTimeout(resolve, 50));

        process.emit("SIGINT");
        process.emit("SIGTERM");

        const r = await hostPromise;
        expect(r.exitCode).toBe(0);
        expect(exitSpy).not.toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
      }
    });

    it("handles SIGTERM followed by SIGINT without calling process.exit()", async () => {
      const s = new SqliteStateStore({ location: db });
      s.close();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as unknown as (code?: string | number | null | undefined) => never);

      try {
        const hostPromise = cli.run(["router", "host", "--db", db, "--poll-interval-ms", "1000"]);
        await new Promise((resolve) => setTimeout(resolve, 50));

        process.emit("SIGTERM");
        process.emit("SIGINT");

        const r = await hostPromise;
        expect(r.exitCode).toBe(0);
        expect(exitSpy).not.toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
      }
    });
  });
});
