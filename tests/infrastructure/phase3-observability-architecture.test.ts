import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFastifyServer } from "../../src/transport/http/server.js";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import {
  EmeraldObservability,
  OtlpHttpJsonExporter,
  ObservabilityConfigurationError,
  formatTraceparent,
  parseTraceparent,
} from "../../src/infrastructure/monitoring/otel-observability.js";
import {
  SelfHostedLangfuseClient,
  LangfuseConfigurationError,
  assertSelfHostedLangfuseUrl,
} from "../../src/infrastructure/monitoring/langfuse-exporter.js";
import {
  TelemetryExporter,
  createTelemetryExporterFromEnv,
} from "../../src/infrastructure/monitoring/telemetry-exporter.js";
import { BoundedPrometheusRegistry } from "../../src/infrastructure/monitoring/prometheus-registry.js";
import {
  sanitizeTelemetryAttributes,
  sanitizeTelemetryString,
  sanitizeTelemetryValue,
} from "../../src/infrastructure/monitoring/telemetry-redaction.js";
import {
  validateAllGrafanaDashboards,
  validateGrafanaDashboard,
} from "../../src/infrastructure/monitoring/dashboard-validator.js";
import {
  evaluateCoreHealthAlerts,
  parseAndValidatePrometheusAlertsYaml,
  validatePrometheusConfigYaml,
} from "../../src/infrastructure/monitoring/alert-evaluator.js";
import { EmeraldLifecycleTelemetry } from "../../src/application/observability-instrumentation.js";
import { GovernedToolConnectorService } from "../../src/application/governed-tool-connector.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import {
  ScopedContextMemoryService,
  TruthFirewallViolationError,
} from "../../src/application/scoped-context-memory.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import { ProductionVerifier } from "../../src/verification/production-verifier.js";
import { createMissionContract, createResourceLimits, createDefaultInProcessPolicy, createVerificationSpec } from "../../src/domain/index.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { GovernedModelRouterService } from "../../src/application/governed-model-router.js";
import { SystemClock } from "../../src/ports/clock.port.js";

const VALID_TOKEN = "emerald-phase3-test-token-entropy-987654321";

function startLocalJsonCollector(): Promise<{
  url: string;
  requests: Array<{ path: string; auth?: string; body: any }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const requests: Array<{ path: string; auth?: string; body: any }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep raw
        }
        requests.push({
          path: req.url ?? "/",
          auth: req.headers.authorization,
          body: parsed,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Invalid server address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise<void>((resClose) => server.close(() => resClose())),
      });
    });
  });
}

