import { describe, expect, it } from "vitest";
import { InProcessExecutionProvider } from "../../src/adapters/execution/in-process-execution-provider.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator, WorkerRuntime } from "../../src/application/index.js";
import { LeaseRenewalLoop, MIN_RENEWAL_INTERVAL_MS, RenewalScheduler, validateLeaseRenewalConfig } from "../../src/application/lease-renewal.js";
import { LeaseExpiredError, LeaseLostError } from "../../src/domain/errors.js";
import { EchoOperation } from "../../src/domain/operation.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import type { ExecutionProvider } from "../../src/ports/execution-provider.port.js";
import type { LeaseRecord } from "../../src/ports/state-store.port.js";
import { createAndActivateContract } from "./test-helpers.js";

/** Manual scheduler: nothing fires unless the test calls fire(). */
function manualScheduler() {
  let pending: (() => void) | null = null;
  const delays: number[] = [];
  const scheduler: RenewalScheduler = {
    schedule(fn, delayMs) {
      pending = fn;
      delays.push(delayMs);
      return { cancel: () => (pending = null) };
    },
  };
  return {
    scheduler,
    delays,
    hasPending: () => pending !== null,
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

const TTL = 9000;

function setup(providerOutcome: "ECHO" | "TIMED_OUT" | "CANCELLED" | "FAILED" = "ECHO") {
  const clock = new SettableClock("2026-03-30T10:00:00.000Z");
  const store = new SqliteStateStore();
  const coordinator = new RunCoordinator(store, clock);
  const timer = manualScheduler();

  let releaseExecution!: () => void;
  const gate = new Promise<void>((r) => (releaseExecution = r));
  let executionStarted!: () => void;
  const started = new Promise<void>((r) => (executionStarted = r));
  const inner = new InProcessExecutionProvider([new EchoOperation()]);
  const provider: ExecutionProvider = {
    name: "in-process",
    async execute(request) {
      executionStarted();
      await gate;
      if (providerOutcome !== "ECHO") {
        return { status: providerOutcome, error: { code: "X", message: "provider reported " + providerOutcome }, durationMs: 1 } as never;
      }
      return inner.execute(request);
    },
  };

  const worker = new WorkerRuntime({
    workerId: "worker-A",
    coordinator,
    clock,
    leaseTtlMs: TTL,
    executionProvider: provider,
    leaseRenewal: { scheduler: timer.scheduler },
    allowUnverifiedCompletion: true,
  });
  worker.ensureRegistered();

  const task = coordinator.createTask({ title: "echo", inputPayload: { n: 1 } });
  createAndActivateContract(store, task.taskId);
  const { run } = coordinator.createRun({ taskId: task.taskId, maxAttempts: 3, timeoutMs: 30000 });
  coordinator.queueRun(run.runId);

  return { clock, store, coordinator, timer, worker, runId: run.runId, started, releaseExecution };
}

describe("Worker lease renewal (heartbeat during execution)", () => {
  it("schedules the first renewal at one third of the lease TTL", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    expect(t.timer.delays[0]).toBe(TTL / 3);
    t.releaseExecution();
    await result;
    t.store.close();
  });

  it("keeps a run that outlives its original TTL leased: the sweeper does not recover it and it completes", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    const originalExpiry = t.coordinator.getRun(t.runId)!.leaseExpiresAt!;

    t.clock.advanceMs(4000);
    t.timer.fire(); // renewal at t+4s -> expires t+13s
    t.clock.advanceMs(6000); // t+10s: past the ORIGINAL expiry (t+9s)
    expect(t.clock.nowIso() > originalExpiry).toBe(true);
    expect(t.coordinator.recoverExpiredRuns().recoveredCount).toBe(0);
    expect(t.coordinator.getRun(t.runId)!.status).toBe("RUNNING");

    t.timer.fire(); // next renewal keeps going
    t.releaseExecution();
    const outcome = await result;
    expect(outcome.status).toBe("COMPLETED");
    t.store.close();
  });

  it("renewal does not change the run version (the worker's later OCC writes still succeed)", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    const before = t.coordinator.getRun(t.runId)!.version;
    t.clock.advanceMs(3000);
    t.timer.fire();
    expect(t.coordinator.getRun(t.runId)!.version).toBe(before);
    t.releaseExecution();
    expect((await result).status).toBe("COMPLETED");
    t.store.close();
  });

  it("sweeper wins the race: renewal reports the lease lost and the worker is FENCED without a terminal write", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;

    t.clock.advanceMs(TTL + 1000); // no renewal tick ran in time (e.g. the worker was starved)
    expect(t.coordinator.recoverExpiredRuns().recoveredCount).toBe(1); // sweeper reclaims first
    const afterSweep = t.coordinator.getRun(t.runId)!;
    expect(afterSweep.status).not.toBe("RUNNING");

    t.timer.fire(); // renewal now runs and finds the lease gone
    t.releaseExecution();
    const outcome = await result;
    expect(outcome.status).toBe("FENCED");
    const finalRun = t.coordinator.getRun(t.runId)!;
    expect(finalRun.status).not.toBe("COMPLETED");
    expect(finalRun.version).toBe(afterSweep.version); // the stale worker wrote nothing
    t.store.close();
  });

  it("worker crash: with no renewals the run is recovered, and the stale worker cannot complete it", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    const staleLeaseId = t.coordinator.getRun(t.runId)!.leaseId!;

    t.clock.advanceMs(TTL + 1000); // the crashed worker never renews
    expect(t.coordinator.recoverExpiredRuns().recoveredCount).toBe(1);
    t.coordinator.registerWorker({
      workerId: "worker-B", hostname: "localhost", pid: 2, status: "ACTIVE",
      lastHeartbeatAt: t.clock.nowIso(), createdAt: t.clock.nowIso(),
    });
    const claimB = t.coordinator.claimRun(t.runId, "worker-B", TTL);
    expect(claimB.lease.leaseId).not.toBe(staleLeaseId);
    t.coordinator.startRun(t.runId, "worker-B", claimB.lease.leaseId);
    expect(() => t.coordinator.completeRun(t.runId, "worker-A", staleLeaseId, {})).toThrow(LeaseLostError);

    t.releaseExecution();
    await result;
    t.store.close();
  });

  it("stops renewing when the run finishes (no pending renewal, nothing renews a released lease)", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    t.releaseExecution();
    expect((await result).status).toBe("COMPLETED");
    expect(t.timer.hasPending()).toBe(false);
    t.timer.fire(); // a stray tick is a no-op
    t.store.close();
  });
});

