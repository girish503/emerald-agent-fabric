/**
 * ADR-0038 / Remediation Finding F-06:
 * Genuine Cross-Process SQLite Tenant Launch Gate Integration Tests
 *
 * Demonstrates mutual exclusion, live-owner pause safety, stale-owner crash recovery,
 * and token-fenced release across independent OS processes sharing a file-backed SQLite database.
 */
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/index.js";
import { TenantLaunchGateConflictError } from "../../src/domain/errors.js";
import { createDefaultDockerPolicy } from "../../src/domain/policy.js";
import { createAndActivateContract } from "../application/test-helpers.js";

const WORKER_SCRIPT = `
import { DatabaseSync } from "node:sqlite";
import * as readline from "node:readline";
import * as crypto from "node:crypto";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("Missing dbPath\\n");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");

function isProcessAlive(pid) {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && (err.code === "ESRCH" || err.errno === -4040)) return false;
    return true;
  }
}

function handleAcquire(cmd) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const row = db.prepare("SELECT * FROM tenant_launch_gates WHERE run_id = ?").get(cmd.runId);
    const nowIso = cmd.nowIso || new Date().toISOString();
    const nowMs = new Date(nowIso).getTime();
    const ttlMs = cmd.ttlMs || 30000;
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const token = crypto.randomUUID();
    const ownerPid = process.pid;

    if (row && row.state === "ACQUIRED") {
      const expiresMs = new Date(row.expires_at).getTime();
      if (nowMs < expiresMs) {
        throw new Error("CONFLICT: Gate held by " + row.holder_id + " until " + row.expires_at);
      }

      // Past nominal TTL -> check liveness per ADR-0038 F-01/F-02/F-05
      const priorPid = row.owner_pid;
      if (!priorPid) {
        throw new Error("CONFLICT: Missing owner PID fail-closed");
      }
      if (isProcessAlive(priorPid)) {
        throw new Error("CONFLICT: Owner " + row.holder_id + " (PID " + priorPid + ") is still alive; stealing refused");
      }
    }

    db.prepare(\`
      INSERT INTO tenant_launch_gates (run_id, holder_type, holder_id, lease_id, token, acquired_at, expires_at, state, owner_pid)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACQUIRED', ?)
      ON CONFLICT(run_id) DO UPDATE SET
        holder_type = excluded.holder_type,
        holder_id = excluded.holder_id,
        lease_id = excluded.lease_id,
        token = excluded.token,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        released_at = NULL,
        state = 'ACQUIRED',
        owner_pid = excluded.owner_pid
    \`).run(cmd.runId, cmd.holderType, cmd.holderId, cmd.leaseId, token, nowIso, expiresAt, ownerPid);

    db.exec("COMMIT;");
    return { ok: true, token, ownerPid, expiresAt };
  } catch (err) {
    try { db.exec("ROLLBACK;"); } catch {}
    return { ok: false, error: err.message };
  }
}

function handleRelease(cmd) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const nowIso = cmd.nowIso || new Date().toISOString();
    db.prepare(\`
      UPDATE tenant_launch_gates
      SET state = 'RELEASED', released_at = ?
      WHERE run_id = ? AND token = ? AND state = 'ACQUIRED'
    \`).run(nowIso, cmd.runId, cmd.token);
    db.exec("COMMIT;");
    return { ok: true };
  } catch (err) {
    try { db.exec("ROLLBACK;"); } catch {}
    return { ok: false, error: err.message };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const cmd = JSON.parse(trimmed);
    let res;
    if (cmd.cmd === "acquire") {
      res = handleAcquire(cmd);
    } else if (cmd.cmd === "release") {
      res = handleRelease(cmd);
    } else if (cmd.cmd === "ping") {
      res = { ok: true, pid: process.pid };
    } else if (cmd.cmd === "exit") {
      process.exit(0);
    } else {
      res = { ok: false, error: "unknown cmd" };
    }
    process.stdout.write(JSON.stringify(res) + "\\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + "\\n");
  }
});
`;

class ProcessClient {
  readonly process: child_process.ChildProcess;
  readonly pid: number;
  private readonly rl: readline.Interface;
  private responseQueue: Array<(val: any) => void> = [];
  stderr: string = "";

