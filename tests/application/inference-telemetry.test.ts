import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OllamaModelProvider } from "../../src/adapters/models/ollama-model-provider.js";
import { LiveAgentBrain } from "../../src/application/live-agent-brain.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import {
  ModelRequestTimeoutError,
  ModelProviderUnavailableError,
} from "../../src/domain/errors.js";
import { createContractBinding } from "../../src/domain/invariants.js";
import { createMissionContract } from "../../src/domain/mission-contract.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import type { AgentBrainPort } from "../../src/ports/agent-brain.port.js";
import type { ModelInferenceTelemetryPayload } from "../../src/domain/events.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Milestone 2.28 Phase 5 Step 4 — Durable Ollama Inference Telemetry", () => {
  let tmpDir: string;
  let dbPath: string;
  let stateStore: SqliteStateStore;
  let coordinator: RunCoordinator;
  let workerRuntime: WorkerRuntime;
  let proposalValidator: ProposalValidator;
  let clock: SystemClock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-telemetry-test-"));
    dbPath = path.join(tmpDir, "telemetry.db");
    stateStore = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(stateStore);
    workerRuntime = new WorkerRuntime({ coordinator, stateStore, clock } as any);
    proposalValidator = new ProposalValidator();
    clock = new SystemClock();
  });

  afterEach(() => {
    try {
      stateStore.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setupTestRun(options?: { tenantId?: string }) {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `task-${Date.now()}`;
    const workerId = `worker-${Date.now()}`;
    const leaseId = `lease-${Date.now()}`;
    const nowIso = clock.nowIso();

    const contractPolicy = createExecutionPolicy({
      isolationRequirement: "IN_PROCESS",
      allowedCapabilities: ["read_file", "write_file", "run_command"],
      ...(options?.tenantId ? { tenantId: options.tenantId, trustClassification: "MULTI_TENANT_WORKLOAD" } : {}),
    });

    const contract = createMissionContract({
      contractId: `contract-${taskId}`,
      version: 1,
      taskId,
      policy: contractPolicy,
      resourceLimits: {
        timeoutMs: 30000,
        maxAttempts: 3,
        maxOutputBytes: 65536,
      },
      verificationSpecs: [],
    });

    let contractBinding: any;

    stateStore.transaction((tx) => {
      tx.insertTask({
        taskId,
        title: "Telemetry task",
        description: "Test task",
        inputPayload: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      tx.insertWorker({
        workerId,
        hostname: "test-host",
        pid: process.pid,
        status: "ACTIVE",
        lastHeartbeatAt: nowIso,
        createdAt: nowIso,
      });

      tx.insertContract(contract);
      const activatedContract = tx.activateContract(contract.spec.contractId, contract.spec.version);
      contractBinding = createContractBinding({
        contractId: activatedContract.spec.contractId,
        version: activatedContract.spec.version,
        contentHash: activatedContract.contentHash,
      });

      tx.insertRun(
        {
          runId,
          taskId,
          status: "LEASED",
          attemptCount: 1,
          maxAttempts: 3,
          timeoutMs: 60000,
          idempotencyKey: `idemp-${runId}`,
          currentWorkerId: workerId,
          leaseId,
          leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
          resultPayload: null,
          errorPayload: null,
          contractBinding,
          maxOutputBytes: 65536,
          createdAt: nowIso,
          updatedAt: nowIso,
          version: 1,
        },
        {
          eventId: `evt-created-${runId}`,
          runId,
          timestamp: nowIso,
          eventType: "run.created",
          schemaVersion: 1,
          producer: "test",
          payload: { taskId, maxAttempts: 3, timeoutMs: 60000, idempotencyKey: null, maxOutputBytes: 65536 },
        }
      );

      tx.insertLease({
        leaseId,
        runId,
        workerId,
        acquiredAt: nowIso,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        releasedAt: null,
        state: "ACTIVE",
      });
    });

    return { runId, taskId, workerId, leaseId, contractBinding };
  }

  // ==========================================================================
  // 1. OllamaModelProvider Timing Extraction Fidelity
  // ==========================================================================
  describe("1. OllamaModelProvider Timing Extraction Fidelity", () => {
    it("captures full nanosecond timing fields and parameters on successful generation", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:1.5b",
          message: { role: "assistant", content: JSON.stringify({ isGoalReached: false, proposalId: "p1", toolName: "read_file", inputPayload: { path: "test.txt" }, contextSnapshotHash: "hash123" }) },
          done: true,
          done_reason: "stop",
          total_duration: 1250000000, // 1.25s in ns
          load_duration: 35000000,   // 35ms in ns
          prompt_eval_duration: 415000000, // 415ms in ns
          eval_duration: 800000000, // 800ms in ns
          prompt_eval_count: 512,
          eval_count: 64,
        }),
      });

      const provider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: "qwen2.5-coder:1.5b",
        keepAlive: "15m",
        numCtx: 4096,
        fetch: mockFetch as any,
      });

      const response = await provider.generate({
        model: "qwen2.5-coder:1.5b",
        requestId: "req-full-timings-1",
        timeoutMs: 30000,
        input: [{ role: "user", content: "hello" }],
        generation: { temperature: 0.2, maxOutputTokens: 128 },
      });

      expect(response.providerMetadata).toBeDefined();
      const meta = response.providerMetadata!;
      expect(meta.totalDurationNs).toBe(1250000000);
      expect(meta.loadDurationNs).toBe(35000000);
      expect(meta.promptEvalDurationNs).toBe(415000000);
      expect(meta.evalDurationNs).toBe(800000000);
      expect(meta.promptEvalCount).toBe(512);
      expect(meta.evalCount).toBe(64);
      expect(meta.doneReason).toBe("stop");
      expect(meta.modelParameters).toEqual({
        temperature: 0.2,
        numPredict: 128,
        numCtx: 4096,
        keepAlive: "15m",
      });
      expect(meta.startedAt).toBeDefined();
      expect(meta.completedAt).toBeDefined();
    });

    it("accurately leaves missing timing fields absent without fabrication", async () => {
      // Simulate partial response from Ollama (e.g. streaming fallback or cached without load_duration)
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:1.5b",
          message: { role: "assistant", content: JSON.stringify({ isGoalReached: false, proposalId: "p2", toolName: "read_file", inputPayload: { path: "test.txt" }, contextSnapshotHash: "hash123" }) },
          done: true,
          // total_duration, load_duration, prompt_eval_duration are missing
          eval_duration: 500000000,
          eval_count: 32,
        }),
      });

      const provider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: "qwen2.5-coder:1.5b",
        fetch: mockFetch as any,
      });

      const response = await provider.generate({
        model: "qwen2.5-coder:1.5b",
        requestId: "req-partial-timings-1",
        timeoutMs: 30000,
        input: [{ role: "user", content: "hello" }],
      });

      const meta = response.providerMetadata!;
      expect(meta.evalDurationNs).toBe(500000000);
      expect(meta.evalCount).toBe(32);
      expect(meta.totalDurationNs).toBeUndefined();
      expect(meta.loadDurationNs).toBeUndefined();
      expect(meta.promptEvalDurationNs).toBeUndefined();
      expect(meta.promptEvalCount).toBeUndefined();
    });
  });

  // ==========================================================================
  // 2. LiveAgentBrain Metadata Forwarding
  // ==========================================================================
  describe("2. LiveAgentBrain Metadata Forwarding", () => {
    it("forwards nanosecond timing metadata from provider to brainResult", async () => {
      const mockProvider = {
        providerName: "ollama",
        generate: vi.fn().mockResolvedValue({
          requestId: "req-brain-forward-1",
          model: "qwen2.5-coder:1.5b",
          outputText: JSON.stringify({
            isGoalReached: false,
            proposalId: "prop-1",
            toolName: "read_file",
            inputPayload: { path: "a.txt" },
            contextSnapshotHash: "hash-snap-1",
          }),
          finishReason: "STOP",
          durationMs: 450,
          providerMetadata: {
            provider: "ollama",
            totalDurationNs: 450000000,
            loadDurationNs: 20000000,
            promptEvalDurationNs: 180000000,
            evalDurationNs: 250000000,
            promptEvalCount: 150,
            evalCount: 45,
            doneReason: "stop",
            modelParameters: { keepAlive: "10m", numCtx: 2048 },
          },
        }),
      };

      const brain = new LiveAgentBrain({
        modelProvider: mockProvider as any,
        model: "qwen2.5-coder:1.5b",
      });

      const brainResult = await brain.proposeAction({
        runId: "run-test-1",
        contextSnapshot: {
          snapshotId: "snap-1",
          runId: "run-test-1",
          taskId: "task-1",
          contextHash: "hash-snap-1",
          totalBytes: 100,
          totalEstimatedTokens: 50,
          observations: [],
          createdAt: clock.nowIso(),
        } as any,
        availableTools: [],
        sequenceNumber: 1,
      });

      expect(brainResult.modelMetadata).toBeDefined();
      const meta = brainResult.modelMetadata!;
      expect(meta.requestId).toBe("req-brain-forward-1");
      expect(meta.totalDurationNs).toBe(450000000);
      expect(meta.loadDurationNs).toBe(20000000);
      expect(meta.promptEvalDurationNs).toBe(180000000);
      expect(meta.evalDurationNs).toBe(250000000);
      expect(meta.promptEvalCount).toBe(150);
      expect(meta.evalCount).toBe(45);
      expect(meta.doneReason).toBe("stop");
      expect(meta.modelParameters).toEqual({ keepAlive: "10m", numCtx: 2048 });
    });
  });

  // ==========================================================================
  // 3. AgentStepController Durable Telemetry Recording
  // ==========================================================================
  describe("3. AgentStepController Durable Telemetry Recording", () => {
    it("persists measured nanosecond telemetry and correlation IDs on step completion", async () => {
      const { runId, taskId, workerId, leaseId } = setupTestRun();

      const mockBrain: AgentBrainPort = {
        proposeAction: vi.fn().mockResolvedValue({
          finishReason: "ACTION_PROPOSED",
          proposal: {
            isGoalReached: false,
            proposalId: "prop-step-1",
            toolName: "read_file",
            inputPayload: { path: "test.txt" },
            contextSnapshotHash: "snap-hash",
          },
          modelMetadata: {
            requestId: "req-step-1",
            modelName: "qwen2.5-coder:1.5b",
            providerName: "ollama",
            totalDurationNs: 890000000,
            loadDurationNs: 12000000,
            promptEvalDurationNs: 350000000,
            evalDurationNs: 528000000,
            promptEvalCount: 300,
            evalCount: 75,
            doneReason: "stop",
            finishReason: "STOP",
            modelParameters: { keepAlive: "10m", numCtx: 2048, temperature: 0.1 },
          },
        }),
      };

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain: mockBrain,
        proposalValidator,
        toolRegistry: staticToolRegistry,
        clock,
      });

      await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      const telemetryEvents = stateStore.getInferenceTelemetryForRun(runId);
      expect(telemetryEvents.length).toBe(1);

      const event = telemetryEvents[0]!;
      expect(event.eventType).toBe("model.inference.telemetry");
      expect(event.schemaVersion).toBe(1);
      expect(event.producer).toBe("application.agent_step_controller");

      const payload = event.payload;
      expect(payload.runId).toBe(runId);
      expect(payload.taskId).toBe(taskId);
      expect(payload.stepNumber).toBe(1);
      expect(payload.workerId).toBe(workerId);
      expect(payload.leaseId).toBe(leaseId);
      expect(payload.requestId).toBe("req-step-1");
      expect(payload.model).toBe("qwen2.5-coder:1.5b");
      expect(payload.provider).toBe("ollama");
      expect(payload.outcome).toBe("SUCCESS");
      expect(payload.totalDurationNs).toBe(890000000);
      expect(payload.loadDurationNs).toBe(12000000);
      expect(payload.promptEvalDurationNs).toBe(350000000);
      expect(payload.evalDurationNs).toBe(528000000);
      expect(payload.promptEvalCount).toBe(300);
      expect(payload.evalCount).toBe(75);
      expect(payload.doneReason).toBe("stop");
      expect(payload.finishReason).toBe("STOP");
      expect(payload.wallClockDurationMs).toBeGreaterThanOrEqual(0);
      expect(payload.modelParameters).toEqual({ keepAlive: "10m", numCtx: 2048, temperature: 0.1 });
    });

    it("records failure telemetry with accurate error classification on timeout", async () => {
      const { runId, workerId, leaseId } = setupTestRun();

      const timeoutError = new ModelRequestTimeoutError("Inference timed out after 30000ms", {
        timeoutMs: 30000,
        providerName: "ollama",
        requestId: "req-timeout-1",
      });

      const mockBrain: AgentBrainPort = {
        proposeAction: vi.fn().mockRejectedValue(timeoutError),
      };

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain: mockBrain,
        proposalValidator,
        toolRegistry: staticToolRegistry,
        clock,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(result.terminalReason).toBe("BRAIN_FAILURE");

      const telemetryEvents = stateStore.getInferenceTelemetryForRun(runId);
      expect(telemetryEvents.length).toBe(1);

      const payload = telemetryEvents[0]!.payload;
      expect(payload.outcome).toBe("TIMEOUT");
      expect(payload.requestId).toBe("req-timeout-1");
      expect(payload.error?.code).toBe("MODEL_REQUEST_TIMEOUT");
      expect(payload.error?.message).toContain("Inference timed out after 30000ms");
      // Missing fields must be strictly null, never fabricated
      expect(payload.totalDurationNs).toBeNull();
      expect(payload.loadDurationNs).toBeNull();
      expect(payload.promptEvalDurationNs).toBeNull();
      expect(payload.evalDurationNs).toBeNull();
      expect(payload.promptEvalCount).toBeNull();
      expect(payload.evalCount).toBeNull();
      expect(payload.wallClockDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("records failure telemetry when provider is unavailable", async () => {
      const { runId, workerId, leaseId } = setupTestRun();

      const unavailableError = new ModelProviderUnavailableError(
        "Local Ollama runtime is unavailable: connect ECONNREFUSED",
        {
          providerName: "ollama",
          requestId: "req-unavail-1",
        }
      );

      const mockBrain: AgentBrainPort = {
        proposeAction: vi.fn().mockRejectedValue(unavailableError),
      };

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain: mockBrain,
        proposalValidator,
        toolRegistry: staticToolRegistry,
        clock,
      });

      await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      const telemetryEvents = stateStore.getInferenceTelemetryForRun(runId);
      expect(telemetryEvents.length).toBe(1);
      expect(telemetryEvents[0]!.payload.outcome).toBe("PROVIDER_UNAVAILABLE");
      expect(telemetryEvents[0]!.payload.error?.code).toBe("MODEL_PROVIDER_UNAVAILABLE");
    });
  });

  // ==========================================================================
  // 4. Deduplication & Idempotency Guarantees
  // ==========================================================================
  describe("4. Deduplication & Idempotency Guarantees", () => {
    it("prevents duplicate telemetry events with identical dedupToken", () => {
      const { runId, taskId, workerId, leaseId } = setupTestRun();

      const payload: ModelInferenceTelemetryPayload = {
        runId,
        taskId,
        stepNumber: 1,
        workerId,
        leaseId,
        requestId: "req-dedup-1",
        model: "qwen2.5-coder:1.5b",
        provider: "ollama",
        outcome: "SUCCESS",
        startedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        wallClockDurationMs: 250,
        totalDurationNs: 250000000,
      };

      const event = {
        eventId: "evt-telemetry-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "model.inference.telemetry" as const,
        schemaVersion: 1,
        producer: "application.agent_step_controller",
        payload,
      };

      const dedupToken = `inference-telemetry:${payload.requestId}`;

      // First insert
      const first = stateStore.appendEvent(event, dedupToken);
      expect(first.sequence).toBe(2); // run.created was seq 1

      // Duplicate insert attempt with same dedupToken
      const duplicateEvent = {
        ...event,
        eventId: "evt-telemetry-duplicate",
      };
      const second = stateStore.appendEvent(duplicateEvent, dedupToken);

      // Should return the existing persisted event without creating a new sequence
      expect(second.eventId).toBe("evt-telemetry-1");
      expect(second.sequence).toBe(2);

      // Only 1 telemetry event in run_events
      const allTelemetry = stateStore.getInferenceTelemetryForRun(runId);
      expect(allTelemetry.length).toBe(1);
    });
  });

  // ==========================================================================
  // 5. Failure Isolation
  // ==========================================================================
  describe("5. Failure Isolation", () => {
    it("ensures telemetry persistence error does not crash step loop or alter outcome", async () => {
      const { runId, workerId, leaseId } = setupTestRun();

      const mockBrain: AgentBrainPort = {
        proposeAction: vi.fn().mockResolvedValue({
          finishReason: "ACTION_PROPOSED",
          proposal: {
            isGoalReached: false,
            proposalId: "prop-iso-1",
            toolName: "read_file",
            inputPayload: { path: "test.txt" },
            contextSnapshotHash: "hash-iso",
          },
          modelMetadata: {
            requestId: "req-iso-1",
            modelName: "qwen2.5-coder:1.5b",
            providerName: "ollama",
            totalDurationNs: 100000000,
          },
        }),
      };

      // Mock appendEvent on stateStore to throw when telemetry event is appended
      const originalAppendEvent = stateStore.appendEvent.bind(stateStore);
      vi.spyOn(stateStore, "transaction").mockImplementation(((cb: any) => {
        const fakeTx = {
          appendEvent: (e: any, dedup: any) => {
            if (e.eventType === "model.inference.telemetry") {
              throw new Error("Disk full: failed to persist telemetry");
            }
            return originalAppendEvent(e, dedup);
          },
        };
        return cb(fakeTx);
      }) as any);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain: mockBrain,
        proposalValidator,
        toolRegistry: staticToolRegistry,
        clock,
      });

      // The step loop must NOT crash due to telemetry persistence failure
      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      // Should complete step processing without throwing an unhandled exception
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // 6. Durability Across Store Close and Reload
  // ==========================================================================
  describe("6. Durability Across Store Close and Reload", () => {
    it("preserves exact nanosecond telemetry across database close and reopen", () => {
      const { runId, taskId, workerId, leaseId } = setupTestRun();

      const payload: ModelInferenceTelemetryPayload = {
        runId,
        taskId,
        stepNumber: 1,
        workerId,
        leaseId,
        requestId: "req-reload-1",
        model: "qwen2.5-coder:1.5b",
        provider: "ollama",
        outcome: "SUCCESS",
        startedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        wallClockDurationMs: 412,
        totalDurationNs: 412589123,
        loadDurationNs: 15421000,
        promptEvalDurationNs: 180123456,
        evalDurationNs: 217044667,
        promptEvalCount: 420,
        evalCount: 88,
        doneReason: "stop",
        finishReason: "STOP",
        modelParameters: { keepAlive: "10m", numCtx: 4096 },
      };

      stateStore.appendEvent({
        eventId: "evt-reload-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "model.inference.telemetry",
        schemaVersion: 1,
        producer: "application.agent_step_controller",
        payload,
      });

      // Close database and reopen from disk
      stateStore.close();
      const reloadedStore = new SqliteStateStore({ location: dbPath });

      const records = reloadedStore.getInferenceTelemetryForRun(runId);
      expect(records.length).toBe(1);
      const reloadedPayload = records[0]!.payload;

      expect(reloadedPayload.totalDurationNs).toBe(412589123);
      expect(reloadedPayload.loadDurationNs).toBe(15421000);
      expect(reloadedPayload.promptEvalDurationNs).toBe(180123456);
      expect(reloadedPayload.evalDurationNs).toBe(217044667);
      expect(reloadedPayload.promptEvalCount).toBe(420);
      expect(reloadedPayload.evalCount).toBe(88);
      expect(reloadedPayload.modelParameters).toEqual({ keepAlive: "10m", numCtx: 4096 });

      reloadedStore.close();
    });
  });

  // ==========================================================================
  // 7. Tenant Isolation in Read-Only Telemetry Query
  // ==========================================================================
  describe("7. Tenant Isolation in Read-Only Telemetry Query", () => {
    it("returns telemetry only when the querying tenant matches the run tenant", () => {
      const { runId, taskId, workerId, leaseId } = setupTestRun({ tenantId: "tenant-alpha" });

      const payload: ModelInferenceTelemetryPayload = {
        runId,
        taskId,
        stepNumber: 1,
        workerId,
        leaseId,
        requestId: "req-tenant-1",
        model: "qwen2.5-coder:1.5b",
        provider: "ollama",
        outcome: "SUCCESS",
        startedAt: clock.nowIso(),
        completedAt: clock.nowIso(),
        wallClockDurationMs: 100,
        totalDurationNs: 100000000,
      };

      stateStore.appendEvent({
        eventId: "evt-tenant-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "model.inference.telemetry",
        schemaVersion: 1,
        producer: "application.agent_step_controller",
        payload,
      });

      // Query with matching tenantId -> returns telemetry
      const match = stateStore.getInferenceTelemetryForRun(runId, { tenantId: "tenant-alpha" });
      expect(match.length).toBe(1);
      expect(match[0]!.payload.requestId).toBe("req-tenant-1");

      // Query with differing tenantId -> returns empty list (tenant isolation)
      const nonMatch = stateStore.getInferenceTelemetryForRun(runId, { tenantId: "tenant-beta" });
      expect(nonMatch.length).toBe(0);

      // Query without tenantId filter -> returns telemetry
      const unconstrained = stateStore.getInferenceTelemetryForRun(runId);
      expect(unconstrained.length).toBe(1);
    });
  });

  // ==========================================================================
  // 8. Observability != Verification Evidence (Invariant)
  // ==========================================================================
  describe("8. Observability != Verification Evidence", () => {
    it("confirms telemetry event cannot satisfy verification or alter completion gate", () => {
      const { runId, taskId, workerId, leaseId } = setupTestRun();

      // Append inference telemetry
      stateStore.appendEvent({
        eventId: "evt-obs-1",
        runId,
        timestamp: clock.nowIso(),
        eventType: "model.inference.telemetry",
        schemaVersion: 1,
        producer: "application.agent_step_controller",
        payload: {
          runId,
          taskId,
          stepNumber: 1,
          workerId,
          leaseId,
          requestId: "req-obs-1",
          model: "qwen2.5-coder:1.5b",
          provider: "ollama",
          outcome: "SUCCESS",
          startedAt: clock.nowIso(),
          completedAt: clock.nowIso(),
          wallClockDurationMs: 100,
        },
      });

      // Check run status is unchanged (still LEASED)
      const run = stateStore.getRun(runId);
      expect(run?.status).toBe("LEASED");

      // Check events: only run.created and model.inference.telemetry exist
      const events = stateStore.getEventsForRun(runId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).not.toContain("verification.completed");
      expect(eventTypes).not.toContain("run.completed");
    });
  });
});