describe("LeaseRenewalLoop failure handling", () => {
  const lease = (expiresAt: string): LeaseRecord => ({
    leaseId: "L1", runId: "R1", workerId: "W1", acquiredAt: "x", expiresAt, releasedAt: null, state: "ACTIVE",
  });

  function loopWith(renew: () => LeaseRecord, opts: { timeoutMs?: number; graceMs?: number } = {}) {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const timer = manualScheduler();
    const calls = { n: 0 };
    const loop = new LeaseRenewalLoop({
      coordinator: {
        renewLease: () => {
          calls.n++;
          return renew();
        },
      },
      clock,
      runId: "R1",
      leaseId: "L1",
      ttlMs: 9000,
      expiresAt: "2026-03-30T10:00:09.000Z",
      timeoutMs: opts.timeoutMs ?? 600000,
      options: { scheduler: timer.scheduler, graceMs: opts.graceMs, retryDelayMs: 500 },
    });
    return { clock, timer, calls, loop };
  }

  it("retries a transient error within the remaining lease time, then resumes the normal cadence", () => {
    let fail = true;
    const { clock, timer, loop } = loopWith(() => {
      if (fail) {
        fail = false;
        throw new Error("SQLITE_BUSY");
      }
      return lease("2026-03-30T10:00:20.000Z");
    });
    loop.start();
    clock.advanceMs(3000);
    timer.fire(); // transient failure
    expect(loop.lostError).toBeNull();
    expect(timer.delays).toEqual([3000, 500]);
    clock.advanceMs(500);
    timer.fire(); // retry succeeds
    expect(timer.delays).toEqual([3000, 500, 3000]);
    expect(loop.lostError).toBeNull();
  });

  it("treats a transient error as a lost lease once the lease has expired", () => {
    const { clock, timer, loop } = loopWith(() => {
      throw new Error("SQLITE_BUSY");
    });
    loop.start();
    clock.advanceMs(9500); // past expiry
    timer.fire();
    expect(loop.lostError).toBeInstanceOf(LeaseExpiredError);
    expect(timer.hasPending()).toBe(false);
  });

  it("records LeaseLostError from the coordinator and stops without retrying", () => {
    const { clock, timer, calls, loop } = loopWith(() => {
      throw new LeaseLostError("R1", "L1", "L2");
    });
    loop.start();
    clock.advanceMs(3000);
    timer.fire();
    expect(loop.lostError).toBeInstanceOf(LeaseLostError);
    expect(calls.n).toBe(1);
    expect(timer.hasPending()).toBe(false);
  });

  it("stops renewing after the run timeout plus grace, letting the lease lapse (not a lost lease)", () => {
    const { clock, timer, calls, loop } = loopWith(() => lease("2026-03-30T10:30:00.000Z"), { timeoutMs: 10000, graceMs: 2000 });
    loop.start();
    clock.advanceMs(12000);
    timer.fire();
    expect(calls.n).toBe(0);
    expect(loop.lostError).toBeNull();
    expect(timer.hasPending()).toBe(false);
  });

  it("stop() is idempotent and cancels the pending renewal", () => {
    const { timer, calls, loop } = loopWith(() => lease("2026-03-30T10:00:20.000Z"));
    loop.start();
    expect(timer.hasPending()).toBe(true);
    loop.stop();
    loop.stop();
    timer.fire();
    expect(calls.n).toBe(0);
    expect(timer.hasPending()).toBe(false);
  });
});