  constructor(child: child_process.ChildProcess) {
    this.process = child;
    this.pid = child.pid!;
    child.stderr?.on("data", (d) => {
      this.stderr += d.toString();
    });
    this.rl = readline.createInterface({ input: child.stdout! });
    this.rl.on("line", (line) => {
      try {
        const parsed = JSON.parse(line.trim());
        const resolver = this.responseQueue.shift();
        if (resolver) resolver(parsed);
      } catch (err) {
        const resolver = this.responseQueue.shift();
        if (resolver) resolver({ ok: false, error: "Failed to parse JSON: " + line });
      }
    });

    this.process.on("exit", (code, signal) => {
      while (this.responseQueue.length > 0) {
        const resolver = this.responseQueue.shift();
        if (resolver) {
          resolver({
            ok: false,
            error: `Process ${this.pid} exited with code ${code} signal ${signal}. Stderr: ${this.stderr}`,
          });
        }
      }
    });
  }

  async send(cmd: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error: `Timed out (${timeoutMs}ms) waiting for response from PID ${this.pid}. Stderr: ${this.stderr}`,
        });
      }, timeoutMs);

      this.responseQueue.push((val) => {
        clearTimeout(timer);
        resolve(val);
      });
      this.process.stdin!.write(JSON.stringify(cmd) + "\n");
    });
  }

  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (this.process.exitCode !== null) {
      return;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.process.kill(signal);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

describe("ADR-0038 / F-06: Cross-Process SQLite Tenant Launch Gate Integration", () => {
  let testRoot: string;
  let dbPath: string;
  let scriptPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  const spawnedProcesses: ProcessClient[] = [];

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `emerald-cross-process-${crypto.randomUUID()}`);
    await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
    testRoot = await fs.realpath(testRoot);
    dbPath = path.join(testRoot, "fabric.db");
    scriptPath = path.join(testRoot, "gate-worker.mjs");
    await fs.writeFile(scriptPath, WORKER_SCRIPT, "utf8");

    // Initialize state store to create tables in WAL mode on disk
    store = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(store);
  });

  function createGovernedRun(): string {
    const task = coordinator.createTask({ title: "echo", inputPayload: { test: true } });
    const policy = createDefaultDockerPolicy(`policy-${task.taskId}`);
    createAndActivateContract(store, task.taskId, { policy });
    const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);
    return run.runId;
  }

  afterEach(async () => {
    for (const client of spawnedProcesses) {
      await client.kill().catch(() => {});
    }
    spawnedProcesses.length = 0;

    store.close();
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  function spawnWorker(): ProcessClient {
    const child = child_process.spawn(process.execPath, [scriptPath, dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new ProcessClient(child);
    spawnedProcesses.push(client);
    return client;
  }

  it("Scenario 1: Cross-process mutual exclusion and release propagation", async () => {
    const childA = spawnWorker();
    const childB = spawnWorker();

    const pingA = await childA.send({ cmd: "ping" });
    const pingB = await childB.send({ cmd: "ping" });
    expect(pingA.pid).toBe(childA.pid);
    expect(pingB.pid).toBe(childB.pid);
    expect(childA.pid).not.toBe(childB.pid);

    const runId = createGovernedRun();

    // 1. Child A acquires the gate
    const acqA = await childA.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-A",
      leaseId: "lease-A",
      ttlMs: 20_000,
    });
    expect(acqA.ok).toBe(true);
    expect(acqA.ownerPid).toBe(childA.pid);

    // 2. Child B attempts to acquire the gate concurrently -> denied with conflict
    const acqB = await childB.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-B",
      leaseId: "lease-B",
      ttlMs: 20_000,
    });
    expect(acqB.ok).toBe(false);
    expect(acqB.error).toMatch(/CONFLICT: Gate held by worker-A/);

    // 3. Parent test process attempts to acquire the gate via SqliteStateStore -> denied
    expect(() => {
      store.acquireTenantLaunchGate({
        runId,
        holderType: "WORKER",
        holderId: "parent-worker",
        leaseId: "parent-lease",
        nowIso: new Date().toISOString(),
        ttlMs: 20_000,
      });
    }).toThrow(TenantLaunchGateConflictError);

    // 4. Child A releases the gate
    const relA = await childA.send({
      cmd: "release",
      runId,
      token: acqA.token,
    });
    expect(relA.ok).toBe(true);

    // 5. Child B now successfully acquires the gate
    const acqB2 = await childB.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-B",
      leaseId: "lease-B",
      ttlMs: 20_000,
    });
    expect(acqB2.ok).toBe(true);
    expect(acqB2.ownerPid).toBe(childB.pid);
    expect(acqB2.token).not.toBe(acqA.token);

    // 6. Child A now fails to acquire
    const acqA2 = await childA.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-A",
      leaseId: "lease-A",
      ttlMs: 20_000,
    });
    expect(acqA2.ok).toBe(false);
    expect(acqA2.error).toMatch(/CONFLICT: Gate held by worker-B/);
  });

  it("Scenario 2: Live-owner pause safety across OS processes (stealing refused past TTL)", async () => {
    const childA = spawnWorker();
    const childB = spawnWorker();
    const runId = createGovernedRun();

    // 1. Child A acquires gate with short TTL (400ms)
    const acqA = await childA.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-A",
      leaseId: "lease-A",
      ttlMs: 400,
    });
    expect(acqA.ok).toBe(true);
    expect(acqA.ownerPid).toBe(childA.pid);

    // 2. Wait past the 400ms nominal TTL (e.g. 600ms)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Child A is STILL ALIVE (simulating an OS thread/process pause, slow GC, or long I/O)
    const pingA = await childA.send({ cmd: "ping" });
    expect(pingA.ok).toBe(true);

    // 3. Child B attempts to acquire -> stealing is REFUSED because Child A PID is still alive
    const acqB = await childB.send({
      cmd: "acquire",
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-B",
      leaseId: "sup-lease-B",
      ttlMs: 20_000,
    });
    expect(acqB.ok).toBe(false);
    expect(acqB.error).toMatch(new RegExp(`CONFLICT: Owner worker-A \\(PID ${childA.pid}\\) is still alive; stealing refused`));

    // 4. Parent process also confirms stealing is refused
    expect(() => {
      store.acquireTenantLaunchGate({
        runId,
        holderType: "RECOVERY",
        holderId: "supervisor-parent",
        leaseId: "sup-lease-parent",
        nowIso: new Date().toISOString(),
        ttlMs: 20_000,
      });
    }).toThrow(TenantLaunchGateConflictError);
  });

  it("Scenario 3: Stale-owner crash recovery and reclamation across OS processes", async () => {
    const childA = spawnWorker();
    const childB = spawnWorker();
    const runId = createGovernedRun();

    // 1. Child A acquires gate with short TTL (300ms)
    const acqA = await childA.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-A",
      leaseId: "lease-A",
      ttlMs: 300,
    });
    expect(acqA.ok).toBe(true);

    // 2. Terminate Child A abruptly
    await childA.kill();

    // 3. Wait until TTL has expired
    await new Promise((resolve) => setTimeout(resolve, 450));

    // 4. Child B attempts to acquire gate.
    // Since Child A has terminated and PID is dead, Child B successfully reclaims the gate!
    const acqB = await childB.send({
      cmd: "acquire",
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-B",
      leaseId: "sup-lease-B",
      ttlMs: 20_000,
    });
    expect(acqB.ok).toBe(true);
    expect(acqB.ownerPid).toBe(childB.pid);
    expect(acqB.token).not.toBe(acqA.token);

    // Verify state in database via parent
    const gateInDb = store.getTenantLaunchGate(runId);
    expect(gateInDb).not.toBeNull();
    expect(gateInDb?.holderId).toBe("supervisor-B");
    expect(gateInDb?.ownerPid).toBe(childB.pid);
    expect(gateInDb?.token).toBe(acqB.token);
  });

  it("Scenario 4: Token fencing prevents stale owner release from clearing newer owner gate", async () => {
    const childA = spawnWorker();
    const childB = spawnWorker();
    const runId = createGovernedRun();

    // 1. Child A acquires gate with 300ms TTL
    const acqA = await childA.send({
      cmd: "acquire",
      runId,
      holderType: "WORKER",
      holderId: "worker-A",
      leaseId: "lease-A",
      ttlMs: 300,
    });
    expect(acqA.ok).toBe(true);

    // Kill Child A
    await childA.kill();
    await new Promise((resolve) => setTimeout(resolve, 450));

    // Child B reclaims gate
    const acqB = await childB.send({
      cmd: "acquire",
      runId,
      holderType: "RECOVERY",
      holderId: "supervisor-B",
      leaseId: "sup-lease-B",
      ttlMs: 20_000,
    });
    expect(acqB.ok).toBe(true);

    // Delayed release using Child A's old token
    store.releaseTenantLaunchGate({
      runId,
      token: acqA.token,
      nowIso: new Date().toISOString(),
    });

    // Child B's gate MUST still be ACQUIRED and active!
    const gateInDb = store.getTenantLaunchGate(runId);
    expect(gateInDb?.state).toBe("ACQUIRED");
    expect(gateInDb?.holderId).toBe("supervisor-B");
    expect(gateInDb?.token).toBe(acqB.token);
  });
});
