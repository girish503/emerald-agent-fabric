/**
 * Self-Hosted Langfuse HTTP Ingestion Client for Emerald Agent Fabric (Phase 3).
 *
 * Security & Authority Invariants:
 * 1. Strictly Self-Hosted: Rejects proprietary/cloud Langfuse SaaS URLs fail-closed.
 * 2. Zero Authority: Langfuse traces/scores NEVER approve tasks, certify models,
 *    authorize connectors, or alter recovery/verification state.
 * 3. Pre-Export Redaction: All prompts, inputs, outputs, errors, and metadata pass through
 *    `sanitizeTelemetryValue` before buffering or HTTP export.
 * 4. Bounded & Fail-Safe: Bounded ring queue with drop-oldest eviction, AbortSignal timeouts,
 *    and non-blocking failure isolation.
 */

import * as crypto from "node:crypto";
import type { LangfuseTelemetryPort } from "../../ports/observability.port.js";
import { sanitizeTelemetryString, sanitizeTelemetryValue } from "./telemetry-redaction.js";

export interface LangfuseGenerationEventInput {
  readonly id: string;
  readonly traceId: string;
  readonly parentObservationId?: string;
  readonly name: string;
  readonly model: string;
  readonly promptName?: string;
  readonly promptVersion?: number;
  readonly modelParameters?: Record<string, unknown>;
  readonly input: unknown;
  readonly output: unknown;
  readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number };
  readonly startTime: string;
  readonly endTime: string;
  readonly level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  readonly statusMessage?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface LangfuseTraceCreateInput {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: string;
}

export interface LangfuseScoreInput {
  readonly id?: string;
  readonly traceId: string;
  readonly observationId?: string;
  readonly name: string;
  readonly value: number | string;
  readonly comment?: string;
}

export interface LangfuseSpanInput {
  readonly id: string;
  readonly traceId: string;
  readonly parentObservationId?: string;
  readonly name: string;
  readonly startTime: string;
  readonly endTime?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  readonly statusMessage?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface LangfuseClientConfig {
  readonly baseUrl?: string;
  readonly publicKey?: string;
  readonly secretKey?: string;
  readonly maxQueueEvents?: number;
  readonly maxBatchSize?: number;
  readonly exportTimeoutMs?: number;
  readonly retentionDays?: number;
  readonly enabled?: boolean;
}

export interface LangfuseHealthStatus {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly queuedEvents: number;
  readonly exportedEvents: number;
  readonly droppedEvents: number;
  readonly exportFailures: number;
  readonly lastExportError?: string;
  readonly retentionDays: number;
}

export class LangfuseConfigurationError extends Error {
  constructor(message: string) {
    super(`Langfuse configuration rejected: ${message}`);
    this.name = "LangfuseConfigurationError";
  }
}

const FORBIDDEN_CLOUD_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)langfuse\.[a-z.]+$/i,
  /(^|\.)openai\.com$/i,
  /(^|\.)anthropic\.com$/i,
  /(^|\.)googleapis\.com$/i,
];

export function assertSelfHostedLangfuseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new LangfuseConfigurationError(`Invalid URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LangfuseConfigurationError(`Unsupported protocol '${parsed.protocol}'; expected http: or https:`);
  }
  if (parsed.username || parsed.password) {
    throw new LangfuseConfigurationError("Embedded credentials in Langfuse URL are strictly prohibited");
  }
  const host = parsed.hostname.toLowerCase();
  for (const pattern of FORBIDDEN_CLOUD_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new LangfuseConfigurationError(
        `Cloud-hosted endpoint '${host}' is strictly prohibited; only self-hosted endpoints are permitted`
      );
    }
  }
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new LangfuseConfigurationError(
      `Unencrypted http:// Langfuse endpoint rejected for non-loopback host '${host}'; use https:// or loopback`
    );
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${normalizedPath}`;
}

export class SelfHostedLangfuseClient implements LangfuseTelemetryPort {
  private readonly baseUrl?: string;
  private readonly publicKey?: string;
  private readonly secretKey?: string;
  private readonly enabled: boolean;
  private readonly maxQueueEvents: number;
  private readonly maxBatchSize: number;
  private readonly exportTimeoutMs: number;
  private readonly retentionDays: number;
  private readonly queue: Array<Record<string, unknown>> = [];

  private exportedEvents = 0;
  private droppedEvents = 0;
  private exportFailures = 0;
  private lastExportError?: string;
  private activeFlush: Promise<void> | null = null;

  constructor(config: LangfuseClientConfig = {}) {
    if (config.baseUrl !== undefined && config.baseUrl.trim().length > 0) {
      this.baseUrl = assertSelfHostedLangfuseUrl(config.baseUrl.trim());
    }
    this.publicKey = config.publicKey?.trim() || undefined;
    this.secretKey = config.secretKey?.trim() || undefined;
    this.enabled = config.enabled ?? Boolean(this.baseUrl);
    this.maxQueueEvents =
      config.maxQueueEvents !== undefined && Number.isFinite(config.maxQueueEvents)
        ? Math.max(10, Math.floor(config.maxQueueEvents))
        : 512;
    this.maxBatchSize =
      config.maxBatchSize !== undefined && Number.isFinite(config.maxBatchSize)
        ? Math.max(1, Math.floor(config.maxBatchSize))
        : 64;
    this.exportTimeoutMs =
      config.exportTimeoutMs !== undefined && Number.isFinite(config.exportTimeoutMs)
        ? Math.max(100, Math.floor(config.exportTimeoutMs))
        : 2000;
    this.retentionDays =
      config.retentionDays !== undefined && Number.isFinite(config.retentionDays)
        ? Math.max(1, Math.floor(config.retentionDays))
        : 14;
  }

  /**
   * Formats a sanitized Langfuse generation body compatible with `/api/public/ingestion`.
   */
  public formatGenerationBody(trace: LangfuseGenerationEventInput): Record<string, unknown> {
    const redactedInput = sanitizeTelemetryValue(trace.input, { maxStringChars: 512 });
    const redactedOutput = sanitizeTelemetryValue(trace.output, { maxStringChars: 512 });
    const redactedMeta = sanitizeTelemetryValue(trace.metadata ?? {}, { maxStringChars: 256 }) as Record<
      string,
      unknown
    >;

    return {
      id: sanitizeTelemetryString(trace.id, 128),
      traceId: sanitizeTelemetryString(trace.traceId, 128),
      parentObservationId: trace.parentObservationId
        ? sanitizeTelemetryString(trace.parentObservationId, 128)
        : undefined,
      name: sanitizeTelemetryString(trace.name, 128),
      type: "GENERATION",
      model: sanitizeTelemetryString(trace.model, 128),
      promptName: trace.promptName ? sanitizeTelemetryString(trace.promptName, 128) : undefined,
      promptVersion: trace.promptVersion,
      modelParameters: sanitizeTelemetryValue(trace.modelParameters ?? {}, { maxStringChars: 128 }),
      input: redactedInput,
      output: redactedOutput,
      usage: trace.usage ?? {},
      startTime: trace.startTime,
      endTime: trace.endTime,
      level: trace.level ?? "DEFAULT",
      statusMessage: trace.statusMessage ? sanitizeTelemetryString(trace.statusMessage, 256) : undefined,
      metadata: {
        ...redactedMeta,
        framework: "emerald-agent-fabric",
        telemetryVersion: "1.0.0",
        zeroAuthority: true,
      },
    };
  }

  public enqueueTrace(input: LangfuseTraceCreateInput): void {
    try {
      if (!this.enabled) return;
      this.pushEvent({
        id: crypto.randomUUID(),
        type: "trace-create",
        timestamp: input.timestamp ?? new Date().toISOString(),
        body: {
          id: sanitizeTelemetryString(input.id, 128),
          name: sanitizeTelemetryString(input.name, 128),
          tags: input.tags?.slice(0, 16).map((t) => sanitizeTelemetryString(t, 64)),
          metadata: sanitizeTelemetryValue(input.metadata ?? {}, { maxStringChars: 256 }),
        },
      });
    } catch {
      // Fail-safe isolation
    }
  }

  public enqueueGeneration(trace: LangfuseGenerationEventInput): void {
    try {
      if (!this.enabled) return;
      this.pushEvent({
        id: crypto.randomUUID(),
        type: "generation-create",
        timestamp: trace.endTime,
        body: this.formatGenerationBody(trace),
      });
    } catch {
      // Fail-safe isolation
    }
  }

  public enqueueSpan(span: LangfuseSpanInput): void {
    try {
      if (!this.enabled) return;
      const redactedMeta = sanitizeTelemetryValue(span.metadata ?? {}, { maxStringChars: 256 }) as Record<
        string,
        unknown
      >;
      this.pushEvent({
        id: crypto.randomUUID(),
        type: "span-create",
        timestamp: span.endTime ?? span.startTime,
        body: {
          id: sanitizeTelemetryString(span.id, 128),
          traceId: sanitizeTelemetryString(span.traceId, 128),
          parentObservationId: span.parentObservationId
            ? sanitizeTelemetryString(span.parentObservationId, 128)
            : undefined,
          name: sanitizeTelemetryString(span.name, 128),
          startTime: span.startTime,
          endTime: span.endTime,
          input: span.input !== undefined ? sanitizeTelemetryValue(span.input, { maxStringChars: 256 }) : undefined,
          output: span.output !== undefined ? sanitizeTelemetryValue(span.output, { maxStringChars: 256 }) : undefined,
          level: span.level ?? "DEFAULT",
          statusMessage: span.statusMessage ? sanitizeTelemetryString(span.statusMessage, 256) : undefined,
          metadata: {
            ...redactedMeta,
            framework: "emerald-agent-fabric",
            telemetryVersion: "1.0.0",
            zeroAuthority: true,
          },
        },
      });
    } catch {
      // Fail-safe isolation
    }
  }

  public enqueueScore(score: LangfuseScoreInput): void {
    try {
      if (!this.enabled) return;
      this.pushEvent({
        id: crypto.randomUUID(),
        type: "score-create",
        timestamp: new Date().toISOString(),
        body: {
          id: score.id ? sanitizeTelemetryString(score.id, 128) : crypto.randomUUID(),
          traceId: sanitizeTelemetryString(score.traceId, 128),
          observationId: score.observationId ? sanitizeTelemetryString(score.observationId, 128) : undefined,
          name: sanitizeTelemetryString(score.name, 128),
          value: typeof score.value === "number" ? score.value : sanitizeTelemetryString(String(score.value), 64),
          comment: score.comment ? sanitizeTelemetryString(score.comment, 256) : undefined,
        },
      });
    } catch {
      // Fail-safe isolation
    }
  }

  public async flush(timeoutMs: number = this.exportTimeoutMs): Promise<void> {
    if (!this.enabled || !this.baseUrl || this.queue.length === 0) {
      return;
    }
    if (this.activeFlush) {
      await this.activeFlush;
      return;
    }

    const totalBudgetMs = Math.max(50, timeoutMs);
    const deadlineMs = Date.now() + totalBudgetMs;

    this.activeFlush = (async () => {
      while (this.queue.length > 0) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          this.exportFailures++;
          this.lastExportError = `Flush deadline exceeded after ${totalBudgetMs}ms`;
          return;
        }
        const batch = this.queue.slice(0, this.maxBatchSize);
        const url = `${this.baseUrl}/api/public/ingestion`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (this.publicKey && this.secretKey) {
          const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`, "utf8").toString("base64");
          headers["Authorization"] = `Basic ${auth}`;
        }

        try {
          const effectiveTimeout = Math.max(25, Math.min(this.exportTimeoutMs, remainingMs));
          const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ batch }),
            signal: AbortSignal.timeout(effectiveTimeout),
          });
          if (!res.ok) {
            this.exportFailures++;
            this.lastExportError = `HTTP ${res.status}`;
            // Drop failed batch after failure to protect bounded memory
            this.queue.splice(0, batch.length);
            this.droppedEvents += batch.length;
            return;
          }
          this.queue.splice(0, batch.length);
          this.exportedEvents += batch.length;
          this.lastExportError = undefined;
        } catch (err) {
          this.exportFailures++;
          this.lastExportError = sanitizeTelemetryString(err instanceof Error ? err.message : String(err), 128);
          this.queue.splice(0, batch.length);
          this.droppedEvents += batch.length;
          return;
        }
      }
    })();

    try {
      await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  public getHealth(): LangfuseHealthStatus {
    return {
      configured: Boolean(this.baseUrl),
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      queuedEvents: this.queue.length,
      exportedEvents: this.exportedEvents,
      droppedEvents: this.droppedEvents,
      exportFailures: this.exportFailures,
      lastExportError: this.lastExportError,
      retentionDays: this.retentionDays,
    };
  }

  private pushEvent(event: Record<string, unknown>): void {
    if (this.queue.length >= this.maxQueueEvents) {
      this.queue.shift();
      this.droppedEvents++;
    }
    this.queue.push(event);
  }
}
