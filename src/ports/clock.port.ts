/**
 * ClockPort abstraction for injecting time.
 * Allows deterministic tests without fragile real-time sleeps.
 */
export interface ClockPort {
  now(): Date;
  nowIso(): string;
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
