import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GovernedAgentExecutionProvider } from "../../src/adapters/execution/governed-agent-execution-provider.js";
import { SqliteScopedMemoryStore } from "../../src/adapters/persistence/sqlite-scoped-memory-store.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../src/adapters/workspace/node-fs-workspace-adapter.js";
import { AgentStepController } from "../../src/application/agent-step-controller.js";
import { ProposalValidator } from "../../src/application/proposal-validator.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ScopedContextMemoryService } from "../../src/application/scoped-context-memory.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { createOutputPayloadEvidence } from "../../src/domain/evidence.js";
import { createExecutionPolicy } from "../../src/domain/policy.js";
import { staticToolRegistry } from "../../src/domain/tool.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { DeterministicVerifier } from "../../src/domain/verification.js";
import { createAndActivateContract } from "./test-helpers.js";

function recoverUnderQuiescence(
  coordinator: RunCoordinator,
  store: SqliteStateStore,
  clock: SettableClock,
  runId: string,
  supervisorId = "sup-diag-1"
) {
  const gate = store.acquireTenantLaunchGate({
    runId,
    holderType: "RECOVERY",
    holderId: supervisorId,
    leaseId: `lease-${supervisorId}`,
    nowIso: clock.nowIso(),
    ttlMs: 30_000,
    ownerPid: process.pid,
  });
  store.markQuiescentTenantLaunchGate({
    runId,
    token: gate.token,
    nowIso: clock.nowIso(),
  });
  return coordinator.recoverExpiredRuns({
    supervisorId,
    quiescedGateTokens: new Map([[runId, gate.token]]),
  });
}

