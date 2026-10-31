/**
 * CLI-level end-to-end acceptance test with NO test-only worker: every actor is the real `emerald` command
 * (bundled from src/cli/main.ts) in its own process, sharing only one temporary SQLite file.
 *
 *   emerald submit -> emerald worker (A) -> SIGKILL while RUNNING -> emerald recovery sweep -> emerald worker (B)
 *   -> emerald inspect (result + history) -> emerald recovery sweep again (no-op)
 *
 * The crash window is the built-in `slow` operation (4s), so worker A is killed while the run is RUNNING under a
 * live lease; the contract allows 3 attempts, so recovery re-queues it (at-least-once; nothing here claims exactly-once).
 * tests/e2e/durable-submission-recovery.test.ts remains as the regression test for the same scenario with a test worker.
 *
 * Does NOT prove: graceful SIGINT/SIGTERM shutdown on POSIX (skipped on Windows, where Node cannot deliver signals),
 * a live zombie worker (the killed process cannot write; the stale write comes from a fresh process with the old identity),
 * the agent-step/tool-gateway loop, or model integration.
 */
import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { SystemClock } from "../../src/ports/clock.port.js";

const isWindows = process.platform === "win32";
const LEASE_TTL_MS = 1500;
const WAIT_MS = 30_000;

let bundleDir: string;
let cliBundle: string;

