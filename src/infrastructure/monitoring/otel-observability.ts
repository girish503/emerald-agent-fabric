/**
 * Vendor-Neutral OpenTelemetry-Compatible Observability Adapter (Phase 3).
 *
 * Implements W3C Trace Context propagation, AsyncLocalStorage correlation across async steps,
 * pre-export credential/secret redaction, deterministic head sampling, bounded ring buffers,
 * OTLP HTTP/JSON batch export, and failure isolation so telemetry NEVER blocks or crashes tasks.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import type {
  MetricLabels,
  ObservabilityConfig,
  ObservabilityCorrelation,
  ObservabilityPipelineHealth,
  ObservabilityPort,
  StartSpanOptions,
  StructuredLogRecord,
  TelemetryAttributeValue,
  TelemetryBatchExporter,
  TelemetrySpanKind,
  TelemetrySpanRecord,
} from "../../ports/observability.port.js";

function otlpSpanKindNumber(kind: TelemetrySpanKind): number {
  switch (kind) {
    case "SERVER":
      return 2;
    case "CLIENT":
      return 3;
    case "PRODUCER":
      return 4;
    case "CONSUMER":
      return 5;
    case "INTERNAL":
    default:
      return 1;
  }
}

function isStartSpanOptions(
  input: Partial<ObservabilityCorrelation> | StartSpanOptions
): input is StartSpanOptions {
  return "kind" in input || "correlation" in input;
}
import { BoundedPrometheusRegistry } from "./prometheus-registry.js";
import {
  sanitizeTelemetryAttributes,
  sanitizeTelemetryString,
  sanitizeTelemetryValue,
} from "./telemetry-redaction.js";

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE = "00000000000000000000000000000000";
const ALL_ZERO_SPAN = "0000000000000000";

export class ObservabilityConfigurationError extends Error {
  constructor(message: string) {
    super(`Observability configuration rejected: ${message}`);
    this.name = "ObservabilityConfigurationError";
  }
}

export interface ParsedTraceparent {
  readonly version: string;
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly sampled: boolean;
}

export function generateTraceId(): string {
  let id = crypto.randomBytes(16).toString("hex");
  if (id === ALL_ZERO_TRACE) {
    id = crypto.randomBytes(16).toString("hex");
  }
  return id;
}

export function generateSpanId(): string {
  let id = crypto.randomBytes(8).toString("hex");
  if (id === ALL_ZERO_SPAN) {
    id = crypto.randomBytes(8).toString("hex");
  }
  return id;
}

export function parseTraceparent(headerValue: string | undefined): ParsedTraceparent | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim().toLowerCase();
  const match = TRACEPARENT_REGEX.exec(trimmed);
  if (!match) return undefined;
  const [, version, traceId, parentSpanId, flagsHex] = match;
  if (!version || !traceId || !parentSpanId || !flagsHex) return undefined;
  if (version === "ff" || traceId === ALL_ZERO_TRACE || parentSpanId === ALL_ZERO_SPAN) {
    return undefined;
  }
  const flags = parseInt(flagsHex, 16);
  return {
    version,
    traceId,
    parentSpanId,
    sampled: (flags & 0x01) === 0x01,
  };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean = true): string {
  const cleanTrace = /^[0-9a-f]{32}$/i.test(traceId) ? traceId.toLowerCase() : generateTraceId();
  const cleanSpan = /^[0-9a-f]{16}$/i.test(spanId) ? spanId.toLowerCase() : generateSpanId();
  const flags = sampled ? "01" : "00";
  return `00-${cleanTrace}-${cleanSpan}-${flags}`;
}

export function validateObservabilityConfig(config: ObservabilityConfig = {}): {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly traceSampleRate: number;
  readonly maxBufferedSpans: number;
  readonly maxBufferedLogs: number;
  readonly maxSeriesPerMetric: number;
  readonly maxExportBatchSize: number;
  readonly maxExportQueueBatches: number;
  readonly exportTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly otlpEndpoint?: string;
  readonly logToStderr: boolean;
} {
  const sampleRate = config.traceSampleRate ?? 1.0;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new ObservabilityConfigurationError(
      `traceSampleRate must be finite within [0, 1], got ${String(config.traceSampleRate)}`
    );
  }

  let validatedOtlp: string | undefined;
  if (config.otlpEndpoint !== undefined && config.otlpEndpoint.trim().length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(config.otlpEndpoint.trim());
    } catch {
      throw new ObservabilityConfigurationError(`Invalid otlpEndpoint URL: '${config.otlpEndpoint}'`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ObservabilityConfigurationError(
        `Unsupported otlpEndpoint protocol '${parsed.protocol}'; expected http: or https:`
      );
    }
    if (parsed.username || parsed.password) {
      throw new ObservabilityConfigurationError("Embedded credentials in otlpEndpoint URL are strictly prohibited");
    }
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    if (parsed.protocol === "http:" && !isLocal) {
      throw new ObservabilityConfigurationError(
        `Unencrypted http:// OTLP endpoint rejected for non-localhost host '${host}'`
      );
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    validatedOtlp = `${parsed.origin}${normalizedPath}`;
  }

  return {
    serviceName: sanitizeTelemetryString(config.serviceName ?? "emerald-agent-fabric", 64),
    serviceVersion: sanitizeTelemetryString(config.serviceVersion ?? "0.1.0", 32),
    environment: sanitizeTelemetryString(config.environment ?? "local", 32),
    traceSampleRate: sampleRate,
    maxBufferedSpans: Math.max(16, Math.floor(config.maxBufferedSpans ?? 1024)),
    maxBufferedLogs: Math.max(16, Math.floor(config.maxBufferedLogs ?? 1024)),
    maxSeriesPerMetric: Math.max(10, Math.floor(config.maxSeriesPerMetric ?? 200)),
    maxExportBatchSize: Math.max(1, Math.floor(config.maxExportBatchSize ?? 64)),
    maxExportQueueBatches: Math.max(2, Math.floor(config.maxExportQueueBatches ?? 64)),
    exportTimeoutMs: Math.max(50, Math.floor(config.exportTimeoutMs ?? 2000)),
    shutdownTimeoutMs: Math.max(50, Math.floor(config.shutdownTimeoutMs ?? 1500)),
    otlpEndpoint: validatedOtlp,
    logToStderr: config.logToStderr ?? false,
  };
}

/**
 * Built-in OTLP/HTTP JSON exporter using Node 24 native fetch with AbortSignal timeout.
 */
