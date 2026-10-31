/**
 * Persistent submission -> execution -> REAL process failure -> recovery CLI -> final result.
 *
 * Every step crosses a real process boundary and the only shared state is one temporary SQLite file:
 *   1. `emerald submit` (CLI process) creates the durable QUEUED run.
 *   2. Worker process A claims it and starts the deterministic operation (run RUNNING under a live lease) - then the
 *      parent kills the process (SIGKILL / TerminateProcess). Crash point: "provider invoked, completion not persisted"
 *      (Window F of worker-runtime-recovery-integration.test.ts); the contract allows 3 attempts, so recovery requeues.
 *   3. After the lease expired and the process is gone, `emerald recovery sweep --workers-stopped` re-queues the run.
 *      (--workers-stopped is an operator assertion; the test makes it TRUE by waiting for the child's exit first.)
 *   4. A stale identity (worker A + its old lease) cannot mutate the run: LeaseLostError, state unchanged.
 *   5. Worker process B claims attempt 2 and completes; `emerald inspect` returns the result and event history.
 *   6. A second sweep changes nothing and no terminal transition is duplicated.
 *
 * Proves: durable submission, process-level crash recovery with at-least-once re-execution (the operation ran twice:
 * once killed, once completed), lease fencing against a stale identity, an inspectable consistent history.
 * Does NOT prove: exactly-once execution (it is explicitly not claimed), recovery of a LIVE zombie worker (the killed
 * process cannot write; the stale write is attempted from a fresh process with the old identity), POSIX behaviour
 * (run on Windows here), multi-step agent loops/tool gateway, model integration, or durability under power loss.
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

const LEASE_TTL_MS = 1500;
const WAIT_MS = 30_000;

let bundleDir: string;
let cliBundle: string;
let workerBundle: string;

beforeAll(() => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-e2e-bundle-"));
  cliBundle = path.join(bundleDir, "emerald.mjs");
  workerBundle = path.join(bundleDir, "worker.mjs");
  for (const [entry, outfile] of [
    ["src/cli/main.ts", cliBundle],
    ["tests/e2e/support/durable-worker-child.ts", workerBundle],
  ] as const) {
    buildSync({ entryPoints: [path.resolve(entry)], bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "silent" });
  }
});

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

interface Proc {
  readonly child: ChildProcess;
  readonly lines: Array<Record<string, unknown>>;
  readonly stdout: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForEvent(event: string): Promise<Record<string, unknown>>;
}

describe("durable submission -> real process crash -> recovery CLI -> final result", { timeout: 120_000 }, () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceRoot: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-e2e-"));
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

  function spawnNode(script: string, args: string[]): Proc {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const lines: Array<Record<string, unknown>> = [];
    let raw = "";
    let buffer = "";
    const waiters: Array<{ event: string; resolve: (r: Record<string, unknown>) => void }> = [];
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          lines.push(rec);
          for (const w of waiters.filter((x) => x.event === rec.event)) w.resolve(rec);
        } catch {
          // not a JSON record
        }
      }
    });
    child.stderr!.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    const waitForEvent = (event: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const existing = lines.find((r) => r.event === event);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'; output: ${raw}`)), WAIT_MS);
        waiters.push({ event, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      });
    return { child, lines, stdout: () => raw, exited, waitForEvent };
  }

  /** Runs one CLI command to completion. */
  async function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
    const p = spawnNode(cliBundle, args);
    const { code } = await p.exited;
    return { code, out: p.stdout().trim() };
  }

  async function inspect(runId: string) {
    const { code, out } = await cli("inspect", "--db", dbPath, "--run-id", runId);
    expect(code, out).toBe(0);
    return JSON.parse(out) as {
      runId: string; status: string; attemptCount: number; result: unknown; error: unknown;
      events: Array<{ sequence: number; eventType: string; timestamp: string; payload: Record<string, unknown> }>;
    };
  }

  const workerArgs = (id: string, mode: "hang" | "complete") =>
    ["--db", dbPath, "--worker-id", id, "--mode", mode, "--lease-ttl-ms", String(LEASE_TTL_MS), "--workspace-root", workspaceRoot];
  const sweepArgs = () => ["recovery", "sweep", "--db", dbPath, "--workers-stopped", "--workspace-root", workspaceRoot];
  const TERMINAL = new Set(["run.completed", "run.failed", "run.timed_out", "run.cancelled"]);

  it("submits durably, survives a real worker crash, recovers from the same database and returns an auditable result", async () => {
    // ---- 1. durable submission from a clean database ----
    expect(fs.existsSync(dbPath)).toBe(false);
    const submit = await cli("submit", "--db", dbPath, "--operation", "sum", "--input", "[1,2,3,4]", "--max-attempts", "3");
    expect(submit.code, submit.out).toBe(0);
    const { runId, taskId } = JSON.parse(submit.out) as { runId: string; taskId: string; status: string };
    expect(fs.existsSync(dbPath)).toBe(true);
    const queued = await inspect(runId);
    expect(queued.status).toBe("QUEUED");
    expect(queued.attemptCount).toBe(0);

    // ---- 2. worker A claims and starts executing, then is killed mid-run ----
    const workerA = spawnNode(workerBundle, workerArgs("worker-A", "hang"));
    const started = await workerA.waitForEvent("operation.started");
    expect(started).toMatchObject({ workerId: "worker-A", runId, status: "RUNNING" });
    const staleLeaseId = started.leaseId as string;
    expect(staleLeaseId).toBeTruthy();
    const killedAt = Date.now();
    workerA.child.kill("SIGKILL");
    const exitA = await workerA.exited;
    expect(exitA.code === 0 && exitA.signal === null, "worker A must have died abnormally").toBe(false);
    expect(workerA.lines.some((r) => r.event === "worker.result"), "worker A never reported a result").toBe(false);

    // durable state after the crash: still RUNNING under the dead worker's lease; its workspace is on disk
    const afterCrash = await inspect(runId);
    expect(afterCrash.status).toBe("RUNNING");
    expect(fs.readdirSync(workspaceRoot).some((n) => n === `ws-${runId}`)).toBe(true);

    // ---- 3. recovery: the process is gone (so --workers-stopped is true) and the lease has expired ----
    await new Promise((r) => setTimeout(r, Math.max(0, killedAt + LEASE_TTL_MS + 700 - Date.now())));
    const sweep1 = await cli(...sweepArgs());
    expect(sweep1.code, sweep1.out).toBe(0);
    const recovered = await inspect(runId);
    expect(recovered.status).toBe("QUEUED"); // re-queued for attempt 2 (at-least-once)
    expect(fs.existsSync(path.join(workspaceRoot, `ws-${runId}`)), "the crashed attempt's workspace was discarded").toBe(false);

    // ---- 4. worker B claims attempt 2 and is held RUNNING under a live lease; a stale identity (worker A, its old
    //         lease) must not be able to mutate that newer attempt ----
    const gateFile = path.join(tempDir, "release-worker-B");
    const workerB = spawnNode(workerBundle, [...workerArgs("worker-B", "complete"), "--gate-file", gateFile]);
    const startedB = await workerB.waitForEvent("operation.started");
    expect(startedB).toMatchObject({ workerId: "worker-B", runId, status: "RUNNING" });
    expect(startedB.leaseId).not.toBe(staleLeaseId);
    const store = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store, new SystemClock());
      expect(() => coordinator.completeRun(runId, "worker-A", staleLeaseId, { forged: true })).toThrow(LeaseLostError);
      expect(() => coordinator.failRun(runId, { forged: true }, "worker-A", staleLeaseId)).toThrow(LeaseLostError);
      const live = coordinator.getRun(runId)!;
      expect(live.status).toBe("RUNNING");
      expect(live.leaseId).toBe(startedB.leaseId); // the newer attempt's lease is untouched
    } finally {
      store.close();
    }

    // ---- 5. worker B is released and completes attempt 2 ----
    fs.writeFileSync(gateFile, "go");
    const resultB = await workerB.waitForEvent("worker.result");
    expect((await workerB.exited).code).toBe(0);
    expect(resultB.result).toMatchObject({ status: "COMPLETED", runId });

    const finalRun = await inspect(runId);
    expect(finalRun.status).toBe("COMPLETED");
    expect(finalRun.attemptCount).toBe(1); // one recovery retry consumed (the run's attemptCount counts retries)
    expect(finalRun.result).toEqual(10); // sum([1,2,3,4])

    // the stale identity is still fenced out after completion, and the result is unchanged
    const store2 = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store2, new SystemClock());
      expect(() => coordinator.completeRun(runId, "worker-A", staleLeaseId, { forged: true })).toThrow();
      expect(coordinator.getRun(runId)!.resultPayload).toEqual(finalRun.result);
    } finally {
      store2.close();
    }

    // ---- 6. history is consistent and inspectable; repeated recovery is a no-op ----
    const types = finalRun.events.map((e) => e.eventType);
    expect(finalRun.events.map((e) => e.sequence)).toEqual(finalRun.events.map((_, i) => i + 1)); // gapless, ordered
    expect(types[0]).toBe("run.created");
    expect(types.filter((t) => TERMINAL.has(t))).toEqual(["run.completed"]); // exactly one terminal transition
    expect(types.filter((t) => t === "worker.claimed")).toHaveLength(2); // two claims: the killed attempt and the completed one
    expect(types.filter((t) => t === "lease.expired")).toHaveLength(1); // the killed attempt's lease, expired exactly once
    expect(types.filter((t) => t === "run.recovered")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("run.completed"); // nothing is recorded after the single terminal transition
    expect(types.indexOf("lease.expired")).toBeLessThan(types.indexOf("run.recovered"));
    expect(types.indexOf("run.recovered")).toBeLessThan(types.lastIndexOf("worker.claimed"));
    expect(finalRun.events.every((e, i, all) => i === 0 || e.timestamp >= all[i - 1]!.timestamp)).toBe(true);
    expect(taskId).toBeTruthy();

    const sweep2 = await cli(...sweepArgs());
    expect(sweep2.code, sweep2.out).toBe(0);
    const afterSecondSweep = await inspect(runId);
    expect(afterSecondSweep).toEqual(finalRun);
  });
});
