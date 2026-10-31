import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";

/** `emerald submit` / `emerald inspect` argument handling and idempotency, in-process against a temporary file database. */
describe("emerald submit / inspect (durable store commands)", () => {
  let dir: string;
  let db: string;
  const cli = new EmeraldCli();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-submit-cli-"));
    db = path.join(dir, "emerald.sqlite");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("submit creates the file database and a QUEUED run that inspect can read back", async () => {
    const s = await cli.run(["submit", "--db", db, "--operation", "sum", "--input", "[1,2]"]);
    expect(s.exitCode, s.output).toBe(0);
    const { runId, status, deduplicated } = JSON.parse(s.output);
    expect(status).toBe("QUEUED");
    expect(deduplicated).toBe(false);
    const i = await cli.run(["inspect", "--db", db, "--run-id", runId]);
    expect(i.exitCode, i.output).toBe(0);
    const view = JSON.parse(i.output);
    expect(view).toMatchObject({ runId, status: "QUEUED", result: null });
    expect(view.events.map((e: { eventType: string }) => e.eventType)).toEqual(["run.created", "run.queued"]);
  });

  it("the same idempotency key returns the existing run and creates nothing new", async () => {
    const a = JSON.parse((await cli.run(["submit", "--db", db, "--operation", "sum", "--input", "[1]", "--idempotency-key", "k1"])).output);
    const b = JSON.parse((await cli.run(["submit", "--db", db, "--operation", "sum", "--input", "[1]", "--idempotency-key", "k1"])).output);
    expect(b.runId).toBe(a.runId);
    expect(b.deduplicated).toBe(true);
    expect(b.taskId).toBe(a.taskId);
  });

  it("rejects bad arguments without creating a database", async () => {
    for (const args of [
      ["submit", "--operation", "sum"],
      ["submit", "--db", db],
      ["submit", "--db", ":memory:", "--operation", "sum"],
      ["submit", "--db", db, "--operation", "sum", "--input", "{not json"],
      ["submit", "--db", db, "--operation", "sum", "--max-attempts", "0"],
      ["submit", "--db", db, "--operation", "sum", "--bogus", "x"],
    ]) {
      expect((await cli.run(args)).exitCode, args.join(" ")).toBe(1);
    }
    expect(fs.existsSync(db)).toBe(false);
  });

  it("inspect never creates a database and reports an unknown run", async () => {
    expect((await cli.run(["inspect", "--db", db, "--run-id", "x"])).exitCode).toBe(1);
    expect(fs.existsSync(db)).toBe(false);
    await cli.run(["submit", "--db", db, "--operation", "sum"]);
    const r = await cli.run(["inspect", "--db", db, "--run-id", "no-such-run"]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/Run not found/);
  });
});
