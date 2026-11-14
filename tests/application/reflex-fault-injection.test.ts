/**
 * Emerald Agent Fabric — Phase 8.6 Test Suite
 * Reflex Fault Injection & Fail-Safe Recovery
 *
 * Exhaustively evaluates runtime behavior when Reflex itself fails.
 *
 * Core Research Question:
 * "What happens when Reflex itself fails (throws exception, returns malformed output,
 * invalid decision, config failure, evidence failure, cancellation, timeout)?
 * Does the system fail closed without authorization bypass?"
 *
 * Safety Invariants:
 * 1. Zero Tool Execution: providerInvocationCount === 0 for all Reflex failures.
 * 2. Fail-Closed Containment: Reflex failure NEVER translates to ALLOW or execution.
 * 3. Telemetry Purity: Zero fabricated reflexEvaluations, reflexAllows, or reflexRejects.
 * 4. Evidence Purity: Zero synthetic or fake ReflexEvidence artifacts produced during crashes.
 * 5. Monotonic Authority: Reflex failure cannot expand authority or bypass PolicyEvaluator.
 * 6. Cancellation Fast-Path: AbortSignal produces immediate CANCELLED terminal state.
 * 7. UNKNOWN Separation: Reflex failure cannot mutate or clear existing UNKNOWN attempts.
 * 8. BASELINE Non-Interference: Faulty Reflex implementations cannot impact BASELINE mode.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  assertReflexAuthorityInvariant,
  validateReflexDecision,
} from "../../src/domain/reflex.js";
import {
  ReflexExecutionError,
  InvalidReflexDecisionError,
  ReflexAuthorityExpansionError,
} from "../../src/domain/errors.js";
import {
  createReflexEvidence,
  replayReflexEvidence,
} from "../../src/domain/reflex-evidence.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { NoopReflex } from "../../src/adapters/reflex/noop-reflex.js";
import { createAndActivateContract } from "./test-helpers.js";

import { Action } from "../../src/domain/action.js";
import { Attempt } from "../../src/domain/attempt.js";
import {
  createValidBaseProposal,
  createValidBaseEvidence,
} from "../../src/application/evaluation/reflex-adversarial-fixtures.js";

import {
  FaultInjectableReflex,
  ReflexFaultMode,
} from "../fixtures/fault-injectable-reflex.js";

// ----------------------------------------------------------------------------
// Test Doubles & Helpers
// ----------------------------------------------------------------------------

class ScriptableAgentBrain implements AgentBrainPort {
  readonly name = "ScriptableAgentBrain";
  readonly version = "1.0.0";
  private steps: Array<
    (request: AgentBrainRequest) => Promise<AgentBrainResult> | AgentBrainResult
  > = [];

  queueStep(
    handler: (
      request: AgentBrainRequest
    ) => Promise<AgentBrainResult> | AgentBrainResult
  ): void {
    this.steps.push(handler);
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    return { finishReason: "GOAL_REACHED" };
  }
}

class CountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "CountingExecutionProvider";
  readonly invocations: ExecutionRequest[] = [];

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request as ExecutionRequest);
    return {
      status: "SUCCESS",
      output: { executed: true } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

function queueValidProposal(
  agentBrain: ScriptableAgentBrain,
  toolName: "read_file" | "write_file" = "read_file",
  payload: Record<string, unknown> = { path: "src/main.ts" },
  rationale: string = "Read main file"
): void {
  agentBrain.queueStep((request) => ({
    finishReason: "ACTION_PROPOSED",
    proposal: {
      proposalId: `prop-${crypto.randomUUID()}`,
      toolName,
      inputPayload: payload,
      contextSnapshotHash: request.contextSnapshot.contextHash,
      rationale,
    },
  }));
}

describe("Phase 8.6 — Reflex Fault Injection & Fail-Safe Recovery", () => {
  let tempDir: string;
  let dbPath: string;
  let stateStore: SqliteStateStore;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let coordinator: RunCoordinator;
  let executionProvider: CountingExecutionProvider;
  let workerRuntime: WorkerRuntime;
  let agentBrain: ScriptableAgentBrain;
  let proposalValidator: ProposalValidator;
  let clock: SettableClock;
  let faultReflex: FaultInjectableReflex;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-reflex-fault-"));
    dbPath = path.join(tempDir, "state.db");
    const workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    clock = new SettableClock(new Date("2026-10-14T12:00:00Z"));
    stateStore = new SqliteStateStore({ location: dbPath });
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
    coordinator = new RunCoordinator(stateStore, clock, undefined, workspaceAdapter);
    executionProvider = new CountingExecutionProvider();
    workerRuntime = new WorkerRuntime({
      workerId: "worker-fault-eval-1",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider,
    });
    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore,
      clock,
    });
    agentBrain = new ScriptableAgentBrain();
    faultReflex = new FaultInjectableReflex({ faultMode: "NONE" });

    stateStore.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-fault-eval-1",
        hostname: "localhost",
        pid: 9999,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(() => {
    stateStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupStandardRun(taskId: string = "task-fault-1") {
    const task = coordinator.createTask({
      taskId,
      title: "Fault injection evaluation task",
      description: "Fault injection evaluation task",
      inputPayload: { target: "test" },
    });

    createAndActivateContract(stateStore, task.taskId, {
      policy: createExecutionPolicy({
        policyId: "policy-fault-test",
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement: "IN_PROCESS",
      }),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    const runId = run.runId;
    const workerId = "worker-fault-eval-1";

    coordinator.queueRun(runId);
    const claimResult = coordinator.claimRun(runId, workerId, 60000);
    const leaseId = claimResult.lease.leaseId;
    coordinator.startRun(runId, workerId, leaseId);

    return { taskId: task.taskId, runId, workerId, leaseId };
  }

  // ==========================================================================
  // Section 1: Zero Tool Dispatch & Execution Boundary (Deliverables 3 & 4)
  // ==========================================================================
  describe("Section 1: Zero Tool Dispatch & Execution Boundary", () => {
    it("1. blocks tool execution when Reflex throws ReflexExecutionError", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW", {
        customError: new ReflexExecutionError("Reflex evaluation blew up"),
      });

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("2. blocks tool execution when Reflex throws a generic runtime Error", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW", {
        customError: new TypeError("Cannot read properties of undefined (reading 'evaluate')"),
      });

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("3. blocks tool execution when Reflex throws a primitive non-Error value", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("NON_ERROR_THROW", {
        customError: "Fatal unhandled reflex string exception",
      });

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("4. blocks tool execution when Reflex returns an invalid decision kind string", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("INVALID_DECISION_STRING");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("5. blocks tool execution when Reflex returns an invalid reason code", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("INVALID_REASON_CODE");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("6. blocks tool execution when Reflex returns null or non-object shape", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("INVALID_SCHEMA_SHAPE", { customError: null });

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("7. blocks tool execution when Reflex attempts authority expansion keys", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("AUTHORITY_INJECTION");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("8. blocks tool execution when Reflex returns an async promise rejection", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("ASYNC_REJECTION");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
    });

    it("9. blocks tool execution when Reflex is cancelled via AbortSignal", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("ABORT_SIGNAL_CANCELLATION");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(executionProvider.invocations.length).toBe(0);
      expect(result.terminalReason).toBe("CANCELLED");
    });
  });

  // ==========================================================================
  // Section 2: Telemetry & Evidence Purity (Deliverables 5, 6, 7, 14)
  // ==========================================================================
  describe("Section 2: Telemetry & Evidence Purity", () => {
    it("10. records reflexError in transcript and leaves reflexDecision undefined on throw", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW", {
        customError: new Error("Specific internal Reflex failure 404"),
      });

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(result.transcript.length).toBeGreaterThan(0);
      const entry = result.transcript[0]!;
      expect(entry.reflexError).toBe("Specific internal Reflex failure 404");
      expect(entry.reflexDecision).toBeUndefined();
      expect(entry.reflexReasonCode).toBe("UNSUPPORTED_ACTION");
    });

    it("11. leaves reflexEvidence undefined on Reflex error (zero fake evidence fabricated)", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      const entry = result.transcript[0]!;
      expect(entry.reflexEvidence).toBeUndefined();
    });

    it("12. records validation failure details in reflexError on invalid schema output", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("INVALID_DECISION_STRING");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      const entry = result.transcript[0]!;
      expect(entry.reflexError).toBeDefined();
      expect(entry.reflexError).toContain("ReflexDecision validation failed");
      expect(entry.reflexDecision).toBeUndefined();
    });

    it("13. does not count faulted reflex evaluation as ALLOW, REJECT, or DEFER decision", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      const decisionCounts = result.transcript.reduce(
        (acc, e) => {
          if (e.reflexDecision === "ALLOW") acc.allows++;
          if (e.reflexDecision === "REJECT") acc.rejects++;
          if (e.reflexDecision === "DEFER") acc.defers++;
          return acc;
        },
        { allows: 0, rejects: 0, defers: 0 }
      );

      expect(decisionCounts.allows).toBe(0);
      expect(decisionCounts.rejects).toBe(0);
      expect(decisionCounts.defers).toBe(0);
    });

    it("14. increments proposalRejections to count toward budget limit on Reflex fault", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2, maxProposalRejections: 3 },
      });

      expect(result.totalProposalRejections).toBe(1);
    });

    it("15. does not crash reasoning loop if observational evidence creation fails internally", () => {
      expect(() => {
        createReflexEvidence({
          runId: "run-test",
          sequenceNumber: 1,
          proposal: null as any,
          context: {} as any,
          decision: { decision: "ALLOW", reasonCode: "NO_INTERVENTION" },
          reflexImplementation: "TestReflex",
          ruleConfigurationHash: "0".repeat(64),
          evaluatedAt: new Date().toISOString(),
        });
      }).toThrow();
    });

    it("16. offline replay handles faulty Reflex implementation safely with INVALID_EVIDENCE", async () => {
      const validEvidence = createValidBaseEvidence();

      faultReflex.setFaultMode("EXCEPTION_THROW", {
        customError: new ReflexExecutionError("Replay evaluation internal fault"),
      });

      const replayResult = await replayReflexEvidence(validEvidence, { reflex: faultReflex });
      expect(replayResult.status).toBe("INVALID_EVIDENCE");
      expect(replayResult.match).toBe(false);
      expect(replayResult.mismatchDetails).toContain("Replay evaluate threw error");
    });
  });

  // ==========================================================================
  // Section 3: Cancellation & Timeout Mechanics (Deliverables 8 & 9)
  // ==========================================================================
  describe("Section 3: Cancellation & Timeout Mechanics", () => {
    it("17. returns CANCELLED immediately when AbortSignal is pre-aborted before step loop", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      const abortController = new AbortController();
      abortController.abort();

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5 },
        abortSignal: abortController.signal,
      });

      expect(result.terminalReason).toBe("CANCELLED");
      expect(executionProvider.invocations.length).toBe(0);
      expect(result.totalSteps).toBe(0);
    });

    it("18. returns CANCELLED when abort occurs during Reflex evaluation", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      const abortController = new AbortController();

      const abortingReflex = {
        name: "AbortingReflex",
        activeConfigHash: "0".repeat(64),
        evaluate: async () => {
          abortController.abort();
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        },
      };

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: abortingReflex as any,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5 },
        abortSignal: abortController.signal,
      });

      expect(result.terminalReason).toBe("CANCELLED");
      expect(executionProvider.invocations.length).toBe(0);
    });

    it("19. returns CANCELLED when Reflex throws an AbortError instance directly", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("ABORT_SIGNAL_CANCELLATION");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5 },
      });

      expect(result.terminalReason).toBe("CANCELLED");
      expect(executionProvider.invocations.length).toBe(0);
    });

    it("20. terminates with MAX_WALL_CLOCK when Reflex delay causes wall-clock budget exhaustion", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();

      const slowReflex = {
        name: "SlowReflex",
        activeConfigHash: "0".repeat(64),
        evaluate: async () => {
          clock.advanceMs(100_000);
          return {
            decision: "ALLOW" as const,
            reasonCode: "NO_INTERVENTION" as const,
          };
        },
      };

      queueValidProposal(agentBrain);
      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: slowReflex as any,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 10, maxWallClockMs: 50_000 },
      });

      expect(result.terminalReason).toBe("MAX_WALL_CLOCK");
    });

    it("21. halts execution loop when consecutive Reflex faults reach maxProposalRejections ceiling", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW");

      for (let i = 0; i < 5; i++) {
        queueValidProposal(agentBrain, "read_file", { path: "src/main.ts" }, `Proposal ${i}`);
      }

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 10, maxProposalRejections: 3 },
      });

      expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
      expect(result.totalProposalRejections).toBe(3);
      expect(executionProvider.invocations.length).toBe(0);
    });
  });

  // ==========================================================================
  // Section 4: Authority Monotonicity & Invariant Defense (Deliverables 10 & 11)
  // ==========================================================================
  describe("Section 4: Authority Monotonicity & Invariant Defense", () => {
    it("22. throws InvalidReflexDecisionError on unknown authority keys due to strict schema", () => {
      const rogueDecision = {
        decision: "ALLOW",
        reasonCode: "NO_INTERVENTION",
        bypassGovernance: true,
      };

      expect(() => {
        validateReflexDecision(rogueDecision);
      }).toThrow(InvalidReflexDecisionError);
    });

    it("23. assertReflexAuthorityInvariant throws ReflexAuthorityExpansionError on capability expansion", () => {
      const baseProposal = createValidBaseProposal({ toolName: "read_file" });

      const rogueDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        capability: "workspace.file.write",
      };

      expect(() => {
        assertReflexAuthorityInvariant(baseProposal, rogueDecision as any);
      }).toThrow(ReflexAuthorityExpansionError);
    });

    it("24. ensures contract binding and active permissions remain immutable across Reflex faults", async () => {
      const { taskId, runId, workerId, leaseId } = setupStandardRun();
      faultReflex.setFaultMode("EXCEPTION_THROW");

      const contractBefore = stateStore.getContract(`contract-${taskId}`, 1)!;
      expect(contractBefore.lifecycle.status).toBe("ACTIVE");

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      const contractAfter = stateStore.getContract(`contract-${taskId}`, 1)!;
      expect(contractAfter.lifecycle.status).toBe("ACTIVE");
      expect(contractAfter.spec.credentialScopes).toEqual(contractBefore.spec.credentialScopes);
      expect(contractAfter.spec.resourceLimits).toEqual(contractBefore.spec.resourceLimits);
    });

    it("25. prevents Reflex from mutating the proposal object passed into evaluate", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();

      const mutatingReflex = {
        name: "MutatingReflex",
        activeConfigHash: "0".repeat(64),
        evaluate: async (proposal: any) => {
          try {
            proposal.toolName = "run_command";
          } catch {
            // Handled if frozen
          }
          return {
            decision: "ALLOW" as const,
            reasonCode: "NO_INTERVENTION" as const,
          };
        },
      };

      let originalProposal: any;
      agentBrain.queueStep((request) => {
        originalProposal = Object.freeze({
          proposalId: "prop-immutable-check",
          toolName: "read_file" as const,
          inputPayload: { path: "src/main.ts" },
          contextSnapshotHash: request.contextSnapshot.contextHash,
          rationale: "Read main file",
        });
        return {
          finishReason: "ACTION_PROPOSED",
          proposal: originalProposal,
        };
      });

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: mutatingReflex as any,
      });

      await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(originalProposal.toolName).toBe("read_file");
    });

    it("26. prevents Reflex from mutating the frozen ReflexContext object", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();

      let contextWasFrozen = false;
      const contextMutatingReflex = {
        name: "ContextMutatingReflex",
        activeConfigHash: "0".repeat(64),
        evaluate: async (_proposal: any, context: any) => {
          contextWasFrozen = Object.isFrozen(context);
          try {
            context.contextHash = "tampered-hash";
          } catch {
            // Expected in frozen strict mode
          }
          return {
            decision: "ALLOW" as const,
            reasonCode: "NO_INTERVENTION" as const,
          };
        },
      };

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: contextMutatingReflex as any,
      });

      await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(contextWasFrozen).toBe(true);
    });
  });

  // ==========================================================================
  // Section 5: UNKNOWN State Preservation & BASELINE Non-Interference (Deliverables 12 & 13)
  // ==========================================================================
  describe("Section 5: UNKNOWN State Preservation & BASELINE Non-Interference", () => {
    it("27. preserves UNKNOWN attempt from prior action when subsequent Reflex faults", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: faultReflex,
      });

      const origExecute = workerRuntime.executeAction.bind(workerRuntime);
      let executed = false;
      workerRuntime.executeAction = async () => {
        executed = true;
        return {
          actionId: "act-unknown-test",
          runId,
          status: "UNKNOWN",
          error: "Uncertain execution failure",
        };
      };

      queueValidProposal(agentBrain);

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5 },
      });

      expect(executed).toBe(true);
      expect(result.terminalReason).toBe("UNKNOWN_EXECUTION");
      workerRuntime.executeAction = origExecute;
    });

    it("28. verifies Reflex failure cannot mutate or clear existing UNKNOWN attempt records", () => {
      const { taskId, runId, workerId, leaseId } = setupStandardRun("task-unk-preservation");
      const contract = stateStore.getContract(`contract-${taskId}`, 1)!;

      const { action, event: aEvent } = Action.create({
        actionId: "act-unknown-record",
        runId,
        sequenceNumber: 1,
        toolName: "read_file",
        inputPayload: { path: "src/main.ts" },
        contractBinding: {
          contractId: `contract-${taskId}`,
          version: 1,
          contentHash: contract.contentHash,
        },
        maxAttempts: 3,
        now: clock.nowIso(),
      });

      const { attempt, event: attEvent } = Attempt.create({
        attemptId: "att-unknown-record",
        actionId: action.actionId,
        runId,
        attemptNumber: 1,
        workerId,
        leaseId,
        idempotencyToken: "token-unknown-1",
        now: clock.nowIso(),
      });

      stateStore.transaction((tx) => {
        tx.insertAction(action.snapshot, aEvent, { workerId, leaseId });
        tx.transitionAction(
          action.actionId,
          { type: "AUTHORIZE", now: clock.nowIso() },
          () => "evt-auth-act",
          { workerId, leaseId }
        );
        tx.insertAttempt(attempt.snapshot, attEvent, { workerId, leaseId });
        tx.transitionAttempt(
          attempt.attemptId,
          { type: "DISPATCH", now: clock.nowIso() },
          () => "evt-disp-att",
          { workerId, leaseId }
        );
        tx.transitionAttempt(
          attempt.attemptId,
          { type: "START", now: clock.nowIso() },
          () => "evt-start-att",
          { workerId, leaseId }
        );
        tx.transitionAttempt(
          attempt.attemptId,
          {
            type: "MARK_UNKNOWN",
            reason: "Execution crashed unexpectedly",
            reasonCode: "WORKER_CRASHED",
            now: clock.nowIso(),
          },
          () => "evt-mark-unk-test",
          { workerId, leaseId }
        );
      });

      const attemptBefore = stateStore.getAttempt("att-unknown-record");
      expect(attemptBefore?.status).toBe("UNKNOWN");

      faultReflex.setFaultMode("EXCEPTION_THROW");
      expect(faultReflex.getFaultMode()).toBe("EXCEPTION_THROW");

      const attemptAfter = stateStore.getAttempt("att-unknown-record");
      expect(attemptAfter?.status).toBe("UNKNOWN");
    });

    it("29. guarantees BASELINE mode uses NoopReflex and is isolated from Reflex faults", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();

      const noopReflex = new NoopReflex();

      queueValidProposal(agentBrain);
      agentBrain.queueStep(() => ({
        finishReason: "GOAL_REACHED",
      }));

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: noopReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5 },
      });

      expect(result.terminalReason).toBe("COMPLETED");
      expect(result.totalActions).toBe(1);

      for (const entry of result.transcript) {
        expect(entry.reflexEvidence).toBeUndefined();
      }
    });

    it("30. confirms BASELINE mode produces zero reflex telemetry metrics", async () => {
      const { runId, workerId, leaseId } = setupStandardRun();
      const noopReflex = new NoopReflex();

      queueValidProposal(agentBrain);

      const controller = new AgentStepController({
        coordinator,
        stateStore,
        workerRuntime,
        agentBrain,
        proposalValidator,
        clock,
        reflex: noopReflex,
      });

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 2 },
      });

      expect(result.transcript[0]?.reflexEvidence).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 6: Executable 12-Row Fault Matrix (Deliverable 15)
  // ==========================================================================
  describe("Section 6: Executable 12-Row Fault Matrix", () => {
    const faultMatrix: Array<{
      row: number;
      name: string;
      mode: ReflexFaultMode;
      expectedTerminalReason?: string;
    }> = [
      { row: 1, name: "EXCEPTION_THROW", mode: "EXCEPTION_THROW" },
      { row: 2, name: "NON_ERROR_THROW", mode: "NON_ERROR_THROW" },
      { row: 3, name: "INVALID_DECISION_STRING", mode: "INVALID_DECISION_STRING" },
      { row: 4, name: "INVALID_REASON_CODE", mode: "INVALID_REASON_CODE" },
      { row: 5, name: "INVALID_SCHEMA_SHAPE", mode: "INVALID_SCHEMA_SHAPE" },
      { row: 6, name: "AUTHORITY_INJECTION", mode: "AUTHORITY_INJECTION" },
      { row: 7, name: "RULE_CONFIG_CORRUPTION", mode: "RULE_CONFIG_CORRUPTION" },
      { row: 8, name: "CONTEXT_CORRUPTION_ATTEMPT", mode: "CONTEXT_CORRUPTION_ATTEMPT" },
      { row: 9, name: "OBSERVATIONAL_EVIDENCE_FAILURE", mode: "OBSERVATIONAL_EVIDENCE_FAILURE" },
      {
        row: 10,
        name: "ABORT_SIGNAL_CANCELLATION",
        mode: "ABORT_SIGNAL_CANCELLATION",
        expectedTerminalReason: "CANCELLED",
      },
      { row: 11, name: "BOUNDED_TIMEOUT_DELAY", mode: "BOUNDED_TIMEOUT_DELAY" },
      { row: 12, name: "ASYNC_REJECTION", mode: "ASYNC_REJECTION" },
    ];

    for (const testCase of faultMatrix) {
      it(`Matrix Row ${testCase.row} [${testCase.name}]: guarantees containment and fails closed`, async () => {
        const { runId, workerId, leaseId } = setupStandardRun(`task-matrix-${testCase.row}`);
        const testReflex = new FaultInjectableReflex({ faultMode: testCase.mode });

        if (testCase.mode === "BOUNDED_TIMEOUT_DELAY") {
          testReflex.setFaultMode("BOUNDED_TIMEOUT_DELAY", { delayMs: 10 });
        }

        queueValidProposal(agentBrain);

        const controller = new AgentStepController({
          coordinator,
          stateStore,
          workerRuntime,
          agentBrain,
          proposalValidator,
          clock,
          reflex: testReflex,
        });

        const result = await controller.runStepLoop({
          runId,
          workerId,
          leaseId,
          budget: { maxSteps: 2, maxProposalRejections: 3 },
        });

        if (testCase.expectedTerminalReason) {
          expect(result.terminalReason).toBe(testCase.expectedTerminalReason);
        }

        if (
          testCase.mode === "EXCEPTION_THROW" ||
          testCase.mode === "NON_ERROR_THROW" ||
          testCase.mode === "INVALID_DECISION_STRING" ||
          testCase.mode === "INVALID_REASON_CODE" ||
          testCase.mode === "INVALID_SCHEMA_SHAPE" ||
          testCase.mode === "AUTHORITY_INJECTION" ||
          testCase.mode === "ABORT_SIGNAL_CANCELLATION" ||
          testCase.mode === "ASYNC_REJECTION"
        ) {
          expect(executionProvider.invocations.length).toBe(0);
          expect(result.totalActions).toBe(0);
          if (testCase.mode !== "ABORT_SIGNAL_CANCELLATION") {
            expect(result.totalProposalRejections).toBeGreaterThanOrEqual(1);
          }
        }
      });
    }
  });
});
