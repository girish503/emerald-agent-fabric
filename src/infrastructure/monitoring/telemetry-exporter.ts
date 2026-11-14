/**
 * OpenTelemetry, Prometheus, and Langfuse Telemetry Exporter for Emerald Agent Fabric.
 *
 * Implements vendor-neutral instrumentation, bounded-cardinality Prometheus exposition,
 * pre-export credential/secret redaction, and self-hosted Langfuse trace export under
 * strict ₹0-cost and fail-safe constraints:
 *
 * Invariants:
 * 1. Zero Authority: Monitoring components possess ZERO execution, approval, or verification authority.
 * 2. Fail-Safe Non-Disruption: Monitoring or export failures must NEVER interrupt execution
 *    or alter task outcomes.
 * 3. ₹0-Cost & Open-Source: Only open-source standards (OTel, Prometheus, Langfuse self-hosted).
 * 4. Data Scoping & Redaction: Secrets, private tokens, and sensitive credentials are redacted before export.
 */

import type {
  ObservabilityConfig,
  ObservabilityPipelineHealth,
  TelemetryBatchExporter,
} from "../../ports/observability.port.js";
import {
  SelfHostedLangfuseClient,
  type LangfuseClientConfig,
  type LangfuseHealthStatus,
} from "./langfuse-exporter.js";
import { EmeraldObservability } from "./otel-observability.js";
import {
  sanitizeTelemetryAttributes,
  sanitizeTelemetryString,
} from "./telemetry-redaction.js";

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

export interface TraceSpan {
  readonly name: string;
  readonly context: SpanContext;
  readonly startTimeMs: number;
  endTimeMs?: number;
  readonly attributes: Record<string, string | number | boolean>;
  readonly events: Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
  status: "OK" | "ERROR" | "UNSET";
  errorDescription?: string;
}

export interface MetricSample {
  readonly name: string;
  readonly type: "COUNTER" | "GAUGE" | "HISTOGRAM";
  readonly help: string;
  readonly value: number;
  readonly labels: Record<string, string>;
}

export interface LangfuseGenerationTrace {
  readonly id: string;
  readonly traceId: string;
  readonly name: string;
  readonly model: string;
  readonly modelParameters?: Record<string, unknown>;
  readonly input: unknown;
  readonly output: unknown;
  readonly usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  readonly startTime: string;
  readonly endTime: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TelemetryExporterOptions {
  readonly observability?: ObservabilityConfig;
  readonly batchExporter?: TelemetryBatchExporter;
  readonly langfuse?: LangfuseClientConfig;
  readonly maxRetainedSpans?: number;
}

export class TelemetryExporter {
  public readonly observability: EmeraldObservability;
  public readonly langfuse: SelfHostedLangfuseClient;
  private readonly spans = new Map<string, TraceSpan>();
  private readonly maxRetainedSpans: number;

  constructor(options: TelemetryExporterOptions = {}) {
    this.observability = new EmeraldObservability(options.observability, options.batchExporter);
    this.langfuse = new SelfHostedLangfuseClient(options.langfuse);
    this.maxRetainedSpans = Math.max(16, options.maxRetainedSpans ?? 1024);
  }

  /**
   * Starts a vendor-neutral OpenTelemetry-compatible span with pre-storage redaction.
   */
  public startSpan(
    name: string,
    context: SpanContext,
    attributes: Record<string, string | number | boolean> = {}
  ): TraceSpan {
    const cleanAttributes = sanitizeTelemetryAttributes(attributes, 256);
    const span: TraceSpan = {
      name: sanitizeTelemetryString(name, 128),
      context,
      startTimeMs: Date.now(),
      attributes: cleanAttributes,
      events: [],
      status: "UNSET",
    };

    if (this.spans.size >= this.maxRetainedSpans) {
      const oldestKey = this.spans.keys().next().value;
      if (oldestKey !== undefined) {
        this.spans.delete(oldestKey);
      }
    }
    this.spans.set(context.spanId, span);

    this.observability.startSpan(name, cleanAttributes, {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
    });

    return span;
  }

  /**
   * Completes an active span.
   */
  public endSpan(spanId: string, status: "OK" | "ERROR" = "OK", errorDescription?: string): void {
    const span = this.spans.get(spanId);
    if (span) {
      span.endTimeMs = Date.now();
      span.status = status;
      if (errorDescription !== undefined) {
        span.errorDescription = sanitizeTelemetryString(errorDescription, 256);
      }
    }
    this.observability.endSpan(spanId, status, errorDescription);
  }

  /**
   * Records a Prometheus-compatible metric sample via the bounded-cardinality registry.
   */
  public recordMetric(metric: MetricSample): void {
    this.observability
      .getRegistry()
      .setMetricSample(metric.name, metric.type, metric.help, metric.value, metric.labels);
  }

  /**
   * Collects Node.js runtime process health metrics for Prometheus scraping.
   */
  public collectRuntimeHealth(dataDirectoryPath?: string): void {
    this.observability.collectRuntimeMetrics(dataDirectoryPath);
  }

  /**
   * Exports all recorded metrics in Prometheus text exposition format (v0.0.4).
   */
  public exportPrometheusMetrics(): string {
    return this.observability.exportPrometheusMetrics();
  }

  /**
   * Formats a sanitized telemetry trace for a self-hosted Langfuse ingestion API.
   */
  public formatLangfuseGeneration(trace: LangfuseGenerationTrace): Record<string, unknown> {
    return this.langfuse.formatGenerationBody(trace);
  }

  public getHealth(): {
    readonly observability: ObservabilityPipelineHealth;
    readonly langfuse: LangfuseHealthStatus;
  } {
    return {
      observability: this.observability.getPipelineHealth(),
      langfuse: this.langfuse.getHealth(),
    };
  }

  public async flush(timeoutMs?: number): Promise<void> {
    await Promise.allSettled([
      this.observability.flush(timeoutMs),
      this.langfuse.flush(timeoutMs),
    ]);
  }

  public async shutdown(timeoutMs?: number): Promise<void> {
    await Promise.allSettled([
      this.observability.shutdown(timeoutMs),
      this.langfuse.flush(timeoutMs),
    ]);
  }
}

/**
 * Constructs a fail-closed TelemetryExporter from validated environment variables.
 * Rejects cloud Langfuse SaaS URLs and invalid OTLP endpoints at startup while
 * remaining completely zero-network when unset.
 */
export function createTelemetryExporterFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TelemetryExporter {
  const otlpEndpoint = env.EMERALD_OTLP_ENDPOINT?.trim() || undefined;
  const environment = env.EMERALD_ENV?.trim() || "local";
  const langfuseBaseUrl = env.EMERALD_LANGFUSE_BASE_URL?.trim() || undefined;

  return new TelemetryExporter({
    observability: otlpEndpoint ? { otlpEndpoint, environment } : { environment },
    langfuse: langfuseBaseUrl
      ? {
          baseUrl: langfuseBaseUrl,
          publicKey: env.EMERALD_LANGFUSE_PUBLIC_KEY?.trim() || undefined,
          secretKey: env.EMERALD_LANGFUSE_SECRET_KEY?.trim() || undefined,
          enabled: true,
        }
      : undefined,
  });
}
