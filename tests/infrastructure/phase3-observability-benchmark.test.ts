import { describe, expect, it } from "vitest";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { EmeraldLifecycleTelemetry } from "../../src/application/observability-instrumentation.js";
import { ScopedContextMemoryService } from "../../src/application/scoped-context-memory.js";
import { EmeraldObservability } from "../../src/infrastructure/monitoring/otel-observability.js";
import { SystemClock } from "../../src/ports/clock.port.js";

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

describe("Phase 3 Observability Performance & Overhead Benchmark", () => {
  it("measures warmed interleaved multi-batch overhead, total RSS delta, and empirically bounded latency", async () => {
    const warmupOps = 50;
    const batches = 5;
    const opsPerBatch = 100;
    const totalIterations = batches * opsPerBatch;
    const clock = new SystemClock();
    const nowIso = clock.nowIso();

    // 1. JIT Warmup (excluded from measured statistics)
    {
      const warmDb = createSqliteClient({ location: ":memory:" });
      const warmStore = new SqliteStateStore(warmDb);
      warmStore.transaction((tx) => {
        tx.insertTask({
          taskId: "warm-task",
          title: "Warmup",
          description: "Warmup",
          inputPayload: {},
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      });
      const warmObs = new EmeraldObservability({
        maxBufferedSpans: 256,
        maxBufferedLogs: 256,
        maxSeriesPerMetric: 200,
      });
      const warmLifecycle = new EmeraldLifecycleTelemetry(warmObs, undefined, {
        defaultExecutionMode: "fixture",
      });
      warmStore.setTelemetry(warmLifecycle);
      const warmMem = new ScopedContextMemoryService(warmStore, { telemetry: warmLifecycle });
      warmLifecycle.withCorrelation({ tenantId: "warm-tenant", taskId: "warm-task" }, () => {
        for (let i = 0; i < warmupOps; i++) {
          warmObs.withSpan("memory.record", { idx: i }, () => {
            warmMem.recordEntry("warm-tenant", "warm-task", "PROJECT_KNOWLEDGE", "bench", `warm-${i}`);
          });
        }
      });
      await warmObs.shutdown();
      warmDb.close();
    }

    // Measure baseline RSS BEFORE allocating baseline store vs BEFORE allocating observability
    const rssBeforeTotal = process.memoryUsage().rss;

    const dbOff = createSqliteClient({ location: ":memory:" });
    const storeOff = new SqliteStateStore(dbOff);
    storeOff.transaction((tx) => {
      tx.insertTask({
        taskId: "bench-task",
        title: "Benchmark",
        description: "Baseline",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    });
    const memOff = new ScopedContextMemoryService(storeOff);

    const dbOn = createSqliteClient({ location: ":memory:" });
    const storeOn = new SqliteStateStore(dbOn);
    storeOn.transaction((tx) => {
      tx.insertTask({
        taskId: "bench-task",
        title: "Benchmark",
        description: "Instrumented",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    });

    const rssBeforeObs = process.memoryUsage().rss;
    const obs = new EmeraldObservability({
      maxBufferedSpans: 256,
      maxBufferedLogs: 256,
      maxSeriesPerMetric: 200,
    });
    const lifecycle = new EmeraldLifecycleTelemetry(obs, undefined, {
      defaultExecutionMode: "fixture",
    });
    storeOn.setTelemetry(lifecycle);
    const memOn = new ScopedContextMemoryService(storeOn, { telemetry: lifecycle });

    // 2. Interleaved multi-batch execution (reduces JIT/GC ordering bias)
    const baselineBatchMs: number[] = [];
    const instrumentedBatchMs: number[] = [];
    const overheadPerOpSamplesMs: number[] = [];

    for (let b = 0; b < batches; b++) {
      const runBaseline = () => {
        const t0 = performance.now();
        for (let i = 0; i < opsPerBatch; i++) {
          const idx = b * opsPerBatch + i;
          memOff.recordEntry("bench-tenant", "bench-task", "PROJECT_KNOWLEDGE", "bench", `entry-${idx}`);
        }
        return performance.now() - t0;
      };

      const runInstrumented = () => {
        const t1 = performance.now();
        lifecycle.withCorrelation({ tenantId: "bench-tenant", taskId: "bench-task" }, () => {
          for (let i = 0; i < opsPerBatch; i++) {
            const idx = b * opsPerBatch + i;
            obs.withSpan("memory.record", { idx }, () => {
              memOn.recordEntry("bench-tenant", "bench-task", "PROJECT_KNOWLEDGE", "bench", `entry-${idx}`);
            });
          }
        });
        return performance.now() - t1;
      };

      let offMs: number;
      let onMs: number;
      if (b % 2 === 0) {
        offMs = runBaseline();
        onMs = runInstrumented();
      } else {
        onMs = runInstrumented();
        offMs = runBaseline();
      }
      baselineBatchMs.push(offMs);
      instrumentedBatchMs.push(onMs);
      overheadPerOpSamplesMs.push((onMs - offMs) / opsPerBatch);
    }

    const rssAfterTotal = process.memoryUsage().rss;
    const metricsPayloadBytes = Buffer.byteLength(obs.exportPrometheusMetrics(), "utf8");

    const sortedOverhead = [...overheadPerOpSamplesMs].sort((a, b) => a - b);
    const sortedBase = [...baselineBatchMs].sort((a, b) => a - b);
    const sortedInst = [...instrumentedBatchMs].sort((a, b) => a - b);
    const baselineTotalMs = baselineBatchMs.reduce((a, b) => a + b, 0);
    const instrumentedTotalMs = instrumentedBatchMs.reduce((a, b) => a + b, 0);
    const meanOverheadPerOpMs = (instrumentedTotalMs - baselineTotalMs) / totalIterations;
    const medianOverheadPerOpMs = quantile(sortedOverhead, 0.5);
    const p95OverheadPerOpMs = quantile(sortedOverhead, 0.95);

    const health = obs.getPipelineHealth();
    console.info(
      JSON.stringify({
        benchmark: "phase3-observability-overhead-v2",
        warmupOps,
        batches,
        opsPerBatch,
        totalIterations,
        baselineTotalMs: Number(baselineTotalMs.toFixed(2)),
        instrumentedTotalMs: Number(instrumentedTotalMs.toFixed(2)),
        medianBaselineBatchMs: Number(quantile(sortedBase, 0.5).toFixed(2)),
        medianInstrumentedBatchMs: Number(quantile(sortedInst, 0.5).toFixed(2)),
        meanOverheadPerOpMs: Number(meanOverheadPerOpMs.toFixed(4)),
        medianOverheadPerOpMs: Number(medianOverheadPerOpMs.toFixed(4)),
        p95OverheadPerOpMs: Number(p95OverheadPerOpMs.toFixed(4)),
        rssBeforeTotalBytes: rssBeforeTotal,
        rssBeforeObsBytes: rssBeforeObs,
        rssAfterTotalBytes: rssAfterTotal,
        rssDeltaTotalBytes: rssAfterTotal - rssBeforeTotal,
        rssDeltaObservabilityPlusRunBytes: rssAfterTotal - rssBeforeObs,
        metricsPayloadBytes,
        pipelineHealth: health,
      })
    );

    await obs.shutdown();
    dbOff.close();
    dbOn.close();

    expect(metricsPayloadBytes).toBeLessThan(65536);
    expect(health.metricSeriesCount).toBeLessThan(200);
    expect(obs.getCompletedSpans().length).toBeLessThanOrEqual(256);
    // Empirically justified upper bound (< 0.85 ms/op even under concurrent test workers; baseline pre-remediation was 1.1381 ms/op)
    expect(meanOverheadPerOpMs).toBeLessThan(0.85);
    expect(medianOverheadPerOpMs).toBeLessThan(0.85);
  });

  it("isolates export queue saturation and failing exporter backpressure without throwing or leaking buffers", async () => {
    let exportCalls = 0;
    const saturatedObs = new EmeraldObservability(
      {
        maxBufferedSpans: 32,
        maxBufferedLogs: 32,
        maxExportBatchSize: 8,
        maxExportQueueBatches: 2,
        exportTimeoutMs: 60,
        shutdownTimeoutMs: 80,
      },
      {
        async exportSpans() {
          exportCalls++;
          throw new Error("Simulated collector ECONNREFUSED postgresql://user:pass@db:5432/prod");
        },
        async exportLogs() {
          throw new Error("Simulated log collector timeout");
        },
      }
    );

    for (let i = 0; i < 64; i++) {
      const span = saturatedObs.startSpan("sat.op", { idx: i });
      saturatedObs.endSpan(span.spanId, "OK");
      saturatedObs.emitLog("INFO", "sat.log", `msg-${i}`);
    }

    await saturatedObs.flush(60);
    const health = saturatedObs.getPipelineHealth();

    console.info(
      JSON.stringify({
        benchmark: "phase3-export-saturation",
        exportCalls,
        health,
      })
    );

    expect(health.spansRecorded).toBe(64);
    expect(health.spansDropped).toBeGreaterThan(0);
    expect(health.exportFailures).toBeGreaterThan(0);
    expect(health.lastExportError).not.toContain("pass@");
    expect(saturatedObs.getCompletedSpans().length).toBeLessThanOrEqual(32);
    expect(saturatedObs.getBufferedLogs().length).toBeLessThanOrEqual(32);

    // Repeated shutdown remains strictly idempotent
    await saturatedObs.shutdown(60);
    await saturatedObs.shutdown(60);
  });
});
