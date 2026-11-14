/**
 * Milestone 2.28 — Phase 5, Step 11: Mandatory System-Owned Verification Execution Test Suite
 *
 * Deterministic test suite verifying all 16 scenarios required for system-owned verification:
 * 1. Correct workspace content: verification executes and returns VERIFIED.
 * 2. Incorrect workspace content: verification rejects completion.
 * 3. Missing verification specification: unverifiable (NO_VERIFICATION_SPECS).
 * 4. Empty specification list: unverifiable.
 * 5. Unsupported verification rule: fail closed (UNSUPPORTED_VERIFICATION_RULE).
 * 6. Missing physical provider: fails closed; no host fallback.
 * 7. Sandbox unavailable or rejected: no verification success.
 * 8. Verification timeout: no success evidence (EXECUTION_TIMEOUT).
 * 9. Failed implementation run_command before verification: verification still executes.
 * 10. Model never proposes verification command: system-owned verification still executes.
 * 11. Repeated GOAL_REACHED: no duplicate or contradictory authoritative evidence (dedup token).
 * 12. Cross-run / cross-tenant evidence: isolated and rejected.
 * 13. Cancellation or lease loss during verification: no stale completion.
 * 14. Event persistence failure: completion cannot be marked verified.
 * 15. Existing completion-evidence gate regressions remain covered.
 * 16. Existing provider-role and no-host-fallback regressions remain covered.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { SandboxedCommandToolAdapter } from "../../src/adapters/tools/sandboxed-command.tool-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import {
  createVerificationSpec,
  DeterministicVerifier,
  type VerificationSpec,
} from "../../src/domain/verification.js";
import { createProcessExitEvidence } from "../../src/domain/evidence.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
} from "../../src/ports/agent-brain.port.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../src/ports/execution-provider.port.js";
import { createAndActivateContract } from "./test-helpers.js";

// ============================================================================
// Test Mock Providers
// ============================================================================

class ControllableExecutionProvider implements ExecutionProvider {
  readonly name = "controllable-mock-provider";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;
  readonly invocations: ExecutionRequest[] = [];

  constructor(
    private handler?: (req: ExecutionRequest) => { exitCode: number; stdout?: string; stderr?: string }
  ) {}

  setHandler(handler: (req: ExecutionRequest) => { exitCode: number; stdout?: string; stderr?: string }) {
    this.handler = handler;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    const res = this.handler
      ? this.handler(request)
      : { exitCode: 0, stdout: "ok\n", stderr: "" };

    return {
      status: "SUCCESS",
      output: {
        exitCode: res.exitCode,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        durationMs: 5,
        outputTruncated: false,
        commandHash: "mock-hash-" + res.exitCode,
      } as unknown as TOutput,
      durationMs: 5,
    };
  }
}

class ScriptedBrain implements AgentBrainPort {
  readonly requests: AgentBrainRequest[] = [];
  private readonly steps: ((req: AgentBrainRequest) => AgentBrainResult)[] = [];

  queue(step: (req: AgentBrainRequest) => AgentBrainResult): this {
    this.steps.push(step);
    return this;
  }

  async proposeAction(request: AgentBrainRequest): Promise<AgentBrainResult> {
    this.requests.push(request);
    const next = this.steps.shift();
    return next ? next(request) : { finishReason: "GOAL_REACHED" };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Mandatory System-Owned Verification Execution (Milestone 2.28 Phase 5 Step 11)", () => {
  const workerId = "worker-system-verification";
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let brain: ScriptedBrain;
  let provider: ControllableExecutionProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-sys-verify-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-10T12:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    brain = new ScriptedBrain();
    provider = new ControllableExecutionProvider();

    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 12345,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function runtimeWith(p: ExecutionProvider): WorkerRuntime {
    return new WorkerRuntime({
      workerId,
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
      executionProvider: p,
      isIsolationAvailable: true,
    });
  }

  function controllerFor(runtime: WorkerRuntime, allowUnverified = false): AgentStepController {
    return new AgentStepController({
      coordinator,
      stateStore: store,
      workerRuntime: runtime,
      agentBrain: brain,
      proposalValidator: new ProposalValidator({
        coordinator,
        stateStore: store,
        toolRegistry: staticToolRegistry,
        clock,
      }),
      toolRegistry: staticToolRegistry,
      clock,
      enableGovernedVerificationStage: true,
      allowUnverifiedCompletion: allowUnverified,
    });
  }

  async function setupRun(verificationSpecs?: VerificationSpec[]) {
    const task = coordinator.createTask({
      title: "System verification test task",
      description: "Test mandatory verification stage",
      inputPayload: { file: "acceptance.txt" },
    });

    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        tenantId: "tenant-acceptance",
        allowedCapabilities: [
          "workspace.file.read",
          "workspace.file.write",
          "git.read",
          "process.execute",
        ],
        isolationRequirement: "ISOLATED",
      }),
      verificationSpecs,
      timeoutMs: 30000,
      maxAttempts: 3,
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, workerId, 60000);
    coordinator.startRun(run.runId, workerId, claim.lease.leaseId);
    const workspace = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });

    return {
      task,
      contract,
      runId: run.runId,
      leaseId: claim.lease.leaseId,
      workspace,
    };
  }

  const defaultVerifySpec = () =>
    createVerificationSpec({
      specId: "vspec-exit-zero",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: {
        toolName: "run_command",
        argv: ["node", "-e", "process.exit(0)"],
      },
    });

  // --------------------------------------------------------------------------
  // Scenario 1: Correct workspace content -> VERIFIED
  // --------------------------------------------------------------------------
  it("Scenario 1: Correct workspace content -> verification executes and returns VERIFIED", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "-e") {
        return { exitCode: 0, stdout: "ALL_TESTS_PASSED" };
      }
      return { exitCode: 0 };
    });

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Agent immediately returns GOAL_REACHED
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // Authoritative verification events recorded
    const events = store.getEventsForRun(run.runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    const p = verifyEvent!.payload as Record<string, unknown>;
    expect(p.status).toBe("VERIFIED");
    expect(p.details).toMatchObject({
      runId: run.runId,
      specId: "vspec-exit-zero",
      exitCode: 0,
      executionOutcome: "SUCCEEDED",
      provenance: "SYSTEM_VERIFICATION",
    });

    // Verification command was executed through WorkerRuntime
    expect(provider.invocations.length).toBeGreaterThan(0);
    const lastInvocation = provider.invocations[provider.invocations.length - 1];
    expect(lastInvocation).toBeDefined();
    expect((lastInvocation!.inputPayload as any)?.argv).toEqual(["node", "-e", "process.exit(0)"]);
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Incorrect workspace content -> rejection
  // --------------------------------------------------------------------------
  it("Scenario 2: Incorrect workspace content -> verification rejects completion", async () => {
    provider.setHandler(() => ({ exitCode: 1, stderr: "ASSERTION_FAILED" }));

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Agent proposes GOAL_REACHED
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    const events = store.getEventsForRun(run.runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    const p = verifyEvent!.payload as Record<string, unknown>;
    expect(p.status).toBe("FAILED");
    expect(p.reasonCode).toBe("ASSERTION_FAILED");
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Missing verification specification -> unverifiable (fail-closed)
  // --------------------------------------------------------------------------
  it("Scenario 3: Missing verification specification -> unverifiable fail-closed", async () => {
    const run = await setupRun(undefined);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, false); // allowUnverified = false

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(result.terminalMessage).toContain("NO_VERIFICATION_SPECS");
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Empty specification list -> unverifiable
  // --------------------------------------------------------------------------
  it("Scenario 4: Empty specification list -> unverifiable fail-closed", async () => {
    const run = await setupRun([]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime, false);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(result.terminalMessage).toContain("NO_VERIFICATION_SPECS");
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Unsupported verification rule -> fail closed
  // --------------------------------------------------------------------------
  it("Scenario 5: Unsupported verification rule -> fail closed", async () => {
    const run = await setupRun([]);
    const originalContract = store.getContract(run.contract.spec.contractId, run.contract.spec.version)!;
    const contractWithUnsupported = {
      ...originalContract,
      spec: {
        ...originalContract.spec,
        verificationSpecs: [
          { specId: "vspec-unsupported", ruleKind: "UNSUPPORTED_RULE_KIND" as any },
        ],
      },
    };
    store.getContract = () => contractWithUnsupported as any;

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("COMPLETION_UNVERIFIABLE");
    expect(result.terminalMessage).toContain("UNSUPPORTED_VERIFICATION_RULE");
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Missing physical provider -> fails closed; no host fallback
  // --------------------------------------------------------------------------
  it("Scenario 6: Missing physical provider -> fails closed; no host fallback", async () => {
    class VirtualProvider implements ExecutionProvider {
      readonly name = "virtual-provider";
      readonly role = "ORCHESTRATION" as const;
      readonly tenantModel = "NONE" as const;
      async execute<_TInput, TOutput>(_req: ExecutionRequest<_TInput>): Promise<ExecutionResult<TOutput>> {
        return { status: "SUCCESS", output: { exitCode: 0 } as unknown as TOutput, durationMs: 1 };
      }
    }

    const virtualProv = new VirtualProvider();
    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(virtualProv);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 1 },
    });

    // Verification cannot complete with non-physical provider
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Sandbox unavailable or rejected -> no verification success
  // --------------------------------------------------------------------------
  it("Scenario 7: Sandbox unavailable -> completion rejected fail-closed", async () => {
    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: undefined, // Workspace unavailable
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
    const verEvent = store.getEventsForRun(run.runId).find(e => e.eventType === "verification.completed");
    expect(verEvent).toBeDefined();
    const p = verEvent!.payload as Record<string, unknown>;
    expect(p.message).toContain("requires an agent workspace");
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Verification timeout -> no success evidence
  // --------------------------------------------------------------------------
  it("Scenario 8: Verification timeout -> fails closed without completion", async () => {
    class TimingOutProvider implements ExecutionProvider {
      readonly name = "timeout-provider";
      readonly role = "PHYSICAL" as const;
      readonly tenantModel = "NONE" as const;
      async execute<_TInput, TOutput>(_req: ExecutionRequest<_TInput>): Promise<ExecutionResult<TOutput>> {
        return {
          status: "TIMED_OUT",
          error: { code: "EXECUTION_TIMEOUT", message: "Process timed out after 60000ms" },
          output: { exitCode: null, stdout: "", stderr: "Timeout" } as unknown as TOutput,
          durationMs: 60000,
        };
      }
    }

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(new TimingOutProvider());
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 1 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Failed implementation run_command before verification
  // --------------------------------------------------------------------------
  it("Scenario 9: Failed implementation command before verification -> verification STILL executes", async () => {
    let callCount = 0;
    provider.setHandler((_req) => {
      callCount++;
      // Implementation command (call 1) fails with syntax error (exit 1)
      if (callCount === 1) {
        return { exitCode: 1, stderr: "SyntaxError: Unexpected token" };
      }
      // System verification command (call 2) succeeds (exit 0)
      return { exitCode: 0, stdout: "VERIFIED_OK" };
    });

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Step 1: Model proposes a failing command
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "prop-failing-1",
        toolName: "run_command",
        inputPayload: { argv: ["node", "-e", "throw new Error()"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "Agent running broken code",
      },
    }));

    // Step 2: Model proposes GOAL_REACHED
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    // Even though agent's implementation command failed, system-owned verification executed!
    expect(result.terminalReason).toBe("COMPLETED");
    expect(callCount).toBe(2);

    const events = store.getEventsForRun(run.runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    const p = verifyEvent!.payload as Record<string, unknown>;
    expect(p.status).toBe("VERIFIED");
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Model never proposes verification command -> system executes it
  // --------------------------------------------------------------------------
  it("Scenario 10: Model never proposes verification command -> system-owned verification executes it", async () => {
    provider.setHandler(() => ({ exitCode: 0, stdout: "ALL_TESTS_PASS" }));

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Agent ONLY says GOAL_REACHED, zero tools proposed
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");

    // The single action in the run is the system verification action
    const actions = store.getActionsForRun(run.runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.toolName).toBe("run_command");
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Repeated GOAL_REACHED -> no duplicate contradictory evidence
  // --------------------------------------------------------------------------
  it("Scenario 11: Repeated GOAL_REACHED -> deduplicated and loop prevented", async () => {
    provider.setHandler(() => ({ exitCode: 1, stderr: "FAIL" }));

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    // Agent proposes GOAL_REACHED twice in a row without making changes
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      budget: { maxProposalRejections: 2 },
    });

    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");

    // Verification command was executed only ONCE because loop prevention halted duplicate execution
    expect(provider.invocations).toHaveLength(1);

    // Events in store are properly recorded with dedup tokens
    const events = store.getEventsForRun(run.runId);
    const verifyEvents = events.filter((e) => e.eventType === "verification.completed");
    expect(verifyEvents).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Cross-run / cross-tenant evidence isolation
  // --------------------------------------------------------------------------
  it("Scenario 12: Cross-run / cross-tenant evidence is isolated and rejected", async () => {
    const run1 = await setupRun([defaultVerifySpec()]);

    // Create a real second run in store to satisfy foreign key constraints
    const task2 = coordinator.createTask({
      title: "Foreign task",
      description: "Foreign task for isolation test",
      inputPayload: {},
    });
    createAndActivateContract(store, task2.taskId);
    const { run: run2 } = coordinator.createRun({ taskId: task2.taskId });

    // Insert exit evidence belonging to run2
    const foreignEvidence = createProcessExitEvidence(run2.runId, { exitCode: 0 });
    coordinator.recordEvidence(run2.runId, foreignEvidence);

    // Run 1 verification fails
    provider.setHandler(() => ({ exitCode: 1 }));
    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run1.runId,
      workerId,
      leaseId: run1.leaseId,
      workspace: run1.workspace,
      budget: { maxProposalRejections: 1 },
    });

    // Must NOT use foreignEvidence to complete run1
    expect(result.terminalReason).toBe("MAX_PROPOSAL_REJECTIONS");
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Cancellation or lease loss during verification
  // --------------------------------------------------------------------------
  it("Scenario 13: Cancellation during verification -> halts cleanly without completion", async () => {
    const abortCtrl = new AbortController();

    class CancellingProvider implements ExecutionProvider {
      readonly name = "cancelling-provider";
      readonly role = "PHYSICAL" as const;
      readonly tenantModel = "NONE" as const;
      async execute<_TInput, TOutput>(_req: ExecutionRequest<_TInput>): Promise<ExecutionResult<TOutput>> {
        abortCtrl.abort();
        return {
          status: "CANCELLED",
          error: { code: "EXECUTION_CANCELLED", message: "Cancelled by signal" },
          durationMs: 1,
        };
      }
    }

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(new CancellingProvider());
    const controller = controllerFor(runtime);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: run.leaseId,
      workspace: run.workspace,
      abortSignal: abortCtrl.signal,
    });

    expect(result.terminalReason).toBe("CANCELLED");
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Event persistence failure -> completion cannot be marked verified
  // --------------------------------------------------------------------------
  it("Scenario 14: Event persistence failure -> fails closed", async () => {
    provider.setHandler(() => ({ exitCode: 0 }));

    const run = await setupRun([defaultVerifySpec()]);
    const runtime = runtimeWith(provider);

    // Mock coordinator.recordVerificationResult to throw persistence error
    coordinator.recordVerificationResult = () => {
      throw new Error("Disk full: cannot append verification event");
    };

    const controller = controllerFor(runtime);
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    await expect(
      controller.runStepLoop({
        runId: run.runId,
        workerId,
        leaseId: run.leaseId,
        workspace: run.workspace,
      })
    ).rejects.toThrow("Disk full");
  });

  // --------------------------------------------------------------------------
  // Scenario 15: DeterministicVerifier pure logic regressions remain covered
  // --------------------------------------------------------------------------
  it("Scenario 15: DeterministicVerifier pure unit regression tests pass", () => {
    const spec = createVerificationSpec({
      specId: "vspec-exit",
      ruleKind: "EXIT_CODE_ZERO",
      expectedValue: { toolName: "run_command" },
    });

    // Empty evidence -> FAILED with MISSING_EVIDENCE
    const resEmpty = DeterministicVerifier.verify([], spec);
    expect(resEmpty.status).toBe("FAILED");
    expect(resEmpty.reasonCode).toBe("MISSING_EVIDENCE");

    // Process exit with code 0 -> VERIFIED
    const goodEvidence = createProcessExitEvidence("run-test", { exitCode: 0 });
    const resGood = DeterministicVerifier.verify([goodEvidence], spec);
    expect(resGood.status).toBe("VERIFIED");

    // Process exit with code 1 -> FAILED
    const badEvidence = createProcessExitEvidence("run-test", { exitCode: 1 });
    const resBad = DeterministicVerifier.verify([badEvidence], spec);
    expect(resBad.status).toBe("FAILED");
    expect(resBad.reasonCode).toBe("ASSERTION_FAILED");
  });

  // --------------------------------------------------------------------------
  // Scenario 16: Provider role and no host fallback regression
  // --------------------------------------------------------------------------
  it("Scenario 16: SandboxedCommandToolAdapter rejects non-physical execution providers", () => {
    class VirtualExecProvider implements ExecutionProvider {
      readonly name = "virtual-exec";
      readonly role = "ORCHESTRATION" as const;
      readonly tenantModel = "NONE" as const;
      async execute<_TInput, TOutput>(_req: ExecutionRequest<_TInput>): Promise<ExecutionResult<TOutput>> {
        return { status: "SUCCESS", durationMs: 1 };
      }
    }

    expect(() => {
      new SandboxedCommandToolAdapter(new VirtualExecProvider());
    }).toThrow("Only PHYSICAL execution providers are permitted");
  });
});
