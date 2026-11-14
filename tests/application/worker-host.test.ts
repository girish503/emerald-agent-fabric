import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { WorkerHostConfigError, WorkerLogRecord, runWorkerHost } from "../../src/application/worker-host.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { createVerificationSpec } from "../../src/domain/verification.js";

/**
 * Worker-host lifecycle contracts, in-process against a temporary FILE database. The host (`runWorkerHost`) is the same
 * code `emerald worker` runs; the abort signal stands in for the FIRST SIGINT/SIGTERM. (The second-signal `process.exit(130)`
 * lives in the CLI wrapper and cannot be exercised on Windows; see the POSIX notes in docs/HANDOFF.md.)
 */
describe("worker host lifecycle", { timeout: 60_000 }, () => {
  let dir: string;
  let dbPath: string;
  let observer: SqliteStateStore; // a SECOND connection to the same file, like another process
  let coordinator: RunCoordinator;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-workerhost-"));
    dbPath = path.join(dir, "emerald.sqlite");
    observer = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(observer, new SystemClock());
  });
  afterEach(() => {
    observer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const submit = (operation: string, input: unknown) => submitDurableTask(observer, coordinator, {
    operation,
    input,
    maxAttempts: 3,
    verificationSpecs: [createVerificationSpec({ specId: `vspec-${operation}`, ruleKind: "EXACT_OUTPUT_MATCH", expectedValue: (input as { value?: unknown })?.value ?? input })],
  });

  async function until(what: string, pred: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("a run longer than the lease TTL keeps its lease while the worker is healthy: nobody can reclaim it, and it completes", async () => {
    const TTL = 400;
    const { runId } = submit("slow", { ms: 2000, value: "long" });
    const controller = new AbortController();
    const host = runWorkerHost({ dbPath, workerId: "w-long", leaseTtlMs: TTL, once: true, signal: controller.signal, log: () => {} });

    await until("RUNNING", () => coordinator.getRun(runId)?.status === "RUNNING");
    const first = coordinator.getRun(runId)!;
    const startedAt = Date.now();
    // run well past the original expiry; at every check another connection plays "recovery" and must find nothing to reclaim
    while (Date.now() - startedAt < TTL * 3) {
      await new Promise((r) => setTimeout(r, 100));
      const recovered = coordinator.recoverExpiredRuns();
      expect(recovered.runs.map((r) => r.runId), "a healthy worker's run must never be reclaimed").not.toContain(runId);
      const now = coordinator.getRun(runId)!;
      expect(now.status).toBe("RUNNING");
      expect(now.leaseId).toBe(first.leaseId);
      expect(now.currentWorkerId).toBe("w-long");
    }
    const renewed = coordinator.getRun(runId)!;
    expect(renewed.leaseExpiresAt! > first.leaseExpiresAt!, "the lease was renewed past its first expiry").toBe(true);
    expect(Date.parse(renewed.leaseExpiresAt!)).toBeGreaterThan(Date.now());

    const result = await host;
    expect(result).toMatchObject({ workerId: "w-long", runsProcessed: 1, errors: 0 });
    const done = coordinator.getRun(runId)!;
    expect(done.status).toBe("COMPLETED");
    expect(done.resultPayload).toBe("long");
    const types = coordinator.getEventsForRun(runId).map((e) => e.eventType);
    expect(types.filter((t) => t === "lease.expired" || t === "run.recovered")).toEqual([]);
    expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
  });

  it("the first shutdown signal stops new claims but lets the in-flight run finish with consistent state", async () => {
    const a = submit("slow", { ms: 1200, value: "a" });
    const b = submit("echo", "b"); // queued behind a; must NOT be claimed after the signal
    const controller = new AbortController();
    const logs: WorkerLogRecord[] = [];
    const host = runWorkerHost({ dbPath, workerId: "w-stop", leaseTtlMs: 1000, signal: controller.signal, pollIntervalMs: 50, log: (r) => logs.push(r), maxRuns: 10 });

    await until("first run RUNNING", () => coordinator.getRun(a.runId)?.status === "RUNNING");
    expect(coordinator.getRun(b.runId)!.status).toBe("QUEUED");
    controller.abort(); // == first SIGINT/SIGTERM
    const result = await host;

    expect(result).toMatchObject({ runsProcessed: 1, errors: 0 });
    expect(coordinator.getRun(a.runId)).toMatchObject({ status: "COMPLETED", resultPayload: "a" });
    expect(coordinator.getRun(b.runId)).toMatchObject({ status: "QUEUED", leaseId: null }); // untouched, still claimable
    expect(logs.map((l) => l.event)).toEqual(["worker.started", "worker.run.finished", "worker.stopped"]);
    // the queued run is still runnable by another worker afterwards
    await runWorkerHost({ dbPath, workerId: "w-next", once: true, signal: new AbortController().signal, log: () => {} });
    expect(coordinator.getRun(b.runId)).toMatchObject({ status: "COMPLETED", resultPayload: "b" });
  });

  it("an idle worker stops promptly when signalled, without claiming anything", async () => {
    submit("echo", 1); // the database must exist; drain it first
    await runWorkerHost({ dbPath, once: true, signal: new AbortController().signal, log: () => {} });
    const controller = new AbortController();
    const host = runWorkerHost({ dbPath, pollIntervalMs: 3_600_000, signal: controller.signal, log: () => {} });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    controller.abort();
    const result = await host;
    expect(Date.now() - t0).toBeLessThan(2000); // not blocked on the hour-long poll sleep
    expect(result.runsProcessed).toBe(0);
  });

  it("rejects missing or invalid configuration before touching anything", async () => {
    const signal = new AbortController().signal;
    await expect(runWorkerHost({ dbPath: path.join(dir, "missing.sqlite"), signal })).rejects.toBeInstanceOf(WorkerHostConfigError);
    expect(fs.existsSync(path.join(dir, "missing.sqlite"))).toBe(false);
    submit("echo", 1);
    await expect(runWorkerHost({ dbPath, workspaceRoot: path.join(dir, "nope"), signal })).rejects.toBeInstanceOf(WorkerHostConfigError);
    expect(fs.existsSync(path.join(dir, "nope"))).toBe(false);
    await expect(runWorkerHost({ dbPath, leaseTtlMs: 5, signal })).rejects.toBeInstanceOf(WorkerHostConfigError); // invalid lease config
    await expect(runWorkerHost({ dbPath, pollIntervalMs: 1, signal })).rejects.toBeInstanceOf(WorkerHostConfigError);
    await expect(runWorkerHost({ dbPath, maxRuns: 0, signal })).rejects.toBeInstanceOf(WorkerHostConfigError);
    expect(coordinator.getNextQueuedRun()).not.toBeNull(); // nothing was claimed
  });
});
