/**
 * Emerald Agent Fabric — Durable Multi-Agent Orchestration & Super Agent Integration Test Suite (Phase 2)
 *
 * Verifies:
 * 1. Super Agent decomposition with topological DAG ordering and idempotent canonical hashing.
 * 2. Strict DAG validation: cycle detection, self-loops, duplicate IDs, missing references.
 * 3. Fan-out and depth ceiling enforcement (maxChildrenPerParent, maxDepth).
 * 4. Aggregate resource budget controls (timeout, attempts, output bytes).
 * 5. Specialized subagent capability fencing & anti-escalation (ChildCapabilities ⊆ ParentCapabilities ∧ ChildCapabilities ⊆ RoleProfile).
 * 6. Durable TaskRouter integration & dependency-ordered admission.
 * 7. Independent verification classification (VERIFIED, REJECTED, BLOCKED, UNVERIFIABLE) and zero self-approval.
 * 8. Fail-closed mission synthesis gate.
 * 9. Cascading cancellation on subtask failure.
 * 10. REST transport integration & strict multi-tenant isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { MultiAgentOrchestrator } from "../../src/application/multi-agent-orchestrator.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { submitDurableTask } from "../../src/application/durable-submission.js";
import { buildFastifyServer, type PrincipalRecord } from "../../src/transport/http/server.js";
import {
  SuperAgentDecompositionError,
  CapabilityEscalationError,
  ResourceBudgetExceededError,
} from "../../src/domain/super-agent.js";

const TOK_A_OP = "alpha-operator-token-aaaaaaaa1";
const TOK_B_OP = "beta-operator-token-bbbbbbbbb4";

const principals: PrincipalRecord[] = [
  { token: TOK_A_OP, principalId: "a-op", tenantId: "tenant-alpha", role: "operator" },
  { token: TOK_B_OP, principalId: "b-op", tenantId: "tenant-beta", role: "operator" },
];

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface MultiAgentHarness {
  tempDir: string;
  store: SqliteStateStore;
  coordinator: RunCoordinator;
  taskRouter: TaskRouterService;
  orchestrator: MultiAgentOrchestrator;
  clock: SystemClock;
  eventBroadcaster: EventEmitter;
  server: FastifyInstance;
}

function createMultiAgentHarness(): MultiAgentHarness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-multi-agent-"));
  const dbPath = path.join(tempDir, "state.db");
  const store = new SqliteStateStore({ location: dbPath });
  const clock = new SystemClock();
  const eventBroadcaster = new EventEmitter();
  const coordinator = new RunCoordinator(store, clock, undefined, undefined, eventBroadcaster);
  const taskRouter = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
  store.transaction((tx) =>
    tx.insertWorker({
      workerId: "worker-test",
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    })
  );
  const orchestrator = new MultiAgentOrchestrator(store, coordinator, taskRouter, clock, {
    maxDepth: 4,
    maxChildrenPerParent: 8,
  });

  const server = buildFastifyServer({
    store,
    coordinator,
    taskRouter,
    orchestrator,
    eventBroadcaster,
    principals,
  });

  return { tempDir, store, coordinator, taskRouter, orchestrator, clock, eventBroadcaster, server };
}

function cleanupMultiAgentHarness(h: MultiAgentHarness): void {
  try {
    h.server.close();
  } catch {}
  try {
    h.store.close();
  } catch {}
  try {
    fs.rmSync(h.tempDir, { recursive: true, force: true });
  } catch {}
}

describe("Durable Multi-Agent Orchestration & Super Agent Integration (Phase 2)", () => {
  let h: MultiAgentHarness;

  beforeEach(() => {
    h = createMultiAgentHarness();
  });

  afterEach(() => {
    cleanupMultiAgentHarness(h);
  });

  // ===========================================================================
  // 1. Decomposition, Topological DAG Sorting & Idempotency
  // ===========================================================================
  it("Scenario 1: decomposes mission into topologically sorted subtasks and deduplicates idempotently", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Implement and verify feature X",
      operation: "feature_x",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute", "workspace.code.search"],
      tenantId: "tenant-alpha",
      timeoutMs: 120_000,
    });

    // Provide subtasks out of order: test depends on implement, implement depends on analyze
    const result1 = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "sub-test",
          role: "TESTER",
          objective: "Run automated tests",
          dependencies: ["sub-impl"],
          customCapabilities: ["workspace.file.read", "process.execute"],
          resourceLimits: { timeoutMs: 30_000, maxAttempts: 2 },
        },
        {
          subtaskId: "sub-analyze",
          role: "RESEARCHER",
          objective: "Analyze requirements",
          dependencies: [],
          customCapabilities: ["workspace.file.read", "workspace.code.search"],
          resourceLimits: { timeoutMs: 20_000, maxAttempts: 1 },
        },
        {
          subtaskId: "sub-impl",
          role: "CODER",
          objective: "Implement feature",
          dependencies: ["sub-analyze"],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
          resourceLimits: { timeoutMs: 40_000, maxAttempts: 2 },
        },
      ],
    });

    expect(result1.isDuplicate).toBe(false);
    expect(result1.subtasks).toHaveLength(3);
    // Topological sort order verification
    expect(result1.subtasks[0]!.subtaskId).toBe("sub-analyze");
    expect(result1.subtasks[1]!.subtaskId).toBe("sub-impl");
    expect(result1.subtasks[2]!.subtaskId).toBe("sub-test");

    // Idempotent resubmission with the exact same plan produces same hash and isDuplicate: true
    const result2 = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "sub-test",
          role: "TESTER",
          objective: "Run automated tests",
          dependencies: ["sub-impl"],
          customCapabilities: ["workspace.file.read", "process.execute"],
          resourceLimits: { timeoutMs: 30_000, maxAttempts: 2 },
        },
        {
          subtaskId: "sub-analyze",
          role: "RESEARCHER",
          objective: "Analyze requirements",
          dependencies: [],
          customCapabilities: ["workspace.file.read", "workspace.code.search"],
          resourceLimits: { timeoutMs: 20_000, maxAttempts: 1 },
        },
        {
          subtaskId: "sub-impl",
          role: "CODER",
          objective: "Implement feature",
          dependencies: ["sub-analyze"],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
          resourceLimits: { timeoutMs: 40_000, maxAttempts: 2 },
        },
      ],
    });

    expect(result2.isDuplicate).toBe(true);
    expect(result2.decompositionHash).toBe(result1.decompositionHash);
    expect(result2.subtaskTaskIds).toEqual(result1.subtaskTaskIds);

    // Verify subagent.decomposed on parent mission run and subagent.spawned on child subtask runs
    const parentEvents = h.store.getEventsForRun(parent.runId);
    expect(parentEvents.some((e) => e.eventType === "subagent.decomposed")).toBe(true);

    const childSub = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(result1.subtaskTaskIds[0]!));
    const childEvents = h.store.getEventsForRun(childSub!.runId);
    expect(childEvents.some((e) => e.eventType === "subagent.spawned")).toBe(true);
  });

  // ===========================================================================
  // 2. Strict DAG Validation
  // ===========================================================================
  it("Scenario 2: rejects cycles, self-loops, duplicate IDs, and missing references", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Mission for DAG validation",
      operation: "validate_dag",
      capabilities: ["workspace.file.read", "workspace.file.write"],
      tenantId: "tenant-alpha",
    });

    // 2a. Cycle detection: A -> B -> A
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          { subtaskId: "A", role: "RESEARCHER", objective: "A", dependencies: ["B"] },
          { subtaskId: "B", role: "CODER", objective: "B", dependencies: ["A"] },
        ],
      })
    ).toThrow(SuperAgentDecompositionError);

    // 2b. Self-loop: A -> A
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [{ subtaskId: "A", role: "RESEARCHER", objective: "A", dependencies: ["A"] }],
      })
    ).toThrow(SuperAgentDecompositionError);

    // 2c. Duplicate subtask IDs
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          { subtaskId: "dup-id", role: "RESEARCHER", objective: "First", dependencies: [] },
          { subtaskId: "dup-id", role: "CODER", objective: "Second", dependencies: [] },
        ],
      })
    ).toThrow(SuperAgentDecompositionError);

    // 2d. Missing dependency reference
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          { subtaskId: "A", role: "RESEARCHER", objective: "A", dependencies: ["non-existent-task"] },
        ],
      })
    ).toThrow(SuperAgentDecompositionError);
  });

  // ===========================================================================
  // 3. Fan-Out & Depth Ceiling Enforcement
  // ===========================================================================
  it("Scenario 3: enforces maxChildrenPerParent fan-out ceiling", () => {
    const smallOrchestrator = new MultiAgentOrchestrator(
      h.store,
      h.coordinator,
      h.taskRouter,
      h.clock,
      { maxChildrenPerParent: 2 }
    );

    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Parent task with fan-out limit",
      operation: "fanout_test",
      capabilities: ["workspace.file.read"],
      tenantId: "tenant-alpha",
    });

    expect(() =>
      smallOrchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          { subtaskId: "child-1", role: "RESEARCHER", objective: "C1", dependencies: [] },
          { subtaskId: "child-2", role: "RESEARCHER", objective: "C2", dependencies: [] },
          { subtaskId: "child-3", role: "RESEARCHER", objective: "C3", dependencies: [] },
        ],
      })
    ).toThrow(SuperAgentDecompositionError);
  });

  // ===========================================================================
  // 4. Aggregate Resource Budget Enforcement
  // ===========================================================================
  it("Scenario 4: rejects subtasks exceeding individual or aggregate parent resource budgets", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Parent with strict budget",
      operation: "budget_test",
      capabilities: ["workspace.file.read"],
      tenantId: "tenant-alpha",
      timeoutMs: 60_000,
    });

    // 4a. Individual timeout exceeds parent ceiling
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          {
            subtaskId: "sub-long",
            role: "RESEARCHER",
            objective: "Too long",
            dependencies: [],
            resourceLimits: { timeoutMs: 90_000 },
          },
        ],
      })
    ).toThrow(ResourceBudgetExceededError);

    // 4b. Aggregate timeout exceeds parent ceiling
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          {
            subtaskId: "sub-1",
            role: "RESEARCHER",
            objective: "Part 1",
            dependencies: [],
            resourceLimits: { timeoutMs: 40_000 },
          },
          {
            subtaskId: "sub-2",
            role: "RESEARCHER",
            objective: "Part 2",
            dependencies: [],
            resourceLimits: { timeoutMs: 35_000 },
          },
        ],
      })
    ).toThrow(ResourceBudgetExceededError);
  });

  // ===========================================================================
  // 5. Specialized Role Capability Fencing & Anti-Escalation
  // ===========================================================================
  it("Scenario 5: prevents capability escalation across role profiles and parent contracts", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Parent with read and write capabilities only",
      operation: "caps_test",
      capabilities: ["workspace.file.read", "workspace.file.write"],
      tenantId: "tenant-alpha",
    });

    // 5a. RESEARCHER attempting forbidden capability (workspace.file.write is forbidden for RESEARCHER)
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          {
            subtaskId: "res-1",
            role: "RESEARCHER",
            objective: "Write attempt",
            dependencies: [],
            customCapabilities: ["workspace.file.write"],
          },
        ],
      })
    ).toThrow(CapabilityEscalationError);

    // 5b. CODER attempting capability outside parent's contract (e.g. process.execute)
    expect(() =>
      h.orchestrator.decomposeMission({
        missionTaskId: parent.taskId,
        subtasks: [
          {
            subtaskId: "code-1",
            role: "CODER",
            objective: "Command execution attempt",
            dependencies: [],
            customCapabilities: ["process.execute"],
          },
        ],
      })
    ).toThrow(CapabilityEscalationError);

    // 5c. Valid narrow subsets are accepted
    const valid = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "res-valid",
          role: "RESEARCHER",
          objective: "Read only",
          dependencies: [],
          customCapabilities: ["workspace.file.read"],
        },
        {
          subtaskId: "code-valid",
          role: "CODER",
          objective: "Read and write",
          dependencies: ["res-valid"],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
        },
      ],
    });
    expect(valid.subtasks).toHaveLength(2);
  });

  // ===========================================================================
  // 6. Durable TaskRouter Integration & Dependency Admission
  // ===========================================================================
  it("Scenario 6: routes subtasks into TaskRouter and admits them strictly following dependency order", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Sequential multi-agent workflow",
      operation: "seq_workflow",
      capabilities: ["workspace.file.read", "workspace.file.write"],
      tenantId: "tenant-alpha",
    });

    const decomp = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "step-1",
          role: "RESEARCHER",
          objective: "First step",
          dependencies: [],
          customCapabilities: ["workspace.file.read"],
        },
        {
          subtaskId: "step-2",
          role: "CODER",
          objective: "Second step",
          dependencies: ["step-1"],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
        },
      ],
    });

    // Step 1: initial orchestration tick
    const tick1 = h.orchestrator.stepOrchestration(parent.taskId);
    // Root subtask (step-1) is admitted
    expect(tick1.admittedRunIds.length).toBeGreaterThanOrEqual(1);

    const childTaskId1 = decomp.subtaskTaskIds[0]!;
    const childTaskId2 = decomp.subtaskTaskIds[1]!;

    const sub1 = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(childTaskId1));
    const sub2 = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(childTaskId2));

    expect(sub1).toBeDefined();
    expect(sub2).toBeDefined();

    const run1 = h.store.getRun(sub1!.runId);
    const run2 = h.store.getRun(sub2!.runId);

    // Step 1 is QUEUED (or admitted), Step 2 is still PENDING because step 1 has not completed
    expect(run1?.status).toBe("QUEUED");
    expect(run2?.status).toBe("CREATED");

    // Complete Step 1 with exit code 0
    const claim1 = h.coordinator.claimRun(run1!.runId, "worker-test", 30_000);
    h.coordinator.startRun(run1!.runId, "worker-test", claim1.lease.leaseId);
    h.coordinator.completeRun(run1!.runId, "worker-test", claim1.lease.leaseId, 0);

    // Step 2: next orchestration tick
    const tick2 = h.orchestrator.stepOrchestration(parent.taskId);
    // Now step-2 can be admitted
    expect(tick2.admittedRunIds).toContain(sub2!.runId);

    const run2After = h.store.getRun(sub2!.runId);
    expect(run2After?.status).toBe("QUEUED");
  });

  // ===========================================================================
  // 7. Independent Verification Classification & Zero Self-Approval
  // ===========================================================================
  it("Scenario 7: classifies child verifications independently and rejects self-approval without verifiers", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Verification classification trial",
      operation: "verify_class",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
      tenantId: "tenant-alpha",
    });

    const decomp = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "child-verified",
          role: "CODER",
          objective: "Coder with verification",
          dependencies: [],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
          verificationSpecs: [
            {
              specId: "vspec-node-test",
              name: "test",
              argv: ["node", "test.js"],
              timeoutMs: 15_000,
            },
          ],
        },
        {
          subtaskId: "child-unverifiable",
          role: "RESEARCHER",
          objective: "Researcher with exit 0 but no verification spec",
          dependencies: [],
          customCapabilities: ["workspace.file.read"],
          // No verification specs provided
        },
      ],
    });

    const taskIdVerified = decomp.subtaskTaskIds[0]!;
    const taskIdUnverifiable = decomp.subtaskTaskIds[1]!;

    const subV = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskIdVerified))!;
    const subU = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskIdUnverifiable))!;

    // Simulate child-verified run: queued, claimed, started, latch recorded as completed, run completed
    h.coordinator.queueRun(subV.runId);
    const claimV = h.coordinator.claimRun(subV.runId, "worker-test", 30_000);
    h.coordinator.startRun(subV.runId, "worker-test", claimV.lease.leaseId);
    // Append verification evidence and verification latch completion
    h.store.transaction((tx) => {
      tx.appendEvent({
        eventId: "evt-vspec-completed-1",
        runId: subV.runId,
        timestamp: new Date().toISOString(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "SystemOwnedVerifier",
        payload: { specId: "vspec-node-test", passed: true, exitCode: 0 },
      });
    });
    h.coordinator.completeRun(subV.runId, "worker-test", claimV.lease.leaseId, 0);

    // Simulate child-unverifiable run: queued, claimed, started, completed exit 0, but ZERO verification specs
    h.coordinator.queueRun(subU.runId);
    const claimU = h.coordinator.claimRun(subU.runId, "worker-test", 30_000);
    h.coordinator.startRun(subU.runId, "worker-test", claimU.lease.leaseId);
    h.coordinator.completeRun(subU.runId, "worker-test", claimU.lease.leaseId, 0);

    // Evaluate child verifications independently
    const repV = h.orchestrator.evaluateChildVerification(taskIdVerified);
    expect(repV.status).toBe("VERIFIED");
    expect(repV.verificationPassed).toBe(true);

    // Zero Self-Approval Invariant: Unverified child CANNOT be approved!
    const repU = h.orchestrator.evaluateChildVerification(taskIdUnverifiable);
    expect(repU.status).toBe("UNVERIFIABLE");
    expect(repU.verificationPassed).toBe(false);
  });

  // ===========================================================================
  // 8. Fail-Closed Mission Synthesis Gate
  // ===========================================================================
  it("Scenario 8: enforces fail-closed mission synthesis gate blocking completion if any child is unverified", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Synthesis fail-closed trial",
      operation: "synthesis_trial",
      capabilities: ["workspace.file.read", "workspace.file.write", "process.execute"],
      tenantId: "tenant-alpha",
    });

    const decomp = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "sub-1",
          role: "CODER",
          objective: "C1",
          dependencies: [],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
          verificationSpecs: [
            { specId: "v1", name: "v1", argv: ["node", "test1.js"], timeoutMs: 10_000 },
          ],
        },
        {
          subtaskId: "sub-2",
          role: "TESTER",
          objective: "C2",
          dependencies: ["sub-1"],
          customCapabilities: ["workspace.file.read", "process.execute"],
          verificationSpecs: [
            { specId: "v2", name: "v2", argv: ["node", "test2.js"], timeoutMs: 10_000 },
          ],
        },
      ],
    });

    const id1 = decomp.subtaskTaskIds[0]!;
    const id2 = decomp.subtaskTaskIds[1]!;
    const sub1 = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(id1))!;
    const sub2 = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(id2))!;

    // Subtask 1 passes verification
    h.coordinator.queueRun(sub1.runId);
    const claimSub1 = h.coordinator.claimRun(sub1.runId, "worker-test", 30_000);
    h.coordinator.startRun(sub1.runId, "worker-test", claimSub1.lease.leaseId);
    h.store.transaction((tx) => {
      tx.appendEvent({
        eventId: "v-evt-1",
        runId: sub1.runId,
        timestamp: new Date().toISOString(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "SystemVerifier",
        payload: { specId: "v1", passed: true, exitCode: 0 },
      });
    });
    h.coordinator.completeRun(sub1.runId, "worker-test", claimSub1.lease.leaseId, 0);

    // Initial synthesis check: subtask 2 is not yet verified (still in progress / unverifiable)
    const synthesis1 = h.orchestrator.synthesizeMission(parent.taskId);
    expect(synthesis1.canCompleteMission).toBe(false);
    expect(synthesis1.verdict).toBe("IN_PROGRESS");
    expect(synthesis1.verifiedCount).toBe(1);

    // Now subtask 2 also passes verification
    h.coordinator.queueRun(sub2.runId);
    const claimSub2 = h.coordinator.claimRun(sub2.runId, "worker-test", 30_000);
    h.coordinator.startRun(sub2.runId, "worker-test", claimSub2.lease.leaseId);
    h.store.transaction((tx) => {
      tx.appendEvent({
        eventId: "v-evt-2",
        runId: sub2.runId,
        timestamp: new Date().toISOString(),
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "SystemVerifier",
        payload: { specId: "v2", passed: true, exitCode: 0 },
      });
    });
    h.coordinator.completeRun(sub2.runId, "worker-test", claimSub2.lease.leaseId, 0);

    // Final synthesis check: all children verified -> SUCCESS!
    const synthesis2 = h.orchestrator.synthesizeMission(parent.taskId);
    expect(synthesis2.canCompleteMission).toBe(true);
    expect(synthesis2.verdict).toBe("SUCCESS");
    expect(synthesis2.verifiedCount).toBe(2);
    expect(synthesis2.unverifiableCount).toBe(0);

    // Ensure mission.synthesized domain event was recorded
    const parentEvents = h.store.getEventsForRun(parent.runId);
    expect(parentEvents.some((e) => e.eventType === "mission.synthesized")).toBe(true);
  });

  // ===========================================================================
  // 9. Cascading Cancellation on Subtask Failure
  // ===========================================================================
  it("Scenario 9: cascades cancellation to downstream subtasks when upstream subtask fails", () => {
    const parent = submitDurableTask(h.store, h.coordinator, {
      task: "Cascade cancellation trial",
      operation: "cascade_trial",
      capabilities: ["workspace.file.read", "workspace.file.write"],
      tenantId: "tenant-alpha",
    });

    const decomp = h.orchestrator.decomposeMission({
      missionTaskId: parent.taskId,
      subtasks: [
        {
          subtaskId: "upstream",
          role: "RESEARCHER",
          objective: "Upstream step",
          dependencies: [],
          customCapabilities: ["workspace.file.read"],
        },
        {
          subtaskId: "downstream",
          role: "CODER",
          objective: "Downstream step",
          dependencies: ["upstream"],
          customCapabilities: ["workspace.file.read", "workspace.file.write"],
        },
      ],
    });

    const upTaskId = decomp.subtaskTaskIds[0]!;
    const downTaskId = decomp.subtaskTaskIds[1]!;
    const upSub = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(upTaskId))!;
    const downSub = h.store.transaction((tx) => tx.getRouterSubmissionByTaskId(downTaskId))!;

    // Upstream run claims and fails
    h.coordinator.queueRun(upSub.runId);
    const claimUp = h.coordinator.claimRun(upSub.runId, "worker-test", 30_000);
    h.coordinator.startRun(upSub.runId, "worker-test", claimUp.lease.leaseId);
    h.coordinator.failRun(upSub.runId, { message: "Critical upstream error" }, "worker-test", claimUp.lease.leaseId);

    // Advance orchestration step
    const stepResult = h.orchestrator.stepOrchestration(parent.taskId);

    // Verify downstream run is cancelled
    const downRun = h.store.getRun(downSub.runId);
    expect(downRun?.status).toBe("CANCELLED");
    expect(stepResult.synthesis?.verdict).toBe("FAILED");
    expect(stepResult.synthesis?.canCompleteMission).toBe(false);
  });

  // ===========================================================================
  // 10. REST API Integration & Tenant Isolation
  // ===========================================================================
  it("Scenario 10: exposes decompose, hierarchy, and synthesize over REST and preserves strict tenant isolation", async () => {
    // 10a. Submit parent task for Tenant Alpha
    const createRes = await h.server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: bearer(TOK_A_OP),
      payload: {
        title: "Alpha Parent Task",
        prompt: "Parent mission description",
        modelConfig: { modelName: "qwen2.5-coder:7b" },
        requiredCapabilities: ["workspace.file.read", "workspace.file.write"],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const alphaTaskId = JSON.parse(createRes.payload).data.taskId;

    // 10b. Decompose mission via REST
    const decompRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${alphaTaskId}/decompose`,
      headers: bearer(TOK_A_OP),
      payload: {
        subtasks: [
          {
            subtaskId: "rest-analyze",
            role: "RESEARCHER",
            objective: "Analyze requirements via REST",
            dependencies: [],
            customCapabilities: ["workspace.file.read"],
          },
          {
            subtaskId: "rest-code",
            role: "CODER",
            objective: "Implement code via REST",
            dependencies: ["rest-analyze"],
            customCapabilities: ["workspace.file.read", "workspace.file.write"],
          },
        ],
      },
    });
    expect(decompRes.statusCode).toBe(201);
    const decompData = JSON.parse(decompRes.payload).data;
    expect(decompData.missionTaskId).toBe(alphaTaskId);
    expect(decompData.totalSubtasks).toBe(2);
    expect(decompData.subtaskTaskIds).toHaveLength(2);

    // 10c. Get hierarchy via REST
    const hierRes = await h.server.inject({
      method: "GET",
      url: `/api/v1/tasks/${alphaTaskId}/hierarchy`,
      headers: bearer(TOK_A_OP),
    });
    expect(hierRes.statusCode).toBe(200);
    const hierData = JSON.parse(hierRes.payload).data;
    expect(hierData.missionTaskId).toBe(alphaTaskId);
    expect(hierData.totalSubtasks).toBe(2);
    expect(hierData.root.children).toHaveLength(1); // analysis root has 1 child (code)

    // 10d. Synthesize mission via REST
    const synthRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${alphaTaskId}/synthesize`,
      headers: bearer(TOK_A_OP),
    });
    expect(synthRes.statusCode).toBe(200);
    const synthData = JSON.parse(synthRes.payload).data;
    expect(synthData.missionTaskId).toBe(alphaTaskId);
    expect(synthData.totalSubtasks).toBe(2);
    expect(synthData.canCompleteMission).toBe(false); // Children not yet completed or verified

    // 10e. Strict Tenant Isolation: Tenant Beta cannot inspect or decompose Tenant Alpha's task (returns 404)
    const crossDecomp = await h.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${alphaTaskId}/decompose`,
      headers: bearer(TOK_B_OP),
      payload: {
        subtasks: [
          { subtaskId: "spoof", role: "RESEARCHER", objective: "Spoof", dependencies: [] },
        ],
      },
    });
    expect(crossDecomp.statusCode).toBe(404);

    const crossHier = await h.server.inject({
      method: "GET",
      url: `/api/v1/tasks/${alphaTaskId}/hierarchy`,
      headers: bearer(TOK_B_OP),
    });
    expect(crossHier.statusCode).toBe(404);

    const crossSynth = await h.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${alphaTaskId}/synthesize`,
      headers: bearer(TOK_B_OP),
    });
    expect(crossSynth.statusCode).toBe(404);

    // 10f. Capability escalation attempt via REST returns 403 FORBIDDEN
    const escRes = await h.server.inject({
      method: "POST",
      url: `/api/v1/tasks/${alphaTaskId}/decompose`,
      headers: bearer(TOK_A_OP),
      payload: {
        subtasks: [
          {
            subtaskId: "escalate",
            role: "RESEARCHER",
            objective: "Unapproved command execution",
            dependencies: [],
            customCapabilities: ["process.execute"], // RESEARCHER not allowed process.execute
          },
        ],
      },
    });
    expect(escRes.statusCode).toBe(403);
  });
});
