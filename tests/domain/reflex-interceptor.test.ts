/**
 * Emerald Agent Fabric — Phase 8.1 Test Suite
 * Reflex Proposal Interceptor Architecture & Invariant Verification
 *
 * Verifies:
 * 1. Domain contract (ReflexDecision, ReflexReasonCode, schema validation, canonical hashing)
 * 2. Context immutability (observational data only, credential & authority firewall)
 * 3. No-op Reflex adapter (deterministic ALLOW / NO_INTERVENTION, zero side-effects)
 * 4. Pipeline integration (ProposalValidator -> Reflex -> PolicyEvaluator -> ToolGateway)
 * 5. Authority monotonicity (EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex)
 * 6. Architectural invariants (zero model dependency, zero persistence bypass, zero synthetic metrics)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  REFLEX_DECISION_KINDS,
  REFLEX_REASON_CODES,
  MAX_REFLEX_RATIONALE_LENGTH,
  ReflexDecision,
  ReflexContext,
  validateReflexDecision,
  validateReflexContext,
  computeReflexContextHash,
  assertReflexAuthorityInvariant,
  isValidReflexDecisionKind,
  isValidReflexReasonCode,
} from "../../src/domain/reflex.js";
import {
  InvalidReflexDecisionError,
  InvalidReflexContextError,
  ReflexAuthorityExpansionError,
} from "../../src/domain/errors.js";
import { ActionProposal } from "../../src/domain/action-proposal.js";
import { ReflexPort } from "../../src/ports/reflex.port.js";
import { NoopReflex } from "../../src/adapters/reflex/noop-reflex.js";
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

import { createAndActivateContract } from "../application/test-helpers.js";

// ----------------------------------------------------------------------------
// Test Doubles
// ----------------------------------------------------------------------------

class CountingExecutionProvider implements ExecutionProvider {
  readonly tenantModel = "NONE" as const;
  readonly quiescence = { async quiesceRun(_runId: string) { return { status: "QUIESCENT" as const, stopped: 0 }; } };
  readonly name = "counting-provider";
  readonly invocations: ExecutionRequest[] = [];

  get providerInvocationCount(): number {
    return this.invocations.length;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    return {
      status: "SUCCESS",
      output: { executed: true } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

class ScriptableAgentBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private steps: ((req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>)[] = [];

  queueStep(step: (req: AgentBrainRequest) => AgentBrainResult | Promise<AgentBrainResult>): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (next) {
      return await next(request);
    }
    return { finishReason: "GOAL_REACHED" };
  }
}

function makeValidProposal(hash: string, toolName = "read_file" as const): ActionProposal {
  return {
    proposalId: "prop-test-01",
    toolName,
    inputPayload: { path: "hello.txt" },
    contextSnapshotHash: hash,
    rationale: "Read the target file to observe content",
    sequenceHint: 1,
  };
}

// ----------------------------------------------------------------------------
// Test Suite
// ----------------------------------------------------------------------------

describe("Phase 8.1: Reflex Proposal Interceptor Architecture", () => {
  let tempDir: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let provider: CountingExecutionProvider;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let workerRuntime: WorkerRuntime;
  let proposalValidator: ProposalValidator;
  let brain: ScriptableAgentBrain;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-reflex-test-"));
    const dbPath = path.join(tempDir, "test.db");
    const workspaceRoot = path.join(tempDir, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    clock = new SettableClock(new Date("2026-10-13T12:00:00.000Z"));
    store = new SqliteStateStore({ location: dbPath });
    provider = new CountingExecutionProvider();
    workspaceAdapter = new NodeFsWorkspaceAdapter({
      workspaceRoot: workspaceRoot,
    });
    coordinator = new RunCoordinator(store, clock, undefined, workspaceAdapter);
    workerRuntime = new WorkerRuntime({
      workerId: "worker-pipe-01",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: provider,
    });
    proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      clock,
    });
    brain = new ScriptableAgentBrain();

    // Register test worker
    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-pipe-01",
        hostname: "localhost",
        pid: 7777,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Category 1: Domain Contract
  // ==========================================================================

  describe("1. Domain Contract (ReflexDecision & Hashing)", () => {
    it("1. valid ReflexDecision passes validation for all taxonomy kinds", () => {
      for (const kind of REFLEX_DECISION_KINDS) {
        expect(isValidReflexDecisionKind(kind)).toBe(true);
        const decision: ReflexDecision = {
          decision: kind,
          reasonCode: "NO_INTERVENTION",
          rationale: `Valid decision of kind ${kind}`,
        };
        const validated = validateReflexDecision(decision);
        expect(validated.decision).toBe(kind);
        expect(validated.reasonCode).toBe("NO_INTERVENTION");
      }
    });

    it("2. invalid decision kind is rejected", () => {
      expect(isValidReflexDecisionKind("EXECUTE_TOOL")).toBe(false);
      const invalidDecision = {
        decision: "EXECUTE_TOOL",
        reasonCode: "NO_INTERVENTION",
      };
      expect(() => validateReflexDecision(invalidDecision)).toThrow(
        InvalidReflexDecisionError
      );
    });

    it("3. deterministic reason code is enforced", () => {
      for (const code of REFLEX_REASON_CODES) {
        expect(isValidReflexReasonCode(code)).toBe(true);
      }
      expect(isValidReflexReasonCode("ARBITRARY_GUESS")).toBe(false);

      const invalidCodeDecision = {
        decision: "ALLOW",
        reasonCode: "NOT_A_REAL_REASON",
      };
      expect(() => validateReflexDecision(invalidCodeDecision)).toThrow(
        InvalidReflexDecisionError
      );
    });

    it("4. optional rationale bounds are enforced", () => {
      const longRationale = "a".repeat(MAX_REFLEX_RATIONALE_LENGTH + 1);
      const invalid = {
        decision: "ALLOW",
        reasonCode: "NO_INTERVENTION",
        rationale: longRationale,
      };
      expect(() => validateReflexDecision(invalid)).toThrow(
        InvalidReflexDecisionError
      );

      const validBoundary = {
        decision: "ALLOW",
        reasonCode: "NO_INTERVENTION",
        rationale: "a".repeat(MAX_REFLEX_RATIONALE_LENGTH),
      };
      expect(validateReflexDecision(validBoundary).rationale?.length).toBe(
        MAX_REFLEX_RATIONALE_LENGTH
      );
    });

    it("5. forbidden authority fields in ReflexDecision are strictly rejected", () => {
      const maliciousDecision = {
        decision: "ALLOW",
        reasonCode: "NO_INTERVENTION",
        capability: "HOST_COMMAND",
      };
      expect(() => validateReflexDecision(maliciousDecision)).toThrow(
        InvalidReflexDecisionError
      );
    });

    it("6. decision serializes canonically and round-trips", () => {
      const decision: ReflexDecision = {
        decision: "REJECT",
        reasonCode: "RISK_SIGNAL",
        rationale: "Action flagged for high side-effect risk",
      };
      const json = JSON.stringify(decision);
      const deserialized = JSON.parse(json);
      const validated = validateReflexDecision(deserialized);
      expect(validated).toEqual(decision);
    });

    it("7. context serializes canonically and round-trips", () => {
      const context: ReflexContext = {
        runId: "run-100",
        taskId: "task-100",
        stepNumber: 1,
        failureCount: 0,
        taskDescription: "Test task",
        recentActionHistory: [{ toolName: "read_file", status: "SUCCEEDED" }],
        resourceUsage: { elapsedWallClockMs: 150, actionsExecuted: 1 },
      };
      const json = JSON.stringify(context);
      const deserialized = JSON.parse(json);
      const validated = validateReflexContext(deserialized);
      expect(validated.runId).toBe(context.runId);
      expect(validated.recentActionHistory).toEqual(context.recentActionHistory);
    });

    it("8. context identity/hash is deterministic and invariant to key ordering", () => {
      const ctxA: ReflexContext = {
        runId: "run-001",
        taskId: "task-001",
        stepNumber: 2,
        failureCount: 0,
        taskDescription: "Deterministic hash test",
      };
      const ctxB: ReflexContext = {
        taskDescription: "Deterministic hash test",
        failureCount: 0,
        stepNumber: 2,
        taskId: "task-001",
        runId: "run-001",
      };
      const hashA = computeReflexContextHash(ctxA);
      const hashB = computeReflexContextHash(ctxB);
      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ==========================================================================
  // Category 2: Context
  // ==========================================================================

  describe("2. Context Immutability & Security Firewall", () => {
    it("9. validated context is deeply frozen", () => {
      const context: ReflexContext = {
        runId: "run-001",
        taskId: "task-001",
        stepNumber: 1,
        failureCount: 0,
        recentActionHistory: [{ toolName: "read_file", status: "SUCCEEDED" }],
        resourceUsage: { elapsedWallClockMs: 100 },
      };
      const validated = validateReflexContext(context);
      expect(Object.isFrozen(validated)).toBe(true);
      expect(Object.isFrozen(validated.recentActionHistory)).toBe(true);
      expect(Object.isFrozen(validated.recentActionHistory![0])).toBe(true);
      expect(Object.isFrozen(validated.resourceUsage)).toBe(true);
    });

    it("10. task identity preserved across ReflexContext", () => {
      const context: ReflexContext = {
        runId: "run-002",
        taskId: "task-special-42",
        stepNumber: 1,
        failureCount: 0,
      };
      const validated = validateReflexContext(context);
      expect(validated.taskId).toBe("task-special-42");
    });

    it("11. run identity preserved across ReflexContext", () => {
      const context: ReflexContext = {
        runId: "run-xyz-99",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
      };
      const validated = validateReflexContext(context);
      expect(validated.runId).toBe("run-xyz-99");
    });

    it("12. action history preserved accurately in ReflexContext", () => {
      const history = [
        { toolName: "read_file" as const, status: "SUCCEEDED", sequenceNumber: 1 },
        { toolName: "write_file" as const, status: "FAILED", sequenceNumber: 2 },
      ];
      const context: ReflexContext = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 3,
        failureCount: 1,
        recentActionHistory: history,
      };
      const validated = validateReflexContext(context);
      expect(validated.recentActionHistory).toEqual(history);
    });

    it("13. verification state preserved in ReflexContext", () => {
      const context: ReflexContext = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
        verificationStatus: "PASSED",
      };
      const validated = validateReflexContext(context);
      expect(validated.verificationStatus).toBe("PASSED");
    });

    it("14. workspace state preserved in ReflexContext", () => {
      const context: ReflexContext = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
        workspacePath: "/tmp/workspaces/ws-01",
      };
      const validated = validateReflexContext(context);
      expect(validated.workspacePath).toBe("/tmp/workspaces/ws-01");
    });

    it("15. sensitive key firewall rejects credentials/secrets in context", () => {
      const contextWithSecret = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
        api_token: "secret-abc",
      };
      expect(() => validateReflexContext(contextWithSecret)).toThrow(
        InvalidReflexContextError
      );
    });

    it("16. forbidden authority keys firewall rejects worker/lease in context", () => {
      const contextWithAuthority = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
        workerId: "worker-01",
        leaseId: "lease-01",
      };
      expect(() => validateReflexContext(contextWithAuthority)).toThrow(
        InvalidReflexContextError
      );
    });

    it("17. rejects unexpected provider objects", () => {
      const contextWithProvider = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
        provider: { execute: () => {} },
      };
      expect(() => validateReflexContext(contextWithProvider)).toThrow(
        InvalidReflexContextError
      );
    });

    it("18. context is pure observational data and contains no execution methods", () => {
      const context = {
        runId: "run-01",
        taskId: "task-01",
        stepNumber: 1,
        failureCount: 0,
        execute: () => {},
      };
      expect(() => validateReflexContext(context)).toThrow(
        InvalidReflexContextError
      );
    });
  });

  // ==========================================================================
  // Category 3: No-op Reflex Adapter
  // ==========================================================================

  describe("3. NoopReflex Adapter Guarantees", () => {
    let noop: NoopReflex;
    let sampleProposal: ActionProposal;
    let sampleContext: ReflexContext;

    beforeEach(() => {
      noop = new NoopReflex();
      sampleProposal = makeValidProposal("a".repeat(64));
      sampleContext = {
        runId: "run-noop",
        taskId: "task-noop",
        stepNumber: 1,
        failureCount: 0,
      };
    });

    it("19. deterministic ALLOW is returned", async () => {
      const decision = await noop.evaluate(sampleProposal, sampleContext);
      expect(decision.decision).toBe("ALLOW");
    });

    it("20. deterministic NO_INTERVENTION reasonCode is returned", async () => {
      const decision = await noop.evaluate(sampleProposal, sampleContext);
      expect(decision.reasonCode).toBe("NO_INTERVENTION");
      expect(decision.rationale).toBe("No intervention required");
    });

    it("21. does not mutate proposal", async () => {
      const beforeStr = JSON.stringify(sampleProposal);
      await noop.evaluate(sampleProposal, sampleContext);
      expect(JSON.stringify(sampleProposal)).toBe(beforeStr);
    });

    it("22. does not mutate context", async () => {
      const beforeStr = JSON.stringify(sampleContext);
      await noop.evaluate(sampleProposal, sampleContext);
      expect(JSON.stringify(sampleContext)).toBe(beforeStr);
    });

    it("23. does not invoke model provider", async () => {
      // NoopReflex has no model dependencies and takes zero provider parameters
      expect((noop as any).modelProvider).toBeUndefined();
      const decision = await noop.evaluate(sampleProposal, sampleContext);
      expect(decision.decision).toBe("ALLOW");
    });

    it("24. does not invoke tools directly", async () => {
      expect((noop as any).toolRegistry).toBeUndefined();
      expect((noop as any).gateway).toBeUndefined();
      const decision = await noop.evaluate(sampleProposal, sampleContext);
      expect(decision.decision).toBe("ALLOW");
    });

    it("25. does not invoke Docker / container provider", async () => {
      expect((noop as any).executionProvider).toBeUndefined();
      expect(provider.providerInvocationCount).toBe(0);
      await noop.evaluate(sampleProposal, sampleContext);
      expect(provider.providerInvocationCount).toBe(0);
    });

    it("26. no hidden retries or persistence mutations", async () => {
      expect((noop as any).stateStore).toBeUndefined();
      expect((noop as any).coordinator).toBeUndefined();
      const decision = await noop.evaluate(sampleProposal, sampleContext);
      expect(decision.decision).toBe("ALLOW");
    });
  });

  // ==========================================================================
  // Category 4: Pipeline Integration
  // ==========================================================================

  describe("4. Pipeline Integration & Seam Verification", () => {
    let controller: AgentStepController;
    let taskId: string;
    let runId: string;
    let workerId: string;
    let leaseId: string;

    beforeEach(async () => {
      const task = coordinator.createTask({
        title: "Pipeline Task",
        description: "Task for pipeline integration",
        inputPayload: { target: "test" },
      });
      taskId = task.taskId;

      createAndActivateContract(store, task.taskId, {
        policy: createExecutionPolicy({
          policyId: `policy-${task.taskId}`,
          allowedCapabilities: [
            "workspace.file.read",
            "workspace.file.write",
            "workspace.code.search",
          ],
          isolationRequirement: "ISOLATED",
        }),
      });

      const { run } = coordinator.createRun({
        taskId: task.taskId,
      });
      runId = run.runId;
      workerId = "worker-pipe-01";

      coordinator.queueRun(runId);
      const claimResult = coordinator.claimRun(runId, workerId, 60000);
      leaseId = claimResult.lease.leaseId;


      coordinator.startRun(runId, workerId, leaseId);
    });


    it("27. malformed proposal never reaches Reflex", async () => {
      let reflexCalled = false;
      const spyReflex: ReflexPort = {
        async evaluate() {
          reflexCalled = true;
          return { decision: "ALLOW", reasonCode: "NO_INTERVENTION" };
        },
      };

      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: spyReflex,
      });

      // Brain proposes a malformed proposal (unknown tool)
      brain.queueStep(() => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p-bad",
          toolName: "nonexistent_tool" as any,
          inputPayload: {},
          contextSnapshotHash: "0".repeat(64),
        },
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5, maxProposalRejections: 1 },
      });


      expect(reflexCalled).toBe(false);
      expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
      expect(result.transcript[0]?.proposalValid).toBe(false);
    });

    it("28. validated proposal reaches Reflex interceptor", async () => {
      let capturedProposal: ActionProposal | undefined;
      let capturedContext: ReflexContext | undefined;

      const spyReflex: ReflexPort = {
        async evaluate(proposal, context) {
          capturedProposal = proposal;
          capturedContext = context;
          return { decision: "ALLOW", reasonCode: "NO_INTERVENTION" };
        },
      };

      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: spyReflex,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: makeValidProposal(req.contextSnapshot.contextHash),
      }));

      await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(capturedProposal).toBeDefined();
      expect(capturedProposal?.toolName).toBe("read_file");
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.runId).toBe(runId);
      expect(capturedContext?.taskId).toBe(taskId);
    });

    it("29. Reflex decision reaches policy evaluation", async () => {
      const controllerDefault = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: makeValidProposal(req.contextSnapshot.contextHash),
      }));

      const result = await controllerDefault.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(result.totalActions).toBe(1);
      expect(result.transcript[0]?.reflexDecision).toBe("ALLOW");
      expect(result.transcript[0]?.reflexReasonCode).toBe("NO_INTERVENTION");
    });

    it("30. ALLOW does not bypass policy", async () => {
      // Create a proposal for a tool NOT allowed by the contract policy
      // In default in-process policy, 'sandboxed_command' is not authorized
      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p-docker",
          toolName: "sandboxed_command",
          inputPayload: { command: "ls" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5, maxProposalRejections: 1 },
      });

      // ProposalValidator rejected the capability before Reflex, or policy evaluation prevents execution
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBe(1);
    });

    it("31. policy denial remains authoritative over Reflex recommendation", async () => {
      // Even if Reflex says ALLOW, if Policy blocks it, action is never executed
      const allowReflex: ReflexPort = {
        async evaluate() {
          return { decision: "ALLOW", reasonCode: "NO_INTERVENTION" };
        },
      };

      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: allowReflex,
      });

      // Propose unauthorized tool
      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "p-unauth",
          toolName: "sandboxed_command",
          inputPayload: { command: "cat /etc/passwd" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
        },
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5, maxProposalRejections: 1 },
      });

      expect(result.totalActions).toBe(0);
      expect(provider.providerInvocationCount).toBe(0);
    });

    it("32. REJECT prevents dispatch", async () => {
      const rejectingReflex: ReflexPort = {
        async evaluate() {
          return {
            decision: "REJECT",
            reasonCode: "RISK_SIGNAL",
            rationale: "Reflex blocked proposal due to observed risk",
          };
        },
      };

      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: rejectingReflex,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: makeValidProposal(req.contextSnapshot.contextHash),
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5, maxProposalRejections: 1 },
      });


      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBe(1);
      expect(result.transcript[0]?.reflexDecision).toBe("REJECT");
      expect(result.transcript[0]?.reflexReasonCode).toBe("RISK_SIGNAL");
      expect(provider.providerInvocationCount).toBe(0);
    });

    it("33. DEFER never silently becomes ALLOW", async () => {
      const deferringReflex: ReflexPort = {
        async evaluate() {
          return {
            decision: "DEFER",
            reasonCode: "VERIFICATION_CONCERN",
            rationale: "Execution deferred pending verification check",
          };
        },
      };

      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: deferringReflex,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: makeValidProposal(req.contextSnapshot.contextHash),
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(result.totalActions).toBe(0);
      expect(result.terminalReason).toBe("DEFERRED");
      expect(result.terminalMessage).toContain("VERIFICATION_CONCERN");
      expect(provider.providerInvocationCount).toBe(0);
    });

    it("34. unsupported control fails closed", async () => {
      const crashingReflex: ReflexPort = {
        async evaluate() {
          throw new Error("Reflex internal evaluation failure");
        },
      };

      controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: crashingReflex,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: makeValidProposal(req.contextSnapshot.contextHash),
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 5, maxProposalRejections: 1 },
      });


      // Fails safe: treats as rejection, does not execute action
      expect(result.totalActions).toBe(0);
      expect(result.totalProposalRejections).toBe(1);
      expect(result.transcript[0]?.reflexReasonCode).toBe("UNSUPPORTED_ACTION");
      expect(provider.providerInvocationCount).toBe(0);
    });

  });

  // ==========================================================================
  // Category 5: Authority Monotonicity
  // ==========================================================================

  describe("5. Authority Monotonicity & Invariant Verification", () => {
    let proposal: ActionProposal;

    beforeEach(() => {
      proposal = makeValidProposal("b".repeat(64));
    });

    it("35. Reflex cannot change capability", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        capability: "CONTAINER_EXECUTION",
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("36. Reflex cannot change contract", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        contractId: "contract-unlimited",
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("37. Reflex cannot change resource limit", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        resourceLimits: { timeoutMs: 999999 },
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("38. Reflex cannot change isolation", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        isolationLevel: "HOST",
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("39. Reflex cannot select credentials", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        credentials: ["root-admin-token"],
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("40. Reflex cannot select worker", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        workerId: "rogue-worker",
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("41. Reflex cannot select lease", () => {
      const maliciousDecision = {
        decision: "ALLOW" as const,
        reasonCode: "NO_INTERVENTION" as const,
        leaseId: "forged-lease",
      };
      expect(() =>
        assertReflexAuthorityInvariant(proposal, maliciousDecision as any)
      ).toThrow(ReflexAuthorityExpansionError);
    });

    it("42. Reflex cannot bypass ToolExecutionGateway", () => {
      const validDecision: ReflexDecision = {
        decision: "ALLOW",
        reasonCode: "NO_INTERVENTION",
      };
      // Normal invariant check passes for benign decisions
      expect(() =>
        assertReflexAuthorityInvariant(proposal, validDecision)
      ).not.toThrow();

      // But decision object cannot contain gateway override instructions
      const bypassDecision = {
        ...validDecision,
        bypassGateway: true,
      };
      expect(() =>
        validateReflexDecision(bypassDecision)
      ).toThrow(InvalidReflexDecisionError);
    });
  });

  // ==========================================================================
  // Category 6: Architecture Invariants
  // ==========================================================================

  describe("6. Architectural Invariants", () => {
    it("43. no model provider dependency in ReflexPort or NoopReflex", () => {
      const reflex = new NoopReflex();
      expect("generate" in reflex).toBe(false);
      expect("modelProvider" in reflex).toBe(false);
    });

    it("44. no direct provider execution in ReflexPort or NoopReflex", () => {
      const reflex = new NoopReflex();
      expect("execute" in reflex && typeof (reflex as any).execute === "function").toBe(false);
      expect("evaluate" in reflex).toBe(true);
    });

    it("45. no persistence mutation in ReflexPort or NoopReflex", () => {
      const reflex = new NoopReflex();
      expect("insertAction" in reflex).toBe(false);
      expect("stateStore" in reflex).toBe(false);
    });

    it("46. no MissionContract mutation by Reflex", () => {
      const reflex = new NoopReflex();
      expect("createMissionContract" in reflex).toBe(false);
      expect("mutateContract" in reflex).toBe(false);
    });

    it("47. no workspace mutation by Reflex", () => {
      const reflex = new NoopReflex();
      expect("cleanWorkspace" in reflex).toBe(false);
      expect("disposeWorkspace" in reflex).toBe(false);
    });

    it("48. no synthetic metric improvement", async () => {
      const reflex = new NoopReflex();
      const proposal = makeValidProposal("c".repeat(64));
      const context: ReflexContext = {
        runId: "run-m",
        taskId: "task-m",
        stepNumber: 1,
        failureCount: 0,
        resourceUsage: {
          elapsedWallClockMs: 1234,
          actionsExecuted: 5,
          stepsExecuted: 6,
        },
      };

      const decision = await reflex.evaluate(proposal, context);
      expect(decision.decision).toBe("ALLOW");
      // Does not alter context's recorded metrics
      expect(context.resourceUsage?.elapsedWallClockMs).toBe(1234);
      expect(context.resourceUsage?.actionsExecuted).toBe(5);
      expect(context.resourceUsage?.stepsExecuted).toBe(6);
    });
  });
});