describe("Stale worker cannot terminate a newer attempt (timeout/cancel/fail fencing)", () => {
  /** A's heartbeat never fires (starved); the sweeper reclaims; B claims and starts the run. */
  async function takeover(t: ReturnType<typeof setup>) {
    await t.started;
    t.clock.advanceMs(TTL + 1000);
    expect(t.coordinator.recoverExpiredRuns().recoveredCount).toBe(1);
    t.coordinator.registerWorker({
      workerId: "worker-B", hostname: "localhost", pid: 2, status: "ACTIVE",
      lastHeartbeatAt: t.clock.nowIso(), createdAt: t.clock.nowIso(),
    });
    const claim = t.coordinator.claimRun(t.runId, "worker-B", TTL);
    t.coordinator.startRun(t.runId, "worker-B", claim.lease.leaseId);
    return claim.lease.leaseId;
  }

  for (const outcome of ["ECHO", "FAILED", "TIMED_OUT", "CANCELLED"] as const) {
    it(`provider returns ${outcome} after takeover (timer starved): A is FENCED, B's run and lease are untouched`, async () => {
      const t = setup(outcome);
      const result = t.worker.runOnce(t.runId);
      const bLease = await takeover(t);
      const before = t.coordinator.getRun(t.runId)!;
      expect(before.status).toBe("RUNNING");

      t.releaseExecution();
      expect((await result).status).toBe("FENCED");

      const after = t.coordinator.getRun(t.runId)!;
      expect(after.status).toBe("RUNNING");
      expect(after.version).toBe(before.version);
      expect(after.currentWorkerId).toBe("worker-B");
      expect(t.coordinator.getLease(bLease)!.state).toBe("ACTIVE");
      t.store.close();
    });
  }

  it("coordinator.timeoutRun / cancelRun with stale fencing throw LeaseLostError and write nothing", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    const bLease = await takeover(t);
    const staleA = { workerId: "worker-A", leaseId: "stale-lease" };
    const before = t.coordinator.getRun(t.runId)!;

    expect(() => t.coordinator.timeoutRun(t.runId, "x", staleA)).toThrow(LeaseLostError);
    expect(() => t.coordinator.cancelRun(t.runId, "x", staleA)).toThrow(LeaseLostError);
    expect(t.coordinator.getRun(t.runId)!.version).toBe(before.version);
    expect(t.coordinator.getLease(bLease)!.state).toBe("ACTIVE");

    t.releaseExecution();
    await result;
    t.store.close();
  });

  it("the current lease holder can still time out or cancel its own run with fencing", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    const run = t.coordinator.getRun(t.runId)!;
    const fencing = { workerId: run.currentWorkerId!, leaseId: run.leaseId! };
    expect(t.coordinator.timeoutRun(t.runId, "ok", fencing).run.status).toBe("TIMED_OUT");
    t.releaseExecution();
    await result;
    t.store.close();
  });

  it("an operator cancel without fencing still works (unchanged behaviour)", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    expect(t.coordinator.cancelRun(t.runId, "operator").run.status).toBe("CANCELLED");
    t.releaseExecution();
    await result.catch(() => undefined);
    t.store.close();
  });
});

