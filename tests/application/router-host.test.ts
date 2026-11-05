import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RouterHostConfigError,
  RouterHostLogRecord,
  abortableSleep,
  isDatabaseBusyError,
  runRouterHost,
} from "../../src/application/router-host.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TaskRouterService, DispatchTickResult } from "../../src/application/task-router.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";

describe("Milestone 2.19 — Long-Running Durable Router Host", () => {
  let tempDir: string;
  let dbPath: string;
  let clock: SettableClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-router-host-test-"));
    dbPath = path.join(tempDir, "state.db");
    // Initialize an empty file store so the db exists
    const initStore = new SqliteStateStore({ location: dbPath });
    initStore.close();
    clock = new SettableClock("2026-11-05T12:00:00.000Z");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("isDatabaseBusyError", () => {
    it("identifies SQLITE_BUSY and SQLITE_LOCKED codes", () => {
      expect(isDatabaseBusyError({ code: "SQLITE_BUSY" })).toBe(true);
      expect(isDatabaseBusyError({ code: "SQLITE_LOCKED" })).toBe(true);
      expect(isDatabaseBusyError({ code: "EBUSY" })).toBe(true);
    });

    it("identifies database locked error message patterns", () => {
      expect(isDatabaseBusyError(new Error("database is locked"))).toBe(true);
      expect(isDatabaseBusyError(new Error("Error: SQLITE_BUSY: database is locked"))).toBe(true);
      expect(isDatabaseBusyError("SqliteError: database is locked")).toBe(true);
    });

    it("fails closed on non-busy errors", () => {
      expect(isDatabaseBusyError(null)).toBe(false);
      expect(isDatabaseBusyError(undefined)).toBe(false);
      expect(isDatabaseBusyError(new Error("UNIQUE constraint failed: tasks.task_id"))).toBe(false);
      expect(isDatabaseBusyError(new TypeError("Cannot read properties of undefined"))).toBe(false);
      expect(isDatabaseBusyError({ code: "ENOENT" })).toBe(false);
    });
  });

  describe("abortableSleep", () => {
    it("resolves immediately when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const start = Date.now();
      await abortableSleep(5000, controller.signal);
      expect(Date.now() - start).toBeLessThan(100);
    });

    it("interrupts sleep early when signal aborts", async () => {
      const controller = new AbortController();
      const start = Date.now();
      const timer = setTimeout(() => controller.abort(), 20);
      await abortableSleep(5000, controller.signal);
      clearTimeout(timer);
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("resolves normally when no abort signal is provided", async () => {
      const start = Date.now();
      await abortableSleep(15);
      expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    });
  });

  describe("configuration validation", () => {
    it("throws RouterHostConfigError if dbPath is missing or memory", async () => {
      await expect(runRouterHost({ dbPath: "" })).rejects.toThrow(RouterHostConfigError);
      await expect(runRouterHost({ dbPath: ":memory:" })).rejects.toThrow(RouterHostConfigError);
    });

    it("throws RouterHostConfigError if db file does not exist", async () => {
      await expect(runRouterHost({ dbPath: path.join(tempDir, "missing.db") })).rejects.toThrow(
        /database not found/
      );
    });

    it("throws RouterHostConfigError for invalid maxConcurrentRuns", async () => {
      await expect(
        // @ts-expect-error testing invalid cap
        runRouterHost({ dbPath, maxConcurrentRuns: 3 })
      ).rejects.toThrow(/--max-concurrent must be 1 or 2/);
    });

    it("throws RouterHostConfigError for invalid pollIntervalMs", async () => {
      await expect(
        runRouterHost({ dbPath, pollIntervalMs: 0 })
      ).rejects.toThrow(/--poll-interval-ms must be a positive integer/);
      await expect(
        runRouterHost({ dbPath, pollIntervalMs: 1.5 })
      ).rejects.toThrow(/--poll-interval-ms must be a positive integer/);
    });

    it("throws RouterHostConfigError for invalid busyBackoffMs", async () => {
      await expect(
        runRouterHost({ dbPath, busyBackoffMs: -10 })
      ).rejects.toThrow(/--busy-backoff-ms must be a positive integer/);
    });

    it("throws RouterHostConfigError when maxBusyBackoffMs < busyBackoffMs", async () => {
      await expect(
        runRouterHost({ dbPath, busyBackoffMs: 500, maxBusyBackoffMs: 200 })
      ).rejects.toThrow(/--max-busy-backoff-ms must be an integer >= --busy-backoff-ms/);
    });

    it("throws RouterHostConfigError for non-existent workspaceRoot", async () => {
      await expect(
        runRouterHost({ dbPath, workspaceRoot: path.join(tempDir, "ghost-dir") })
      ).rejects.toThrow(/workspace root directory not found/);
    });
  });

  describe("continuous dispatch execution", () => {
    it("executes single tick with once: true and emits structured events", async () => {
      const logs: RouterHostLogRecord[] = [];
      const mockResult: DispatchTickResult = {
        admittedRunIds: ["run-1"],
        cancelledRunIds: [],
        inFlight: 1,
        capacity: 2,
      };
      const mockRouter = {
        dispatchTick: vi.fn().mockReturnValue(mockResult),
      } as unknown as TaskRouterService;

      const result = await runRouterHost({
        dbPath,
        once: true,
        clock,
        log: (r) => logs.push(r),
        taskRouter: mockRouter,
      });

      expect(result.ticksExecuted).toBe(1);
      expect(result.totalAdmitted).toBe(1);
      expect(result.totalCancelled).toBe(0);
      expect(mockRouter.dispatchTick).toHaveBeenCalledTimes(1);

      const events = logs.map((l) => l.event);
      expect(events).toContain("router.host.started");
      expect(events).toContain("router.host.tick.completed");
      expect(events).toContain("router.host.stopped");
    });

    it("executes multiple ticks bounded by maxTicks and respects sleep", async () => {
      const logs: RouterHostLogRecord[] = [];
      const sleeps: number[] = [];
      let tickCount = 0;

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          tickCount++;
          return {
            admittedRunIds: tickCount === 1 ? ["run-a"] : [],
            cancelledRunIds: [],
            inFlight: tickCount === 1 ? 1 : 0,
            capacity: 2,
          };
        }),
      } as unknown as TaskRouterService;

      const result = await runRouterHost({
        dbPath,
        maxTicks: 3,
        pollIntervalMs: 50,
        clock,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: (r) => logs.push(r),
        taskRouter: mockRouter,
      });

      expect(result.ticksExecuted).toBe(3);
      expect(result.totalAdmitted).toBe(1);
      expect(mockRouter.dispatchTick).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([50, 50]);

      // Idle transition test: tick 2 is idle (emits idle), tick 3 is still idle (suppressed)
      const idleLogs = logs.filter((l) => l.event === "router.host.idle");
      expect(idleLogs).toHaveLength(1);
    });

    it("gracefully shuts down when AbortSignal triggers during polling", async () => {
      const logs: RouterHostLogRecord[] = [];
      const controller = new AbortController();

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          return {
            admittedRunIds: [],
            cancelledRunIds: [],
            inFlight: 0,
            capacity: 2,
          };
        }),
      } as unknown as TaskRouterService;

      const promise = runRouterHost({
        dbPath,
        pollIntervalMs: 200,
        signal: controller.signal,
        clock,
        sleep: async (_ms, signal) => {
          // Simulate signal aborting during sleep
          controller.abort();
          expect(signal?.aborted).toBe(true);
        },
        log: (r) => logs.push(r),
        taskRouter: mockRouter,
      });

      const result = await promise;
      expect(result.ticksExecuted).toBe(1);
      const events = logs.map((l) => l.event);
      expect(events).toContain("router.host.shutdown_requested");
      expect(events).toContain("router.host.stopped");
    });

    it("gracefully shuts down when AbortSignal triggers during busy backoff", async () => {
      const logs: RouterHostLogRecord[] = [];
      const controller = new AbortController();

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          const err = new Error("database is locked");
          (err as { code?: string }).code = "SQLITE_BUSY";
          throw err;
        }),
      } as unknown as TaskRouterService;

      const result = await runRouterHost({
        dbPath,
        busyBackoffMs: 500,
        signal: controller.signal,
        clock,
        sleep: async (_ms, signal) => {
          controller.abort();
          expect(signal?.aborted).toBe(true);
        },
        log: (r) => logs.push(r),
        taskRouter: mockRouter,
      });

      expect(result.ticksExecuted).toBe(0);
      expect(result.consecutiveBusyRetries).toBe(1);
      expect(mockRouter.dispatchTick).toHaveBeenCalledTimes(1);

      const events = logs.map((l) => l.event);
      expect(events).toContain("router.host.database_busy");
      expect(events).toContain("router.host.shutdown_requested");
      expect(events).toContain("router.host.stopped");
    });
  });

  describe("database busy contention and exponential backoff", () => {
    it("backs off exponentially on SQLITE_BUSY and resets consecutive retries on success", async () => {
      const logs: RouterHostLogRecord[] = [];
      const backoffDelays: number[] = [];
      let calls = 0;

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          calls++;
          if (calls <= 3) {
            const err = new Error("database is locked");
            (err as { code?: string }).code = "SQLITE_BUSY";
            throw err;
          }
          return {
            admittedRunIds: ["run-recovered"],
            cancelledRunIds: [],
            inFlight: 1,
            capacity: 2,
          };
        }),
      } as unknown as TaskRouterService;

      const result = await runRouterHost({
        dbPath,
        busyBackoffMs: 100,
        maxBusyBackoffMs: 1000,
        once: true,
        clock,
        sleep: async (ms) => {
          backoffDelays.push(ms);
        },
        log: (r) => logs.push(r),
        taskRouter: mockRouter,
      });

      // 3 failures then 1 success
      expect(calls).toBe(4);
      expect(result.ticksExecuted).toBe(1);
      expect(result.totalAdmitted).toBe(1);
      // consecutiveBusyRetries is reset to 0 upon successful tick
      expect(result.consecutiveBusyRetries).toBe(0);

      // Backoff schedule: 100 * 2^0 = 100, 100 * 2^1 = 200, 100 * 2^2 = 400
      expect(backoffDelays).toEqual([100, 200, 400]);

      const busyEvents = logs.filter((l) => l.event === "router.host.database_busy");
      expect(busyEvents).toHaveLength(3);
      expect(busyEvents[0]!.attempt).toBe(1);
      expect(busyEvents[0]!.backoffMs).toBe(100);
      expect(busyEvents[1]!.attempt).toBe(2);
      expect(busyEvents[1]!.backoffMs).toBe(200);
      expect(busyEvents[2]!.attempt).toBe(3);
      expect(busyEvents[2]!.backoffMs).toBe(400);
    });

    it("caps backoff delay at maxBusyBackoffMs", async () => {
      const backoffDelays: number[] = [];
      let calls = 0;

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          calls++;
          if (calls <= 4) {
            const err = new Error("SQLITE_BUSY");
            (err as { code?: string }).code = "SQLITE_BUSY";
            throw err;
          }
          return { admittedRunIds: [], cancelledRunIds: [], inFlight: 0, capacity: 2 };
        }),
      } as unknown as TaskRouterService;

      await runRouterHost({
        dbPath,
        busyBackoffMs: 100,
        maxBusyBackoffMs: 300,
        once: true,
        clock,
        sleep: async (ms) => {
          backoffDelays.push(ms);
        },
        taskRouter: mockRouter,
      });

      // 100, 200, Math.min(400, 300) = 300, Math.min(800, 300) = 300
      expect(backoffDelays).toEqual([100, 200, 300, 300]);
    });

    it("fails immediately without retry on non-retryable errors", async () => {
      const logs: RouterHostLogRecord[] = [];
      const sleepFn = vi.fn();

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          throw new Error("Syntax error in query: unexpected token");
        }),
      } as unknown as TaskRouterService;

      await expect(
        runRouterHost({
          dbPath,
          once: true,
          clock,
          sleep: sleepFn,
          log: (r) => logs.push(r),
          taskRouter: mockRouter,
        })
      ).rejects.toThrow("Syntax error in query: unexpected token");

      expect(sleepFn).not.toHaveBeenCalled();
      const failedEvents = logs.filter((l) => l.event === "router.host.failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]!.error).toMatch(/Syntax error in query/);
    });
  });

  describe("resource management", () => {
    it("closes the stateStore exactly once on normal exit", async () => {
      const closeSpy = vi.fn();
      const mockStore = {
        close: closeSpy,
      } as unknown as SqliteStateStore;

      const mockRouter = {
        dispatchTick: vi.fn().mockReturnValue({
          admittedRunIds: [],
          cancelledRunIds: [],
          inFlight: 0,
          capacity: 2,
        }),
      } as unknown as TaskRouterService;

      await runRouterHost({
        dbPath,
        once: true,
        clock,
        stateStore: mockStore,
        taskRouter: mockRouter,
      });

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("closes the stateStore exactly once even when dispatchTick throws", async () => {
      const closeSpy = vi.fn();
      const mockStore = {
        close: closeSpy,
      } as unknown as SqliteStateStore;

      const mockRouter = {
        dispatchTick: vi.fn().mockImplementation(() => {
          throw new Error("Fatal disk corruption");
        }),
      } as unknown as TaskRouterService;

      await expect(
        runRouterHost({
          dbPath,
          once: true,
          clock,
          stateStore: mockStore,
          taskRouter: mockRouter,
        })
      ).rejects.toThrow("Fatal disk corruption");

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("end-to-end with real database and TaskRouterService", () => {
    it("dispatches pending tasks into QUEUED without executing worker logic", async () => {
      const store = new SqliteStateStore({ location: dbPath });
      const coordinator = new RunCoordinator(store, clock);

      // Create a task and contract
      coordinator.createTask({ taskId: "t-real-1", title: "Real Task 1", inputPayload: {} });
      createAndActivateContract(store, "t-real-1");

      const router = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
      router.submitTask({ taskId: "t-real-1", submissionKey: "key-1" });

      // Run router host for a single tick
      store.close(); // Close so router host can open its own connection cleanly

      const result = await runRouterHost({
        dbPath,
        once: true,
        clock,
      });

      expect(result.ticksExecuted).toBe(1);
      expect(result.totalAdmitted).toBe(1);

      // Verify task run is now QUEUED in the database
      const verifyStore = new SqliteStateStore({ location: dbPath });
      try {
        const runId = verifyStore.transaction((tx) => tx.getRouterSubmissionByTaskId("t-real-1")!.runId);
        const run = verifyStore.getRun(runId);
        expect(run?.status).toBe("QUEUED");
        // Verify it was NOT started or completed (Router Host does not execute runs!)
        expect(run?.currentWorkerId).toBeNull();
        expect(run?.leaseId).toBeNull();
      } finally {
        verifyStore.close();
      }
    });
  });
});