export class OtlpHttpJsonExporter implements TelemetryBatchExporter {
  private readonly baseEndpoint: string;
  private readonly timeoutMs: number;
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly environment: string;

  constructor(options: {
    readonly baseEndpoint: string;
    readonly timeoutMs?: number;
    readonly serviceName?: string;
    readonly serviceVersion?: string;
    readonly environment?: string;
  }) {
    this.baseEndpoint = options.baseEndpoint.replace(/\/+$/, "");
    this.timeoutMs = Math.max(50, options.timeoutMs ?? 2000);
    this.serviceName = options.serviceName ?? "emerald-agent-fabric";
    this.serviceVersion = options.serviceVersion ?? "0.1.0";
    this.environment = options.environment ?? "local";
  }

  public async exportSpans(spans: readonly TelemetrySpanRecord[]): Promise<void> {
    if (spans.length === 0) return;

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
              { key: "service.version", value: { stringValue: this.serviceVersion } },
              { key: "deployment.environment", value: { stringValue: this.environment } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "emerald.observability", version: "1.0.0" },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? "",
                name: s.name,
                kind: otlpSpanKindNumber(s.kind),
                startTimeUnixNano: String(Math.floor(s.startTimeMs * 1_000_000)),
                endTimeUnixNano: String(Math.floor((s.endTimeMs ?? s.startTimeMs) * 1_000_000)),
                attributes: toOtlpAttributes(s.attributes),
                events: s.events.map((ev) => ({
                  name: ev.name,
                  timeUnixNano: String(Math.floor(ev.timestampMs * 1_000_000)),
                  attributes: toOtlpAttributes(ev.attributes ?? {}),
                })),
                status: {
                  code: s.status === "ERROR" ? 2 : s.status === "OK" ? 1 : 0,
                  message: s.errorDescription ?? "",
                },
              })),
            },
          ],
        },
      ],
    };

    const url = this.baseEndpoint.endsWith("/v1/traces")
      ? this.baseEndpoint
      : `${this.baseEndpoint}/v1/traces`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`OTLP trace export HTTP ${res.status}`);
    }
  }

  public async exportLogs(logs: readonly StructuredLogRecord[]): Promise<void> {
    if (logs.length === 0) return;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
              { key: "service.version", value: { stringValue: this.serviceVersion } },
              { key: "deployment.environment", value: { stringValue: this.environment } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: "emerald.observability", version: "1.0.0" },
              logRecords: logs.map((l) => ({
                timeUnixNano: String(Math.floor(Date.parse(l.timestamp) * 1_000_000)),
                severityText: l.severity,
                body: { stringValue: l.message },
                traceId: l.correlation.traceId ?? "",
                spanId: l.correlation.spanId ?? "",
                attributes: toOtlpAttributes({
                  event: l.event,
                  tenantId: l.correlation.tenantId ?? "",
                  taskId: l.correlation.taskId ?? "",
                  runId: l.correlation.runId ?? "",
                  attemptId: l.correlation.attemptId ?? "",
                  agentId: l.correlation.agentId ?? "",
                  executionMode: l.correlation.executionMode ?? "",
                  ...(l.attributes ? sanitizeTelemetryAttributes(l.attributes, 256) : {}),
                }),
              })),
            },
          ],
        },
      ],
    };

    const base = this.baseEndpoint.replace(/\/v1\/traces$/, "");
    const url = `${base}/v1/logs`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`OTLP log export HTTP ${res.status}`);
    }
  }
}

