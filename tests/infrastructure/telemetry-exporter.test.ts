import { describe, expect, it } from "vitest";
import { TelemetryExporter } from "../../src/infrastructure/monitoring/telemetry-exporter.js";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";

describe("OpenTelemetry, Prometheus, and Langfuse Telemetry Exporter", () => {
  const exporter = new TelemetryExporter();

  it("records vendor-neutral spans and tracks status and duration", () => {
    const span = exporter.startSpan("step.execute", {
      traceId: "trace-999",
      spanId: "span-1",
    }, {
      role: "CODER",
      model: "qwen2.5-coder:1.5b",
    });

    expect(span.name).toBe("step.execute");
    expect(span.status).toBe("UNSET");

    exporter.endSpan("span-1", "OK");
    expect(span.status).toBe("OK");
    expect(span.endTimeMs).toBeGreaterThanOrEqual(span.startTimeMs);
  });

  it("exports Prometheus metrics in standard exposition format", () => {
    exporter.recordMetric({
      name: "emerald_runs_total",
      type: "COUNTER",
      help: "Total runs processed",
      value: 42,
      labels: { status: "COMPLETED", tenant: "tenant-alpha" },
    });

    exporter.recordMetric({
      name: "emerald_step_duration_seconds",
      type: "GAUGE",
      help: "Last step duration in seconds",
      value: 1.45,
      labels: { role: "CODER" },
    });

    const output = exporter.exportPrometheusMetrics();

    expect(output).toContain("# HELP emerald_runs_total Total runs processed");
    expect(output).toContain("# TYPE emerald_runs_total counter");
    expect(output).toContain('emerald_runs_total{status="COMPLETED",tenant="tenant-alpha"} 42');
    expect(output).toContain('emerald_step_duration_seconds{role="CODER"} 1.45');
  });

  it("formats self-hosted Langfuse generation payloads accurately", () => {
    const formatted = exporter.formatLangfuseGeneration({
      id: "gen-1",
      traceId: "trace-999",
      name: "action_proposal",
      model: "qwen2.5-coder:1.5b",
      input: { prompt: "Write solver" },
      output: { tool: "write_file", path: "solution.js" },
      usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
      startTime: "2026-11-10T20:00:00.000Z",
      endTime: "2026-11-10T20:00:02.500Z",
    });

    expect(formatted.type).toBe("GENERATION");
    expect(formatted.model).toBe("qwen2.5-coder:1.5b");
    expect((formatted.usage as any).totalTokens).toBe(165);
    expect((formatted.metadata as any).framework).toBe("emerald-agent-fabric");
  });

  it("exposes GET /metrics endpoint over Fastify server with Prometheus content-type", async () => {
    const principals: PrincipalRecord[] = [
      { token: "test-token-11111111111111111111", principalId: "p1", tenantId: "tenant-alpha", role: "operator" },
    ];
    const server = buildFastifyServer({
      principals,
      telemetryExporter: exporter,
    });

    const res = await server.inject({
      method: "GET",
      url: "/metrics",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(res.body).toContain("emerald_runs_total");
    await server.close();
  });
});
