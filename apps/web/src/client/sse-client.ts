/**
 * Emerald Agent Fabric — Typed Fetch-Based SSE Client (Milestone 2.27 / Phase 3)
 *
 * Implements an authenticated, durable, reconnectable Server-Sent Events client:
 * 1. Authenticated fetch streaming (Bearer token injection via token provider).
 * 2. Streaming response-body consumption with zero token leakage in URLs or logs.
 * 3. Robust SSE framing parser supporting:
 *    - CRLF (\r\n), LF (\n), and CR (\r) line endings
 *    - Multiple events per network chunk
 *    - Events split across multiple network chunks
 *    - Comment lines and keepalive pings (: ping\n\n)
 *    - Event IDs, retry fields, and custom event names
 * 4. Cursor tracking & replay:
 *    - Maintains authoritative last accepted sequence
 *    - Transmits Last-Event-ID header on reconnect
 *    - Ignores duplicate events (seq <= lastAccepted)
 *    - Detects sequence gaps (seq > lastAccepted + 1)
 *    - Cursor never advances on malformed or control events
 * 5. Bounded exponential backoff with jitter and server-guided Retry-After support.
 * 6. Transport control event handling (stream.overflow, stream.error).
 * 7. AbortSignal-based cancellation and deterministic resource cleanup.
 */

import {
  SseEventEnvelopeSchema,
  type SseEventEnvelope,
  type StreamOverflowPayloadSchema,
  type StreamErrorPayloadSchema,
  SSE_TERMINAL_EVENT_TYPES,
  SSE_CONTROL_EVENT_TYPES,
} from "../types/api.js";
import { type z } from "zod";

export type StreamOverflowPayload = z.infer<typeof StreamOverflowPayloadSchema>;
export type StreamErrorPayload = z.infer<typeof StreamErrorPayloadSchema>;

export type SseConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "unavailable";

export interface SseRawFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
  readonly retry?: number;
}

/**
 * Pure SSE line and frame parser.
 * Accumulates streaming text chunks and yields complete parsed SSE frames.
 */
export class SseLineParser {
  private buffer = "";
  private currentEvent: string | undefined;
  private currentData: string[] = [];
  private currentId: string | undefined;
  private currentRetry: number | undefined;

  /**
   * Feeds a text chunk into the parser and returns any complete frames.
   */
  feed(chunk: string): SseRawFrame[] {
    this.buffer += chunk;
    const frames: SseRawFrame[] = [];

    while (this.buffer.length > 0) {
      const lineEnd = this.findLineEnd(this.buffer);
      if (lineEnd === -1) {
        break; // Incomplete line, await next chunk
      }

      const line = this.buffer.slice(0, lineEnd);
      const delimLen = this.getDelimiterLength(this.buffer, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + delimLen);

      if (line.length === 0) {
        // Empty line indicates end of an event frame
        if (
          this.currentData.length > 0 ||
          this.currentEvent !== undefined ||
          this.currentId !== undefined
        ) {
          frames.push({
            id: this.currentId,
            event: this.currentEvent || "message",
            data: this.currentData.join("\n"),
            retry: this.currentRetry,
          });
          this.currentEvent = undefined;
          this.currentData = [];
          this.currentId = undefined;
          this.currentRetry = undefined;
        }
      } else if (line.startsWith(":")) {
        // Comment or heartbeat line (: ping), ignore content per SSE spec
      } else {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
          this.processField(line, "");
        } else {
          const field = line.slice(0, colonIdx);
          let value = line.slice(colonIdx + 1);
          if (value.startsWith(" ")) {
            value = value.slice(1);
          }
          this.processField(field, value);
        }
      }
    }