describe("M4.2 Stage 1 — Lease Fencing & Stale-Worker Mutation Prevention", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let workspaceAdapter: NodeFsWorkspaceAdapter;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-lease-fence-"));
    dbPath = path.join(tempDir, "state.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock(new Date("2026-11-12T10:00:00Z"));
    coordinator = new RunCoordinator(store, clock);
    workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: path.join(tempDir, "workspaces") });

    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-1",
        hostname: "localhost",
        pid: 1001,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
      tx.insertWorker({
        workerId: "worker-2",
        hostname: "localhost",
        pid: 1002,
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

  async function setupStartedRun(isolationRequirement: "ISOLATED" | "IN_PROCESS" = "ISOLATED") {
    const task = coordinator.createTask({
      title: "Lease Fencing Diagnostic Task",
      description: "Verify lease ownership and stale worker fencing",
      inputPayload: {},
    });
    const contract = createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement,
      }),
      maxAttempts: 3,
      timeoutMs: 30_000,
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim1 = coordinator.claimRun(run.runId, "worker-1", 60_000);
    coordinator.startRun(run.runId, "worker-1", claim1.lease.leaseId);
    const ws1 = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${run.runId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 10_000_000,
      maxFileSizeBytes: 1_000_000,
    });
    return { task, contract, runId: run.runId, lease1Id: claim1.lease.leaseId, ws1 };
  }

  it("1-2. original owner succeeds while lease is valid, and expired lease is rejected before execution", async () => {
    const { runId, lease1Id, ws1 } = await setupStartedRun();
    const runtime1 = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
    });
    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    const controller = new AgentStepController({
      allowUnverifiedCompletion: true,
      coordinator,
      stateStore: store,
      workerRuntime: runtime1,
      agentBrain: {
        async proposeAction(req) {
          if (req.sequenceNumber === 1) {
            return {
              proposal: {
                proposalId: "p-valid",
                toolName: "write_file",
                inputPayload: { path: "ok.txt", content: "v1" },
                contextSnapshotHash: req.contextSnapshot.contextHash,
              },
              finishReason: "ACTION_PROPOSED",
            };
          }
          // Lease expires during step 2 reasoning
          clock.advanceMs(65_000);
          return {
            proposal: {
              proposalId: "p-expired",
              toolName: "write_file",
              inputPayload: { path: "expired.txt", content: "v2" },
              contextSnapshotHash: req.contextSnapshot.contextHash,
            },
            finishReason: "ACTION_PROPOSED",
          };
        },
      },
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });

    const res = await controller.runStepLoop({
      runId,
      workerId: "worker-1",
      leaseId: lease1Id,
      workspace: ws1,
    });

    expect(res.terminalReason).toBe("LEASE_LOST");
    expect(res.totalActions).toBe(1);
    expect(fs.existsSync(path.join(ws1.hostPath, "ok.txt"))).toBe(true);
    expect(fs.existsSync(path.join(ws1.hostPath, "expired.txt"))).toBe(false);
    // Zero telemetry event recorded for the expired step 2
    const telemetryEvents = store
      .getEventsForRun(runId)
      .filter((e) => e.eventType === "model.inference.telemetry");
    expect(telemetryEvents.length).toBe(1);
  });

  it("3-7. after recovery and new owner replacement lease, old owner cannot mutate run state, action, checkpoint, or verification state", async () => {
    const { runId, lease1Id, ws1 } = await setupStartedRun("ISOLATED");

    clock.advanceMs(65_000);
    // Without quiescence, isolated run stays held; with quiesced supervisor gate it recovers cleanly
    const held = coordinator.recoverExpiredRuns();
    expect(held.recoveredCount).toBe(0);
    expect(held.heldForQuiescenceRunIds).toContain(runId);

    const recovery = recoverUnderQuiescence(coordinator, store, clock, runId);
    expect(recovery.recoveredCount).toBe(1);

    const claim2 = coordinator.claimRun(runId, "worker-2", 60_000);
    coordinator.startRun(runId, "worker-2", claim2.lease.leaseId);
    const runAfterSwap = store.getRun(runId)!;
    expect(runAfterSwap.status).toBe("RUNNING");
    expect(runAfterSwap.currentWorkerId).toBe("worker-2");
    expect(runAfterSwap.leaseId).toBe(claim2.lease.leaseId);

    // 4. Old owner cannot mutate run state (complete, fail, cancel)
    expect(() =>
      coordinator.completeRun(runId, "worker-1", lease1Id, { ok: true })
    ).toThrow(LeaseLostError);
    expect(() =>
      coordinator.failRun(runId, { code: "E", message: "stale" }, "worker-1", lease1Id)
    ).toThrow(LeaseLostError);
    expect(() =>
      coordinator.cancelRun(runId, "stale cancel", { workerId: "worker-1", leaseId: lease1Id })
    ).toThrow(LeaseLostError);

    // 5. Old owner cannot commit an action
    const runtime1 = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
    });
    await expect(
      runtime1.executeAction({
        runId,
        actionId: "act-stale-1",
        sequenceNumber: 1,
        toolName: "write_file",
        inputPayload: { path: "stale.txt", content: "bad" },
        leaseId: lease1Id,
        workspace: ws1,
      })
    ).rejects.toThrow(LeaseLostError);
    expect(store.getActionsForRun(runId)).toHaveLength(0);
    expect(fs.existsSync(path.join(ws1.hostPath, "stale.txt"))).toBe(false);

    // 6. Old owner cannot commit a checkpoint
    expect(() =>
      coordinator.saveCheckpoint({
        runId,
        checkpointVersion: 1,
        actionId: null,
        attemptNumber: null,
        durableState: {
          schemaVersion: 1,
          runId,
          stepCount: 1,
          actionCount: 0,
          consecutiveFailures: 0,
          proposalRejections: 0,
          consecutiveIdenticalReads: 0,
          consecutiveIdenticalWrites: 0,
          consecutiveIneffectiveEdits: 0,
        },
        workerFencing: { workerId: "worker-1", leaseId: lease1Id },
      })
    ).toThrow(LeaseLostError);
    expect(store.getLatestCheckpoint(runId)).toBeNull();

    // 7. Old owner cannot change verification state
    const eventCountBefore = store.getEventsForRun(runId).length;
    expect(() =>
      coordinator.recordVerificationResult(
        runId,
        {
          status: "VERIFIED",
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: "spec-1",
          evidenceIds: [],
          message: "forged",
          verifiedAt: clock.nowIso(),
        },
        "dedup-stale",
        { workerId: "worker-1", leaseId: lease1Id }
      )
    ).toThrow(LeaseLostError);
    expect(store.getEventsForRun(runId).length).toBe(eventCountBefore);

    // New owner completes validly
    coordinator.completeRun(runId, "worker-2", claim2.lease.leaseId, { ok: true });
    expect(store.getRun(runId)!.status).toBe("COMPLETED");
  });

  it("8. concurrent old and new worker action attempts allow only the active lease holder", async () => {
    const { runId, lease1Id, ws1 } = await setupStartedRun("ISOLATED");
    clock.advanceMs(65_000);
    recoverUnderQuiescence(coordinator, store, clock, runId);
    const claim2 = coordinator.claimRun(runId, "worker-2", 60_000);
    coordinator.startRun(runId, "worker-2", claim2.lease.leaseId);

    const runtime1 = new WorkerRuntime({ workerId: "worker-1", coordinator, clock, workspacePort: workspaceAdapter });
    const runtime2 = new WorkerRuntime({ workerId: "worker-2", coordinator, clock, workspacePort: workspaceAdapter });

    const [r1, r2] = await Promise.allSettled([
      runtime1.executeAction({
        runId,
        actionId: "act-old",
        sequenceNumber: 1,
        toolName: "write_file",
        inputPayload: { path: "race.txt", content: "old-worker" },
        leaseId: lease1Id,
        workspace: ws1,
      }),
      runtime2.executeAction({
        runId,
        actionId: "act-new",
        sequenceNumber: 1,
        toolName: "write_file",
        inputPayload: { path: "winner.txt", content: "new-worker" },
        leaseId: claim2.lease.leaseId,
        workspace: ws1,
      }),
    ]);

    expect(r1.status).toBe("rejected");
    if (r1.status === "rejected") {
      expect(r1.reason).toBeInstanceOf(LeaseLostError);
    }
    expect(r2.status).toBe("fulfilled");
    if (r2.status === "fulfilled") {
      expect(r2.value.status).toBe("SUCCEEDED");
    }
    expect(fs.existsSync(path.join(ws1.hostPath, "race.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(ws1.hostPath, "winner.txt"), "utf8")).toBe("new-worker");
    const persistedActions = store.getActionsForRun(runId);
    expect(persistedActions.map((a) => a.actionId)).toEqual(["act-new"]);
  });

  it("9. cancellation combined with lease expiry refuses stale worker mutations and blocks re-claim", async () => {
    const { runId, lease1Id } = await setupStartedRun("ISOLATED");
    clock.advanceMs(65_000);

    // Operator cancels expired run (system-level cancelRun without worker fencing)
    coordinator.cancelRun(runId, "Operator cancelled timed-out run");
    expect(store.getRun(runId)!.status).toBe("CANCELLED");

    expect(() => coordinator.claimRun(runId, "worker-2", 60_000)).toThrow();
    expect(() => coordinator.completeRun(runId, "worker-1", lease1Id, {})).toThrow();
    expect(() =>
      coordinator.recordVerificationResult(
        runId,
        {
          status: "VERIFIED",
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: "s",
          evidenceIds: [],
          message: "ok",
          verifiedAt: clock.nowIso(),
        },
        null,
        { workerId: "worker-1", leaseId: lease1Id }
      )
    ).toThrow(LeaseLostError);
  });

  it("10. recovery followed by stale worker GOAL_REACHED or invalid proposal stops with LEASE_LOST and zero post-loss mutations", async () => {
    const { runId, lease1Id, ws1 } = await setupStartedRun("ISOLATED");
    const runtime1 = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      workspacePort: workspaceAdapter,
    });
    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    let claim2Id = "";
    const controller = new AgentStepController({
      allowUnverifiedCompletion: true,
      coordinator,
      stateStore: store,
      workerRuntime: runtime1,
      agentBrain: {
        async proposeAction() {
          // Simulate worker-1 stall -> expiry -> quiesced recovery -> worker-2 claim+start
          clock.advanceMs(65_000);
          recoverUnderQuiescence(coordinator, store, clock, runId);
          const claim2 = coordinator.claimRun(runId, "worker-2", 60_000);
          claim2Id = claim2.lease.leaseId;
          coordinator.startRun(runId, "worker-2", claim2.lease.leaseId);
          // Stale worker attempts to claim GOAL_REACHED
          return { finishReason: "GOAL_REACHED" };
        },
      },
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });

    const res = await controller.runStepLoop({
      runId,
      workerId: "worker-1",
      leaseId: lease1Id,
      workspace: ws1,
    });

    expect(res.terminalReason).toBe("LEASE_LOST");
    expect(res.totalActions).toBe(0);
    // Persisted run remains actively owned by worker-2, not COMPLETED!
    const current = store.getRun(runId)!;
    expect(current.status).toBe("RUNNING");
    expect(current.currentWorkerId).toBe("worker-2");
    expect(current.leaseId).toBe(claim2Id);
    // Stale worker did not emit unverified_completion or inference telemetry after lease loss
    const events = store.getEventsForRun(runId);
    expect(events.some((e) => e.eventType === "verification.unverified_completion_authorized")).toBe(false);
    expect(events.some((e) => e.eventType === "model.inference.telemetry")).toBe(false);
    expect(store.getLatestCheckpoint(runId)).toBeNull();
  });

  it("11. H-1: fenced recordEvidence throws LeaseLostError and FENCED action writes zero scopedMemory rows", async () => {
    const { task, runId, lease1Id, ws1 } = await setupStartedRun();
    const evBefore = store.getEventsForRun(runId).length;
    expect(() =>
      coordinator.recordEvidence(runId, createOutputPayloadEvidence(runId, { ok: true }), {
        workerId: "worker-2",
        leaseId: "wrong-lease",
      })
    ).toThrow(LeaseLostError);
    expect(store.getEventsForRun(runId).length).toBe(evBefore);

    const memStore = new SqliteScopedMemoryStore({ location: dbPath });
    try {
      const scopedMemory = new ScopedContextMemoryService(memStore, { clock });
      const fakeWorkerRuntime = {
        async executeAction() {
          return {
            status: "FENCED" as const,
            actionId: "act-fenced",
            sequenceNumber: 1,
            durationMs: 1,
          };
        },
      } as unknown as WorkerRuntime;

      const proposalValidator = new ProposalValidator({
        coordinator,
        stateStore: store,
        toolRegistry: staticToolRegistry,
        clock,
      });
      const controller = new AgentStepController({
        allowUnverifiedCompletion: true,
        coordinator,
        stateStore: store,
        workerRuntime: fakeWorkerRuntime,
        scopedMemory,
        agentBrain: {
          async proposeAction(req) {
            return {
              proposal: {
                proposalId: "p-mem-fence",
                toolName: "write_file",
                inputPayload: { path: "fenced.txt", content: "x" },
                contextSnapshotHash: req.contextSnapshot.contextHash,
              },
              finishReason: "ACTION_PROPOSED",
            };
          },
        },
        proposalValidator,
        toolRegistry: staticToolRegistry,
        clock,
      });

      const res = await controller.runStepLoop({
        runId,
        workerId: "worker-1",
        leaseId: lease1Id,
        workspace: ws1,
      });
      expect(res.terminalReason).toBe("LEASE_LOST");
      const postActionEntries = scopedMemory
        .queryMemories("tenant-default", task.taskId, { runId })
        .filter((e) => e.scope === "AGENT_WORKING_CONTEXT" && e.source.startsWith("tool."));
      expect(postActionEntries).toHaveLength(0);
    } finally {
      memStore.close();
    }
  });

  it("12. H-2: expired-lease LEASE_LOST maps through GovernedAgentExecutionProvider to WorkerRuntime FENCED without terminal FAILED", async () => {
    const task = coordinator.createTask({
      title: "H-2 Expired Lease Provider Task",
      description: "Verify expired LEASE_LOST maps to FENCED cleanly",
      inputPayload: { instruction: "Write file then wait" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement: "IN_PROCESS",
      }),
      maxAttempts: 3,
      timeoutMs: 120_000,
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    let runtime!: WorkerRuntime;
    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });
    const controller = new AgentStepController({
      allowUnverifiedCompletion: true,
      coordinator,
      stateStore: store,
      workerRuntime: {
        executeAction: (p: Parameters<WorkerRuntime["executeAction"]>[0]) => runtime.executeAction(p),
      } as unknown as WorkerRuntime,
      agentBrain: {
        async proposeAction() {
          // Lease expires while brain is thinking (default lease TTL < 65s, wall-clock 120s),
          // BEFORE recovery mutates runs.status/leaseId.
          clock.advanceMs(65_000);
          return { finishReason: "GOAL_REACHED" };
        },
      },
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });
    const orchProvider = new GovernedAgentExecutionProvider({ stepController: controller, clock });
    runtime = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      executionProvider: orchProvider,
      workspacePort: workspaceAdapter,
    });

    const runResult = await runtime.runOnce();
    expect(runResult.status).toBe("FENCED");
    // Run stays RUNNING (recoverable by recovery sweeper), NOT marked terminal FAILED
    const storedRun = store.getRun(run.runId)!;
    expect(storedRun.status).toBe("RUNNING");
  });
  it("13. M-6: LeaseExpiredError during WorkerRuntime.executeAction is caught by AgentStepController, mapped to LEASE_LOST without workspace disposal or terminal mutation", async () => {
    let workspaceDisposed = false;
    const origDispose = workspaceAdapter.disposeWorkspace.bind(workspaceAdapter);
    workspaceAdapter.disposeWorkspace = async (...args) => {
      workspaceDisposed = true;
      return origDispose(...args);
    };

    const task = coordinator.createTask({
      title: "M-6 Action Lease Expiration Regression Task",
      description: "Verify LeaseExpiredError escaping executeAction is caught and mapped to FENCED",
      inputPayload: { instruction: "Execute action then expire lease" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: createExecutionPolicy({
        policyId: `policy-${task.taskId}`,
        allowedCapabilities: ["workspace.file.read", "workspace.file.write"],
        isolationRequirement: "IN_PROCESS",
      }),
      maxAttempts: 3,
      timeoutMs: 120_000,
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);

    let runtime!: WorkerRuntime;
    const proposalValidator = new ProposalValidator({
      coordinator,
      stateStore: store,
      toolRegistry: staticToolRegistry,
      clock,
    });

    let actionProposed = false;
    const controller = new AgentStepController({
      allowUnverifiedCompletion: true,
      coordinator,
      stateStore: store,
      workerRuntime: {
        executeAction: async (p: Parameters<WorkerRuntime["executeAction"]>[0]) => {
          // Advance clock right before executeAction encounters store validation so lease is expired
          clock.advanceMs(65_000);
          return runtime.executeAction(p);
        },
      } as unknown as WorkerRuntime,
      agentBrain: {
        async proposeAction(req: any) {
          if (!actionProposed) {
            actionProposed = true;
            return {
              finishReason: "ACTION_PROPOSED",
              proposal: {
                proposalId: "prop-action-1",
                toolName: "write_file",
                inputPayload: { path: "test.txt", content: "hello", overwrite: true },
                contextSnapshotHash: req.contextSnapshot.contextHash,
                rationale: "Write test file",
              },
            };
          }
          return { finishReason: "GOAL_REACHED" };
        },
      },
      proposalValidator,
      toolRegistry: staticToolRegistry,
      clock,
    });

    const orchProvider = new GovernedAgentExecutionProvider({ stepController: controller, clock });
    runtime = new WorkerRuntime({
      workerId: "worker-1",
      coordinator,
      clock,
      executionProvider: orchProvider,
      workspacePort: workspaceAdapter,
    });

    const runResult = await runtime.runOnce();

    // 1. Must be classified as FENCED (not BRAIN_FAILURE, not FAILED)
    expect(runResult.status).toBe("FENCED");

    // 2. Authoritative run must remain RUNNING (not FAILED or COMPLETED)
    const storedRun = store.getRun(run.runId)!;
    expect(storedRun.status).toBe("RUNNING");

    // 3. Workspace must NOT have been disposed by stale/fenced worker
    expect(workspaceDisposed).toBe(false);

    // 4. Stale worker must not have committed a successful action
    const actions = store.getActionsForRun(run.runId);
    const succeededActions = actions.filter((a) => a.status === "SUCCEEDED");
    expect(succeededActions.length).toBe(0);
  });
});