describe("Expired but not reclaimed: ownership, not the clock, decides (starved worker keeps its result)", () => {
  it("lease expired by time with no reclaim and no heartbeat tick: the run still completes", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    t.clock.advanceMs(TTL + 1000); // lease expired; sweeper never ran; the timer was starved
    t.releaseExecution();
    expect((await result).status).toBe("COMPLETED");
    expect(t.coordinator.getRun(t.runId)!.status).toBe("COMPLETED");
    t.store.close();
  });

  it("a late heartbeat tick finds the lease expired but unreclaimed: the run still completes", async () => {
    const t = setup();
    const result = t.worker.runOnce(t.runId);
    await t.started;
    t.clock.advanceMs(TTL + 1000);
    t.timer.fire(); // renewal is rejected (expired); nobody has taken the run
    t.releaseExecution();
    expect((await result).status).toBe("COMPLETED");
    t.store.close();
  });
});

describe("Lease renewal configuration is validated up front (no NaN/zero/tight timer loops)", () => {
  const bad: Array<[string, number, object]> = [
    ["NaN interval", 9000, { intervalMs: Number.NaN }],
    ["Infinity interval", 9000, { intervalMs: Number.POSITIVE_INFINITY }],
    ["zero interval", 9000, { intervalMs: 0 }],
    ["negative interval", 9000, { intervalMs: -5 }],
    ["interval below the minimum", 9000, { intervalMs: MIN_RENEWAL_INTERVAL_MS - 1 }],
    ["interval equal to the TTL", 9000, { intervalMs: 9000 }],
    ["interval longer than the TTL", 9000, { intervalMs: 20000 }],
    ["interval above the timer maximum", 9000, { intervalMs: 2_147_483_648 }],
    ["NaN TTL", Number.NaN, {}],
    ["zero TTL", 0, {}],
    ["negative TTL", -1, {}],
    ["TTL too short to renew safely", MIN_RENEWAL_INTERVAL_MS * 3 - 1, {}],
    ["NaN grace", 9000, { graceMs: Number.NaN }],
    ["negative grace", 9000, { graceMs: -1 }],
    ["NaN retry delay", 9000, { retryDelayMs: Number.NaN }],
    ["zero retry delay", 9000, { retryDelayMs: 0 }],
  ];
  for (const [name, ttl, options] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => validateLeaseRenewalConfig(ttl, options)).toThrow(RangeError);
    });
  }

  it("accepts the boundary values", () => {
    expect(() => validateLeaseRenewalConfig(MIN_RENEWAL_INTERVAL_MS * 3)).not.toThrow();
    expect(() => validateLeaseRenewalConfig(9000, { intervalMs: MIN_RENEWAL_INTERVAL_MS, graceMs: 0, retryDelayMs: 1 })).not.toThrow();
    expect(() => validateLeaseRenewalConfig(9000, { intervalMs: 8999 })).not.toThrow();
    expect(() => validateLeaseRenewalConfig(10_000)).not.toThrow();
  });

  it("WorkerRuntime fails at construction, before any run can be claimed", () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const store = new SqliteStateStore();
    const coordinator = new RunCoordinator(store, clock);
    expect(() => new WorkerRuntime({ coordinator, clock, leaseRenewal: { intervalMs: Number.NaN } })).toThrow(RangeError);
    expect(() => new WorkerRuntime({ coordinator, clock, leaseTtlMs: Number.NaN })).toThrow(RangeError);
    expect(() => new WorkerRuntime({ coordinator, clock, leaseTtlMs: 5000, leaseRenewal: { intervalMs: 6000 } })).toThrow(RangeError);
    expect(() => new WorkerRuntime({ coordinator, clock, leaseTtlMs: 5000 })).not.toThrow();
    store.close();
  });

  it("LeaseRenewalLoop itself refuses an invalid configuration and an invalid timeout", () => {
    const clock = new SettableClock("2026-03-30T10:00:00.000Z");
    const make = (over: object, timeoutMs = 1000) =>
      new LeaseRenewalLoop({
        coordinator: { renewLease: () => ({}) as never },
        clock, runId: "R", leaseId: "L", ttlMs: 9000, expiresAt: "2026-03-30T10:00:09.000Z", timeoutMs, options: over,
      });
    expect(() => make({ intervalMs: Number.NaN })).toThrow(RangeError);
    expect(() => make({}, Number.NaN)).toThrow(RangeError);
    expect(() => make({}, -1)).toThrow(RangeError);
    expect(() => make({})).not.toThrow();
  });
});