beforeAll(() => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-prodworker-bundle-"));
  cliBundle = path.join(bundleDir, "emerald.mjs");
  buildSync({ entryPoints: [path.resolve("src/cli/main.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: cliBundle, logLevel: "silent" });
});

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

interface Proc {
  readonly child: ChildProcess;
  readonly lines: Array<Record<string, unknown>>;
  readonly stdout: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface View {
  runId: string; status: string; attemptCount: number; workerId: string | null; leaseId: string | null; result: unknown;
  events: Array<{ sequence: number; eventType: string; timestamp: string }>;
}

describe("production `emerald worker` end to end (CLI processes only)", { timeout: 120_000 }, () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-prodworker-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot);
  });

  afterEach(async () => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill("SIGKILL");
        await new Promise((r) => c.once("exit", r));
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true }); // only this test's own directory
  });

  function start(args: string[]): Proc {
    const child = spawn(process.execPath, [cliBundle, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const lines: Array<Record<string, unknown>> = [];
    let raw = "";
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        try { lines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a JSON record */ }
      }
    });
    child.stderr!.on("data", (c: Buffer) => { raw += c.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    return { child, lines, stdout: () => raw, exited };
  }

  async function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
    const p = start(args);
    const { code } = await p.exited;
    return { code, out: p.stdout().trim() };
  }

  async function inspect(runId: string): Promise<View> {
    const { code, out } = await cli("inspect", "--db", dbPath, "--run-id", runId);
    expect(code, out).toBe(0);
    return JSON.parse(out) as View;
  }

  async function waitFor(what: string, runId: string, pred: (v: View) => boolean): Promise<View> {
    const deadline = Date.now() + WAIT_MS;
    let last: View | undefined;
    while (Date.now() < deadline) {
      last = await inspect(runId);
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timed out waiting for ${what}; last view: ${JSON.stringify(last)}`);
  }

  const submit = async (operation: string, input: unknown, extra: string[] = []) => {
    const r = await cli("submit", "--db", dbPath, "--operation", operation, "--input", JSON.stringify(input), "--max-attempts", "3", ...extra);
    expect(r.code, r.out).toBe(0);
    return JSON.parse(r.out) as { runId: string; taskId: string };
  };
  const workerArgs = (id: string, ...extra: string[]) => ["worker", "--db", dbPath, "--workspace-root", workspaceRoot, "--worker-id", id, "--lease-ttl-ms", String(LEASE_TTL_MS), "--poll-interval-ms", "100", ...extra];
  const sweepArgs = () => ["recovery", "sweep", "--db", dbPath, "--workers-stopped", "--workspace-root", workspaceRoot];
  const TERMINAL = new Set(["run.completed", "run.failed", "run.timed_out", "run.cancelled"]);

  it("submit -> worker A killed mid-run -> recovery -> worker B completes -> auditable result; repeated recovery is a no-op", async () => {
    const { runId } = await submit("slow", { ms: 4000, value: "done" });
    expect((await inspect(runId)).status).toBe("QUEUED");

    // worker A (separate production process) claims and starts the run
    const workerA = start(workerArgs("worker-A"));
    const runningA = await waitFor("run RUNNING under worker-A", runId, (v) => v.status === "RUNNING" && v.workerId === "worker-A");
    const staleLeaseId = runningA.leaseId!;
    expect(staleLeaseId).toBeTruthy();
    expect(workerA.lines.some((r) => r.event === "worker.started" && r.workerId === "worker-A")).toBe(true);

    // real process failure
    const killedAt = Date.now();
    workerA.child.kill("SIGKILL");
    const exitA = await workerA.exited;
    expect(exitA.code === 0 && exitA.signal === null, "worker A must have died abnormally").toBe(false);
    expect(workerA.lines.some((r) => r.event === "worker.run.finished"), "worker A never finished the run").toBe(false);
    expect((await inspect(runId)).status).toBe("RUNNING"); // durable state still names the dead worker

    // recovery (the process is gone and the lease expired, so --workers-stopped is true)
    await new Promise((r) => setTimeout(r, Math.max(0, killedAt + LEASE_TTL_MS + 700 - Date.now())));
    const sweep1 = await cli(...sweepArgs());
    expect(sweep1.code, sweep1.out).toBe(0);
    expect((await inspect(runId)).status).toBe("QUEUED");

    // worker B claims attempt 2; while it is RUNNING under a live lease a stale identity must be fenced out
    const workerB = start(workerArgs("worker-B", "--once"));
    const runningB = await waitFor("run RUNNING under worker-B", runId, (v) => v.status === "RUNNING" && v.workerId === "worker-B");
    expect(runningB.leaseId).not.toBe(staleLeaseId);
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store, new SystemClock());
      expect(() => coordinator.completeRun(runId, "worker-A", staleLeaseId, { forged: true })).toThrow(LeaseLostError);
      expect(() => coordinator.failRun(runId, { forged: true }, "worker-A", staleLeaseId)).toThrow(LeaseLostError);
      const live = coordinator.getRun(runId)!;
      expect(live.status).toBe("RUNNING");
      expect(live.leaseId).toBe(runningB.leaseId);
    } finally {
      store.close();
    }

    // worker B finishes on its own and, with --once, exits 0 once the queue is empty
    const exitB = await workerB.exited;
    expect(exitB.code, workerB.stdout()).toBe(0);
    expect(workerB.lines.filter((r) => r.event === "worker.run.finished")).toEqual([
      expect.objectContaining({ workerId: "worker-B", runId, status: "COMPLETED" }),
    ]);
    expect(workerB.lines.at(-1)).toMatchObject({ event: "worker.stopped", runsProcessed: 1, errors: 0 });

    const finalRun = await inspect(runId);
    expect(finalRun.status).toBe("COMPLETED");
    expect(finalRun.result).toBe("done");
    expect(finalRun.attemptCount).toBe(1);

    const types = finalRun.events.map((e) => e.eventType);
    expect(finalRun.events.map((e) => e.sequence)).toEqual(finalRun.events.map((_, i) => i + 1));
    expect(types[0]).toBe("run.created");
    expect(types.filter((t) => TERMINAL.has(t))).toEqual(["run.completed"]);
    expect(types.at(-1)).toBe("run.completed");
    expect(types.filter((t) => t === "worker.claimed")).toHaveLength(2);
    expect(types.filter((t) => t === "lease.expired")).toHaveLength(1);
    expect(types.filter((t) => t === "run.recovered")).toHaveLength(1);
    expect(types.indexOf("lease.expired")).toBeLessThan(types.indexOf("run.recovered"));
    expect(types.indexOf("run.recovered")).toBeLessThan(types.lastIndexOf("worker.claimed"));

    // the stale identity is still fenced out and a repeated recovery changes nothing
    const store2 = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store2, new SystemClock());
      expect(() => coordinator.completeRun(runId, "worker-A", staleLeaseId, { forged: true })).toThrow();
      expect(coordinator.getRun(runId)!.resultPayload).toBe("done");
    } finally {
      store2.close();
    }
    const sweep2 = await cli(...sweepArgs());
    expect(sweep2.code, sweep2.out).toBe(0);
    expect(await inspect(runId)).toEqual(finalRun);
  });

  it("a long-running worker started BEFORE any submission picks up runs submitted later by a different process", async () => {
    // a database must exist first (the worker never creates one); an unrelated first submission creates it
    const first = await submit("echo", { n: 0 });
    const worker = start(workerArgs("worker-P"));
    await waitFor("first run completes", first.runId, (v) => v.status === "COMPLETED");
    await new Promise((r) => setTimeout(r, 400)); // worker is now idle-polling
    const later = await submit("sum", [5, 6, 7]);
    const done = await waitFor("later run completes", later.runId, (v) => v.status === "COMPLETED");
    expect(done.result).toBe(18);
    expect(done.workerId).toBe("worker-P");
    expect(worker.child.exitCode, "an idle worker keeps running").toBeNull();
    worker.child.kill("SIGKILL"); // both runs are terminal; killing an idle worker cannot lose work
    await worker.exited;
    expect((await inspect(later.runId)).status).toBe("COMPLETED");
  });

  it("refuses to run without --db or against a missing database, never creating one", async () => {
    expect((await cli("worker")).code).toBe(1);
    const missing = path.join(tempDir, "nope.sqlite");
    const r = await cli("worker", "--db", missing, "--once");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/never creates/);
    expect(fs.existsSync(missing)).toBe(false);
    expect((await cli("worker", "--db", dbPath, "--bogus", "x")).code).toBe(1);
    expect((await cli("worker", "--db", dbPath, "--lease-ttl-ms", "0")).code).toBe(1);
  });

  it("--once exits 0 immediately when nothing is queued", async () => {
    await submit("echo", 1);
    await (async () => { const w = start(workerArgs("worker-1", "--once")); await w.exited; })();
    const w2 = start(workerArgs("worker-2", "--once"));
    const { code } = await w2.exited;
    expect(code, w2.stdout()).toBe(0);
    expect(w2.lines.at(-1)).toMatchObject({ event: "worker.stopped", runsProcessed: 0, errors: 0 });
  });

  it.skipIf(isWindows)("POSIX: SIGTERM lets the in-flight run finish, then the worker exits 0 (SKIPPED on Windows)", async () => {
    const { runId } = await submit("slow", { ms: 1500, value: "graceful" });
    const worker = start(workerArgs("worker-G"));
    await waitFor("RUNNING", runId, (v) => v.status === "RUNNING");
    worker.child.kill("SIGTERM");
    const { code } = await worker.exited;
    expect(code, worker.stdout()).toBe(0);
    const v = await inspect(runId);
    expect(v.status).toBe("COMPLETED");
    expect(v.result).toBe("graceful");
  });

  it.skipIf(isWindows)("POSIX: a SECOND signal exits 130 at once without completing the run; the run is then recovered and finished (SKIPPED on Windows)", async () => {
    const { runId } = await submit("slow", { ms: 6000, value: "forced" });
    const worker = start(workerArgs("worker-F"));
    await waitFor("RUNNING", runId, (v) => v.status === "RUNNING");
    worker.child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 500));
    expect(worker.child.exitCode, "the first signal must wait for the in-flight run").toBeNull();
    const killedAt = Date.now();
    worker.child.kill("SIGINT");
    const { code } = await worker.exited;
    expect(code).toBe(130);
    expect((await inspect(runId)).status).toBe("RUNNING"); // nothing was completed or released by the exit
    await new Promise((r) => setTimeout(r, Math.max(0, killedAt + LEASE_TTL_MS + 700 - Date.now())));
    expect((await cli(...sweepArgs())).code).toBe(0);
    expect((await inspect(runId)).status).toBe("QUEUED");
    expect((await cli(...workerArgs("worker-R", "--once"))).code).toBe(0);
    const done = await inspect(runId);
    expect(done.status).toBe("COMPLETED");
    expect(done.result).toBe("forced");
  });
});