    return frames;
  }

  /**
   * Flushes any remaining frame when the stream closes.
   */
  flush(): SseRawFrame[] {
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      if (!line.startsWith(":")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
          this.processField(line, "");
        } else {
          const field = line.slice(0, colonIdx);
          let value = line.slice(colonIdx + 1);
          if (value.startsWith(" ")) {
            value = value.slice(1);
          }
          this.processField(field, value);
        }
      }
    }

    const frames: SseRawFrame[] = [];
    if (
      this.currentData.length > 0 ||
      this.currentEvent !== undefined ||
      this.currentId !== undefined
    ) {
      frames.push({
        id: this.currentId,
        event: this.currentEvent || "message",
        data: this.currentData.join("\n"),
        retry: this.currentRetry,
      });
    }
    this.reset();
    return frames;
  }

  private processField(name: string, value: string): void {
    switch (name) {
      case "event":
        this.currentEvent = value;
        break;
      case "data":
        this.currentData.push(value);
        break;
      case "id":
        if (!value.includes("\0")) {
          this.currentId = value;
        }
        break;
      case "retry": {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.currentRetry = parsed;
        }
        break;
      }
      default:
        // Ignore unrecognized fields
        break;
    }
  }

  private findLineEnd(str: string): number {
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "\n" || str[i] === "\r") return i;
    }
    return -1;
  }

  private getDelimiterLength(str: string, idx: number): number {
    if (str[idx] === "\r" && str[idx + 1] === "\n") return 2;
    return 1;
  }

  reset(): void {
    this.buffer = "";
    this.currentEvent = undefined;
    this.currentData = [];
    this.currentId = undefined;
    this.currentRetry = undefined;
  }
}

export interface SseClientConfig {
  /** Base URL of the backend (e.g. "http://127.0.0.1:3000") */
  readonly baseUrl: string;
  /** Run ID to stream events for */
  readonly runId: string;
  /** Token provider function or static token string */
  readonly token?: string | (() => Promise<string | null | undefined> | string | null | undefined);
  /** Custom fetch implementation (useful for tests and environments) */
  readonly fetch?: typeof globalThis.fetch;
  /** Initial Last-Event-ID cursor sequence (defaults to 0) */
  readonly initialCursor?: number;
  /** Maximum number of reconnect retries before transitioning to unavailable (defaults to 10) */
  readonly maxRetries?: number;
  /** Minimum reconnect delay in ms (defaults to 1000) */
  readonly initialRetryDelayMs?: number;
  /** Maximum reconnect delay in ms (defaults to 30000) */
  readonly maxRetryDelayMs?: number;
  /** Jitter factor (0-1, defaults to 0.3) */
  readonly jitterFactor?: number;
  /** Callback on valid durable event envelope received */
  readonly onEvent?: (envelope: SseEventEnvelope) => void;
  /** Callback on sequence gap detected (lastAccepted vs received sequence) */
  readonly onGap?: (lastAccepted: number, received: number) => void;
  /** Callback on connection status change */
  readonly onStatusChange?: (status: SseConnectionStatus, error?: Error) => void;
  /** Callback on transport control event (stream.overflow or stream.error) */
  readonly onControlEvent?: (eventType: string, payload: unknown) => void;
  /** Callback when stream ends following an authoritative terminal run event */
  readonly onTerminal?: () => void;
  /** Callback on non-fatal error */
  readonly onError?: (error: Error) => void;
}

/**
 * Consumes streaming response body across Web Streams, Node async iterables, or text fallbacks.
 */
async function* consumeResponseBody(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (text) yield text;
    return;
  }

  // 1. Web ReadableStream (standard browser & Node 18+)
  if (typeof (body as any).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder("utf-8");
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          yield decoder.decode(value, { stream: true });
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Reader already closed
      }
    }
    return;
  }

  // 2. Node.js stream / AsyncIterable fallback
  if (Symbol.asyncIterator in Object(body)) {
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of (body as unknown as AsyncIterable<any>)) {
      if (signal.aborted) break;
      if (typeof chunk === "string") {
        yield chunk;
      } else if (chunk instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk))) {
        yield decoder.decode(chunk, { stream: true });
      }
    }
    return;
  }

  // 3. Fallback to full text read
  const text = await response.text();
  if (text) yield text;
}

export class EmeraldSseClient {
  private readonly baseUrl: string;
  private readonly runId: string;
  private readonly tokenProvider?: () => Promise<string | null | undefined> | string | null | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly config: SseClientConfig;

  private lastSequence: number;
  private status: SseConnectionStatus = "idle";
  private retries = 0;
  private maxRetries: number;
  private initialRetryDelayMs: number;
  private maxRetryDelayMs: number;
  private jitterFactor: number;
  private serverRetryDelayMs?: number;

