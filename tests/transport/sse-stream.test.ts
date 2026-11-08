/**
 * SseSession unit tests: gap-safe, bounded delivery with explicit overflow signalling and backpressure.
 */
import { describe, expect, it } from "vitest";
import { SseSession, type SseEnvelope, type SseSink } from "../../src/transport/http/sse-stream.js";

class FakeSink implements SseSink {
  frames: string[] = [];
  ended = false;
  /** When true, write() reports a full buffer (backpressure) until drain() is called. */
  backpressure = false;
  writesWhilePressured = 0;
  private drainListeners: Array<() => void> = [];
  write(chunk: string): boolean {
    if (this.backpressure) this.writesWhilePressured++;
    this.frames.push(chunk);
    return !this.backpressure;
  }
  end(): void {
    this.ended = true;
  }
  once(_e: "drain", l: () => void): void {
    this.drainListeners.push(l);
  }
  off(_e: "drain", l: () => void): void {
    this.drainListeners = this.drainListeners.filter((x) => x !== l);
  }
  get drainListenerCount(): number {
    return this.drainListeners.length;
  }
  drain(): void {
    this.backpressure = false;
    const ls = this.drainListeners;
    this.drainListeners = [];
    ls.forEach((l) => l());
  }
  ids(): number[] {
    return this.frames.flatMap((f) => [...f.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])));
  }
  overflow(): { frame: string; payload: any } | undefined {
    const frame = this.frames.find((f) => f.includes("event: stream.overflow"));
    return frame ? { frame, payload: JSON.parse(frame.split("data: ")[1]!) } : undefined;
  }
}

const env = (sequence: number, event = "action.created"): SseEnvelope => ({
  id: `e${sequence}`, event, runId: "run-1", sequence, timestamp: "2026-11-07T00:00:00.000Z", schemaVersion: 1, producer: "t", data: {},
});

function session(sink: FakeSink, opts: Partial<{ cursor: number; max: number }> = {}) {
  let closedCount = 0;
  const s = new SseSession({
    sink,
    runId: "run-1",
    cursor: opts.cursor ?? 0,
    maxBufferedEvents: opts.max ?? 1000,
    terminalEventTypes: new Set(["run.completed", "run.failed", "run.cancelled", "run.timed_out"]),
    onClosed: () => closedCount++,
  });
  return { s, closed: () => closedCount };
}

describe("SseSession", () => {
  it("delivers replay then live events in strict sequence order and suppresses duplicates", () => {
    const sink = new FakeSink();
    const { s } = session(sink);
    s.replay([env(2), env(1), env(3)]); // out of order input is sorted
    s.offerLive(env(3)); // held during replay window, duplicate of replay
    s.offerLive(env(4));
    s.beginLive();
    s.offerLive(env(4)); // duplicate after start
    s.offerLive(env(5));
    expect(sink.ids()).toEqual([1, 2, 3, 4, 5]);
  });

  it("ends the stream after a terminal event", () => {
    const sink = new FakeSink();
    const { s, closed } = session(sink);
    s.replay([env(1)]);
    s.beginLive();
    s.offerLive(env(2, "run.completed"));
    s.offerLive(env(3)); // after terminal: ignored
    expect(sink.ids()).toEqual([1, 2]);
    expect(sink.ended).toBe(true);
    expect(closed()).toBe(1);
    expect(sink.overflow()).toBeUndefined();
  });

  it("overflow during the replay window delivers the contiguous held events, then stream.overflow without an id, then ends", () => {
    const sink = new FakeSink();
    const { s } = session(sink, { max: 3 });
    for (let n = 1; n <= 10; n++) s.offerLive(env(n)); // 1..3 held, 4 overflows, 5..10 ignored
    s.replay([]);
    s.beginLive();
    expect(sink.ids()).toEqual([1, 2, 3]);
    const o = sink.overflow()!;
    expect(o.payload).toMatchObject({ runId: "run-1", lastDeliveredSequence: 3, reason: "LIVE_BUFFER_OVERFLOW" });
    expect(o.frame).not.toMatch(/^id:/m);
    expect(sink.ended).toBe(true);
  });

  it("never advances the cursor over a sequence gap in live delivery", () => {
    const sink = new FakeSink();
    const { s } = session(sink);
    s.replay([env(1), env(2)]);
    s.beginLive();
    s.offerLive(env(3));
    s.offerLive(env(7)); // 4..6 unobserved
    s.offerLive(env(8)); // ignored: stream already closing
    expect(sink.ids()).toEqual([1, 2, 3]);
    expect(sink.overflow()!.payload).toMatchObject({ lastDeliveredSequence: 3, reason: "SEQUENCE_GAP" });
    expect(sink.ended).toBe(true);
  });

  it("treats a gap inside the durable replay itself as an overflow, not a silent skip", () => {
    const sink = new FakeSink();
    const { s } = session(sink);
    s.replay([env(1), env(2), env(5)]);
    s.beginLive();
    expect(sink.ids()).toEqual([1, 2]);
    expect(sink.overflow()!.payload.reason).toBe("SEQUENCE_GAP");
  });

  it("respects the resume cursor: events at or below it are never sent", () => {
    const sink = new FakeSink();
    const { s } = session(sink, { cursor: 3 });
    s.replay([env(1), env(2), env(3), env(4), env(5)]);
    s.beginLive();
    s.offerLive(env(5)); // duplicate
    s.offerLive(env(6));
    expect(sink.ids()).toEqual([4, 5, 6]);
  });

  it("applies backpressure: no writes while the socket is full, bounded queue, overflow after drain", () => {
    const sink = new FakeSink();
    const { s } = session(sink, { max: 3 });
    s.replay([]);
    s.beginLive();
    sink.backpressure = true;
    s.offerLive(env(1)); // written, socket reports full
    for (let n = 2; n <= 10; n++) s.offerLive(env(n)); // 2..4 queue (cap 3); 5 overflows; rest ignored
    expect(sink.writesWhilePressured).toBe(1); // exactly one write was issued while pressured
    expect(sink.ids()).toEqual([1]);
    expect(sink.ended).toBe(false);

    sink.drain();
    expect(sink.ids()).toEqual([1, 2, 3, 4]); // queued events flushed in order, contiguous
    const o = sink.overflow()!;
    expect(o.payload).toMatchObject({ lastDeliveredSequence: 4, reason: "SLOW_CLIENT_BACKPRESSURE" });
    expect(sink.ended).toBe(true);
  });

  it("close() is idempotent, removes its drain listener and reports closure once", () => {
    const sink = new FakeSink();
    const { s, closed } = session(sink);
    s.replay([]);
    s.beginLive();
    sink.backpressure = true;
    s.offerLive(env(1));
    expect(sink.drainListenerCount).toBe(1);
    s.close();
    s.close();
    expect(sink.drainListenerCount).toBe(0);
    expect(closed()).toBe(1);
    s.offerLive(env(2));
    expect(sink.ids()).toEqual([1]);
  });

  it("endWhenDrained ends an already-terminal run after replay without an overflow notice", () => {
    const sink = new FakeSink();
    const { s } = session(sink);
    s.replay([env(1), env(2)]);
    s.beginLive();
    s.endWhenDrained();
    expect(sink.ids()).toEqual([1, 2]);
    expect(sink.ended).toBe(true);
    expect(sink.overflow()).toBeUndefined();
  });
});
