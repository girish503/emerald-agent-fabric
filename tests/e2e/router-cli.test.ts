import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";

/** `emerald router submit|tick|status|cancel`, in-process against a temporary file database. */
describe("emerald router (one-shot durable Task Router commands)", () => {
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
  const tick = (cap = "1") => json(["router", "tick", "--db", db, "--max-concurrent", cap]);
  const status = (root: string) => json(["router", "status", "--db", db, "--root", root]);
  const runStatus = (runId: string) => {
    const store = new SqliteStateStore({ location: db });
    try {
      return store.getRun(runId)!.status;
    } finally {
      store.close();
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-router-cli-"));
    db = path.join(dir, "emerald.sqlite");
  });
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best-effort: on Windows a connection whose open failed under a held write lock (createSqliteClient does not
      // close the handle when initialisation throws) can keep the temp file locked until the process exits.
    }
  });

  it("submit leaves runs CREATED (not queued) and is idempotent on the key", async () => {
    const a = await submit("k-root");
    expect(a.status).toBe("CREATED");
    expect(a.duplicate).toBe(false);
    const b = await submit("k-root");
    expect(b).toMatchObject({ taskId: a.taskId, runId: a.runId, duplicate: true });
  });

  it("same key with a different request is rejected and leaves no routed duplicate", async () => {
    await submit("k1");
    const r = await cli.run(["router", "submit", "--db", db, "--key", "k1", "--operation", "sum", "--input", "[9]", "--max-attempts", "2"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/conflict/i);
  });

  it("rejects an unknown parent and cancels the orphan run it had created", async () => {
    const r = await cli.run(["router", "submit", "--db", db, "--key", "k-orphan", "--operation", "sum", "--parent-task", "ghost"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/not routed/);
    const store = new SqliteStateStore({ location: db });
    try {
      const run = store.getRunByIdempotencyKey("k-orphan");
      expect(run?.status).toBe("CANCELLED");
    } finally {
      store.close();
    }
  });

  it("end to end: submit tree, tick, worker --once, tick, status COMPLETED", async () => {
    const root = await submit("k-root");
    const child = await submit("k-child", ["--parent-task", root.taskId]);
    expect((await status(root.taskId)).status).toBe("PENDING");

    const t1 = await tick("1");
    expect(t1.admittedRunIds).toEqual([root.runId]);
    expect(runStatus(child.runId)).toBe("CREATED");

    const w1 = await cli.run(["worker", "--db", db, "--once"]);
    expect(w1.exitCode, w1.output).toBe(0);
    expect(runStatus(root.runId)).toBe("COMPLETED");

    const t2 = await tick("1");
    expect(t2.admittedRunIds).toEqual([child.runId]);
    const w2 = await cli.run(["worker", "--db", db, "--once"]);
    expect(w2.exitCode, w2.output).toBe(0);

    const done = await status(root.taskId);
    expect(done.status).toBe("COMPLETED");
    expect(done.counts.COMPLETED).toBe(2);
  });

  it("tick enforces the explicit cap and requires --max-concurrent 1 or 2", async () => {
    for (const k of ["a", "b", "c"]) await submit(`k-${k}`);
    expect((await tick("2")).admittedRunIds).toHaveLength(2);
    expect((await tick("2")).admittedRunIds).toHaveLength(0);
    for (const bad of [["router", "tick", "--db", db], ["router", "tick", "--db", db, "--max-concurrent", "3"], ["router", "tick", "--db", db, "--max-concurrent", "0"]]) {
      expect((await cli.run(bad)).exitCode, bad.join(" ")).toBe(1);
    }
  });

  it("cancel propagates through the tree and is idempotent", async () => {
    const root = await submit("k-root");
    const child = await submit("k-child", ["--parent-task", root.taskId]);
    await tick("1");
    const res = await json(["router", "cancel", "--db", db, "--root", root.taskId, "--reason", "operator stop"]);
    expect(res.cancelledRunIds).toHaveLength(2);
    expect(runStatus(root.runId)).toBe("CANCELLED");
    expect(runStatus(child.runId)).toBe("CANCELLED");
    expect((await json(["router", "cancel", "--db", db, "--root", root.taskId])).cancelledRunIds).toEqual([]);
    expect((await status(root.taskId)).status).toBe("CANCELLED");
  });

  it("a failed parent cancels never-started children on later ticks", async () => {
    const root = await json(["router", "submit", "--db", db, "--key", "k-root", "--operation", "no-such-operation", "--max-attempts", "1"]);
    const child = await submit("k-child", ["--parent-task", root.taskId]);
    await tick("1");
    await cli.run(["worker", "--db", db, "--once"]);
    expect(["FAILED", "TIMED_OUT"]).toContain(runStatus(root.runId));
    const t = await tick("1");
    expect(t.cancelledRunIds).toEqual([child.runId]);
    expect(runStatus(child.runId)).toBe("CANCELLED");
    expect((await status(root.taskId)).status).toBe("FAILED");
  });

  it("tick, status and cancel never create a database and reject bad arguments", async () => {
    for (const args of [
      ["router", "tick", "--db", db, "--max-concurrent", "1"],
      ["router", "status", "--db", db, "--root", "x"],
      ["router", "cancel", "--db", db, "--root", "x"],
      ["router", "status", "--db", db],
      ["router", "submit", "--db", db, "--operation", "sum"],
      ["router", "submit", "--db", ":memory:", "--key", "k", "--operation", "sum"],
      ["router", "submit", "--db", db, "--key", "k"],
      ["router", "bogus"],
    ]) {
      expect((await cli.run(args)).exitCode, args.join(" ")).toBe(1);
    }
    expect(fs.existsSync(db)).toBe(false);
  });

  it("status of an unknown root is an error, not an empty success", async () => {
    await submit("k1");
    const r = await cli.run(["router", "status", "--db", db, "--root", "no-such-task"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/not found/);
  });

  it("reports DATABASE_BUSY with exit code 2 when another connection holds the write lock", async () => {
    await submit("k1");
    const holder = new SqliteStateStore({ location: db, busyTimeoutMs: 50 });
    // Hold an IMMEDIATE write transaction on a second connection for the duration of the tick.
    (holder as any).db.exec("BEGIN IMMEDIATE;");
    try {
      const r = await cli.run(["router", "tick", "--db", db, "--max-concurrent", "1"]);
      // The holder never releases during the synchronous tick, so the CLI must report busy explicitly (retryable).
      expect(r.exitCode, r.output).toBe(2);
      expect(JSON.parse(r.output)).toMatchObject({ error: "DATABASE_BUSY", retryable: true });
    } finally {
      (holder as any).db.exec("ROLLBACK;");
      holder.close();
    }
  }, 30_000);

  it("emerald submit (legacy) still queues immediately", async () => {
    const s = await json(["submit", "--db", db, "--operation", "sum", "--input", "[1]"]);
    expect(s.status).toBe("QUEUED");
  });
});
