/**
 * Bounded-Cardinality Prometheus Metrics Registry & Runtime Collector (Phase 3).
 *
 * Security & Resource Invariants:
 * - Rejects or strips high-cardinality/sensitive label keys (taskId, runId, userId, prompt, secret, errorMessage).
 * - Caps distinct time-series per metric (`maxSeriesPerMetric`) preventing cardinality DoS/OOM.
 * - Escapes label values per Prometheus text exposition format v0.0.4.
 * - Collects Node.js runtime health (uptime, CPU, RSS/heap, event-loop delay, safe disk stats) zero-dependency.
 */

import * as fs from "node:fs";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { MetricLabels } from "../../ports/observability.port.js";
import { sanitizeTelemetryString } from "./telemetry-redaction.js";

export const DEFAULT_MAX_SERIES_PER_METRIC = 200;
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const FORBIDDEN_HIGH_CARDINALITY_LABELS: ReadonlySet<string> = new Set([
  "taskid",
  "task_id",
  "runid",
  "run_id",
  "attemptid",
  "attempt_id",
  "userid",
  "user_id",
  "principalid",
  "principal_id",
  "traceid",
  "trace_id",
  "spanid",
  "span_id",
  "parenttaskid",
  "parent_task_id",
  "errormessage",
  "error_message",
  "prompt",
  "content",
  "token",
  "secret",
  "password",
  "authorization",
]);

function escapePrometheusHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\r?\n/g, " ");
}

function escapePrometheusLabelValue(value: string): string {
  return sanitizeTelemetryString(value, 128)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

const MAX_LABEL_KEY_CACHE_SIZE = 512;

function compareAscii(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function formatLabelsKey(labels: MetricLabels): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  if (keys.length === 1) {
    const k = keys[0]!;
    return `{${k}="${escapePrometheusLabelValue(labels[k] ?? "")}"}`;
  }
  keys.sort(compareAscii);
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    const k = keys[i]!;
    out += `${k}="${escapePrometheusLabelValue(labels[k] ?? "")}"`;
  }
  out += "}";
  return out;
}

interface MetricFamilyState {
  readonly name: string;
  readonly type: "COUNTER" | "GAUGE" | "HISTOGRAM";
  readonly help: string;
  readonly series: Map<string, number>;
  readonly histograms?: Map<
    string,
    {
      readonly buckets: readonly number[];
      readonly bucketCounts: number[];
      sum: number;
      count: number;
    }
  >;
}

export interface PrometheusRegistryOptions {
  readonly maxSeriesPerMetric?: number;
}

export class BoundedPrometheusRegistry {
  private readonly families = new Map<string, MetricFamilyState>();
  private readonly maxSeriesPerMetric: number;
  private overflowCount = 0;
  private cardinalityRejectionCount = 0;
  private readonly eventLoopMonitor?: IntervalHistogram;
  private lastCpuUsage = process.cpuUsage();
  private readonly labelKeyCache = new Map<string, string>();

  constructor(options: PrometheusRegistryOptions = {}) {
    const rawLimit = options.maxSeriesPerMetric;
    this.maxSeriesPerMetric =
      rawLimit !== undefined && Number.isFinite(rawLimit)
        ? Math.max(10, Math.floor(rawLimit))
        : DEFAULT_MAX_SERIES_PER_METRIC;

    try {
      this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopMonitor.enable();
    } catch {
      // Fail-safe if perf_hooks monitor unavailable in restricted runtime
    }
  }

  public getStats(): { readonly metricSeriesCount: number; readonly metricOverflowCount: number; readonly cardinalityRejectionCount: number } {
    let seriesCount = 0;
    for (const family of this.families.values()) {
      seriesCount += family.series.size + (family.histograms?.size ?? 0);
    }
    return {
      metricSeriesCount: seriesCount,
      metricOverflowCount: this.overflowCount,
      cardinalityRejectionCount: this.cardinalityRejectionCount,
    };
  }

