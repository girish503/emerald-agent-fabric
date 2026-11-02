/**
 * ClockPort abstraction for injecting time.
 * Allows deterministic tests without fragile real-time sleeps.
 */
import { MissingMutationAuthorityError } from "../domain/errors.js";

export interface ClockPort {
  now(): Date;
  nowIso(): string;
}

/**
 * Time contract for recovery authority decisions (gate freshness, worker-lease expiry, supervisor-lease acquisition).
 *
 * The injected ClockPort is the ONLY source of authority time; it is the deliberate deterministic-testing seam
 * (SettableClock). A caller-supplied `nowIso` is validated but never moves authority time: a backdated value would
 * make an expired gate or lease look current, and a future-dated value would expire another holder's live lease.
 * An unparseable value fails closed.
 */
export function resolveAuthorityNowIso(clock: ClockPort, suppliedNowIso: string | undefined, subjectId: string): string {
  if (suppliedNowIso !== undefined && (typeof suppliedNowIso !== "string" || !Number.isFinite(Date.parse(suppliedNowIso)))) {
    throw new MissingMutationAuthorityError(
      subjectId,
      `Invalid caller-supplied nowIso '${String(suppliedNowIso)}'; recovery authority time comes from the injected clock`
    );
  }
  return clock.nowIso();
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}

export class SettableClock implements ClockPort {
  private _currentTime: Date;

  constructor(initialTime: Date | string = new Date()) {
    this._currentTime = typeof initialTime === "string" ? new Date(initialTime) : new Date(initialTime.getTime());
  }

  now(): Date {
    return new Date(this._currentTime.getTime());
  }

  nowIso(): string {
    return this._currentTime.toISOString();
  }

  set(time: Date | string): void {
    this._currentTime = typeof time === "string" ? new Date(time) : new Date(time.getTime());
  }

  advanceMs(ms: number): void {
    this._currentTime = new Date(this._currentTime.getTime() + ms);
  }
}
