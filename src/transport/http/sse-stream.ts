/**
 * Bounded, gap-safe SSE delivery session (Track B transport).
 *
 * Guarantees (and their limits):
 *  - Every frame that carries an `id:` is the next sequence after the previous one: the stream never skips
 *    a sequence number. A client's Last-Event-ID therefore never moves past an event it did not receive.
 *  - Live events that arrive while durable replay is being read are held in a bounded buffer. Live events
 *    that arrive while the socket is backpressured are held in a bounded queue. When either bound is hit
 *    (or a sequence gap is detected) the session stops accepting events, delivers what is already queued,
 *    emits an explicit `stream.overflow` notification (WITHOUT an `id:` field, so the client's cursor is
 *    unchanged) containing the last delivered sequence, then ends the connection. Nothing is dropped
 *    silently and the stream is never presented as uninterrupted afterwards.
 *  - Recovery after an overflow is the client reconnecting with Last-Event-ID; that only recovers events
 *    when a durable event source is configured. The session itself never claims durability.
 *  - Duplicates (sequence <= last accepted) are suppressed.
 *  - Writes respect backpressure: no write is issued while the socket reported a full buffer.
 */

import type { UserRole } from "./api-contracts.js";

export interface SseEnvelope {
  readonly id: string;
  readonly event: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly schemaVersion: number;
  readonly producer: string;
  readonly data: unknown;
}

/**
 * Projects event data according to caller role.
 * - For all roles: tokens, passwords, and raw bearer credentials are redacted.
 * - For auditor: raw execution scripts, command details, and internal paths are removed,
 *   preserving structured verification summaries, hashes, timestamps, and pass/fail statuses.
 */
export function projectEventDataForRole(data: unknown, role: UserRole): unknown {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) {
    return data.map((item) => projectEventDataForRole(item, role));
  }
  const record = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    // Redact tokens/passwords for all roles
    if (/^(token|password|secret|bearerToken|authorization)$/i.test(key)) {
      result[key] = "[REDACTED]";
      continue;
    }
    if (role === "auditor") {
      // Auditor projection: strip raw script code, full shell commands, and internal paths
      if (/^(rawScript|script|command|internalPaths|internalPath|workingDirectory)$/i.test(key)) {
        continue;
      }
      if (typeof value === "string" && (/^(\/tmp\/|[A-Za-z]:\\)/.test(value))) {
        result[key] = "[INTERNAL_PATH_REDACTED]";
        continue;
      }
    }
    if (value && typeof value === "object") {
      result[key] = projectEventDataForRole(value, role);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Minimal writable surface (satisfied by http.ServerResponse and by test fakes). */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", listener: () => void): unknown;
  off?(event: "drain", listener: () => void): unknown;
  removeListener?(event: "drain", listener: () => void): unknown;
}

export type StreamOverflowReason = "LIVE_BUFFER_OVERFLOW" | "SLOW_CLIENT_BACKPRESSURE" | "SEQUENCE_GAP";

export interface SseSessionOptions {
  readonly sink: SseSink;
  readonly runId: string;
  /** Last sequence the client already has (Last-Event-ID), or 0. */
  readonly cursor: number;
  /** Maximum number of live events that may be held (while replaying or while backpressured). */
  readonly maxBufferedEvents: number;
  /** Event types after which the stream ends. */
  readonly terminalEventTypes: ReadonlySet<string>;
  /** Called exactly once when the session is finished (for listener/counter cleanup). */
  readonly onClosed: () => void;
}

type Closing = { readonly kind: "END" } | { readonly kind: "OVERFLOW"; readonly reason: StreamOverflowReason } | null;

export class SseSession {
  private readonly opts: SseSessionOptions;
  private lastAccepted: number;
  private lastWritten: number;
  private paused = false;
  private closed = false;
  private closing: Closing = null;
  private liveStarted = false;

  /** Replay events already materialised by the durable read (not additional buffering). */
  private readonly replayQueue: SseEnvelope[] = [];
  /** Live events held while replaying or while the socket is backpressured. Bounded by maxBufferedEvents. */
  private readonly liveQueue: SseEnvelope[] = [];
  private readonly drainListener = () => {
    this.paused = false;
    this.pump();
  };

  constructor(opts: SseSessionOptions) {
    this.opts = opts;
    this.lastAccepted = opts.cursor;
    this.lastWritten = opts.cursor;
  }

