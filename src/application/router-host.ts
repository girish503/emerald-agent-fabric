/**
 * Emerald Agent Fabric — Long-Running Durable Router Host (Milestone 2.19).
 *
 * Responsibilities:
 *  - Continuously inspects durable routing state and dispatches eligible tasks via TaskRouterService.dispatchTick.
 *  - Strictly separates Router and Worker responsibilities:
 *      * Router Host: reads routing state, determines eligibility, queues runs, enforces concurrency cap, emits events.
 *      * Worker Host: claims queued runs, executes them, manages worker leases.
 *  - Handles transient SQLite lock contention (SQLITE_BUSY, SQLITE_LOCKED) with bounded exponential backoff.
 *  - Never retries non-retryable errors (programming bugs, constraint violations, invalid arguments, permanent DB corruption).
 *  - Resets the consecutive busy retry counter on successful tick.
 *  - Gracefully shuts down on SIGINT / SIGTERM / AbortSignal:
 *      * Finishes the in-flight synchronous dispatch transaction.
 *      * Interrupts polling or backoff sleeps without waiting out the full delay.
 *      * Closes the SQLite connection exactly once.
 *      * Emits structured shutdown events.
 *  - Avoids CPU-intensive busy looping when idle.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "./run-coordinator.js";
import { TaskRouterService, DispatchTickResult } from "./task-router.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";

export class RouterHostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterHostConfigError";
  }
}

export interface RouterHostLogRecord {
  readonly ts: string;
  readonly event: string;
  readonly hostId: string;
  readonly [key: string]: unknown;
}

export interface RouterHostOptions {
  /** Path of an existing Emerald SQLite database file. Router host never creates one. */
  readonly dbPath: string;
  /** Max in-flight runs (1 or 2, default 2). */
  readonly maxConcurrentRuns?: 1 | 2;
  /** Polling interval in ms when idle or between ticks (positive integer, default 1000). */
  readonly pollIntervalMs?: number;
  /** Initial retry delay in ms for database-busy contention (positive integer, default 100). */
  readonly busyBackoffMs?: number;
  /** Maximum retry delay in ms for database-busy contention (positive integer >= busyBackoffMs, default 5000). */
  readonly maxBusyBackoffMs?: number;
  /** Optional workspace root directory (must exist if provided). */
  readonly workspaceRoot?: string;
  /** Exit after first tick instead of polling indefinitely. */
  readonly once?: boolean;
  /** Exit after this many ticks (useful for deterministic tests). */
  readonly maxTicks?: number;
  /** AbortSignal to request graceful shutdown. */
  readonly signal?: AbortSignal;
  /** Host identifier (default auto-generated). */
  readonly hostId?: string;
  /** Custom structured logging sink (default writes to process.stdout). */
  readonly log?: (record: RouterHostLogRecord) => void;
  /** Optional injected ClockPort (default SystemClock). */
  readonly clock?: ClockPort;
  /** Optional injected sleep function (for deterministic testing without real sleeps). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional injected SqliteStateStore (for testing). */
  readonly stateStore?: SqliteStateStore;
  /** Optional injected TaskRouterService (for testing). */
  readonly taskRouter?: TaskRouterService;
}

export interface RouterHostResult {
  readonly hostId: string;
  readonly ticksExecuted: number;
  readonly totalAdmitted: number;
  readonly totalCancelled: number;
  readonly consecutiveBusyRetries: number;
}

/**
 * Determines if an error represents genuine transient SQLite lock contention.
 * Retries ONLY errors explicitly classified as retryable.
 * Does NOT retry arbitrary programming errors, constraint violations, invalid arguments, or permanent database failures.
 */