function toOtlpAttributes(
  attrs: Record<string, TelemetryAttributeValue>
): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === "boolean") {
      return { key, value: { boolValue: value } };
    }
    if (typeof value === "number") {
      return Number.isInteger(value)
        ? { key, value: { intValue: String(value) } }
        : { key, value: { doubleValue: value } };
    }
    return { key, value: { stringValue: String(value) } };
  });
}

function isHeadSampled(traceId: string, rate: number): boolean {
  if (rate >= 1.0) return true;
  if (rate <= 0.0) return false;
  // Deterministic hash fraction from last 8 hex digits of traceId
  const tailHex = traceId.slice(-8);
  const val = parseInt(tailHex, 16);
  if (!Number.isFinite(val)) return false;
  return val / 0xffffffff <= rate;
}

export class EmeraldObservability implements ObservabilityPort {
  private readonly cfg: ReturnType<typeof validateObservabilityConfig>;
  private readonly als = new AsyncLocalStorage<ObservabilityCorrelation>();
  private readonly registry: BoundedPrometheusRegistry;
  private readonly batchExporter?: TelemetryBatchExporter;

  private readonly activeSpans = new Map<string, TelemetrySpanRecord>();
  private readonly completedSpanRing: TelemetrySpanRecord[] = [];
  private readonly logRing: StructuredLogRecord[] = [];
  private readonly pendingSpanExportQueue: TelemetrySpanRecord[] = [];
  private readonly pendingLogExportQueue: StructuredLogRecord[] = [];

  private spansRecorded = 0;
  private spansDropped = 0;
  private logsRecorded = 0;
  private logsDropped = 0;
  private exportAttempts = 0;
  private exportFailures = 0;
  private lastExportError?: string;
  private activeFlush: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private closed = false;
  private readonly baseSpanAttributes: Readonly<Record<string, TelemetryAttributeValue>>;