describe("Phase 3 Comprehensive Monitoring & Observability Architecture", () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const fn = closers.pop();
      if (fn) await fn();
    }
  });

  it("propagates W3C traceparent & AsyncLocalStorage correlation without losing durable identifiers", async () => {
    const obs = new EmeraldObservability({
      serviceName: "emerald-test",
      environment: "ci",
      traceSampleRate: 1.0,
    });
    closers.push(() => obs.shutdown());

    const incomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const incomingParentSpan = "00f067aa0ba902b7";
    const parsed = parseTraceparent(`00-${incomingTraceId}-${incomingParentSpan}-01`);
    expect(parsed).toEqual({
      version: "00",
      traceId: incomingTraceId,
      parentSpanId: incomingParentSpan,
      sampled: true,
    });

    await obs.runWithCorrelation(
      {
        traceId: parsed!.traceId,
        parentSpanId: parsed!.parentSpanId,
        tenantId: "tenant-alpha",
        taskId: "task-123",
        runId: "run-456",
        attemptId: "attempt-1",
        agentId: "agent-researcher",
        parentTaskId: "mission-root",
        eventSequence: 7,
        executionMode: "fixture",
      },
      async () => {
        await obs.withSpanAsync("router.dispatch", { step: "admit" }, async (outerSpan) => {
          expect(outerSpan.traceId).toBe(incomingTraceId);
          expect(outerSpan.parentSpanId).toBe(incomingParentSpan);

          await new Promise((r) => setTimeout(r, 5));

          obs.withSpan("connector.execute", { connector: "read_file" }, (innerSpan) => {
            expect(innerSpan.traceId).toBe(incomingTraceId);
            expect(innerSpan.parentSpanId).toBe(outerSpan.spanId);
            obs.emitLog("INFO", "tool.called", "Tool completed cleanly");
          });
        });
      }
    );

    const spans = obs.getCompletedSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0]!.name).toBe("connector.execute");
    expect(spans[0]!.attributes["emerald.tenant_id"]).toBe("tenant-alpha");
    expect(spans[0]!.attributes["emerald.task_id"]).toBe("task-123");
    expect(spans[0]!.attributes["emerald.run_id"]).toBe("run-456");
    expect(spans[0]!.attributes["emerald.parent_task_id"]).toBe("mission-root");
    expect(spans[0]!.attributes["emerald.execution_mode"]).toBe("fixture");

    const logs = obs.getBufferedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.correlation.traceId).toBe(incomingTraceId);
    expect(logs[0]!.correlation.runId).toBe("run-456");
    expect(formatTraceparent(incomingTraceId, spans[1]!.spanId, true)).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/
    );
  });

  it("redacts bearer tokens, API keys, JWTs, private keys, URL credentials, and log injection characters before storage/export", () => {
    const dirtyString =
      "line1\r\nFAKE_LOG Bearer super-secret-token-123456 sk-lf-secretkey12345678 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig12345 https://admin:topsecret@localhost:9000/ingest";
    const clean = sanitizeTelemetryString(dirtyString);
    expect(clean).not.toContain("\r");
    expect(clean).not.toContain("\n");
    expect(clean).not.toContain("super-secret-token-123456");
    expect(clean).not.toContain("sk-lf-secretkey12345678");
    expect(clean).not.toContain("sig12345");
    expect(clean).not.toContain("topsecret");

    const redactedAttrs = sanitizeTelemetryAttributes({
      authorization: "Bearer secret99999999",
      apiKey: "sk-proj-abc1234567890",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      safeField: "ok-value",
    });
    expect(redactedAttrs.authorization).toBe("[REDACTED]");
    expect(redactedAttrs.apiKey).toBe("[REDACTED]");
    expect(String(redactedAttrs.privateKey)).not.toContain("abc");
    expect(redactedAttrs.safeField).toBe("ok-value");

    const deepObj = sanitizeTelemetryValue({
      nested: { token: "ghp_secretTokenValue12345" },
      cookie: "session_id=secretCookie999",
      pat: "glpat-secretGitLabToken1234",
    }) as any;
    expect(deepObj.nested.token).toBe("[REDACTED]");
    expect(deepObj.cookie).toBe("[REDACTED]");
    expect(deepObj.pat).toBe("[REDACTED_TOKEN]");
  });

  it("enforces bounded Prometheus cardinality, strips high-cardinality labels, and folds overflow series", () => {
    const reg = new BoundedPrometheusRegistry({ maxSeriesPerMetric: 10 });
    closers.push(() => reg.close());

    // High-cardinality labels stripped automatically
    reg.incrementCounter("emerald_test_counter", "Test help", {
      taskId: "task-should-be-stripped",
      runId: "run-should-be-stripped",
      status: "COMPLETED",
    });

    // Trigger series overflow (> 10 distinct series)
    for (let i = 0; i < 20; i++) {
      reg.incrementCounter("emerald_overflow_counter", "Overflow help", { bucket: `b${i}` });
    }

    const text = reg.exportPrometheusText();
    expect(text).not.toContain("task-should-be-stripped");
    expect(text).not.toContain("run-should-be-stripped");
    expect(text).toContain('emerald_test_counter{status="COMPLETED"} 1');
    expect(text).toContain('emerald_overflow_counter{__overflow="true"} 10');
    expect(text).toContain("emerald_telemetry_metric_overflow_total 10");
    expect(text).toContain("emerald_telemetry_cardinality_rejections_total 2");
  });

  it("rejects cloud Langfuse & unencrypted remote OTLP endpoints fail-closed while ingesting to localhost receiver", async () => {
    expect(() => assertSelfHostedLangfuseUrl("https://cloud.langfuse.com")).toThrow(
      LangfuseConfigurationError
    );
    expect(() => assertSelfHostedLangfuseUrl("http://remote-langfuse.example.com:3002")).toThrow(
      LangfuseConfigurationError
    );
    expect(() => assertSelfHostedLangfuseUrl("https://user:pass@localhost:3002")).toThrow(
      LangfuseConfigurationError
    );
    expect(() => new SelfHostedLangfuseClient({ baseUrl: "https://us.cloud.langfuse.com" })).toThrow(
      LangfuseConfigurationError
    );
    expect(
      () => new EmeraldObservability({ otlpEndpoint: "http://remote-collector.example.com:4318" })
    ).toThrow(ObservabilityConfigurationError);
    expect(
      () =>
        new EmeraldObservability({
          otlpEndpoint: "http://remote-collector.example.com:4318",
          allowInsecureLocalhost: true,
        })
    ).toThrow(ObservabilityConfigurationError);
    expect(
      () => new EmeraldObservability({ otlpEndpoint: "http://user:pass@127.0.0.1:4318" })
    ).toThrow(ObservabilityConfigurationError);
    expect(
      () => new EmeraldObservability({ otlpEndpoint: "http://[::1]:4318" }).shutdown()
    ).not.toThrow();

    const collector = await startLocalJsonCollector();
    closers.push(() => collector.close());

    const otlpExporter = new OtlpHttpJsonExporter({
      baseEndpoint: collector.url,
      timeoutMs: 1000,
    });
    const obs = new EmeraldObservability({ otlpEndpoint: collector.url }, otlpExporter);
    const langfuse = new SelfHostedLangfuseClient({
      baseUrl: collector.url,
      publicKey: "pk-local-emerald",
      secretKey: "sk-local-emerald-secret",
    });
    closers.push(() => obs.shutdown());

    const span = obs.startSpan("model.call", { model: "qwen2.5-coder:1.5b" });
    obs.endSpan(span.spanId, "OK");
    obs.emitLog("INFO", "model.finished", "Secret check Bearer my-secret-token-xyz123");

    langfuse.enqueueTrace({ id: span.traceId, name: "g4-eval", tags: ["fixture"] });
    langfuse.enqueueGeneration({
      id: "gen-1",
      traceId: span.traceId,
      parentObservationId: span.spanId,
      name: "ollama.generate",
      model: "qwen2.5-coder:1.5b",
      input: { prompt: "Fix bug", apiKey: "sk-secret-key-99999999" },
      output: "diff --git a/x.ts",
      usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    });
    langfuse.enqueueScore({
      traceId: span.traceId,
      name: "sovereign_verification_passed",
      value: 1,
    });

    await obs.flush();
    await langfuse.flush();

    expect(collector.requests.some((r) => r.path === "/v1/traces")).toBe(true);
    expect(collector.requests.some((r) => r.path === "/v1/logs")).toBe(true);
    const lfReq = collector.requests.find((r) => r.path === "/api/public/ingestion");
    expect(lfReq).toBeDefined();
    expect(lfReq!.auth).toMatch(/^Basic /);
    expect(JSON.stringify(lfReq!.body)).not.toContain("sk-secret-key-99999999");
    expect(langfuse.getHealth().exportedEvents).toBe(3);
  });

  it("isolates failing, timing-out, and overflowing exporters without blocking execution or shutdown", async () => {
    // 1. Failing/timeout custom exporter + tight buffer caps
    const hangingExporter = {
      exportSpans: () => new Promise<void>(() => { /* never resolves */ }),
      exportLogs: () => Promise.reject(new Error("collector 503")),
      shutdown: () => new Promise<void>(() => { /* hangs */ }),
    };

    const obs = new EmeraldObservability(
      {
        maxBufferedSpans: 16,
        maxBufferedLogs: 16,
        maxExportBatchSize: 4,
        maxExportQueueBatches: 2,
        exportTimeoutMs: 60,
        shutdownTimeoutMs: 100,
      },
      hangingExporter
    );

    // Overflow buffer intentionally
    for (let i = 0; i < 40; i++) {
      obs.withSpan(`op.${i}`, { idx: i }, () => "ok");
      obs.emitLog("WARN", "op.log", `log-${i}`);
    }

    const startMs = Date.now();
    await obs.flush(80);
    await obs.shutdown(120);
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(800);
    const health = obs.getPipelineHealth();
    expect(health.spansDropped).toBeGreaterThan(0);
    expect(health.exportFailures).toBeGreaterThan(0);

    // 2. Unreachable self-hosted Langfuse never throws during task execution
    const lf = new SelfHostedLangfuseClient({
      baseUrl: "http://127.0.0.1:19",
      exportTimeoutMs: 60,
      maxQueueEvents: 10,
    });
    for (let i = 0; i < 15; i++) {
      lf.enqueueScore({ traceId: "t1", name: "check", value: i });
    }
    await expect(lf.flush(80)).resolves.toBeUndefined();
    expect(lf.getHealth().exportFailures).toBe(1);
    expect(lf.getHealth().droppedEvents).toBeGreaterThan(0);
  });

  it("instruments full lifecycle end-to-end across SQLite, Router, Connectors, Scoped Memory, Model, Verification, Recovery, HTTP /metrics and /health", async () => {
    const collector = await startLocalJsonCollector();
    closers.push(() => collector.close());

    const exporter = new TelemetryExporter({
      observability: { otlpEndpoint: collector.url },
      langfuse: { baseUrl: collector.url, publicKey: "pk-test", secretKey: "sk-test" },
    });
    const lifecycle = new EmeraldLifecycleTelemetry(exporter.observability, exporter.langfuse, {
      defaultExecutionMode: "fixture",
    });

    const db = createSqliteClient({ location: ":memory:" });
    closers.push(() => db.close());
    const stateStore = new SqliteStateStore(db);
    stateStore.setTelemetry(lifecycle);

    const clock = new SystemClock();
    const coordinator = new RunCoordinator(stateStore, clock);
    const router = new TaskRouterService(stateStore, coordinator, clock, {
      maxConcurrentRuns: 2,
      telemetry: lifecycle,
    });

    const tenantId = "tenant-obs";
    const taskId = "task-obs-1";
    const nowIso = clock.nowIso();
    const contract = createMissionContract({
      contractId: "contract-obs-1",
      version: 1,
      taskId,
      policy: {
        ...createDefaultInProcessPolicy(tenantId),
        allowedCapabilities: ["FS_READ"],
      },
      verificationSpecs: [
        createVerificationSpec({
          specId: "v1",
          ruleKind: "EXIT_CODE_ZERO",
          expectedValue: 0,
        }),
      ],
      resourceLimits: createResourceLimits({ timeoutMs: 5000, maxAttempts: 1, maxOutputBytes: 4096 }),
      credentialScopes: [],
    });
    stateStore.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Observability e2e task",
        description: "Verify telemetry propagation",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      tx.insertContract(contract);
      tx.activateContract(contract.spec.contractId, 1, nowIso);
    });

    // Execute inside correlation scope
    await lifecycle.withCorrelation({ tenantId, taskId }, async () => {
      const sub = router.submitTask({ submissionKey: "subm-obs-1", taskId });
      expect(sub.duplicate).toBe(false);
      router.dispatchTick();

      // Connector execution + capability denial
      const connectors = new GovernedToolConnectorService(undefined, lifecycle);
      connectors.registerConnector({
        connectorId: "safe_echo",
        name: "Safe Echo",
        description: "Echo",
        requiredCapability: "FS_READ",
        isIdempotent: true,
        inputSchema: z.object({ msg: z.string() }),
        outputSchema: z.string(),
        execute: async (input) => ({ success: true, output: input.msg, truncated: false, durationMs: 1, bytesEmitted: 5, executionHash: "h1" }),
      });
      await connectors.executeConnector("safe_echo", { msg: "hello" }, {
        tenantId,
        taskId,
        runId: sub.runId,
        contractId: contract.spec.contractId,
        authorizedCapabilities: ["FS_READ"],
        timeoutMs: 500,
        maxOutputBytes: 1024,
      });
      await expect(
        connectors.executeConnector("safe_echo", { msg: "deny" }, {
          tenantId,
          taskId,
          runId: sub.runId,
          contractId: contract.spec.contractId,
          authorizedCapabilities: [],
          timeoutMs: 500,
          maxOutputBytes: 1024,
        })
      ).rejects.toThrow();

      // Scoped memory write + Truth Firewall rejection without content leakage
      const memory = new ScopedContextMemoryService(stateStore, { telemetry: lifecycle });
      const sensitiveSecretMemory = "PRIVATE_MEMORY_SECRET_VALUE_999111";
      memory.recordEntry(tenantId, taskId, "PROJECT_KNOWLEDGE", "unit-test", sensitiveSecretMemory);
      expect(() =>
        memory.recordEntry(tenantId, taskId, "VERIFIED_EVIDENCE", "model-x", "spoofed", {
          isModelGenerated: true,
        })
      ).toThrow(TruthFirewallViolationError);
      memory.compileContextForPrompt(tenantId, taskId, {
        maxTokens: 500,
        role: "RESEARCHER",
        includeProjectKnowledge: true,
      });

      // Mocked Ollama model call (zero live inference!)
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            model: "qwen2.5-coder:1.5b",
            message: { role: "assistant", content: "Proposed fix" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 15,
            eval_count: 8,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      const modelProvider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: "qwen2.5-coder:1.5b",
        fetch: mockFetch,
        telemetry: lifecycle,
      });
      await modelProvider.generate({
        requestId: "req-obs-1",
        model: "qwen2.5-coder:1.5b",
        timeoutMs: 5000,
        input: [{ role: "user", content: "Inspect bug" }],
      });

      // Sovereign verifier + Langfuse score
      const verifier = new ProductionVerifier(clock, lifecycle);
      await verifier.verify({ workspacePath: process.cwd() });

      // Model router fail-closed decision metric + Recovery observer
      const modelRouter = new GovernedModelRouterService({ telemetry: lifecycle });
      expect(() =>
        modelRouter.routeModel({
          role: "CODER",
          tenantId,
          taskId,
          contractId: contract.spec.contractId,
          remainingBudgetMs: 120000,
          stepBudgetMs: 30000,
          estimatedContextTokens: 500,
        })
      ).toThrow();
      const runControl = new RunControl(coordinator, stateStore, clock);
      const prodRun = runControl.createRun({
        missionId: "mission-obs-1",
        taskId,
        contract,
        status: "ACTIVE",
        createdAt: nowIso,
        updatedAt: nowIso,
        objective: "Verify recovery telemetry",
        title: "Obs Recovery",
      } as any);
      const recoverySvc = new ProductionRecoveryService(runControl, undefined, clock, lifecycle);
      recoverySvc.recoverRun(prodRun.runId);
    });

    // Fastify HTTP server /metrics & /health + W3C traceparent
    const server = buildFastifyServer({
      principals: [{ token: VALID_TOKEN, principalId: "op1", tenantId, role: "operator" }],
      store: stateStore,
      telemetryExporter: exporter,
      lifecycleTelemetry: lifecycle,
    });
    closers.push(() => server.close());

    const healthRes = await server.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const healthJson = healthRes.json();
    expect(healthJson.status).toBe("ok");
    expect(healthJson.zeroAuthority).toBe(true);
    expect(healthJson.store.reachable).toBe(true);

    const metricsRes = await server.inject({ method: "GET", url: "/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    const metricsBody = metricsRes.body;
    expect(metricsBody).toContain('emerald_router_submissions_total{execution_mode="fixture",outcome="admitted"} 1');
    expect(metricsBody).toContain('emerald_connector_executions_total{connector_id="safe_echo",execution_mode="fixture",status="denied"} 1');
    expect(metricsBody).toContain('emerald_memory_truth_firewall_rejections_total{execution_mode="fixture",scope="VERIFIED_EVIDENCE"} 1');
    expect(metricsBody).toContain('emerald_model_requests_total{execution_mode="fixture",model="qwen2.5-coder:1.5b",provider="ollama",status="ok"} 1');
    expect(metricsBody).toContain('emerald_verifications_total{execution_mode="fixture",verified="true"} 1');
    expect(metricsBody).toContain('emerald_model_routing_decisions_total{execution_mode="fixture",outcome="blocked",role="CODER"} 1');
    expect(metricsBody).toContain('emerald_recovery_runs_total{execution_mode="fixture",outcome="FAILED"} 1');
    expect(metricsBody).not.toContain("emerald_recovery_worker_leases_expired_observed_total");
    expect(metricsBody).toContain('emerald_tasks_total{execution_mode="fixture"} 1');
    expect(metricsBody).toContain('emerald_runs_total{execution_mode="fixture",status="QUEUED"} 1');
    expect(metricsBody).toContain("emerald_sqlite_operations_total");
    expect(metricsBody).toContain("emerald_process_resident_memory_bytes");
    // Ensure raw scoped memory payload NEVER leaks into Prometheus or telemetry logs
    expect(metricsBody).not.toContain("PRIVATE_MEMORY_SECRET_VALUE_999111");
    expect(JSON.stringify(exporter.observability.getBufferedLogs())).not.toContain(
      "PRIVATE_MEMORY_SECRET_VALUE_999111"
    );

    // Alert rules evaluate Truth Firewall trigger on this exact scrape
    const evalAlerts = evaluateCoreHealthAlerts(metricsBody);
    const fwAlert = evalAlerts.find((a) => a.alert === "EmeraldTruthFirewallRejections");
    expect(fwAlert?.firing).toBe(true);

    await exporter.flush();
    expect(exporter.langfuse.getHealth().exportedEvents).toBeGreaterThanOrEqual(2);
    expect(healthJson.langfuse).not.toHaveProperty("baseUrl");
    expect(healthJson.observability).not.toHaveProperty("lastExportError");

    // Concurrent flush coalescing & transient error health recovery
    let failOnce = true;
    let exportedCount = 0;
    const flakyObs = new EmeraldObservability(
      { maxExportBatchSize: 2, exportTimeoutMs: 500 },
      {
        exportSpans: async (batch) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("transient 503");
          }
          await new Promise((r) => setTimeout(r, 10));
          exportedCount += batch.length;
        },
      }
    );
    closers.push(() => flakyObs.shutdown());
    flakyObs.withSpan("s1", {}, () => "ok");
    await flakyObs.flush();
    expect(flakyObs.getPipelineHealth().healthy).toBe(false);
    flakyObs.withSpan("s2", {}, () => "ok");
    flakyObs.withSpan("s3", {}, () => "ok");
    await Promise.all([flakyObs.flush(), flakyObs.flush()]);
    expect(exportedCount).toBe(2);
    expect(flakyObs.getPipelineHealth().healthy).toBe(true);
  });

  it("validates all 10 Grafana dashboard JSON specs and all Prometheus alert rules", () => {
    const repoRoot = process.cwd();
    const dashDir = path.join(repoRoot, "infra", "monitoring", "grafana", "provisioning", "dashboards");
    const files = fs
      .readdirSync(dashDir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    expect(files).toHaveLength(10);
    for (const file of files) {
      const parsed = JSON.parse(fs.readFileSync(path.join(dashDir, file), "utf8"));
      const report = validateGrafanaDashboard(parsed);
      expect(report.errors, `Dashboard ${file} validation errors`).toEqual([]);
      expect(report.valid).toBe(true);
      expect(report.panelCount).toBeGreaterThanOrEqual(2);
    }

    const alertsYaml = fs.readFileSync(
      path.join(repoRoot, "infra", "monitoring", "prometheus-alerts.yml"),
      "utf8"
    );
    const alertReport = parseAndValidatePrometheusAlertsYaml(alertsYaml);
    expect(alertReport.errors).toEqual([]);
    expect(alertReport.valid).toBe(true);
    expect(alertReport.rules.length).toBeGreaterThanOrEqual(12);

    const allDashReport = validateAllGrafanaDashboards(
      files.map((file) => ({
        file,
        spec: JSON.parse(fs.readFileSync(path.join(dashDir, file), "utf8")),
      }))
    );
    expect(allDashReport.errors).toEqual([]);
    expect(allDashReport.valid).toBe(true);

    const promConfigYaml = fs.readFileSync(
      path.join(repoRoot, "infra", "monitoring", "prometheus.yml"),
      "utf8"
    );
    const promConfigReport = validatePrometheusConfigYaml(promConfigYaml);
    expect(promConfigReport.errors).toEqual([]);
    expect(promConfigReport.valid).toBe(true);
  });

  it("redacts Slack hyphenated tokens, non-HTTP DSNs, OS local paths, and handles circular/throwing values safely", () => {
    const raw =
      "slack=xoxb-1234567890-abcdef123456 db=postgresql://admin:Sup3rSecret!@db.internal:5432/emerald path1=C:\\Users\\alice\\secrets\\key.pem path2=/home/bob/.ssh/id_rsa";
    const scrubbed = sanitizeTelemetryString(raw, 512);
    expect(scrubbed).not.toContain("xoxb-1234567890");
    expect(scrubbed).not.toContain("Sup3rSecret");
    expect(scrubbed).not.toContain("alice");
    expect(scrubbed).not.toContain("bob");

    const circular: Record<string, unknown> = {
      credentialScopes: ["FS_READ"],
      idempotencyToken: "idem-safe-123",
      promptTokens: 42,
      signingKey: "super-secret-signing-key",
    };
    circular.self = circular;
    Object.defineProperty(circular, "badGetter", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    const sanitized = sanitizeTelemetryValue(circular) as Record<string, unknown>;
    expect(sanitized.credentialScopes).toEqual(["FS_READ"]);
    expect(sanitized.idempotencyToken).toBe("idem-safe-123");
    expect(sanitized.promptTokens).toBe(42);
    expect(sanitized.signingKey).toBe("[REDACTED]");
    expect(sanitized.self).toBe("[CIRCULAR]");
    expect(sanitized.badGetter).toBe("[UNSERIALIZABLE_VALUE]");

    const proxyBoom = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy boom");
        },
      }
    );
    const attrs = sanitizeTelemetryAttributes({
      proxyBoom,
    });
    expect(attrs.proxyBoom).toBe("[UNSERIALIZABLE_OBJECT]");
  });

  it("enforces privacy-by-default prompt hashing, OTel SpanKind/exceptions, Langfuse tool spans, and health separation", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          model: "qwen2.5-coder:1.5b",
          message: { role: "assistant", content: "SENSITIVE_OUTPUT_TEXT_XYZ" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 11,
          eval_count: 7,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const capturedBatches: any[] = [];
    let shutdownCalls = 0;
    const obs = new EmeraldObservability(
      { serviceName: "emerald-test", exportTimeoutMs: 500 },
      {
        async exportSpans(spans) {
          capturedBatches.push(...spans);
        },
        async shutdown() {
          shutdownCalls++;
        },
      }
    );

    const ingestedLangfuse: any[] = [];
    const serverHttp = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/api/public/ingestion") {
          ingestedLangfuse.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        }
        res.statusCode = 200;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => serverHttp.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => serverHttp.close(() => resolve())));
    const port = (serverHttp.address() as any).port;

    const langfuse = new SelfHostedLangfuseClient({
      baseUrl: `http://127.0.0.1:${port}`,
      enabled: true,
    });
    const telemetry = new EmeraldLifecycleTelemetry(obs, langfuse, {
      defaultExecutionMode: "fixture",
    });

    const providerDefault = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: mockFetch,
      telemetry,
    });

    await obs.withSpanAsync("agent.step", {}, async () => {
      await providerDefault.generate({
        requestId: "req-priv-1",
        model: "qwen2.5-coder:1.5b",
        timeoutMs: 2000,
        input: [{ role: "user", content: "SENSITIVE_PROMPT_SECRET_ABC" }],
      });
      telemetry.recordModelInvocation({
        provider: "ollama",
        model: "qwen2.5-coder:1.5b",
        status: "ok",
        durationMs: 12,
        startTimeIso: new Date().toISOString(),
        endTimeIso: new Date().toISOString(),
        requestId: "req-priv-versioned",
        promptName: "g4_repair_system",
        promptVersion: 3,
        harnessVersion: "harness-0.1",
      });
      telemetry.recordConnectorAuditEvent({
        eventType: "connector.completed",
        connectorId: "fs_read",
        tenantId: "t1",
        taskId: "task1",
        runId: "run1",
        timestamp: new Date().toISOString(),
        inputHash: "abc123",
        durationMs: 5,
        bytesEmitted: 64,
      });
    });

    await expect(
      obs.withSpanAsync("failing.step", {}, async () => {
        throw new Error("Simulated failure in /Users/alice/repo/secret.ts");
      })
    ).rejects.toThrow();

    await langfuse.flush();
    await obs.flush();

    // Prompt privacy-by-default: raw prompt/output never sent unless opted in
    const serializedLangfuse = JSON.stringify(ingestedLangfuse);
    expect(serializedLangfuse).not.toContain("SENSITIVE_PROMPT_SECRET_ABC");
    expect(serializedLangfuse).not.toContain("SENSITIVE_OUTPUT_TEXT_XYZ");
    expect(serializedLangfuse).toContain("sha256_metadata_only");
    expect(serializedLangfuse).toContain('"type":"span-create"');
    expect(serializedLangfuse).toContain('"promptName":"g4_repair_system"');
    expect(serializedLangfuse).toContain('"promptVersion":3');
    expect(serializedLangfuse).toContain('"harnessVersion":"harness-0.1"');

    // OTel SpanKind + exception event assertions
    const modelSpan = capturedBatches.find((s) => s.name === "model.ollama.generate");
    expect(modelSpan?.kind).toBe("CLIENT");
    const errSpan = capturedBatches.find((s) => s.name === "failing.step");
    expect(errSpan?.status).toBe("ERROR");
    const exEvent = errSpan?.events.find((e: any) => e.name === "exception");
    expect(exEvent?.attributes["exception.type"]).toBe("Error");
    expect(exEvent?.attributes["exception.message"]).not.toContain("alice");

    // /health separation: telemetry failure degrades telemetryStatus only, not coreStatus
    const degradedExporter = new TelemetryExporter({
      observability: { exportTimeoutMs: 500 },
      batchExporter: {
        async exportSpans() {
          throw new Error("OTLP down");
        },
      },
    });
    const s = degradedExporter.observability.startSpan("test.op");
    degradedExporter.observability.endSpan(s.spanId, "OK");
    await degradedExporter.flush();

    const apiServer = buildFastifyServer({
      principals: [{ token: VALID_TOKEN, principalId: "op1", tenantId: "t1", role: "operator" }],
      telemetryExporter: degradedExporter,
    });
    closers.push(() => apiServer.close());

    const health = (await apiServer.inject({ method: "GET", url: "/health" })).json();
    expect(health.coreStatus).toBe("ok");
    expect(health.telemetryStatus).toBe("degraded");
    expect(health.status).toBe("ok");

    const httpSpan = degradedExporter.observability.getCompletedSpans().find((sp) => sp.name === "http.request");
    expect(httpSpan?.kind).toBe("SERVER");

    // Idempotent repeated shutdown calls
    await obs.shutdown();
    await obs.shutdown();
    expect(shutdownCalls).toBe(1);

    // Env config fails closed on cloud Langfuse URL
    expect(() =>
      createTelemetryExporterFromEnv({ EMERALD_LANGFUSE_BASE_URL: "https://cloud.langfuse.com" })
    ).toThrow(LangfuseConfigurationError);
    const defaultEnvExp = createTelemetryExporterFromEnv({});
    expect(defaultEnvExp.getHealth().langfuse.configured).toBe(false);
    await defaultEnvExp.shutdown();
  });

  it("rejects duplicate UIDs, missing execution_mode filters, and malformed Prometheus alert durations", () => {
    const badDash = validateAllGrafanaDashboards([
      {
        file: "a.json",
        spec: {
          uid: "dup-uid-1",
          title: "Dash A",
          schemaVersion: 38,
          templating: { list: [{ name: "execution_mode", type: "custom" }] },
          panels: [
            {
              id: 1,
              title: "Tasks without mode filter",
              type: "stat",
              gridPos: { h: 6, w: 12, x: 0, y: 0 },
              targets: [{ refId: "A", expr: "sum(emerald_tasks_total)" }],
            },
          ],
        },
      },
      {
        file: "b.json",
        spec: {
          uid: "dup-uid-1",
          title: "Dash B",
          schemaVersion: 38,
          templating: { list: [{ name: "execution_mode", type: "custom" }] },
          panels: [
            {
              id: 1,
              title: "Ok",
              type: "stat",
              gridPos: { h: 6, w: 12, x: 0, y: 0 },
              targets: [{ refId: "A", expr: "sum(emerald_http_errors_total)" }],
            },
          ],
        },
      },
    ]);
    expect(badDash.valid).toBe(false);
    expect(badDash.errors.some((e) => e.includes("execution_mode filter"))).toBe(true);
    expect(badDash.errors.some((e) => e.includes("Duplicate dashboard uid"))).toBe(true);

    const badAlerts = parseAndValidatePrometheusAlertsYaml(`
groups:
  - name: g1
    rules:
      - alert: BadAlert
        expr: sum(emerald_tasks_total
        for: 5minutes
        labels:
          severity: fatal
        annotations:
          summary: "bad"
`);
    expect(badAlerts.valid).toBe(false);
    expect(badAlerts.errors.some((e) => e.includes("unbalanced delimiters"))).toBe(true);
    expect(badAlerts.errors.some((e) => e.includes("invalid Prometheus 'for' duration"))).toBe(true);
    expect(badAlerts.errors.some((e) => e.includes("unsupported severity"))).toBe(true);
    expect(badAlerts.errors.some((e) => e.includes("missing description annotation"))).toBe(true);
    expect(badAlerts.errors.some((e) => e.includes("execution_mode"))).toBe(true);
  });

  it("remediates short POSIX path bypass, hostile Error/Array proxies, late-settling flush race, Langfuse health visibility, and CLI flags", async () => {
    // [M-03] Short (<8 char) POSIX local paths must still be redacted
    expect(sanitizeTelemetryString("/root/a")).toBe("[REDACTED_LOCAL_PATH]");
    expect(sanitizeTelemetryString("/home/u")).toBe("[REDACTED_LOCAL_PATH]");

    // [L-01] Hostile Error getters & Array Proxy traps must not crash telemetry serialization
    const hostileError = new Error("initial");
    Object.defineProperty(hostileError, "message", {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(sanitizeTelemetryValue(hostileError)).toBe("[UNSERIALIZABLE_ERROR]");

    const hostileArray = new Proxy([1, 2], {
      get(target, prop, receiver) {
        if (prop === "1") throw new Error("array trap");
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(sanitizeTelemetryValue(hostileArray)).toEqual([1, "[UNSERIALIZABLE_VALUE]"]);

    // [M-02] Slow late-settling exporter must NEVER splice post-timeout spans queued afterward
    let exportedLaterCount = 0;
    let firstExport = true;
    const slowObs = new EmeraldObservability(
      { maxExportBatchSize: 2, exportTimeoutMs: 50 },
      {
        async exportSpans(batch) {
          if (firstExport) {
            firstExport = false;
            await new Promise((r) => setTimeout(r, 120));
          }
          exportedLaterCount += batch.length;
        },
      }
    );
    closers.push(() => slowObs.shutdown());
    const sp1 = slowObs.startSpan("slow.1");
    slowObs.endSpan(sp1.spanId, "OK");
    await slowObs.flush(50);
    // Queue a second span after timeout; wait for the stalled promise to finish, then flush again
    const sp2 = slowObs.startSpan("fast.2");
    slowObs.endSpan(sp2.spanId, "OK");
    await new Promise((r) => setTimeout(r, 100));
    await slowObs.flush(200);
    expect(exportedLaterCount).toBe(2);

    // [L-02] Langfuse export failures degrade /health telemetryStatus without degrading coreStatus
    const closedPort = 65439;
    const lfDegradedExp = new TelemetryExporter({
      langfuse: {
        baseUrl: `http://127.0.0.1:${closedPort}`,
        enabled: true,
        exportTimeoutMs: 100,
      },
    });
    lfDegradedExp.langfuse.enqueueTrace({ id: "t-lf-fail", name: "lf.fail" });
    await lfDegradedExp.flush(150);
    const lfServer = buildFastifyServer({
      principals: [{ token: VALID_TOKEN, principalId: "op1", tenantId: "t1", role: "operator" }],
      telemetryExporter: lfDegradedExp,
    });
    closers.push(() => lfServer.close());
    const lfHealth = (await lfServer.inject({ method: "GET", url: "/health" })).json();
    expect(lfHealth.coreStatus).toBe("ok");
    expect(lfHealth.telemetryStatus).toBe("degraded");
    expect(lfHealth.status).toBe("ok");

    // [M-01] CLI server accepts --otlp-endpoint and --langfuse-base-url flags and fails closed on cloud URL
    const cli = new EmeraldCli();
    const cliRes = await cli.run([
      "server",
      "--db",
      ":memory:",
      "--otlp-endpoint",
      "http://127.0.0.1:4318",
      "--langfuse-base-url",
      "https://cloud.langfuse.com",
    ]);
    expect(cliRes.exitCode).toBe(1);
    expect(cliRes.output).not.toContain("unknown option");
    expect(cliRes.output).toContain("Cloud-hosted endpoint");
  });
});