export function isDatabaseBusyError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string })?.code;
  if (code && ["SQLITE_BUSY", "SQLITE_LOCKED", "EBUSY"].includes(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/**
 * Interruptible sleep that resolves early when the AbortSignal fires.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Executes the continuous Router Host dispatch loop.
 */
export async function runRouterHost(options: RouterHostOptions): Promise<RouterHostResult> {
  // 1. Validate configuration fail-closed
  if (!options.dbPath || typeof options.dbPath !== "string") {
    throw new RouterHostConfigError("Error: --db is required");
  }
  if (options.dbPath === ":memory:") {
    throw new RouterHostConfigError("Error: --db <file> is required (not :memory:)");
  }
  if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) {
    throw new RouterHostConfigError(`Error: database not found (router host never creates one): ${options.dbPath}`);
  }

  const workspaceRoot = options.workspaceRoot;
  if (workspaceRoot !== undefined) {
    try {
      if (!fs.statSync(workspaceRoot).isDirectory()) {
        throw new RouterHostConfigError(`Error: workspace root is not a directory: ${workspaceRoot}`);
      }
    } catch (err: unknown) {
      if (err instanceof RouterHostConfigError) throw err;
      throw new RouterHostConfigError(`Error: workspace root directory not found: ${workspaceRoot}`);
    }
  }

  const maxConcurrentRuns: 1 | 2 = options.maxConcurrentRuns ?? 2;
  if (maxConcurrentRuns !== 1 && maxConcurrentRuns !== 2) {
    throw new RouterHostConfigError("Error: --max-concurrent must be 1 or 2");
  }

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RouterHostConfigError("Error: --poll-interval-ms must be a positive integer");
  }

  const busyBackoffMs = options.busyBackoffMs ?? 100;
  if (!Number.isInteger(busyBackoffMs) || busyBackoffMs < 1) {
    throw new RouterHostConfigError("Error: --busy-backoff-ms must be a positive integer");
  }

  const maxBusyBackoffMs = options.maxBusyBackoffMs ?? 5000;
  if (!Number.isInteger(maxBusyBackoffMs) || maxBusyBackoffMs < busyBackoffMs) {
    throw new RouterHostConfigError("Error: --max-busy-backoff-ms must be an integer >= --busy-backoff-ms");
  }

  if (options.maxTicks !== undefined && (!Number.isInteger(options.maxTicks) || options.maxTicks < 1)) {
    throw new RouterHostConfigError("Error: maxTicks must be a positive integer >= 1");
  }

  // 2. Setup dependencies and single-close resource management
  const hostId = options.hostId ?? `router-host-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const clock = options.clock ?? new SystemClock();
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? ((r: RouterHostLogRecord) => process.stdout.write(JSON.stringify(r) + "\n"));
  const once = options.once ?? false;
  const signal = options.signal;

  const stamp = (event: string, payload: Record<string, unknown> = {}): RouterHostLogRecord => ({
    ts: clock.nowIso ? clock.nowIso() : new Date().toISOString(),
    event,
    hostId,
    ...payload,
  });

  const store = options.stateStore ?? new SqliteStateStore({ location: options.dbPath });
  let isClosed = false;
  const closeStoreOnce = () => {
    if (!isClosed) {
      isClosed = true;
      try {
        store.close();
      } catch {
        // safe fallback
      }
    }
  };

  const coordinator = new RunCoordinator(store, clock);
  const router = options.taskRouter ?? new TaskRouterService(store, coordinator, clock, {
    maxConcurrentRuns,
  });

  log(
    stamp("router.host.started", {
      dbPath: options.dbPath,
      maxConcurrentRuns,
      pollIntervalMs,
      busyBackoffMs,
      maxBusyBackoffMs,
      workspaceRoot: workspaceRoot ?? null,
      once,
    })
  );

  let ticksExecuted = 0;
  let totalAdmitted = 0;
  let totalCancelled = 0;
  let consecutiveBusyRetries = 0;
  let lastTickHadActivity = true;

  try {
    while (!signal?.aborted) {
      if (options.maxTicks !== undefined && ticksExecuted >= options.maxTicks) {
        break;
      }

      let tickResult: DispatchTickResult;
      const tickStartMs = clock.now().getTime();
      try {
        tickResult = router.dispatchTick();
        consecutiveBusyRetries = 0;
      } catch (err: unknown) {
        if (isDatabaseBusyError(err)) {
          consecutiveBusyRetries++;
          const backoffMs = Math.min(
            busyBackoffMs * Math.pow(2, consecutiveBusyRetries - 1),
            maxBusyBackoffMs
          );
          log(
            stamp("router.host.database_busy", {
              attempt: consecutiveBusyRetries,
              backoffMs,
              error: err instanceof Error ? err.message : String(err),
            })
          );
          await sleep(backoffMs, signal);
          continue;
        }

        log(
          stamp("router.host.failed", {
            error: err instanceof Error ? err.message : String(err),
            consecutiveBusyRetries,
          })
        );
        throw err;
      }

      const durationMs = clock.now().getTime() - tickStartMs;
      ticksExecuted++;
      totalAdmitted += tickResult.admittedRunIds.length;
      totalCancelled += tickResult.cancelledRunIds.length;

      const hadActivity = tickResult.admittedRunIds.length > 0 || tickResult.cancelledRunIds.length > 0;
      if (hadActivity) {
        log(
          stamp("router.host.tick.completed", {
            durationMs,
            admittedCount: tickResult.admittedRunIds.length,
            cancelledCount: tickResult.cancelledRunIds.length,
            inFlight: tickResult.inFlight,
            capacity: tickResult.capacity,
            admittedRunIds: tickResult.admittedRunIds,
            cancelledRunIds: tickResult.cancelledRunIds,
          })
        );
        lastTickHadActivity = true;
      } else {
        // Emit idle event only on transition to idle to prevent log spam
        if (lastTickHadActivity) {
          log(
            stamp("router.host.idle", {
              durationMs,
              inFlight: tickResult.inFlight,
              capacity: tickResult.capacity,
            })
          );
          lastTickHadActivity = false;
        }
      }

      if (once) {
        break;
      }

      if (options.maxTicks !== undefined && ticksExecuted >= options.maxTicks) {
        break;
      }

      if (signal?.aborted) {
        break;
      }

      await sleep(pollIntervalMs, signal);
    }
  } finally {
    if (signal?.aborted) {
      log(stamp("router.host.shutdown_requested", { reason: "Shutdown signal received" }));
    }
    closeStoreOnce();
    log(
      stamp("router.host.stopped", {
        ticksExecuted,
        totalAdmitted,
        totalCancelled,
        consecutiveBusyRetries,
      })
    );
  }

  return {
    hostId,
    ticksExecuted,
    totalAdmitted,
    totalCancelled,
    consecutiveBusyRetries,
  };
}
