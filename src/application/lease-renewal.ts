import { LeaseExpiredError, LeaseLostError } from "../domain/errors.js";
import { ClockPort } from "../ports/clock.port.js";
import type { LeaseRecord } from "../ports/state-store.port.js";

export interface RenewalTimer {
  cancel(): void;
}

/** Schedules the next renewal tick; injectable so tests drive renewals without real timers. */
export interface RenewalScheduler {
  schedule(fn: () => void, delayMs: number): RenewalTimer;
}

/** setTimeout-based scheduler; the timer is unref'd so it never keeps the process alive. */
export const systemRenewalScheduler: RenewalScheduler = {
  schedule(fn, delayMs) {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface LeaseRenewalOptions {
  /** Delay between renewals. Default: one third of the lease TTL. */
  readonly intervalMs?: number;
  /** Renewals stop this long after the run's own timeout, so a hung run's lease eventually lapses. Default: one TTL. */
  readonly graceMs?: number;
  /** Delay before retrying after a transient renewal error (only while the lease has not expired). Default: 1000ms, at most the interval. */
  readonly retryDelayMs?: number;
  readonly scheduler?: RenewalScheduler;
}

/** setTimeout delays above this are clamped to 1ms by Node, which would turn the loop into a spin. */
const MAX_TIMER_MS = 2_147_483_647;
/** Smallest accepted renewal interval; anything tighter is a near-busy loop against the database. */
export const MIN_RENEWAL_INTERVAL_MS = 10;

/**
 * Rejects timing values that would create an immediate or tight timer loop, a renewal that can never
 * keep the lease alive, or a NaN/Infinity delay. Throws RangeError; call it before any run is claimed.
 */
export function validateLeaseRenewalConfig(ttlMs: number, options: LeaseRenewalOptions = {}): void {
  const reject = (name: string, value: unknown, rule: string): never => {
    throw new RangeError(`Invalid lease renewal config: ${name}=${String(value)} (${rule})`);
  };
  const finiteIn = (name: string, value: unknown, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      reject(name, value, `must be a finite number between ${min} and ${max}`);
    }
    return value as number;
  };
  finiteIn("leaseTtlMs", ttlMs, MIN_RENEWAL_INTERVAL_MS * 3, MAX_TIMER_MS);
  const interval =
    options.intervalMs === undefined
      ? Math.floor(ttlMs / 3)
      : finiteIn("intervalMs", options.intervalMs, MIN_RENEWAL_INTERVAL_MS, MAX_TIMER_MS);
  if (interval >= ttlMs) reject("intervalMs", interval, `must be shorter than the lease TTL (${ttlMs}ms) or the lease lapses between renewals`);
  if (options.graceMs !== undefined) finiteIn("graceMs", options.graceMs, 0, MAX_TIMER_MS);
  if (options.retryDelayMs !== undefined) finiteIn("retryDelayMs", options.retryDelayMs, 1, MAX_TIMER_MS);
}

export interface LeaseRenewalDeps {
  readonly coordinator: { renewLease(runId: string, leaseId: string, ttlMs: number): LeaseRecord };
  readonly clock: ClockPort;
  readonly runId: string;
  readonly leaseId: string;
  readonly ttlMs: number;
  /** Expiry of the lease as claimed. */
  readonly expiresAt: string;
  readonly timeoutMs: number;
  readonly options?: LeaseRenewalOptions;
}

/**
 * Keeps a worker's lease alive while it executes a claimed run (ADR-0002 §2.5).
 *
 * - Renewal goes through the coordinator (one BEGIN IMMEDIATE transaction), so it is serialized with
 *   the recovery sweeper: whichever commits first wins. An expired, released or taken-over lease is
 *   never revived; the loop then records `lostError` and stops.
 * - Transient errors are retried only while the lease has not expired; after that the lease is lost.
 * - It stops renewing after the run's timeout plus a grace period, and stop() must be called before
 *   the lease is released. Liveness is in-process: a crashed or wedged worker stops renewing.
 * - Caveat: node:sqlite is synchronous, so a long synchronous stretch can starve the timer; the TTL
 *   must exceed the longest such stretch.
 */
export class LeaseRenewalLoop {
  private readonly scheduler: RenewalScheduler;
  private readonly intervalMs: number;
  private readonly retryDelayMs: number;
  private readonly deadlineMs: number;
  private expiresAt: string;
  private timer: RenewalTimer | null = null;
  private stopped = true;
  private lost: LeaseLostError | LeaseExpiredError | null = null;

  constructor(private readonly deps: LeaseRenewalDeps) {
    validateLeaseRenewalConfig(deps.ttlMs, deps.options);
    if (!Number.isFinite(deps.timeoutMs) || deps.timeoutMs < 0) {
      throw new RangeError(`Invalid lease renewal config: timeoutMs=${String(deps.timeoutMs)} (must be a finite number >= 0)`);
    }
    const o = deps.options ?? {};
    this.scheduler = o.scheduler ?? systemRenewalScheduler;
    this.intervalMs = Math.max(1, o.intervalMs ?? Math.floor(deps.ttlMs / 3));
    this.retryDelayMs = Math.max(1, Math.min(o.retryDelayMs ?? 1000, this.intervalMs));
    this.deadlineMs = deps.clock.now().getTime() + deps.timeoutMs + (o.graceMs ?? deps.ttlMs);
    this.expiresAt = deps.expiresAt;
  }

  /** The reason the lease was lost, or null while it is held (or renewal was merely stopped). */
  get lostError(): LeaseLostError | LeaseExpiredError | null {
    return this.lost;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.arm(this.intervalMs);
  }

  /** Cancels future renewals. Renewal is synchronous, so none can be in flight once this returns. */
  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
  }

  private arm(delayMs: number): void {
    this.timer = this.scheduler.schedule(() => this.tick(), delayMs);
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    const nowMs = this.deps.clock.now().getTime();
    if (nowMs >= this.deadlineMs) {
      this.stopped = true; // run is past its timeout + grace: let the lease lapse
      return;
    }
    try {
      const lease = this.deps.coordinator.renewLease(this.deps.runId, this.deps.leaseId, this.deps.ttlMs);
      this.expiresAt = lease.expiresAt;
      this.arm(this.intervalMs);
    } catch (err: unknown) {
      if (err instanceof LeaseLostError || err instanceof LeaseExpiredError) {
        this.lost = err;
        this.stopped = true;
        return;
      }
      if (nowMs >= new Date(this.expiresAt).getTime()) {
        this.lost = new LeaseExpiredError(this.deps.leaseId, this.expiresAt, this.deps.clock.nowIso());
        this.stopped = true;
        return;
      }
      this.arm(this.retryDelayMs);
    }
  }
}
