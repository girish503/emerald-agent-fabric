/**
 * Vendor-neutral Observability & Telemetry Port for Emerald Agent Fabric (Phase 3).
 *
 * Invariants:
 * - Zero Authority: Telemetry carries no execution, authorization, verification, or recovery authority.
 * - Trace identifiers (traceId, spanId) are correlation coordinates only, never credentials.
 * - Implementations must isolate telemetry failures so core execution never stalls or fails.
 */

export type ExecutionModeTag = "fixture" | "live";

export interface ObservabilityCorrelation {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly sampled?: boolean;
  readonly tenantId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly agentId?: string;
  readonly parentTaskId?: string;
  readonly eventSequence?: number;
  readonly executionMode?: ExecutionModeTag;
}

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;
export type MetricLabels = Readonly<Record<string, string>>;
export type TelemetrySpanKind = "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";

export interface StartSpanOptions {
  readonly kind?: TelemetrySpanKind;
  readonly correlation?: Partial<ObservabilityCorrelation>;
}

export interface TelemetrySpanRecord {
  readonly name: string;
  readonly kind: TelemetrySpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTimeMs: number;
  endTimeMs?: number;
  readonly attributes: Record<string, TelemetryAttributeValue>;
  readonly events: Array<{
    readonly name: string;
    readonly timestampMs: number;
    readonly attributes?: Record<string, TelemetryAttributeValue>;
  }>;
  status: "OK" | "ERROR" | "UNSET";
  errorDescription?: string;
}

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  readonly event: string;
  readonly message: string;
  readonly correlation: ObservabilityCorrelation;
  readonly attributes?: Record<string, unknown>;
}

export interface ObservabilityPipelineHealth {
  readonly healthy: boolean;
  readonly spansRecorded: number;
  readonly spansDropped: number;
  readonly logsRecorded: number;
  readonly logsDropped: number;
  readonly metricSeriesCount: number;
  readonly metricOverflowCount: number;
  readonly exportAttempts: number;
  readonly exportFailures: number;
  readonly queuedExportBatches: number;
  readonly lastExportError?: string;
}

export interface ObservabilityConfig {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  /** Trace head-sampling rate in [0, 1]. Default 1.0. */
  readonly traceSampleRate?: number;
  readonly maxBufferedSpans?: number;
  readonly maxBufferedLogs?: number;
  readonly maxSeriesPerMetric?: number;
  readonly maxExportBatchSize?: number;
  readonly maxExportQueueBatches?: number;
  readonly exportTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly otlpEndpoint?: string;
  readonly allowInsecureLocalhost?: boolean;
  readonly logToStderr?: boolean;
}

export interface TelemetryBatchExporter {
  exportSpans(spans: readonly TelemetrySpanRecord[]): Promise<void>;
  exportLogs?(logs: readonly StructuredLogRecord[]): Promise<void>;
  shutdown?(timeoutMs?: number): Promise<void>;
}

export interface ObservabilityPort {
  currentCorrelation(): ObservabilityCorrelation;

  runWithCorrelation<T>(correlation: Partial<ObservabilityCorrelation>, fn: () => T): T;

  startSpan(
    name: string,
    attributes?: Record<string, unknown>,
    correlationOrOptions?: Partial<ObservabilityCorrelation> | StartSpanOptions
  ): TelemetrySpanRecord;
  recordSpanException?(
    span: TelemetrySpanRecord,
    error: unknown,
    attributes?: Record<string, unknown>
  ): void;

  endSpan(spanId: string, status?: "OK" | "ERROR", errorDescription?: string): void;

  withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: TelemetrySpanRecord) => T
  ): T;

  withSpanAsync<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: TelemetrySpanRecord) => Promise<T>
  ): Promise<T>;

  addSpanEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void;

  incrementCounter(name: string, help: string, labels?: MetricLabels, delta?: number): void;

  setGauge(name: string, help: string, value: number, labels?: MetricLabels): void;

  observeHistogram(
    name: string,
    help: string,
    value: number,
    labels?: MetricLabels,
    buckets?: readonly number[]
  ): void;

  emitLog(
    severity: StructuredLogRecord["severity"],
    event: string,
    message: string,
    attributes?: Record<string, unknown>
  ): void;

  exportPrometheusMetrics(): string;

  flush(timeoutMs?: number): Promise<void>;

  shutdown(timeoutMs?: number): Promise<void>;

  getPipelineHealth(): ObservabilityPipelineHealth;
}

export interface LangfuseTelemetryPort {
  enqueueTrace(input: {
    readonly id: string;
    readonly name: string;
    readonly tags?: readonly string[];
    readonly metadata?: Record<string, unknown>;
    readonly timestamp?: string;
  }): void;
  enqueueSpan(span: {
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
  }): void;
  enqueueGeneration(trace: {
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
  }): void;
  enqueueScore(score: {
    readonly id?: string;
    readonly traceId: string;
    readonly observationId?: string;
    readonly name: string;
    readonly value: number | string;
    readonly comment?: string;
  }): void;
  getHealth(): {
    readonly exportedEvents: number;
    readonly droppedEvents: number;
    readonly exportFailures: number;
  };
}