  private abortController = new AbortController();
  private reconnectTimer: NodeJS.Timeout | number | undefined;
  private isConnecting = false;
  private isAborted = false;
  private isTerminalState = false;

  constructor(config: SseClientConfig) {
    if (!config || !config.baseUrl) {
      throw new Error("EmeraldSseClient requires a valid baseUrl");
    }
    if (!config.runId || config.runId.trim().length === 0) {
      throw new Error("EmeraldSseClient requires a non-empty runId");
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.runId = config.runId.trim();
    this.config = config;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.lastSequence = Math.max(0, config.initialCursor ?? 0);

    this.maxRetries = config.maxRetries ?? 10;
    this.initialRetryDelayMs = config.initialRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? 30000;
    this.jitterFactor = config.jitterFactor ?? 0.3;

    if (typeof config.token === "function") {
      this.tokenProvider = config.token;
    } else if (typeof config.token === "string") {
      const staticToken = config.token;
      this.tokenProvider = () => staticToken;
    }
  }

  /**
   * Retrieves Bearer token, if configured.
   */
  private async getToken(): Promise<string | null> {
    if (!this.tokenProvider) return null;
    try {
      const res = await this.tokenProvider();
      return typeof res === "string" && res.trim().length > 0 ? res.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Current connection status.
   */
  getStatus(): SseConnectionStatus {
    return this.status;
  }

  /**
   * Authoritative last accepted sequence number cursor.
   */
  getLastSequence(): number {
    return this.lastSequence;
  }

  /**
   * Returns true if stream completed following an authoritative terminal event.
   */
  isTerminal(): boolean {
    return this.isTerminalState;
  }

  /**
   * Returns true if currently connected.
   */
  isConnected(): boolean {
    return this.status === "connected";
  }

  /**
   * Initiates the SSE streaming connection.
   */
  async connect(): Promise<void> {
    if (this.isAborted || this.isTerminalState) return;
    if (this.isConnecting || this.status === "connected") return;

    this.isConnecting = true;
    this.clearReconnectTimer();

    const newStatus: SseConnectionStatus = this.retries > 0 ? "reconnecting" : "connecting";
    this.updateStatus(newStatus);

    const endpoint = `${this.baseUrl}/api/v1/runs/${encodeURIComponent(this.runId)}/events`;
    const parser = new SseLineParser();

    try {
      const token = await this.getToken();
      if (this.isAborted) return;

      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      // Transmit Last-Event-ID if we have a positive cursor sequence
      if (this.lastSequence > 0) {
        headers["Last-Event-ID"] = String(this.lastSequence);
      }

      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers,
        signal: this.abortController.signal,
      });

      if (this.isAborted) return;

      if (!response.ok) {
        const statusCode = response.status;
        this.isConnecting = false;

        // Permanent authorization failures: stop retrying
        if (statusCode === 401 || statusCode === 403) {
          const authErr = new Error(`SSE authentication failed with HTTP ${statusCode}`);
          this.updateStatus("error", authErr);
          this.config.onError?.(authErr);
          return;
        }

        // Run not found: stop retrying
        if (statusCode === 404) {
          const notFoundErr = new Error(`Run '${this.runId}' not found`);
          this.updateStatus("error", notFoundErr);
          this.config.onError?.(notFoundErr);
          return;
        }

        // Rate limit: parse Retry-After
        if (statusCode === 429) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            const sec = parseInt(retryAfter, 10);
            if (!isNaN(sec) && sec > 0) {
              this.serverRetryDelayMs = sec * 1000;
            }
          }
        }

        const serverErr = new Error(`SSE endpoint returned HTTP ${statusCode}`);
        this.handleFailure(serverErr);
        return;
      }

      // Successful connection established
      this.retries = 0;
      this.isConnecting = false;
      this.updateStatus("connected");

      // Consume stream body
      for await (const chunk of consumeResponseBody(response, this.abortController.signal)) {
        if (this.isAborted) break;
        const frames = parser.feed(chunk);
        for (const frame of frames) {
          this.processFrame(frame);
        }
      }

      // Flush any trailing frame
      const remaining = parser.flush();
      for (const frame of remaining) {
        this.processFrame(frame);
      }

      // Stream closed
      if (!this.isAborted && !this.isTerminalState) {
        // Non-terminal closure from server: attempt reconnection with cursor
        this.handleFailure(new Error("SSE stream closed by server"));
      }
    } catch (err) {
      this.isConnecting = false;
      if (this.isAborted) return;

      const error = err instanceof Error ? err : new Error(String(err));
      this.handleFailure(error);
    }
  }

  /**
   * Processes a single parsed SSE frame.
   */
  private processFrame(frame: SseRawFrame): void {
    if (frame.retry !== undefined) {
      this.serverRetryDelayMs = frame.retry;
    }

    // 1. Control events: stream.overflow or stream.error
    if (
      frame.event === "stream.overflow" ||
      frame.event === "stream.error" ||
      (frame.event && (SSE_CONTROL_EVENT_TYPES as readonly string[]).includes(frame.event))
    ) {
      let parsedPayload: unknown = frame.data;
      try {
        parsedPayload = JSON.parse(frame.data);
      } catch {
        // Keep raw text if not JSON
      }
      this.config.onControlEvent?.(frame.event, parsedPayload);
      // Control events never carry an id and never advance the cursor
      return;
    }

    if (!frame.data || frame.data.trim().length === 0) {
      return; // Keepalive/empty frame
    }

    // 2. Parse durable event envelope
    let json: unknown;
    try {
      json = JSON.parse(frame.data);
    } catch (err) {
      this.config.onError?.(new Error(`Failed to parse SSE JSON payload: ${(err as Error).message}`));
      return; // Malformed JSON: discard without advancing cursor
    }

    const validation = SseEventEnvelopeSchema.safeParse(json);
    if (!validation.success) {
      this.config.onError?.(new Error("SSE event payload failed contract envelope validation"));
      return; // Contract violation: discard without advancing cursor
    }

    const envelope = validation.data;

    // 3. Deduplication check
    if (envelope.sequence <= this.lastSequence) {
      return; // Duplicate event, safely ignore
    }

    // 4. Sequence gap detection
    if (this.lastSequence > 0 && envelope.sequence > this.lastSequence + 1) {
      this.config.onGap?.(this.lastSequence, envelope.sequence);
    }

    // 5. Advance authoritative cursor
    this.lastSequence = envelope.sequence;

    // 6. Dispatch event to caller
    this.config.onEvent?.(envelope);

    // 7. Terminal event detection
    if ((SSE_TERMINAL_EVENT_TYPES as readonly string[]).includes(envelope.event)) {
      this.isTerminalState = true;
      this.config.onTerminal?.();
      this.abort(); // Close stream after receiving terminal event
    }
  }

  /**
   * Handles stream failure and schedules reconnect with backoff.
   */
  private handleFailure(error: Error): void {
    if (this.isAborted || this.isTerminalState) return;

    this.retries++;
    if (this.retries > this.maxRetries) {
      this.updateStatus("unavailable", new Error(`Exceeded maximum SSE reconnection attempts (${this.maxRetries})`));
      this.config.onError?.(error);
      return;
    }

    const delayMs = this.calculateDelay();
    this.updateStatus("reconnecting", error);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.isAborted && !this.isTerminalState) {
        void this.connect();
      }
    }, delayMs);
  }

  /**
   * Calculates exponential backoff delay with jitter.
   */
  private calculateDelay(): number {
    if (this.serverRetryDelayMs !== undefined) {
      const delay = this.serverRetryDelayMs;
      this.serverRetryDelayMs = undefined;
      return delay;
    }

    const exponent = Math.min(this.retries - 1, 6);
    const base = this.initialRetryDelayMs * Math.pow(1.5, exponent);
    const capped = Math.min(base, this.maxRetryDelayMs);
    const jitterRange = capped * this.jitterFactor;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(50, Math.round(capped + jitter));
  }

  private updateStatus(newStatus: SseConnectionStatus, error?: Error): void {
    this.status = newStatus;
    this.config.onStatusChange?.(newStatus, error);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer as any);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Aborts active stream connection and clears any pending reconnect attempts.
   */
  abort(): void {
    this.isAborted = true;
    this.clearReconnectTimer();
    this.abortController.abort();
    this.isConnecting = false;
    if (this.status !== "error" && this.status !== "unavailable") {
      this.updateStatus("idle");
    }
  }
}
