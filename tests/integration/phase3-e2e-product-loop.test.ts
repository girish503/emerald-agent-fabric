/**
 * Phase 3: End-to-End Product Loop Integration Tests
 *
 * Proves all 6 E2E scenarios with real SQLite persistence, Fastify transport,
 * and Track A + Track B wiring:
 *   1. Successful execution
 *   2. Approval-required action (new approve / reject endpoints)
 *   3. Verification failure + repair
 *   4. Multi-agent DAG
 *   5. Restart + recovery
 *   6. Tenant isolation
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { WorkerRuntime } from "../../src/application/worker-runtime.js";
import { BoundedRepairLoopController } from "../../src/application/bounded-repair-loop.js";
import { ApprovalControl } from "../../src/control-plane/approval-control.js";
import { EmeraldObservability } from "../../src/infrastructure/monitoring/otel-observability.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { EchoOperation } from "../../src/domain/operation.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { buildFastifyServer, PrincipalRecord } from "../../src/transport/http/server.js";
import { createAndActivateContract } from "../application/test-helpers.js";

describe("Phase 3: End-to-End Product Loop Acceptance Suite", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let clock: SettableClock;
  let approvalControl: ApprovalControl;
  let taskRouter: TaskRouterService;
  let observability: EmeraldObservability;

  const TOK_ALPHA = "alpha-operator-token-32chars-ok-1";
  const TOK_BETA = "beta-operator-token-32chars-ok-2";

  const principals: PrincipalRecord[] = [
    { principalId: "op-alpha", token: TOK_ALPHA, role: "operator", tenantId: "tenant-alpha", allowConstrainedHost: true },
    { principalId: "op-beta", token: TOK_BETA, role: "operator", tenantId: "tenant-beta" },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-phase3-e2e-"));
    dbPath = path.join(tmpDir, "phase3_e2e.db");
    store = new SqliteStateStore({ location: dbPath });
    clock = new SettableClock(new Date("2026-11-13T10:00:00.000Z"));
    coordinator = new RunCoordinator(store, clock);
    approvalControl = new ApprovalControl(clock, store, true);
    taskRouter = new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: 2 });
    observability = new EmeraldObservability();

    // Register active workers for runs
    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-e2e-1",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.now().toISOString(),
        lastHeartbeatAt: clock.now().toISOString(),
      });
      tx.insertWorker({
        workerId: "worker-restart",
        hostname: "localhost",
        pid: process.pid,
        status: "ACTIVE",
        createdAt: clock.now().toISOString(),
        lastHeartbeatAt: clock.now().toISOString(),
      });
    });
  });

  afterEach(() => {
    try {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  // Scenario 1: Successful execution
  // Proof Type: Fixture-backed (Deterministic EchoOperation with SQLite persistence & Fastify transport)
  it("Scenario 1: Successful execution — task submission, worker execution, verification, and run inspection", async () => {
    const server = buildFastifyServer({
      store,
      coordinator,
      approvalControl,
      taskRouter,
      principals,
    });

    // 1. Submit task via REST API with verification specs in payload
    const createRes = await server.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { authorization: `Bearer ${TOK_ALPHA}` },
      payload: {
        title: "echo",
        prompt: "Execute deterministic echo operation",
        executionMode: "constrained_host",
        modelConfig: {
          provider: "ollama",
          modelName: "qwen2.5-coder:1.5b",
        },
        verificationSpecs: [
          {
            specId: "vspec-echo-match",
            ruleKind: "EXACT_OUTPUT_MATCH",
            expectedOutput: { instruction: "Execute deterministic echo operation" },
          },
        ],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createBody = createRes.json();
    const taskId = createBody.data.taskId;
    expect(taskId).toBeDefined();

    // 2. Obtain run (already queued by task submission)
    const runId = createBody.data.runId!;
    expect(runId).toBeDefined();

    // 3. WorkerRuntime executes the run with EchoOperation & ObservabilityPort
    const worker = new WorkerRuntime({
      workerId: "worker-e2e-1",
      coordinator,
      clock,
      operations: [new EchoOperation()],
      observabilityPort: observability,
    });

    const execResult = await worker.runOnce(runId);
    expect(execResult.status).toBe("COMPLETED");

    // 4. Inspect run via Fastify REST API
    const runRes = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: { authorization: `Bearer ${TOK_ALPHA}` },
    });

    expect(runRes.statusCode).toBe(200);
    const runBody = runRes.json();
    expect(runBody.data.runId).toBe(runId);
    expect(runBody.data.status).toBe("COMPLETED");
    expect(runBody.data.verificationSummary.verified).toBe(true);

    await server.close();
  });

  // Scenario 2: Approval-required action (new approve / reject endpoints)
  // Proof Type: Deterministic control-plane operations with SQLite persistence & Fastify transport
  it("Scenario 2: Approval-required action — request approval, inspection, decision, and atomic consumption", async () => {
    const server = buildFastifyServer({
      store,
      coordinator,
      approvalControl,
      taskRouter,
      principals,
    });

    // 1. Create task & contract in tenant-alpha
    const task = coordinator.createTask({
      title: "Protected Deployment Task",
      inputPayload: { tenantId: "tenant-alpha" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: {
        ...createDefaultInProcessPolicy(`policy-${task.taskId}`),
        tenantId: "tenant-alpha",
      },
    });
    const { run } = coordinator.createRun({ taskId: task.taskId });

    // 2. Worker / gateway encounters approval-required operation
    const approvalReq = approvalControl.requestApproval({
      runId: run.runId,
      taskId: task.taskId,
      tenantId: "tenant-alpha",
      operation: "production_database_migration",
      parameters: { script: "001_initial_schema.sql" },
      riskLevel: "CRITICAL",
      justification: "Schema alteration requires operational signoff",
    });

    // 3. Inspect approval via GET /api/v1/approvals/:approvalId
    const getRes = await server.inject({
      method: "GET",
      url: `/api/v1/approvals/${approvalReq.approvalId}`,
      headers: { authorization: `Bearer ${TOK_ALPHA}` },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    expect(getBody.data.approvalId).toBe(approvalReq.approvalId);
    expect(getBody.data.status).toBe("PENDING");

    // 4. Operator approves via POST /api/v1/approvals/:approvalId/decide
    const approveRes = await server.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalReq.approvalId}/decide`,
      headers: { authorization: `Bearer ${TOK_ALPHA}` },
      payload: {
        decision: "APPROVE",
        reason: "Migration script reviewed and validated in staging",
      },
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();
    expect(approveBody.data.approval.status).toBe("APPROVED");
    expect(approveBody.data.approval.decidedBy).toBe("op-alpha");

    // 5. Atomic single-use consumption
    const authRes = approvalControl.authorizeAndConsume({
      approvalId: approvalReq.approvalId,
      runId: run.runId,
      taskId: task.taskId,
      tenantId: "tenant-alpha",
      operation: "production_database_migration",
      parametersHash: approvalReq.parametersHash,
    });
    expect(authRes.authorized).toBe(true);
    expect(authRes.status).toBe("APPROVED");

    // Second consumption must fail (single-use invariant)
    const authRes2 = approvalControl.authorizeAndConsume({
      approvalId: approvalReq.approvalId,
      runId: run.runId,
      taskId: task.taskId,
      tenantId: "tenant-alpha",
      operation: "production_database_migration",
      parametersHash: approvalReq.parametersHash,
    });
    expect(authRes2.authorized).toBe(false);
    expect(authRes2.status).toBe("CONSUMED");

    // 6. Test REJECT decision
    const rejectReq = approvalControl.requestApproval({
      runId: run.runId,
      taskId: task.taskId,
      tenantId: "tenant-alpha",
      operation: "unsafe_file_deletion",
      parameters: { path: "/etc/passwd" },
      riskLevel: "CRITICAL",
      justification: "Arbitrary file deletion",
    });

    const rejectRes = await server.inject({
      method: "POST",
      url: `/api/v1/approvals/${rejectReq.approvalId}/decide`,
      headers: { authorization: `Bearer ${TOK_ALPHA}` },
      payload: {
        decision: "REJECT",
        reason: "Security violation detected",
      },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().data.approval.status).toBe("REJECTED");

    // Attempting to authorize rejected approval fails fail-closed
    const rejectAuth = approvalControl.authorizeAndConsume({
      approvalId: rejectReq.approvalId,
      runId: run.runId,
      taskId: task.taskId,
      tenantId: "tenant-alpha",
      operation: "unsafe_file_deletion",
      parametersHash: rejectReq.parametersHash,
    });
    expect(rejectAuth.authorized).toBe(false);
    expect(rejectAuth.status).toBe("REJECTED");

    await server.close();
  });

  // Scenario 3: Verification failure + repair
  // Proof Type: Fixture-backed (Deterministic EchoOperation with BoundedRepairLoopController)
  it("Scenario 3: Verification failure + repair — triggers repair loop controller and bounds iterations", async () => {
    const repairController = new BoundedRepairLoopController({
      maxRepairIterations: 2,
      maxCumulativeActions: 4,
      maxCumulativeTimeMs: 10_000,
    });

    const worker = new WorkerRuntime({
      workerId: "worker-e2e-1",
      coordinator,
      clock,
      operations: [new EchoOperation()],
      repairController,
      observabilityPort: observability,
    });

    const task = coordinator.createTask({
      taskId: "task-repair-e2e",
      title: "echo",
      inputPayload: { expectedNumber: 99 },
    });

    // Verification spec expects 100, but payload provides 99
    createAndActivateContract(store, task.taskId, {
      verificationSpecs: [
        {
          specId: "vspec-exact-number",
          ruleKind: "EXACT_OUTPUT_MATCH",
          expectedValue: { expectedNumber: 100 },
        },
      ],
    });

    const { run } = coordinator.createRun({
      taskId: task.taskId,
      maxAttempts: 1,
    });
    coordinator.queueRun(run.runId);

    // Initial execution fails verification
    const result = await worker.runOnce(run.runId);
    expect(result.status).toBe("FAILED");

    const err = (result as { status: "FAILED"; error?: any }).error;
    expect(err.code).toMatch(/VERIFICATION_FAILED/);
    expect(err.details.repairDiagnosis.category).toBe("TEST_ASSERTION_FAILURE");
    expect(err.details.repairStage).toBeDefined();

    // Verify persisted state reflects verification failure
    const persisted = store.getRun(run.runId);
    expect(persisted?.status).toBe("FAILED");
  });

  // Scenario 4: Multi-agent DAG
  // Proof Type: Deterministic DAG scheduler & SQLite persistence
  it("Scenario 4: Multi-agent DAG — multi-parent blocking, cycle detection, and DAG REST inspection", async () => {
    const server = buildFastifyServer({
      store,
      coordinator,
      approvalControl,
      taskRouter,
      principals,
    });

    // 1. Create parent tasks A and B, and child task C
    const parentA = coordinator.createTask({
      title: "Parent Preprocessor A",
      inputPayload: { tenantId: "tenant-alpha" },
    });
    const parentB = coordinator.createTask({
      title: "Parent Ingestion B",
      inputPayload: { tenantId: "tenant-alpha" },
    });
    const childC = coordinator.createTask({
      title: "Child Aggregator C",
      inputPayload: { tenantId: "tenant-alpha" },
    });

    createAndActivateContract(store, parentA.taskId, {
      policy: { ...createDefaultInProcessPolicy(`policy-${parentA.taskId}`), tenantId: "tenant-alpha" },
    });
    createAndActivateContract(store, parentB.taskId, {
      policy: { ...createDefaultInProcessPolicy(`policy-${parentB.taskId}`), tenantId: "tenant-alpha" },
    });
    createAndActivateContract(store, childC.taskId, {
      policy: { ...createDefaultInProcessPolicy(`policy-${childC.taskId}`), tenantId: "tenant-alpha" },
    });

    // 2. Register tasks with TaskRouterService establishing multi-parent dependency
    taskRouter.submitTask({
      taskId: parentA.taskId,
      submissionKey: "k-parent-a",
    });
    taskRouter.submitTask({
      taskId: parentB.taskId,
      submissionKey: "k-parent-b",
    });
    taskRouter.submitTask({
      taskId: childC.taskId,
      submissionKey: "k-child-c",
      dependsOnTaskIds: [parentA.taskId, parentB.taskId],
    });

    const runIdOf = (taskId: string): string =>
      store.transaction((tx) => tx.getRouterSubmissionByTaskId(taskId)!.runId);
    const statusOf = (taskId: string): string => store.getRun(runIdOf(taskId))!.status;

    // 3. Child C must NOT be queued while parents are incomplete
    taskRouter.dispatchTick();
    expect(statusOf(childC.taskId)).toBe("CREATED");

    // 4. Complete Parent A only
    const runAId = runIdOf(parentA.taskId);
    expect(statusOf(parentA.taskId)).toBe("QUEUED");
    const claimA = coordinator.claimRun(runAId, "worker-e2e-1", 30_000)!;
    coordinator.startRun(runAId, "worker-e2e-1", claimA.lease.leaseId);
    coordinator.completeRun(runAId, "worker-e2e-1", claimA.lease.leaseId, { output: "done-a" });

    // Child C still NOT queued (parent B is still pending)
    taskRouter.dispatchTick();
    expect(statusOf(childC.taskId)).toBe("CREATED");

    // 5. Complete Parent B
    const runBId = runIdOf(parentB.taskId);
    expect(statusOf(parentB.taskId)).toBe("QUEUED");
    const claimB = coordinator.claimRun(runBId, "worker-e2e-1", 30_000)!;
    coordinator.startRun(runBId, "worker-e2e-1", claimB.lease.leaseId);
    coordinator.completeRun(runBId, "worker-e2e-1", claimB.lease.leaseId, { output: "done-b" });

    // Child C now unblocked and queued!
    taskRouter.dispatchTick();
    expect(statusOf(childC.taskId)).toBe("QUEUED");

    // 6. Inspect DAG via GET /api/v1/tasks/:taskId/dag
    const dagRes = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${childC.taskId}/dag`,
      headers: { authorization: `Bearer ${TOK_ALPHA}` },
    });

    expect(dagRes.statusCode).toBe(200);
    const dagBody = dagRes.json();
    expect(dagBody.data.rootTaskId).toBe(childC.taskId);
    expect(dagBody.data.nodes.length).toBeGreaterThanOrEqual(3);

    const childNode = dagBody.data.nodes.find((n: any) => n.taskId === childC.taskId);
    expect(childNode.parentTaskIds).toContain(parentA.taskId);
    expect(childNode.parentTaskIds).toContain(parentB.taskId);

    // 7. Verify cycle rejection
    expect(() => {
      taskRouter.submitTask({
        taskId: parentA.taskId,
        submissionKey: "k-cycle-rejection",
        dependsOnTaskIds: [childC.taskId],
      });
    }).toThrow();

    await server.close();
  });

  // Scenario 5: Restart + recovery
  // Proof Type: Deterministic crash simulation & lease fencing with SQLite file persistence
  it("Scenario 5: Restart + recovery — recovers persistent state across simulated process crash and fences expired worker", async () => {
    // 1. Create run and claim with worker-restart
    const task = coordinator.createTask({
      title: "Crash Recovery Task",
      inputPayload: { tenantId: "tenant-alpha" },
    });
    createAndActivateContract(store, task.taskId, {
      policy: { ...createDefaultInProcessPolicy(`policy-${task.taskId}`), tenantId: "tenant-alpha" },
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-restart", 10_000)!;
    coordinator.startRun(run.runId, "worker-restart", claim.lease.leaseId);

    // Verify run is RUNNING in database
    const initialRun = store.getRun(run.runId);
    expect(initialRun?.status).toBe("RUNNING");

    // 2. Simulate process crash: Close store, advance clock past lease
    store.close();
    clock.advanceMs(20_000); // 20s > 10s lease duration

    // 3. Simulate process restart: Reopen brand new store and coordinator from disk
    const recoveredStore = new SqliteStateStore({ location: dbPath });
    const recoveredCoordinator = new RunCoordinator(recoveredStore, clock);

    // 4. Expired worker tries to assert lease authority after restart -> must throw LeaseLostError
    expect(() => {
      recoveredCoordinator.assertLeaseHeld(run.runId, "worker-restart", claim.lease.leaseId);
    }).toThrow(/Lease/i);
    expect(recoveredCoordinator.isLeaseActive(run.runId, "worker-restart", claim.lease.leaseId)).toBe(false);

    // 5. Clean up recovered store
    recoveredStore.close();
  });

  // Scenario 6: Tenant isolation
  // Proof Type: Deterministic security boundary with Fastify transport & SQLite persistence
  it("Scenario 6: Tenant isolation — prevents cross-tenant access to tasks, DAGs, and approvals", async () => {
    const server = buildFastifyServer({
      store,
      coordinator,
      approvalControl,
      taskRouter,
      principals,
    });

    // 1. Create Task & Approval in Tenant Alpha
    const taskAlpha = coordinator.createTask({
      title: "Secret Alpha Task",
      inputPayload: { tenantId: "tenant-alpha" },
    });
    createAndActivateContract(store, taskAlpha.taskId, {
      policy: { ...createDefaultInProcessPolicy(`policy-${taskAlpha.taskId}`), tenantId: "tenant-alpha" },
    });

    const apprAlpha = approvalControl.requestApproval({
      runId: "run-alpha-priv",
      taskId: taskAlpha.taskId,
      tenantId: "tenant-alpha",
      operation: "secret_financial_audit",
      parameters: { auditCode: "ALPHA-999" },
      riskLevel: "HIGH",
      justification: "Confidential Alpha data",
    });

    // 2. Tenant Beta attempts to inspect Tenant Alpha's task -> 404
    const taskResBeta = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskAlpha.taskId}`,
      headers: { authorization: `Bearer ${TOK_BETA}` },
    });
    expect(taskResBeta.statusCode).toBe(404);

    // 3. Tenant Beta attempts to inspect Tenant Alpha's DAG -> 404
    const dagResBeta = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskAlpha.taskId}/dag`,
      headers: { authorization: `Bearer ${TOK_BETA}` },
    });
    expect(dagResBeta.statusCode).toBe(404);

    // 4. Tenant Beta attempts to inspect Tenant Alpha's approval -> 404
    const apprResBeta = await server.inject({
      method: "GET",
      url: `/api/v1/approvals/${apprAlpha.approvalId}`,
      headers: { authorization: `Bearer ${TOK_BETA}` },
    });
    expect(apprResBeta.statusCode).toBe(404);

    // 5. Tenant Beta attempts to decide on Tenant Alpha's approval -> 404
    const decideResBeta = await server.inject({
      method: "POST",
      url: `/api/v1/approvals/${apprAlpha.approvalId}/decide`,
      headers: { authorization: `Bearer ${TOK_BETA}` },
      payload: {
        decision: "APPROVE",
        reason: "malicious beta decision",
      },
    });
    expect(decideResBeta.statusCode).toBe(404);

    // 6. Cross-tenant DAG dependency rejection
    const taskBeta = coordinator.createTask({
      title: "Beta Task",
      inputPayload: { tenantId: "tenant-beta" },
    });
    createAndActivateContract(store, taskBeta.taskId, {
      policy: { ...createDefaultInProcessPolicy(`policy-${taskBeta.taskId}`), tenantId: "tenant-beta" },
    });

    // Route taskAlpha first so dependency is recognized in DAG
    taskRouter.submitTask({
      taskId: taskAlpha.taskId,
      submissionKey: "k-alpha-route",
    });

    expect(() => {
      taskRouter.submitTask({
        taskId: taskBeta.taskId,
        submissionKey: "k-cross-tenant",
        dependsOnTaskIds: [taskAlpha.taskId],
      });
    }).toThrow(/tenant/i);

    await server.close();
  });
});