  constructor(config: ObservabilityConfig = {}, batchExporter?: TelemetryBatchExporter) {
    this.cfg = validateObservabilityConfig(config);
    this.baseSpanAttributes = {
      "service.name": sanitizeTelemetryString(this.cfg.serviceName, 128),
      "deployment.environment": sanitizeTelemetryString(this.cfg.environment, 64),
    };
    this.registry = new BoundedPrometheusRegistry({ maxSeriesPerMetric: this.cfg.maxSeriesPerMetric });
    if (batchExporter) {
      this.batchExporter = batchExporter;
    } else if (this.cfg.otlpEndpoint) {
      this.batchExporter = new OtlpHttpJsonExporter({
        baseEndpoint: this.cfg.otlpEndpoint,
        timeoutMs: this.cfg.exportTimeoutMs,
        serviceName: this.cfg.serviceName,
        serviceVersion: this.cfg.serviceVersion,
        environment: this.cfg.environment,
      });
    }
  }

  public currentCorrelation(): ObservabilityCorrelation {
    return this.als.getStore() ?? {};
  }

  public runWithCorrelation<T>(correlation: Partial<ObservabilityCorrelation>, fn: () => T): T {
    const parent = this.currentCorrelation();
    const traceId = correlation.traceId ?? parent.traceId ?? generateTraceId();
    const sampled =
      correlation.sampled ??
      parent.sampled ??
      isHeadSampled(traceId, this.cfg.traceSampleRate);

    const merged: ObservabilityCorrelation = {
      ...parent,
      ...correlation,
      traceId,
      sampled,
    };
    return this.als.run(merged, fn);
  }

  public startSpan(
    name: string,
    attributes: Record<string, unknown> = {},
    correlationOrOptions: Partial<ObservabilityCorrelation> | StartSpanOptions = {}
  ): TelemetrySpanRecord {
    const kind: TelemetrySpanKind = isStartSpanOptions(correlationOrOptions)
      ? (correlationOrOptions.kind ?? "INTERNAL")
      : "INTERNAL";
    const correlationOverride: Partial<ObservabilityCorrelation> = isStartSpanOptions(correlationOrOptions)
      ? (correlationOrOptions.correlation ?? {})
      : correlationOrOptions;

    const parent = this.currentCorrelation();
    const traceId = correlationOverride.traceId ?? parent.traceId ?? generateTraceId();
    const parentSpanId = correlationOverride.parentSpanId ?? parent.spanId ?? parent.parentSpanId;
    const spanId = correlationOverride.spanId ?? generateSpanId();
    const sampled =
      correlationOverride.sampled ??
      parent.sampled ??
      isHeadSampled(traceId, this.cfg.traceSampleRate);

    const sanitizedCustom = sanitizeTelemetryAttributes(attributes, 256);
    const spanAttributes: Record<string, TelemetryAttributeValue> = {
      "service.name": this.baseSpanAttributes["service.name"]!,
      "deployment.environment": this.baseSpanAttributes["deployment.environment"]!,
      ...sanitizedCustom,
    };

    const tenantId = correlationOverride.tenantId ?? parent.tenantId;
    if (tenantId) spanAttributes["emerald.tenant_id"] = sanitizeTelemetryString(tenantId, 128);
    const taskId = correlationOverride.taskId ?? parent.taskId;
    if (taskId) spanAttributes["emerald.task_id"] = sanitizeTelemetryString(taskId, 128);
    const runId = correlationOverride.runId ?? parent.runId;
    if (runId) spanAttributes["emerald.run_id"] = sanitizeTelemetryString(runId, 128);
    const attemptId = correlationOverride.attemptId ?? parent.attemptId;
    if (attemptId) spanAttributes["emerald.attempt_id"] = sanitizeTelemetryString(attemptId, 128);
    const agentId = correlationOverride.agentId ?? parent.agentId;
    if (agentId) spanAttributes["emerald.agent_id"] = sanitizeTelemetryString(agentId, 128);
    const parentTaskId = correlationOverride.parentTaskId ?? parent.parentTaskId;
    if (parentTaskId) spanAttributes["emerald.parent_task_id"] = sanitizeTelemetryString(parentTaskId, 128);
    const eventSequence = correlationOverride.eventSequence ?? parent.eventSequence;
    if (eventSequence !== undefined && Number.isFinite(eventSequence)) {
      spanAttributes["emerald.event_sequence"] = eventSequence;
    }
    const executionMode = correlationOverride.executionMode ?? parent.executionMode;
    if (executionMode) spanAttributes["emerald.execution_mode"] = executionMode;

    const span: TelemetrySpanRecord = {
      name: sanitizeTelemetryString(name, 128),
      kind,
      traceId,
      spanId,
      parentSpanId,
      startTimeMs: Date.now(),
      attributes: spanAttributes,
      events: [],
      status: "UNSET",
    };

    if (!this.closed && sampled) {
      if (this.activeSpans.size >= this.cfg.maxBufferedSpans) {
        const oldestKey = this.activeSpans.keys().next().value;
        if (oldestKey !== undefined) {
          this.activeSpans.delete(oldestKey);
          this.spansDropped++;
        }
      }
      this.activeSpans.set(spanId, span);
      this.spansRecorded++;
    } else if (!sampled) {
      this.spansDropped++;
    }

    return span;
  }