  get lastDeliveredSequence(): number {
    return this.lastWritten;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Loads durable replay events (strictly ordered). Must be called before beginLive(). */
  replay(events: readonly SseEnvelope[]): void {
    if (this.closed || this.closing) return;
    const ordered = [...events].filter((e) => e.sequence > this.opts.cursor).sort((a, b) => a.sequence - b.sequence);
    for (const evt of ordered) {
      if (evt.sequence <= this.lastAccepted) continue; // duplicate
      if (evt.sequence !== this.lastAccepted + 1) {
        this.beginClosing({ kind: "OVERFLOW", reason: "SEQUENCE_GAP" });
        return;
      }
      this.replayQueue.push(evt);
      this.lastAccepted = evt.sequence;
      if (this.opts.terminalEventTypes.has(evt.event)) {
        this.beginClosing({ kind: "END" });
        return;
      }
    }
  }

  /** Offers a live event (any time after construction). Held, delivered, or the session overflows. */
  offerLive(evt: SseEnvelope): void {
    if (this.closed || this.closing) return;
    if (evt.sequence <= this.lastAccepted) return; // duplicate, suppressed

    if (!this.liveStarted) {
      // Replay window: hold, bounded.
      if (this.liveQueue.length >= this.opts.maxBufferedEvents) {
        this.beginClosing({ kind: "OVERFLOW", reason: "LIVE_BUFFER_OVERFLOW" });
        return;
      }
      this.liveQueue.push(evt);
      return;
    }

    if (evt.sequence !== this.lastAccepted + 1) {
      this.beginClosing({ kind: "OVERFLOW", reason: "SEQUENCE_GAP" });
      this.pump();
      return;
    }
    const wouldQueue = this.paused || this.replayQueue.length > 0 || this.liveQueue.length > 0;
    if (wouldQueue && this.liveQueue.length >= this.opts.maxBufferedEvents) {
      this.beginClosing({ kind: "OVERFLOW", reason: "SLOW_CLIENT_BACKPRESSURE" });
      this.pump();
      return;
    }
    this.acceptLive(evt);
    this.pump();
  }

  /** Ends the replay window: promotes held live events (ordered, deduplicated, contiguous) and starts pumping. */
  beginLive(): void {
    if (this.closed) return;
    this.liveStarted = true;
    const held = this.liveQueue.splice(0, this.liveQueue.length).sort((a, b) => a.sequence - b.sequence);
    // Held events that are contiguous with what was already accepted are valid and must still be delivered,
    // including when the hold buffer overflowed (the overflow notification follows them). They are never
    // promoted after a normal end (terminal event already replayed).
    if (!this.closing || this.closing.kind === "OVERFLOW") {
      for (const evt of held) {
        if (evt.sequence <= this.lastAccepted) continue; // duplicate of replay
        if (evt.sequence !== this.lastAccepted + 1) {
          this.beginClosing({ kind: "OVERFLOW", reason: "SEQUENCE_GAP" });
          break;
        }
        this.acceptLive(evt);
        if (this.opts.terminalEventTypes.has(evt.event)) break;
      }
    }
    this.pump();
  }

  /** Ends the stream once everything queued has been written (used when the run is already terminal). */
  endWhenDrained(): void {
    if (this.closed) return;
    if (!this.closing) this.closing = { kind: "END" };
    this.pump();
  }

  /** Emits an SSE stream.error terminal event without advancing the client cursor, then ends the sink. */
  emitStreamError(code: string, message: string): void {
    if (this.closed) return;
    const payload = JSON.stringify({
      runId: this.opts.runId,
      code,
      message,
    });
    this.sinkWrite(`event: stream.error\ndata: ${payload}\n\n`);
    this.opts.sink.end();
    this.close();
  }

  /** Immediate teardown (client disconnect or server shutdown). Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.replayQueue.length = 0;
    this.liveQueue.length = 0;
    this.detachDrain();
    this.opts.onClosed();
  }

  // --------------------------------------------------------------------------

  private acceptLive(evt: SseEnvelope): void {
    this.liveQueue.push(evt);
    this.lastAccepted = evt.sequence;
    if (this.opts.terminalEventTypes.has(evt.event)) {
      // A delivered terminal event is the end of the run's log: nothing after it can be missed.
      this.closing = { kind: "END" };
    }
  }

  private beginClosing(closing: NonNullable<Closing>): void {
    if (!this.closing) this.closing = closing;
  }

  private pump(): void {
    while (!this.closed && !this.paused) {
      const next = this.replayQueue.shift() ?? (this.liveStarted ? this.liveQueue.shift() : undefined);
      if (!next) break;
      this.writeEvent(next);
    }
    if (this.closed || this.paused || !this.liveStarted) return;
    if (this.replayQueue.length > 0 || this.liveQueue.length > 0) return;
    if (this.closing) this.finish(this.closing);
  }

  private writeEvent(evt: SseEnvelope): void {
    const frame = `id: ${evt.sequence}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt)}\n\n`;
    this.lastWritten = evt.sequence;
    this.sinkWrite(frame);
  }

  private finish(closing: NonNullable<Closing>): void {
    if (closing.kind === "OVERFLOW") {
      // No `id:` field: the client's Last-Event-ID must stay at the last delivered event.
      const payload = JSON.stringify({
        runId: this.opts.runId,
        lastDeliveredSequence: this.lastWritten,
        reason: closing.reason,
        recovery: "Reconnect with Last-Event-ID set to lastDeliveredSequence; missed events are recoverable only if durable replay is available.",
      });
      this.sinkWrite(`event: stream.overflow\ndata: ${payload}\n\n`);
    }
    this.opts.sink.end();
    this.close();
  }

  private sinkWrite(frame: string): void {
    const ok = this.opts.sink.write(frame);
    if (!ok && !this.paused) {
      this.paused = true;
      this.opts.sink.once("drain", this.drainListener);
    }
  }

  private detachDrain(): void {
    const sink = this.opts.sink;
    (sink.off ?? sink.removeListener)?.call(sink, "drain", this.drainListener);
  }
}