  public incrementCounter(
    name: string,
    help: string,
    labels: MetricLabels = {},
    delta: number = 1
  ): void {
    if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(delta) || delta < 0) {
      return;
    }
    const family = this.getOrCreateFamily(name, "COUNTER", help);
    if (!family || family.type !== "COUNTER") return;
    const key = this.resolveBoundedSeriesKey(family, labels);
    family.series.set(key, (family.series.get(key) ?? 0) + delta);
  }

  public setGauge(name: string, help: string, value: number, labels: MetricLabels = {}): void {
    if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(value)) {
      return;
    }
    const family = this.getOrCreateFamily(name, "GAUGE", help);
    if (!family || family.type !== "GAUGE") return;
    const key = this.resolveBoundedSeriesKey(family, labels);
    family.series.set(key, value);
  }

  /**
   * Backward-compatible metric setter/updater supporting existing TelemetryExporter.recordMetric callers.
   */
  public setMetricSample(
    name: string,
    type: "COUNTER" | "GAUGE" | "HISTOGRAM",
    help: string,
    value: number,
    labels: MetricLabels = {}
  ): void {
    if (type === "HISTOGRAM") {
      this.observeHistogram(name, help, value, labels);
      return;
    }
    if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(value)) {
      return;
    }
    const family = this.getOrCreateFamily(name, type, help);
    if (!family) return;
    const key = this.resolveBoundedSeriesKey(family, labels);
    family.series.set(key, value);
  }

  public observeHistogram(
    name: string,
    help: string,
    value: number,
    labels: MetricLabels = {},
    buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS
  ): void {
    if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(value)) {
      return;
    }
    const family = this.getOrCreateFamily(name, "HISTOGRAM", help);
    if (!family || !family.histograms) return;

    const labelKey = this.resolveBoundedHistogramKey(family, labels);

    let hist = family.histograms.get(labelKey);
    if (!hist) {
      const sortedBuckets = [...buckets].filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
      hist = {
        buckets: sortedBuckets,
        bucketCounts: new Array<number>(sortedBuckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      family.histograms.set(labelKey, hist);
    }

    for (let i = 0; i < hist.buckets.length; i++) {
      if (value <= hist.buckets[i]!) {
        hist.bucketCounts[i]! += 1;
      }
    }
    hist.bucketCounts[hist.buckets.length]! += 1; // +Inf bucket
    hist.sum += value;
    hist.count += 1;
  }

  /**
   * Collects Node.js runtime CPU, memory, uptime, event-loop delay, and optional safe filesystem usage.
   */
  public collectRuntimeMetrics(dataDirectoryPath?: string): void {
    try {
      this.setGauge("emerald_process_uptime_seconds", "Node.js process uptime in seconds", Number(process.uptime().toFixed(3)));

      const mem = process.memoryUsage();
      this.setGauge("emerald_process_resident_memory_bytes", "Resident set size in bytes", mem.rss);
      this.setGauge("emerald_process_heap_used_bytes", "V8 heap used in bytes", mem.heapUsed);
      this.setGauge("emerald_process_heap_total_bytes", "V8 heap total in bytes", mem.heapTotal);

      const cpu = process.cpuUsage(this.lastCpuUsage);
      this.lastCpuUsage = process.cpuUsage();
      this.incrementCounter("emerald_process_cpu_seconds_total", "Total user and system CPU time in seconds", { mode: "user" }, cpu.user / 1e6);
      this.incrementCounter("emerald_process_cpu_seconds_total", "Total user and system CPU time in seconds", { mode: "system" }, cpu.system / 1e6);

      if (this.eventLoopMonitor) {
        this.setGauge(
          "emerald_nodejs_eventloop_delay_p95_seconds",
          "95th percentile Node.js event loop delay in seconds",
          Number((this.eventLoopMonitor.percentile(95) / 1e9).toFixed(6))
        );
        this.setGauge(
          "emerald_nodejs_eventloop_delay_max_seconds",
          "Max Node.js event loop delay in seconds",
          Number((this.eventLoopMonitor.max / 1e9).toFixed(6))
        );
      }

      if (dataDirectoryPath && typeof fs.statfsSync === "function") {
        try {
          const stat = fs.statfsSync(dataDirectoryPath);
          const totalBytes = Number(stat.blocks) * Number(stat.bsize);
          const freeBytes = Number(stat.bavail) * Number(stat.bsize);
          this.setGauge("emerald_disk_total_bytes", "Total disk space in bytes for monitored path", totalBytes);
          this.setGauge("emerald_disk_free_bytes", "Available disk space in bytes for monitored path", freeBytes);
        } catch {
          // Safe fallback if path not yet created or statfs unsupported
        }
      }
    } catch {
      // Fail-safe: runtime collection must never throw
    }
  }

  public exportPrometheusText(): string {
    const lines: string[] = [];

    for (const family of this.families.values()) {
      lines.push(`# HELP ${family.name} ${escapePrometheusHelp(family.help)}`);
      lines.push(`# TYPE ${family.name} ${family.type.toLowerCase()}`);

      if (family.type === "HISTOGRAM" && family.histograms) {
        for (const [labelKey, hist] of family.histograms.entries()) {
          const baseInner = labelKey.startsWith("{") && labelKey.endsWith("}") ? labelKey.slice(1, -1) : "";
          for (let i = 0; i < hist.buckets.length; i++) {
            const le = String(hist.buckets[i]!);
            const bucketLabels = baseInner.length > 0 ? `{${baseInner},le="${le}"}` : `{le="${le}"}`;
            lines.push(`${family.name}_bucket${bucketLabels} ${hist.bucketCounts[i]!}`);
          }
          const infLabels = baseInner.length > 0 ? `{${baseInner},le="+Inf"}` : `{le="+Inf"}`;
          lines.push(`${family.name}_bucket${infLabels} ${hist.bucketCounts[hist.buckets.length]!}`);
          lines.push(`${family.name}_sum${labelKey} ${hist.sum}`);
          lines.push(`${family.name}_count${labelKey} ${hist.count}`);
        }
      } else {
        for (const [labelKey, val] of family.series.entries()) {
          lines.push(`${family.name}${labelKey} ${val}`);
        }
      }
    }

    if (this.overflowCount > 0) {
      lines.push(`# HELP emerald_telemetry_metric_overflow_total Metrics folded into overflow due to cardinality cap`);
      lines.push(`# TYPE emerald_telemetry_metric_overflow_total counter`);
      lines.push(`emerald_telemetry_metric_overflow_total ${this.overflowCount}`);
    }
    if (this.cardinalityRejectionCount > 0) {
      lines.push(`# HELP emerald_telemetry_cardinality_rejections_total High-cardinality forbidden metric labels stripped`);
      lines.push(`# TYPE emerald_telemetry_cardinality_rejections_total counter`);
      lines.push(`emerald_telemetry_cardinality_rejections_total ${this.cardinalityRejectionCount}`);
    }

    return lines.length > 0 ? `${lines.join("\n")}\n` : "\n";
  }

  public close(): void {
    try {
      this.eventLoopMonitor?.disable();
    } catch {
      // ignore
    }
  }

  private getOrCreateFamily(
    name: string,
    type: "COUNTER" | "GAUGE" | "HISTOGRAM",
    help: string
  ): MetricFamilyState | undefined {
    const existing = this.families.get(name);
    if (existing) {
      return existing;
    }
    const created: MetricFamilyState = {
      name,
      type,
      help,
      series: new Map(),
      histograms: type === "HISTOGRAM" ? new Map() : undefined,
    };
    this.families.set(name, created);
    return created;
  }

  private buildSanitizedLabelKey(labels: MetricLabels): string {
    const keys = Object.keys(labels);
    if (keys.length === 0) {
      return "";
    }
    // Fast bounded cache lookup for repeated valid low-cardinality label combinations
    let rawCacheKey: string | undefined;
    if (keys.length <= 6) {
      rawCacheKey = "";
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (i > 0) rawCacheKey += "\u0000";
        rawCacheKey += `${k}=${labels[k]}`;
      }
      const cached = this.labelKeyCache.get(rawCacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const clean: Record<string, string> = {};
    let hadRejection = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (!LABEL_NAME_PATTERN.test(key)) {
        this.cardinalityRejectionCount++;
        hadRejection = true;
        continue;
      }
      if (FORBIDDEN_HIGH_CARDINALITY_LABELS.has(key.toLowerCase())) {
        this.cardinalityRejectionCount++;
        hadRejection = true;
        continue;
      }
      clean[key] = sanitizeTelemetryString(String(labels[key]), 128);
    }

    const formatted = formatLabelsKey(clean);
    if (!hadRejection && rawCacheKey !== undefined) {
      if (this.labelKeyCache.size >= MAX_LABEL_KEY_CACHE_SIZE) {
        this.labelKeyCache.clear();
      }
      this.labelKeyCache.set(rawCacheKey, formatted);
    }
    return formatted;
  }

  private resolveBoundedSeriesKey(family: MetricFamilyState, labels: MetricLabels): string {
    const key = this.buildSanitizedLabelKey(labels);
    if (family.series.has(key)) {
      return key;
    }
    if (family.series.size >= this.maxSeriesPerMetric) {
      this.overflowCount++;
      return `{__overflow="true"}`;
    }
    return key;
  }

  private resolveBoundedHistogramKey(family: MetricFamilyState, labels: MetricLabels): string {
    const key = this.buildSanitizedLabelKey(labels);
    if (!family.histograms) {
      return key;
    }
    if (family.histograms.has(key)) {
      return key;
    }
    if (family.histograms.size >= this.maxSeriesPerMetric) {
      this.overflowCount++;
      return `{__overflow="true"}`;
    }
    return key;
  }
}
