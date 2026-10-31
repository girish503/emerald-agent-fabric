/**
 * Process-level tests for `emerald recovery watch|sweep`: the REAL CLI entry point (src/cli/main.ts, bundled to a
 * temporary file with esbuild - no tsc, no dist/ writes) runs in a child process against a disposable SQLite file.
 *
 * Platform note: Node on Windows cannot deliver SIGINT/SIGTERM to a child (child.kill() terminates it
 * unconditionally and no handler runs). The graceful-shutdown tests therefore only run on POSIX
 * (`describe.skipIf(win32)`); on Windows they are SKIPPED and graceful signal shutdown stays UNVERIFIED there.
 * The forced-termination / restart tests run everywhere.
 */
import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";

const isWindows = process.platform === "win32";
const WAIT_MS = 20_000;

let bundleDir: string;
let bundle: string;

beforeAll(() => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-cli-bundle-"));
  bundle = path.join(bundleDir, "emerald.mjs");
  buildSync({
    entryPoints: [path.resolve("src/cli/main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundle,
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

interface Spawned {
  readonly child: ChildProcess;
  readonly lines: string[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForEvent(event: string): Promise<Record<string, unknown>>;
}

describe("emerald recovery CLI as a real process", { timeout: 60_000 }, () => {
  let tempDir: string;
  let dbPath: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-proc-"));
    dbPath = path.join(tempDir, "emerald.sqlite");
    new SqliteStateStore({ location: dbPath }).close(); // a valid, current Emerald database
  });

  afterEach(async () => {
    // Never leave a background process behind, even when an assertion failed.
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill("SIGKILL");
        await new Promise((r) => c.once("exit", r));
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(args: string[]): Spawned {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const lines: string[] = [];
    let buffer = "";
    const waiters: Array<{ event: string; resolve: (r: Record<string, unknown>) => void }> = [];
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        lines.push(line);
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          for (const w of waiters.filter((x) => x.event === rec.event)) w.resolve(rec);
        } catch {
          // non-JSON output (e.g. a printed summary)
        }
      }
    });
    child.stderr!.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    const waitForEvent = (event: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const existing = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find((r) => r?.event === event);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'; output: ${lines.join(" | ")}`)), WAIT_MS);
        waiters.push({ event, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      });
    return { child, lines, exited, waitForEvent };
  }

  const bounded = <T,>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), WAIT_MS))]);

  const watchArgs = () => ["recovery", "watch", "--db", dbPath, "--workers-stopped", "--interval-ms", "100"];

  it("refuses to start without --workers-stopped: exit 1 and no process left running", async () => {
    const p = run(["recovery", "watch", "--db", dbPath]);
    const { code } = await bounded(p.exited, "exit without --workers-stopped");
    expect(code).toBe(1);
  });

  it("refuses to start without --db: exit 1", async () => {
    const p = run(["recovery", "watch", "--workers-stopped"]);
    const { code } = await bounded(p.exited, "exit without --db");
    expect(code).toBe(1);
  });

  it("refuses a nonexistent database path without creating one", async () => {
    const missing = path.join(tempDir, "nope.sqlite");
    const p = run(["recovery", "watch", "--db", missing, "--workers-stopped"]);
    const { code } = await bounded(p.exited, "exit for missing db");
    expect(code).toBe(1);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("watch stays alive across many sweep intervals instead of exiting on its own (regression: unref'd timers let the process exit silently)", async () => {
    const p = run(watchArgs());
    await p.waitForEvent("recovery.host.started");
    await new Promise((r) => setTimeout(r, 1500)); // ~15 sweep intervals
    expect(p.child.exitCode, "the watch host must still be running").toBeNull();
    expect(p.child.signalCode).toBeNull();
    p.child.kill("SIGKILL");
    await bounded(p.exited, "exit after SIGKILL");
  });

  it("a hard-terminated watch host leaves the database valid, and a later sweep starts and exits 0", async () => {
    const p = run(watchArgs());
    await p.waitForEvent("recovery.host.started");
    p.child.kill(); // POSIX: SIGTERM (graceful handler); Windows: unconditional termination
    await bounded(p.exited, "watch host exit after kill");

    // Forced-termination equivalent on every platform: SIGKILL a second host, then recover.
    const p2 = run(watchArgs());
    await p2.waitForEvent("recovery.host.started");
    p2.child.kill("SIGKILL");
    await bounded(p2.exited, "watch host exit after SIGKILL");

    const sweep = run(["recovery", "sweep", "--db", dbPath, "--workers-stopped"]);
    const { code } = await bounded(sweep.exited, "sweep after terminated hosts");
    expect(code).toBe(0);
  });

  it("two watch hosts on the same database coexist without corrupting it (coexistence, NOT prevention of duplicates)", async () => {
    const a = run(watchArgs());
    const b = run(watchArgs());
    await Promise.all([a.waitForEvent("recovery.host.started"), b.waitForEvent("recovery.host.started")]);
    a.child.kill("SIGKILL");
    b.child.kill("SIGKILL");
    await bounded(Promise.all([a.exited, b.exited]), "both hosts exit");

    const sweep = run(["recovery", "sweep", "--db", dbPath, "--workers-stopped"]);
    expect((await bounded(sweep.exited, "sweep after both hosts")).code).toBe(0);
  });

  describe.skipIf(isWindows)("graceful shutdown on POSIX signals (SKIPPED on Windows: signals cannot be delivered to a child there)", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      it(`${signal} while idle: logs recovery.host.stopped and exits 0`, async () => {
        const p = run(watchArgs());
        await p.waitForEvent("recovery.host.started");
        p.child.kill(signal);
        const { code } = await bounded(p.exited, `exit after ${signal}`);
        expect(code).toBe(0);
        const stopped = p.lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((r) => r?.event === "recovery.host.stopped");
        expect(stopped).toHaveLength(1);
      });
    }

    it("repeated signals: a second SIGINT while shutting down does not crash or double-stop", async () => {
      const p = run(watchArgs());
      await p.waitForEvent("recovery.host.started");
      p.child.kill("SIGINT");
      p.child.kill("SIGINT");
      const { code } = await bounded(p.exited, "exit after repeated SIGINT");
      // the handler is registered with process.once: the second SIGINT may take the default action (code null, signal SIGINT)
      expect([0, null]).toContain(code);
      const stopped = p.lines.filter((l) => l.includes("recovery.host.stopped"));
      expect(stopped.length).toBeLessThanOrEqual(1);
    });

    it("the database is intact and a sweep succeeds after a graceful shutdown", async () => {
      const p = run(watchArgs());
      await p.waitForEvent("recovery.host.started");
      p.child.kill("SIGTERM");
      await bounded(p.exited, "exit after SIGTERM");
      const sweep = run(["recovery", "sweep", "--db", dbPath, "--workers-stopped"]);
      expect((await bounded(sweep.exited, "sweep after graceful stop")).code).toBe(0);
    });
  });
});
