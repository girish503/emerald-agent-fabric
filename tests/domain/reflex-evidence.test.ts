/**
 * Emerald Agent Fabric — Phase 8.4 Test Suite
 * Reflex Evidence and Replay Instrumentation Verification
 *
 * Verifies:
 * 1. Evidence contract & schema validation (bounds, precedence, canonical schemas)
 * 2. Security & credential firewalls (secrets, tokens, authority keys)
 * 3. Deterministic identity hashing (canonical sorting, timestamp exclusion, tamper evidence)
 * 4. Pure offline replay verification (ALLOW, REJECT, DEFER, zero side-effects, UNKNOWN preservation)
 * 5. Mismatch detection (decision, reason, rule, configuration, context, invalid evidence)
 * 6. AgentStepController & End-to-End integration (baseline isolation, reflex retention, evidence replay)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createReflexEvidence,
  validateReflexEvidence,
  replayReflexEvidence,
  getReflexPrecedenceIndex,
  MAX_REFLEX_EVIDENCE_BYTES,
  REFLEX_EVIDENCE_SCHEMA_VERSION,
  REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
} from "../../src/domain/reflex-evidence.js";
import {
  ReflexContext,
  ReflexDecision,
  RuleBasedReflexConfig,
  computeReflexContextHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
} from "../../src/domain/reflex.js";
import { ActionProposal } from "../../src/domain/action-proposal.js";
import { RuleBasedReflex } from "../../src/adapters/reflex/rule-based-reflex.js";
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

// Mock brain helper
class ScriptableAgentBrain implements AgentBrainPort {
  readonly name = "ScriptableAgentBrain";
  readonly version = "1.0.0";
  private steps: Array<(request: AgentBrainRequest) => Promise<AgentBrainResult> | AgentBrainResult> = [];

  queueStep(handler: (request: AgentBrainRequest) => Promise<AgentBrainResult> | AgentBrainResult): void {
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
  readonly name = "CountingExecutionProvider";
  readonly invocations: ExecutionRequest[] = [];

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request as ExecutionRequest);
    return {
      status: "SUCCESS",
      output: { executed: true } as unknown as TOutput,
      durationMs: 10,
    };
  }
}

describe("Phase 8.4 — Reflex Evidence and Replay Instrumentation", () => {
  function createSampleProposal(overrides?: Partial<ActionProposal>): ActionProposal {
    return {
      proposalId: "prop-sample-001",
      toolName: "read_file",
      inputPayload: { path: "src/main.ts" },
      contextSnapshotHash: "a".repeat(64),
      rationale: "Inspecting main source file",
      ...overrides,
    };
  }

  function createSampleContext(overrides?: Partial<ReflexContext>): ReflexContext {
    return {
      runId: "run-sample-001",
      taskId: "task-test-001",
      stepNumber: 3,
      failureCount: 0,
      recentActionHistory: [
        {
          toolName: "read_file",
          status: "SUCCEEDED",
          sequenceNumber: 1,
          inputHash: "b".repeat(64),
        },
        {
          toolName: "search_code",
          status: "SUCCEEDED",
          sequenceNumber: 2,
          inputHash: "c".repeat(64),
        },
      ],
      resourceUsage: {
        stepsExecuted: 2,
        actionsExecuted: 2,
        elapsedWallClockMs: 1200,
        modelCallsExecuted: 2,
      },
      ...overrides,
    };
  }

  function createSampleDecision(overrides?: Partial<ReflexDecision>): ReflexDecision {
    return {
      decision: "ALLOW",
      reasonCode: "NO_INTERVENTION",
      ruleId: undefined,
      rationale: "Action passed deterministic heuristic evaluation without trigger.",
      ...overrides,
    };
  }

  describe("1. Evidence Contract & Schema Validation", () => {
    it("validates a properly structured ReflexEvidence record", () => {
      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: "RuleBasedReflex",
        reflexImplementationVersion: "1.0.0",
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
      });

      expect(evidence.evidenceId).toMatch(/^rfe-run-001-1-/);
      expect(evidence.schemaVersion).toBe(REFLEX_EVIDENCE_SCHEMA_VERSION);
      expect(evidence.toolName).toBe("read_file");
      expect(evidence.decision).toBe("ALLOW");
      expect(evidence.reasonCode).toBe("NO_INTERVENTION");
      expect(evidence.precedenceIndex).toBe(4);
      expect(evidence.evidenceIdentityHash).toMatch(/^[a-f0-9]{64}$/);

      const validated = validateReflexEvidence(evidence);
      expect(validated.evidenceId).toBe(evidence.evidenceId);
    });

    it("rejects evidence exceeding the 64 KB payload ceiling", () => {
      const proposal = createSampleProposal({
        inputPayload: {
          bloat: "x".repeat(MAX_REFLEX_EVIDENCE_BYTES + 100),
        },
      });
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      expect(() =>
        createReflexEvidence({
          runId: "run-001",
          sequenceNumber: 1,
          proposal,
          context,
          decision,
          reflexImplementation: "RuleBasedReflex",
          reflexImplementationVersion: "1.0.0",
          ruleConfigurationHash: reflex.activeConfigHash,
          reflexContextHash: computeReflexContextHash(context),
        })
      ).toThrow(/exceeds maximum limit/);
    });

    it("enforces deterministic precedence indexing across rules", () => {
      expect(getReflexPrecedenceIndex("reflex.failure-loop.v1", "REJECT", "REPEATED_FAILURE")).toBe(1);
      expect(getReflexPrecedenceIndex("reflex.redundant-action.v1", "REJECT", "REDUNDANT_ACTION")).toBe(2);
      expect(getReflexPrecedenceIndex("reflex.budget-pressure.v1", "DEFER", "RESOURCE_PRESSURE")).toBe(3);
      expect(getReflexPrecedenceIndex(undefined, "ALLOW", "NO_INTERVENTION")).toBe(4);
      expect(getReflexPrecedenceIndex(undefined, "ALLOW", "POLICY_PRECHECK")).toBe(0);
    });

    it("rejects invalid hash formats and negative sequence numbers", () => {
      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      expect(() =>
        createReflexEvidence({
          runId: "run-001",
          sequenceNumber: -1,
          proposal,
          context,
          decision,
          reflexImplementation: "RuleBasedReflex",
          reflexImplementationVersion: "1.0.0",
          ruleConfigurationHash: reflex.activeConfigHash,
          reflexContextHash: computeReflexContextHash(context),
        })
      ).toThrow();

      expect(() =>
        createReflexEvidence({
          runId: "run-001",
          sequenceNumber: 1,
          proposal,
          context,
          decision,
          reflexImplementation: "RuleBasedReflex",
          reflexImplementationVersion: "1.0.0",
          ruleConfigurationHash: "invalid-hash",
          reflexContextHash: computeReflexContextHash(context),
        })
      ).toThrow();
    });
  });

  describe("2. Security & Credential Firewalls", () => {
    it("rejects evidence containing sensitive secret keywords in proposal", () => {
      const proposal = createSampleProposal({
        inputPayload: {
          apiKey: "secret-token-123",
        },
      });
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      expect(() =>
        createReflexEvidence({
          runId: "run-001",
          sequenceNumber: 1,
          proposal,
          context,
          decision,
          reflexImplementation: "RuleBasedReflex",
          reflexImplementationVersion: "1.0.0",
          ruleConfigurationHash: reflex.activeConfigHash,
          reflexContextHash: computeReflexContextHash(context),
        })
      ).toThrow(/contains sensitive key/);
    });

    it("rejects evidence containing forbidden authority keys in proposal", () => {
      const proposal = {
        proposalId: "prop-001",
        toolName: "read_file" as const,
        inputPayload: { path: "main.ts" },
        contextSnapshotHash: "a".repeat(64),
        workerId: "rogue-worker-id",
      } as unknown as ActionProposal;

      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      expect(() =>
        createReflexEvidence({
          runId: "run-001",
          sequenceNumber: 1,
          proposal,
          context,
          decision,
          reflexImplementation: "RuleBasedReflex",
          reflexImplementationVersion: "1.0.0",
          ruleConfigurationHash: reflex.activeConfigHash,
          reflexContextHash: computeReflexContextHash(context),
        })
      ).toThrow(/forbidden authority keys/);
    });

    it("rejects evidence containing forbidden authority keys in context", () => {
      const proposal = createSampleProposal();
      const context = {
        ...createSampleContext(),
        leaseId: "stolen-lease-id",
      } as unknown as ReflexContext;

      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      expect(() =>
        createReflexEvidence({
          runId: "run-001",
          sequenceNumber: 1,
          proposal,
          context,
          decision,
          reflexImplementation: "RuleBasedReflex",
          reflexImplementationVersion: "1.0.0",
          ruleConfigurationHash: reflex.activeConfigHash,
          reflexContextHash: computeReflexContextHash(context),
        })
      ).toThrow(/forbidden authority keys/);
    });
  });

  describe("3. Deterministic Identity Hashing", () => {
    it("produces identical identity hash regardless of object key order", () => {
      const proposalA = createSampleProposal({
        inputPayload: { a: 1, b: 2, c: 3 },
      });
      const proposalB = createSampleProposal({
        inputPayload: { c: 3, a: 1, b: 2 },
      });
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      const evidenceA = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal: proposalA,
        context,
        decision,
        reflexImplementation: "RuleBasedReflex",
        reflexImplementationVersion: "1.0.0",
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
      });

      const evidenceB = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal: proposalB,
        context,
        decision,
        reflexImplementation: "RuleBasedReflex",
        reflexImplementationVersion: "1.0.0",
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
      });

      expect(evidenceA.evidenceIdentityHash).toBe(evidenceB.evidenceIdentityHash);
    });

    it("excludes volatile evaluatedAt timestamp from identity hash", () => {
      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      const evidence1 = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: "RuleBasedReflex",
        reflexImplementationVersion: "1.0.0",
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        evaluatedAt: "2026-10-14T10:00:00.000Z",
      });

      const evidence2 = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: "RuleBasedReflex",
        reflexImplementationVersion: "1.0.0",
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        evaluatedAt: "2026-10-14T12:00:00.000Z",
      });

      expect(evidence1.evidenceIdentityHash).toBe(evidence2.evidenceIdentityHash);
      expect(evidence1.evaluatedAt).not.toBe(evidence2.evaluatedAt);
    });

    it("detects tampering when any input field changes", async () => {
      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = createSampleDecision();
      const reflex = new RuleBasedReflex();

      const baseEvidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: "RuleBasedReflex",
        reflexImplementationVersion: "1.0.0",
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
      });

      const tamperedEvidence = {
        ...baseEvidence,
        decision: "REJECT" as const,
      };

      const result = await replayReflexEvidence(tamperedEvidence, { reflex });
      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.match).toBe(false);
      expect(result.mismatchDetails).toContain("evidenceIdentityHash mismatch");
    });
  });

  describe("4. Pure Offline Replay Verification", () => {
    it("replays an ALLOW decision with status MATCH without side-effects", async () => {
      const reflex = new RuleBasedReflex();
      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = await reflex.evaluate(proposal, context);

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        ruleConfig: reflex.activeConfig,
      });

      const replayResult = await replayReflexEvidence(evidence, { reflex });
      expect(replayResult.status).toBe("MATCH");
      expect(replayResult.match).toBe(true);
      expect(replayResult.recomputed?.decision).toBe("ALLOW");
      expect(replayResult.recomputed?.reasonCode).toBe("NO_INTERVENTION");
    });

    it("replays a failure-loop REJECT decision with status MATCH", async () => {
      const reflex = new RuleBasedReflex();
      const proposal = createSampleProposal({
        toolName: "read_file",
        inputPayload: { path: "src/main.ts" },
      });
      const context = createSampleContext({
        recentActionHistory: [
          { toolName: "read_file", status: "FAILED", sequenceNumber: 1 },
          { toolName: "read_file", status: "FAILED", sequenceNumber: 2 },
          { toolName: "read_file", status: "FAILED", sequenceNumber: 3 },
        ],
      });
      const decision = await reflex.evaluate(proposal, context);

      expect(decision.decision).toBe("REJECT");
      expect(decision.reasonCode).toBe("REPEATED_FAILURE");
      expect(decision.ruleId).toBe("reflex.failure-loop.v1");

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        ruleConfig: reflex.activeConfig,
      });

      const replayResult = await replayReflexEvidence(evidence, { reflex });
      expect(replayResult.status).toBe("MATCH");
      expect(replayResult.match).toBe(true);
      expect(replayResult.recomputed?.decision).toBe("REJECT");
      expect(replayResult.recomputed?.reasonCode).toBe("REPEATED_FAILURE");
      expect(replayResult.recomputed?.ruleId).toBe("reflex.failure-loop.v1");
    });

    it("replays a redundant-action REJECT decision with status MATCH", async () => {
      const reflex = new RuleBasedReflex();
      const proposal = createSampleProposal({
        toolName: "read_file",
        inputPayload: { path: "src/main.ts" },
      });

      // Same action executed 3 times already
      const actionInputHash = "d".repeat(64);
      const context = createSampleContext({
        recentActionHistory: [
          { toolName: "read_file", inputHash: actionInputHash, status: "SUCCEEDED", sequenceNumber: 1 },
          { toolName: "read_file", inputHash: actionInputHash, status: "SUCCEEDED", sequenceNumber: 2 },
          { toolName: "read_file", inputHash: actionInputHash, status: "SUCCEEDED", sequenceNumber: 3 },
        ],
      });

      const decision = await reflex.evaluate(proposal, context);

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        ruleConfig: reflex.activeConfig,
      });

      const replayResult = await replayReflexEvidence(evidence, { reflex });
      expect(replayResult.status).toBe("MATCH");
      expect(replayResult.match).toBe(true);
      expect(replayResult.recomputed?.decision).toBe(decision.decision);
      expect(replayResult.recomputed?.reasonCode).toBe(decision.reasonCode);
    });

    it("replays a budget-pressure DEFER decision with status MATCH", async () => {
      const config: RuleBasedReflexConfig = {
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        budgetPressure: {
          enabled: true,
          pressureThreshold: 0.8,
          maxSteps: 10,
          decisionOnTrigger: "DEFER",
        },
      };
      const reflex = new RuleBasedReflex(config);
      const proposal = createSampleProposal();
      const context = createSampleContext({
        stepNumber: 9, // 9/10 = 0.9 >= 0.8
        resourceUsage: {
          stepsExecuted: 9,
          actionsExecuted: 8,
          elapsedWallClockMs: 500,
          modelCallsExecuted: 9,
        },
      });

      const decision = await reflex.evaluate(proposal, context);
      expect(decision.decision).toBe("DEFER");
      expect(decision.reasonCode).toBe("RESOURCE_PRESSURE");
      expect(decision.ruleId).toBe("reflex.budget-pressure.v1");

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        ruleConfig: reflex.activeConfig,
      });

      const replayResult = await replayReflexEvidence(evidence, { reflex });
      expect(replayResult.status).toBe("MATCH");
      expect(replayResult.match).toBe(true);
      expect(replayResult.recomputed?.decision).toBe("DEFER");
      expect(replayResult.recomputed?.reasonCode).toBe("RESOURCE_PRESSURE");
      expect(replayResult.recomputed?.ruleId).toBe("reflex.budget-pressure.v1");
    });

    it("preserves epistemic integrity: UNKNOWN actions in context are never fabricated", async () => {
      const reflex = new RuleBasedReflex();
      const proposal = createSampleProposal();
      const context = createSampleContext({
        recentActionHistory: [
          { toolName: "run_command", inputHash: "e".repeat(64), status: "UNKNOWN", sequenceNumber: 1 },
        ],
      });

      const decision = await reflex.evaluate(proposal, context);
      expect(decision.decision).toBe("ALLOW");

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
      });

      expect(evidence.replayInput.context.recentActionHistory?.[0]?.status).toBe("UNKNOWN");
      const replay = await replayReflexEvidence(evidence, { reflex });
      expect(replay.status).toBe("MATCH");
    });
  });

  describe("5. Mismatch Detection", () => {
    it("detects MISMATCH_CONFIGURATION when replay reflex configuration differs", async () => {
      const originalReflex = new RuleBasedReflex({
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        failureLoop: { enabled: true, maxRepeatedFailures: 3, decisionOnTrigger: "REJECT" },
      });
      const differentReflex = new RuleBasedReflex({
        ...DEFAULT_RULE_BASED_REFLEX_CONFIG,
        failureLoop: { enabled: true, maxRepeatedFailures: 5, decisionOnTrigger: "REJECT" },
      });

      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = createSampleDecision();

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: originalReflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: originalReflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
      });

      const result = await replayReflexEvidence(evidence, { reflex: differentReflex });
      expect(result.status).toBe("MISMATCH_CONFIGURATION");
      expect(result.match).toBe(false);
      expect(result.mismatchDetails).toContain("does not match recorded ruleConfigurationHash");
    });

    it("detects MISMATCH_CONTEXT when replay input context hash does not match recorded context hash", async () => {
      const reflex = new RuleBasedReflex();
      const proposal = createSampleProposal();
      const context = createSampleContext();
      const decision = createSampleDecision();

      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision,
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: "f".repeat(64), // Inconsistent context hash
      });

      const result = await replayReflexEvidence(evidence, { reflex });
      expect(result.status).toBe("MISMATCH_CONTEXT");
      expect(result.match).toBe(false);
      expect(result.mismatchDetails).toContain("does not match recorded reflexContextHash");
    });

    it("detects MISMATCH_DECISION when re-evaluated decision differs from recorded decision", async () => {
      const reflex = new RuleBasedReflex();
      const proposal = createSampleProposal({
        toolName: "read_file",
        inputPayload: { path: "src/main.ts" },
      });
      // Context has 3 repeated failures so re-evaluation will produce REJECT
      const context = createSampleContext({
        recentActionHistory: [
          { toolName: "read_file", status: "FAILED", sequenceNumber: 1 },
          { toolName: "read_file", status: "FAILED", sequenceNumber: 2 },
          { toolName: "read_file", status: "FAILED", sequenceNumber: 3 },
        ],
      });

      // Record says ALLOW, but evaluation against reflex will produce REJECT
      const evidence = createReflexEvidence({
        runId: "run-001",
        sequenceNumber: 1,
        proposal,
        context,
        decision: {
          decision: "ALLOW",
          reasonCode: "NO_INTERVENTION",
        },
        reflexImplementation: reflex.name,
        reflexImplementationVersion: REFLEX_IMPLEMENTATION_VERSION_DEFAULT,
        ruleConfigurationHash: reflex.activeConfigHash,
        reflexContextHash: computeReflexContextHash(context),
        ruleConfig: reflex.activeConfig,
      });

      const result = await replayReflexEvidence(evidence, { reflex });
      expect(result.status).toBe("MISMATCH_DECISION");
      expect(result.match).toBe(false);
      expect(result.recorded.decision).toBe("ALLOW");
      expect(result.recomputed?.decision).toBe("REJECT");
    });
  });

  describe("6. AgentStepController & End-to-End Integration", () => {
    let tempDir: string;
    let store: SqliteStateStore;
    let coordinator: RunCoordinator;
    let workerRuntime: WorkerRuntime;
    let workspaceAdapter: NodeFsWorkspaceAdapter;
    let proposalValidator: ProposalValidator;
    let brain: ScriptableAgentBrain;
    let clock: SettableClock;
    let provider: CountingExecutionProvider;

    let runId: string;
    let workerId: string;
    let leaseId: string;

    beforeEach(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-8-4-reflex-evidence-"));
      const dbPath = path.join(tempDir, "test.db");
      const workspaceRoot = path.join(tempDir, "workspaces");
      fs.mkdirSync(workspaceRoot, { recursive: true });

      clock = new SettableClock(new Date("2026-10-14T10:00:00.000Z"));
      store = new SqliteStateStore({ location: dbPath });
      provider = new CountingExecutionProvider();
      workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot });
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

      // Register worker
      store.transaction((tx) => {
        tx.insertWorker({
          workerId: "worker-pipe-01",
          hostname: "localhost",
          pid: 8888,
          status: "ACTIVE",
          createdAt: clock.nowIso(),
          lastHeartbeatAt: clock.nowIso(),
        });
      });

      const task = coordinator.createTask({
        title: "Evaluation Task",
        description: "Task for reflex evidence testing",
        inputPayload: { target: "test" },
      });

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

      const { run } = coordinator.createRun({ taskId: task.taskId });
      runId = run.runId;
      workerId = "worker-pipe-01";

      coordinator.queueRun(runId);
      const claimResult = coordinator.claimRun(runId, workerId, 60000);
      leaseId = claimResult.lease.leaseId;
      coordinator.startRun(runId, workerId, leaseId);
    });

    afterEach(() => {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("attaches reflexEvidence during REFLEX mode and successfully replays offline", async () => {
      const reflex = new RuleBasedReflex();
      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex,
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-step-1",
          toolName: "read_file",
          inputPayload: { path: "src/main.ts" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Read main source file",
        },
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(result.transcript.length).toBe(1);
      const firstStep = result.transcript[0]!;
      expect(firstStep.reflexDecision).toBe("ALLOW");
      expect(firstStep.reflexEvidence).toBeDefined();

      const evidence = firstStep.reflexEvidence!;
      expect(evidence.runId).toBe(runId);
      expect(evidence.sequenceNumber).toBe(1);
      expect(evidence.toolName).toBe("read_file");
      expect(evidence.decision).toBe("ALLOW");
      expect(evidence.reasonCode).toBe("NO_INTERVENTION");
      expect(evidence.ruleConfigurationHash).toBe(reflex.activeConfigHash);

      // Verify offline replay produces exact match
      const replay = await replayReflexEvidence(evidence, { reflex });
      expect(replay.status).toBe("MATCH");
      expect(replay.match).toBe(true);
      expect(replay.recomputed?.decision).toBe("ALLOW");
    });

    it("leaves reflexEvidence undefined when running with NoopReflex (BASELINE isolation)", async () => {
      const controller = new AgentStepController({
        coordinator,
        stateStore: store,
        workerRuntime,
        agentBrain: brain,
        proposalValidator,
        clock,
        reflex: new NoopReflex(), // BASELINE mode
      });

      brain.queueStep((req) => ({
        finishReason: "ACTION_PROPOSED",
        proposal: {
          proposalId: "prop-baseline-1",
          toolName: "read_file",
          inputPayload: { path: "src/main.ts" },
          contextSnapshotHash: req.contextSnapshot.contextHash,
          rationale: "Read main source in baseline",
        },
      }));

      const result = await controller.runStepLoop({
        runId,
        workerId,
        leaseId,
        budget: { maxSteps: 1 },
      });

      expect(result.transcript.length).toBe(1);
      const firstStep = result.transcript[0]!;
      expect(firstStep.reflexDecision).toBe("ALLOW");
      // Must be strictly undefined for baseline NoopReflex
      expect(firstStep.reflexEvidence).toBeUndefined();
    });
  });
});