  public recordSpanException(
    span: TelemetrySpanRecord,
    error: unknown,
    attributes: Record<string, unknown> = {}
  ): void {
    const exceptionType = error instanceof Error ? error.name || "Error" : typeof error;
    const exceptionMessage = error instanceof Error ? error.message : String(error);
    this.addSpanEvent(span.spanId, "exception", {
      "exception.type": exceptionType,
      "exception.message": exceptionMessage,
      ...attributes,
    });
  }

  public endSpan(spanId: string, status: "OK" | "ERROR" = "OK", errorDescription?: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    this.activeSpans.delete(spanId);

    span.endTimeMs = Date.now();
    span.status = status;
    if (errorDescription !== undefined) {
      span.errorDescription = sanitizeTelemetryString(errorDescription, 256);
    }

    this.pushBounded(this.completedSpanRing, span, this.cfg.maxBufferedSpans, "span");
    if (this.batchExporter) {
      const maxQueuedItems = this.cfg.maxExportBatchSize * this.cfg.maxExportQueueBatches;
      this.pushBounded(this.pendingSpanExportQueue, span, maxQueuedItems, "span");
    }
  }

  public withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: TelemetrySpanRecord) => T
  ): T {
    const span = this.startSpan(name, attributes);
    const parent = this.currentCorrelation();
    return this.als.run(
      {
        ...parent,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
      },
      () => {
        try {
          const result = fn(span);
          this.endSpan(span.spanId, "OK");
          return result;
        } catch (err) {
          this.recordSpanException(span, err);
          this.endSpan(span.spanId, "ERROR", err instanceof Error ? err.message : String(err));
          throw err;
        }
      }
    );
  }

  public async withSpanAsync<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: TelemetrySpanRecord) => Promise<T>
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    const parent = this.currentCorrelation();
    return this.als.run(
      {
        ...parent,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
      },
      async () => {
        try {
          const result = await fn(span);
          this.endSpan(span.spanId, "OK");
          return result;
        } catch (err) {
          this.recordSpanException(span, err);
          this.endSpan(span.spanId, "ERROR", err instanceof Error ? err.message : String(err));
          throw err;
        }
      }
    );
  }

  public addSpanEvent(spanId: string, name: string, attributes: Record<string, unknown> = {}): void {
    const span = this.activeSpans.get(spanId);
    if (!span || span.events.length >= 64) return;
    span.events.push({
      name: sanitizeTelemetryString(name, 128),
      timestampMs: Date.now(),
      attributes: sanitizeTelemetryAttributes(attributes, 256),
    });
  }

  public incrementCounter(name: string, help: string, labels: MetricLabels = {}, delta: number = 1): void {
    try {
      this.registry.incrementCounter(name, help, labels, delta);
    } catch {
      // Zero-authority fail-safe isolation
    }
  }

  public setGauge(name: string, help: string, value: number, labels: MetricLabels = {}): void {
    try {
      this.registry.setGauge(name, help, value, labels);
    } catch {
      // Zero-authority fail-safe isolation
    }
  }

  public observeHistogram(
    name: string,
    help: string,
    value: number,
    labels: MetricLabels = {},
    buckets?: readonly number[]
  ): void {
    try {
      this.registry.observeHistogram(name, help, value, labels, buckets);
    } catch {
      // Zero-authority fail-safe isolation
    }
  }

  public emitLog(
    severity: StructuredLogRecord["severity"],
    event: string,
    message: string,
    attributes?: Record<string, unknown>
  ): void {
    try {
      if (this.closed) return;
      const correlation = this.currentCorrelation();
      const record: StructuredLogRecord = {
        timestamp: new Date().toISOString(),
        severity,
        event: sanitizeTelemetryString(event, 128),
        message: sanitizeTelemetryString(message, 512),
        correlation: {
          traceId: correlation.traceId,
          spanId: correlation.spanId,
          parentSpanId: correlation.parentSpanId,
          tenantId: correlation.tenantId,
          taskId: correlation.taskId,
          runId: correlation.runId,
          attemptId: correlation.attemptId,
          agentId: correlation.agentId,
          parentTaskId: correlation.parentTaskId,
          eventSequence: correlation.eventSequence,
          executionMode: correlation.executionMode,
        },
        attributes: attributes
          ? (sanitizeTelemetryValue(attributes, { maxStringChars: 256, maxDepth: 4 }) as Record<
              string,
              unknown
            >)
          : undefined,
      };

      this.logsRecorded++;
      this.pushBounded(this.logRing, record, this.cfg.maxBufferedLogs, "log");
      if (this.batchExporter?.exportLogs) {
        const maxQueuedItems = this.cfg.maxExportBatchSize * this.cfg.maxExportQueueBatches;
        this.pushBounded(this.pendingLogExportQueue, record, maxQueuedItems, "log");
      }
      if (this.cfg.logToStderr) {
        process.stderr.write(`${JSON.stringify(record)}\n`);
      }
    } catch {
      // Fail-safe logging
    }
  }

  public collectRuntimeMetrics(dataDirectoryPath?: string): void {
    this.registry.collectRuntimeMetrics(dataDirectoryPath);
  }

  public exportPrometheusMetrics(): string {
    this.updatePipelineSelfMetrics();
    return this.registry.exportPrometheusText();
  }

  public async flush(timeoutMs: number = this.cfg.exportTimeoutMs): Promise<void> {
    if (!this.batchExporter) return;
    if (this.activeFlush) {
      await this.activeFlush;
      return;
    }
    const boundedTimeout = Math.max(50, timeoutMs);

    this.activeFlush = (async () => {
      let aborted = false;
      let activeSpanBatchLen = 0;
      let activeLogBatchLen = 0;
      try {
        await raceWithTimeout(
          (async () => {
            while (!aborted && this.pendingSpanExportQueue.length > 0) {
              const batch = this.pendingSpanExportQueue.splice(0, this.cfg.maxExportBatchSize);
              activeSpanBatchLen = batch.length;
              this.exportAttempts++;
              try {
                await this.batchExporter!.exportSpans(batch);
                activeSpanBatchLen = 0;
                if (aborted) break;
                this.lastExportError = undefined;
              } catch (err) {
                activeSpanBatchLen = 0;
                if (!aborted) {
                  this.exportFailures++;
                  this.lastExportError = sanitizeTelemetryString(
                    err instanceof Error ? err.message : String(err),
                    128
                  );
                  this.spansDropped += batch.length;
                }
                break;
              }
            }

            if (this.batchExporter!.exportLogs) {
              while (!aborted && this.pendingLogExportQueue.length > 0) {
                const batch = this.pendingLogExportQueue.splice(0, this.cfg.maxExportBatchSize);
                activeLogBatchLen = batch.length;
                this.exportAttempts++;
                try {
                  await this.batchExporter!.exportLogs(batch);
                  activeLogBatchLen = 0;
                  if (aborted) break;
                  this.lastExportError = undefined;
                } catch (err) {
                  activeLogBatchLen = 0;
                  if (!aborted) {
                    this.exportFailures++;
                    this.lastExportError = sanitizeTelemetryString(
                      err instanceof Error ? err.message : String(err),
                      128
                    );
                    this.logsDropped += batch.length;
                  }
                  break;
                }
              }
            }
          })(),
          boundedTimeout
        );
      } catch (err) {
        aborted = true;
        if (activeSpanBatchLen > 0) {
          this.spansDropped += activeSpanBatchLen;
          activeSpanBatchLen = 0;
        }
        if (activeLogBatchLen > 0) {
          this.logsDropped += activeLogBatchLen;
          activeLogBatchLen = 0;
        }
        this.exportFailures++;
        this.lastExportError = sanitizeTelemetryString(
          err instanceof Error ? err.message : String(err),
          128
        );
      }
    })();

    try {
      await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  public async shutdown(timeoutMs: number = this.cfg.shutdownTimeoutMs): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.closed = true;
    const half = Math.max(25, Math.floor(timeoutMs / 2));
    this.shutdownPromise = (async () => {
      try {
        await this.flush(half);
      } catch {
        // Never throw on shutdown
      }
      if (this.batchExporter?.shutdown) {
        try {
          await raceWithTimeout(this.batchExporter.shutdown(half), half);
        } catch {
          // Never hang shutdown
        }
      }
      this.registry.close();
    })();
    return this.shutdownPromise;
  }

  public getPipelineHealth(): ObservabilityPipelineHealth {
    const regStats = this.registry.getStats();
    const queuedBatches = Math.ceil(
      (this.pendingSpanExportQueue.length + this.pendingLogExportQueue.length) /
        this.cfg.maxExportBatchSize
    );
    return {
      healthy: this.exportFailures === 0 || !this.lastExportError,
      spansRecorded: this.spansRecorded,
      spansDropped: this.spansDropped,
      logsRecorded: this.logsRecorded,
      logsDropped: this.logsDropped,
      metricSeriesCount: regStats.metricSeriesCount,
      metricOverflowCount: regStats.metricOverflowCount,
      exportAttempts: this.exportAttempts,
      exportFailures: this.exportFailures,
      queuedExportBatches: queuedBatches,
      lastExportError: this.lastExportError,
    };
  }

  public getRegistry(): BoundedPrometheusRegistry {
    return this.registry;
  }

  public getCompletedSpans(): readonly TelemetrySpanRecord[] {
    return [...this.completedSpanRing];
  }

  public getBufferedLogs(): readonly StructuredLogRecord[] {
    return [...this.logRing];
  }

  private updatePipelineSelfMetrics(): void {
    const h = this.getPipelineHealth();
    this.registry.setGauge(
      "emerald_telemetry_spans_dropped_total",
      "Total telemetry spans dropped due to buffer bounds, sampling, or export failure",
      h.spansDropped
    );
    this.registry.setGauge(
      "emerald_telemetry_logs_dropped_total",
      "Total structured telemetry logs dropped due to buffer bounds or export failure",
      h.logsDropped
    );
    this.registry.setGauge(
      "emerald_telemetry_export_failures_total",
      "Total telemetry export batch failures",
      h.exportFailures
    );
    this.registry.setGauge(
      "emerald_telemetry_queue_depth",
      "Pending telemetry export queue batches",
      h.queuedExportBatches
    );
  }

  private pushBounded<T>(ring: T[], item: T, cap: number, kind: "span" | "log"): void {
    if (ring.length >= cap) {
      ring.shift();
      if (kind === "span") this.spansDropped++;
      else this.logsDropped++;
    }
    ring.push(item);
  }
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Telemetry timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
