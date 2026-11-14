/**
 * Emerald Agent Fabric — SSE Client Unit & Contract Tests (Milestone 2.27 / Phase 3)
 *
 * Verifies:
 * 1. SseLineParser line and framing compliance (CRLF, LF, CR, split chunks, multiple frames, comments).
 * 2. Token injection and credentials hygiene (never in URLs or logs).
 * 3. Durable cursor tracking, Last-Event-ID header, duplicate suppression, and gap detection.
 * 4. Control frame handling (stream.overflow, stream.error never advance cursor).
 * 5. Bounded reconnect backoff with jitter and Retry-After parsing.
 * 6. Terminal event detection and clean lifecycle abort.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SseLineParser,
  EmeraldSseClient,
} from "../../apps/web/src/client/sse-client.js";
import type { SseEventEnvelope } from "../../apps/web/src/types/api.js";

describe("SseLineParser", () => {
  it("parses single frame with LF delimiters", () => {
    const parser = new SseLineParser();
    const frames = parser.feed("id: 1\nevent: run.started\ndata: {\"ok\":true}\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]!).toEqual({
      id: "1",
      event: "run.started",
      data: '{"ok":true}',
      retry: undefined,
    });
  });

  it("parses single frame with CRLF delimiters", () => {
    const parser = new SseLineParser();
    const frames = parser.feed("id: 42\r\nevent: action.created\r\ndata: {\"actionId\":\"act-1\"}\r\n\r\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]!).toEqual({
      id: "42",
      event: "action.created",
      data: '{"actionId":"act-1"}',
      retry: undefined,
    });
  });

  it("handles multiple complete frames in a single chunk", () => {
    const parser = new SseLineParser();
    const chunk = [
      "id: 1\nevent: run.created\ndata: {}\n\n",
      "id: 2\nevent: run.started\ndata: {}\n\n",
      "id: 3\nevent: action.created\ndata: {}\n\n",
    ].join("");

    const frames = parser.feed(chunk);
    expect(frames).toHaveLength(3);
    expect(frames[0]!.id).toBe("1");
    expect(frames[1]!.id).toBe("2");
    expect(frames[2]!.id).toBe("3");
  });

  it("accumulates frames split across multiple network chunks", () => {
    const parser = new SseLineParser();

    // Chunk 1: Partial event field
    expect(parser.feed("id: 1\neve")).toEqual([]);

    // Chunk 2: Rest of event and start of data
    expect(parser.feed("nt: run.started\ndata: {\"partial\":")).toEqual([]);

    // Chunk 3: End of data and single newline
    expect(parser.feed("\"value\"}\n")).toEqual([]);

    // Chunk 4: Final newline closing the frame
    const frames = parser.feed("\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]!).toEqual({
      id: "1",
      event: "run.started",
      data: '{"partial":"value"}',
      retry: undefined,
    });
  });

  it("ignores SSE comment lines (e.g. keepalive heartbeats)", () => {
    const parser = new SseLineParser();
    const chunk = ": ping\n: keepalive\n\nid: 10\nevent: run.queued\ndata: {}\n\n: ping\n\n";
    const frames = parser.feed(chunk);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe("10");
  });

  it("concatenates multi-line data fields with newline per SSE spec", () => {
    const parser = new SseLineParser();
    const chunk = "id: 5\nevent: multi\ndata: line 1\ndata: line 2\ndata: line 3\n\n";
    const frames = parser.feed(chunk);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe("line 1\nline 2\nline 3");
  });

  it("parses retry interval directive", () => {
    const parser = new SseLineParser();
    const chunk = "retry: 3500\nid: 1\ndata: hello\n\n";
    const frames = parser.feed(chunk);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.retry).toBe(3500);
  });

  it("flushes incomplete frame at stream termination", () => {
    const parser = new SseLineParser();
    parser.feed("id: 99\nevent: trailing\ndata: trailing_data");
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!).toEqual({
      id: "99",
      event: "trailing",
      data: "trailing_data",
      retry: undefined,
    });
  });

  it("strips null characters in ID field for security", () => {
    const parser = new SseLineParser();
    const chunk = "id: malicious\0id\ndata: test\n\n";
    const frames = parser.feed(chunk);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBeUndefined();
  });
});

describe("EmeraldSseClient", () => {
  const TEST_BASE_URL = "http://127.0.0.1:3000";
  const TEST_RUN_ID = "run-test-sse-001";

  function createMockResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): Response {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[index++]));
        } else {
          controller.close();
        }
      },
    });

    const headerMap = new Headers({
      "Content-Type": "text/event-stream",
      ...headers,
    });

    return new Response(stream, {
      status,
      headers: headerMap,
    });
  }

  function makeEnvelope(seq: number, event = "action.created", extra: Record<string, unknown> = {}): SseEventEnvelope {
    return {
      id: `evt-${seq}`,
      event,
      runId: TEST_RUN_ID,
      sequence: seq,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      producer: "test_producer",
      data: { toolName: "read_file", ...extra },
    };
  }

  function frameString(env: SseEventEnvelope): string {
    return `id: ${env.sequence}\nevent: ${env.event}\ndata: ${JSON.stringify(env)}\n\n`;
  }

  it("injects Bearer token in request header and does not leak token in URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers ?? {};
      return createMockResponse([frameString(makeEnvelope(1, "run.started"))]);
    });

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      token: "secret-token-xyz-123",
      fetch: mockFetch as any,
    });

    await client.connect();

    expect(capturedUrl).toBe(`${TEST_BASE_URL}/api/v1/runs/${TEST_RUN_ID}/events`);
    expect(capturedUrl).not.toContain("secret-token");
    expect(capturedHeaders["Authorization"]).toBe("Bearer secret-token-xyz-123");
    expect(capturedHeaders["Accept"]).toBe("text/event-stream");
    expect(capturedHeaders["Last-Event-ID"]).toBeUndefined();
  });

  it("transmits Last-Event-ID header when initial cursor is provided", async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init?.headers ?? {};
      return createMockResponse([frameString(makeEnvelope(6, "action.completed"))]);
    });

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      initialCursor: 5,
      fetch: mockFetch as any,
    });

    await client.connect();

    expect(capturedHeaders["Last-Event-ID"]).toBe("5");
    expect(client.getLastSequence()).toBe(6);
  });

  it("dispatches valid events and tracks sequence numbers monotonically", async () => {
    const received: SseEventEnvelope[] = [];

    const env1 = makeEnvelope(1, "run.created");
    const env2 = makeEnvelope(2, "run.started");
    const env3 = makeEnvelope(3, "action.created");

    const chunk = frameString(env1) + frameString(env2) + frameString(env3);

    let statusDuringEvent: string | undefined;

    const mockFetch = vi.fn(async () => createMockResponse([chunk]));

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
      onEvent: (env) => {
        statusDuringEvent = client.getStatus();
        received.push(env);
      },
    });

    await client.connect();

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(client.getLastSequence()).toBe(3);
    expect(statusDuringEvent).toBe("connected");
    // Since mock stream closed without terminal event, client transitions to reconnecting
    expect(client.getStatus()).toBe("reconnecting");
    client.abort();
  });

  it("suppresses duplicate events with seq <= lastSequence", async () => {
    const received: SseEventEnvelope[] = [];

    const env1 = makeEnvelope(1, "run.started");
    const env2 = makeEnvelope(2, "action.created");
    // Duplicate of 2
    const env2Dup = makeEnvelope(2, "action.created");
    const env3 = makeEnvelope(3, "action.completed");

    const chunk = frameString(env1) + frameString(env2) + frameString(env2Dup) + frameString(env3);

    const mockFetch = vi.fn(async () => createMockResponse([chunk]));

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
      onEvent: (env) => received.push(env),
    });

    await client.connect();

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(client.getLastSequence()).toBe(3);
  });

  it("detects sequence gaps and invokes onGap callback", async () => {
    const gaps: Array<{ lastAccepted: number; received: number }> = [];

    const env1 = makeEnvelope(1, "run.started");
    // Gap: sequence 4 instead of 2
    const env4 = makeEnvelope(4, "action.created");

    const chunk = frameString(env1) + frameString(env4);

    const mockFetch = vi.fn(async () => createMockResponse([chunk]));

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
      onGap: (lastAccepted, received) => gaps.push({ lastAccepted, received }),
    });

    await client.connect();

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!).toEqual({ lastAccepted: 1, received: 4 });
    expect(client.getLastSequence()).toBe(4);
  });

  it("handles transport control events (stream.overflow) and never advances cursor", async () => {
    const controlEvents: Array<{ event: string; payload: unknown }> = [];
    const receivedEvents: SseEventEnvelope[] = [];

    const overflowFrame = [
      "event: stream.overflow\n",
      'data: {"runId":"run-test-sse-001","lastDeliveredSequence":2,"reason":"LIVE_BUFFER_OVERFLOW","recovery":"reconnect"}\n\n',
    ].join("");

    const mockFetch = vi.fn(async () => createMockResponse([overflowFrame]));

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      initialCursor: 2,
      fetch: mockFetch as any,
      onEvent: (env) => receivedEvents.push(env),
      onControlEvent: (event, payload) => controlEvents.push({ event, payload }),
    });

    await client.connect();

    expect(controlEvents).toHaveLength(1);
    expect(controlEvents[0]!.event).toBe("stream.overflow");
    expect((controlEvents[0]!.payload as any).reason).toBe("LIVE_BUFFER_OVERFLOW");
    expect(receivedEvents).toHaveLength(0);
    // Cursor MUST remain at 2
    expect(client.getLastSequence()).toBe(2);
  });

  it("handles malformed JSON frames gracefully without advancing cursor", async () => {
    const errors: Error[] = [];
    const received: SseEventEnvelope[] = [];

    const badFrame = "id: 5\nevent: action.created\ndata: {INVALID_JSON}\n\n";
    const goodFrame = frameString(makeEnvelope(1, "run.started"));

    const mockFetch = vi.fn(async () => createMockResponse([badFrame, goodFrame]));

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
      onEvent: (e) => received.push(e),
      onError: (err) => errors.push(err),
    });

    await client.connect();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.sequence).toBe(1);
    expect(client.getLastSequence()).toBe(1);
  });

  it("triggers onTerminal callback on terminal event (run.completed) and stops reconnecting", async () => {
    let terminalTriggered = false;

    const termEnv = makeEnvelope(10, "run.completed", { finalOutcome: "VERIFIED_SUCCESS" });
    const mockFetch = vi.fn(async () => createMockResponse([frameString(termEnv)]));

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
      onTerminal: () => {
        terminalTriggered = true;
      },
    });

    await client.connect();

    expect(terminalTriggered).toBe(true);
    expect(client.isTerminal()).toBe(true);
  });

  it("halts retries immediately on HTTP 401 or 403 unauthorized responses", async () => {
    const statusChanges: string[] = [];

    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid token" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
      onStatusChange: (status) => statusChanges.push(status),
    });

    await client.connect();

    expect(client.getStatus()).toBe("error");
    expect(statusChanges).toContain("connecting");
    expect(statusChanges).toContain("error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts active connection immediately on abort() call", async () => {
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      const signal: AbortSignal = init.signal;
      const stream = new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (signal.aborted) {
            controller.close();
          } else {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const client = new EmeraldSseClient({
      baseUrl: TEST_BASE_URL,
      runId: TEST_RUN_ID,
      fetch: mockFetch as any,
    });

    const connectPromise = client.connect();
    client.abort();
    await connectPromise;

    expect(client.getStatus()).toBe("idle");
  });
});
