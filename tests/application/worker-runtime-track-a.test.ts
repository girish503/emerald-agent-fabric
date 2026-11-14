/**
 * Integration & Lifecycle Tests for Track A Items 2 & 3:
 * - BoundedRepairLoopController post-verification recovery in WorkerRuntime
 * - ObservabilityPort injection into WorkerRuntime lifecycle
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { BoundedRepairLoopController } from "../../src/application/bounded-repair-loop.js";
import { EmeraldObservability } from "../../src/infrastructure/monitoring/otel-observability.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "./test-helpers.js";
import { EchoOperation } from "../../src/domain/operation.js";
import { ObservabilityPort } from "../../src/ports/observability.port.js";

describe("Track A Items 2 & 3: WorkerRuntime Bounded Repair & Observability", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SystemClock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-worker-track-a-test-"));
    dbPath = path.join(tmpDir, "worker-track-a.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SystemClock();
    coordinator = new RunCoordinator(store, clock);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Item 2: triggers BoundedRepairLoopController on verification failure and attaches diagnosis", async () => {
    const repairController = new BoundedRepairLoopController({
      maxRepairIterations: 2,
      maxCumulativeActions: 5,
      maxCumulativeTimeMs: 10_000,
    });

    const worker = new WorkerRuntime({
      coordinator,
      clock,
      operations: [new EchoOperation()],
      repairController,
    });

    // Setup task with verification spec expecting { answer: 42 }, but input payload is { answer: 41 }
    coordinator.createTask({
      taskId: "task-repair-1",
      title: "echo",
      inputPayload: { answer: 41 },
    });

    createAndActivateContract(store, "task-repair-1", {
      verificationSpecs: [
        {
          specId: "vspec-answer",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { answer: 42 },
        },
      ],
    });

    const { run } = coordinator.createRun({
      runId: "run-repair-1",
      taskId: "task-repair-1",
      maxAttempts: 1,
    });
    coordinator.queueRun(run.runId);

    // Run worker
    const result = await worker.runOnce(run.runId);

    expect(result.status).toBe("FAILED");
    const error = (result as { status: "FAILED"; error?: any }).error;
    expect(error.code).toMatch(/VERIFICATION_FAILED/);
    expect(error.details).toBeDefined();
    // Repair diagnosis should have evaluated the failure
    expect(error.details.repairDiagnosis).toBeDefined();
    expect(error.details.repairStage).toBeDefined();

    // Verify run in DB is FAILED
    const persistedRun = store.getRun(run.runId);
    expect(persistedRun?.status).toBe("FAILED");
  });

  it("Item 2: halts fail-closed with VERIFICATION_FAILED_REPAIR_EXHAUSTED when iteration ceiling is 0", async () => {
    const repairController = new BoundedRepairLoopController({
      maxRepairIterations: 0, // Exhausted immediately
    });

    const worker = new WorkerRuntime({
      coordinator,
      clock,
      operations: [new EchoOperation()],
      repairController,
    });

    coordinator.createTask({
      taskId: "task-exhaust-1",
      title: "echo",
      inputPayload: { answer: 0 },
    });

    createAndActivateContract(store, "task-exhaust-1", {
      verificationSpecs: [
        {
          specId: "vspec-exhaust",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { answer: 100 },
        },
      ],
    });

    const { run } = coordinator.createRun({
      runId: "run-exhaust-1",
      taskId: "task-exhaust-1",
      maxAttempts: 1,
    });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);

    expect(result.status).toBe("FAILED");
    const error = (result as { status: "FAILED"; error?: any }).error;
    expect(error.code).toBe("VERIFICATION_FAILED_REPAIR_EXHAUSTED");
    expect(error.message).toContain("ceiling exceeded");
    expect(error.details.repairHaltReason).toContain("iteration budget exhausted");
  });

  it("Item 3: records spans and Prometheus metrics from worker lifecycle", async () => {
    const observability = new EmeraldObservability();

    const worker = new WorkerRuntime({
      coordinator,
      clock,
      operations: [new EchoOperation()],
      observabilityPort: observability,
    });

    coordinator.createTask({
      taskId: "task-obs-1",
      title: "echo",
      inputPayload: { result: "success" },
    });

    createAndActivateContract(store, "task-obs-1", {
      verificationSpecs: [
        {
          specId: "vspec-obs",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { result: "success" },
        },
      ],
    });

    const { run } = coordinator.createRun({
      runId: "run-obs-1",
      taskId: "task-obs-1",
      maxAttempts: 1,
    });
    coordinator.queueRun(run.runId);

    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("COMPLETED");

    // Check Prometheus metrics
    const metrics = observability.exportPrometheusMetrics();
    expect(metrics).toContain("emerald_worker_runs_started_total");
    expect(metrics).toContain("emerald_worker_runs_completed_total");
    expect(metrics).toContain("emerald_worker_verifications_total");

    // Pipeline health should be healthy
    const health = observability.getPipelineHealth();
    expect(health.healthy).toBe(true);
    expect(health.spansRecorded).toBeGreaterThan(0);
  });

  it("Item 3: isolates observability failures so worker execution remains zero-authority and non-blocking", async () => {
    // Failing observability port that throws on every method
    const throwingObservability: ObservabilityPort = {
      currentCorrelation: () => ({}),
      runWithCorrelation: (_c, fn) => fn(),
      startSpan: () => { throw new Error("Telemetry failure"); },
      endSpan: () => { throw new Error("Telemetry failure"); },
      withSpan: (_n, _a, fn) => fn({} as any),
      withSpanAsync: (_n, _a, fn) => fn({} as any),
      addSpanEvent: () => { throw new Error("Telemetry failure"); },
      incrementCounter: () => { throw new Error("Telemetry failure"); },
      setGauge: () => { throw new Error("Telemetry failure"); },
      observeHistogram: () => { throw new Error("Telemetry failure"); },
      emitLog: () => { throw new Error("Telemetry failure"); },
      exportPrometheusMetrics: () => "",
      flush: async () => {},
      shutdown: async () => {},
      getPipelineHealth: () => ({
        healthy: false,
        spansRecorded: 0,
        spansDropped: 0,
        logsRecorded: 0,
        logsDropped: 0,
        metricSeriesCount: 0,
        metricOverflowCount: 0,
        exportAttempts: 0,
        exportFailures: 0,
        queuedExportBatches: 0,
      }),
    };

    const worker = new WorkerRuntime({
      coordinator,
      clock,
      operations: [new EchoOperation()],
      observabilityPort: throwingObservability,
    });

    coordinator.createTask({
      taskId: "task-obs-fault-1",
      title: "echo",
      inputPayload: { hello: "world" },
    });

    createAndActivateContract(store, "task-obs-fault-1", {
      verificationSpecs: [
        {
          specId: "vspec-fault",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { hello: "world" },
        },
      ],
    });

    const { run } = coordinator.createRun({
      runId: "run-obs-fault-1",
      taskId: "task-obs-fault-1",
      maxAttempts: 1,
    });
    coordinator.queueRun(run.runId);

    // Worker must NOT crash or fail despite throwing observability port
    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("COMPLETED");

    const finishedRun = store.getRun(run.runId);
    expect(finishedRun?.status).toBe("COMPLETED");
  });
});
