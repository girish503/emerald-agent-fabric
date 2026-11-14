import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { TaskRouterService } from "../../src/application/task-router.js";
import { ApprovalControl } from "../../src/control-plane/approval-control.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import {
  ApprovalDecisionResponseSchema,
  ApprovalResponseSchema,
  TaskDagResponseSchema,
} from "../../src/transport/http/api-contracts.js";
import { buildFastifyServer } from "../../src/transport/http/server.js";
import { createDefaultInProcessPolicy } from "../../src/domain/policy.js";
import { createAndActivateContract } from "../application/test-helpers.js";

describe("Phase 2 Track B — Fastify Product Transport Data Enrichment", () => {
  let tmpDir: string;
  let dbPath: string;
  let stateStore: SqliteStateStore;
  let coordinator: RunCoordinator;
  let approvalControl: ApprovalControl;
  let taskRouter: TaskRouterService;
  let clock: SystemClock;

  const rawSecret = "test-operator-secret-token-32chars-ok";
  const validToken = `Bearer ${rawSecret}`;
  const authHeader = { authorization: validToken };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-track-b-transport-"));
    dbPath = path.join(tmpDir, "test.db");
    stateStore = new SqliteStateStore({ location: dbPath });
    clock = new SystemClock();
    coordinator = new RunCoordinator(stateStore, clock);
    approvalControl = new ApprovalControl(clock, stateStore, true);
    taskRouter = new TaskRouterService(stateStore, coordinator, clock, { maxConcurrentRuns: 2 });
  });

  afterEach(() => {
    try {
      stateStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it("1. GET /api/v1/tasks/:taskId/dag returns multi-agent DAG view data with nodes, parents, and children", async () => {
    const server = buildFastifyServer({
      store: stateStore,
      coordinator,
      approvalControl,
      taskRouter,
      principals: [
        {
          principalId: "test-op",
          token: rawSecret,
          role: "operator",
          tenantId: "tenant-dag",
        },
      ],
    });

    // Create root task and child task
    const rootTask = coordinator.createTask({
      title: "Root Task A",
      inputPayload: { tenantId: "tenant-dag" },
    });
    createAndActivateContract(stateStore, rootTask.taskId, {
      policy: {
        ...createDefaultInProcessPolicy(`policy-${rootTask.taskId}`),
        tenantId: "tenant-dag",
      },
    });

    const childTask = coordinator.createTask({
      title: "Child Task B",
      inputPayload: { tenantId: "tenant-dag" },
    });
    createAndActivateContract(stateStore, childTask.taskId, {
      policy: {
        ...createDefaultInProcessPolicy(`policy-${childTask.taskId}`),
        tenantId: "tenant-dag",
      },
    });

    // Route both tasks with dependency
    taskRouter.submitTask({
      submissionKey: "sub-root",
      taskId: rootTask.taskId,
    });
    taskRouter.submitTask({
      submissionKey: "sub-child",
      taskId: childTask.taskId,
      parentTaskId: rootTask.taskId,
      dependsOnTaskIds: [rootTask.taskId],
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/tasks/${rootTask.taskId}/dag`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const parsed = TaskDagResponseSchema.parse(JSON.parse(res.payload));
    expect(parsed.success).toBe(true);
    expect(parsed.data.rootTaskId).toBe(rootTask.taskId);
    expect(parsed.data.nodes.length).toBeGreaterThanOrEqual(2);

    const rootNode = parsed.data.nodes.find((n) => n.taskId === rootTask.taskId);
    const childNode = parsed.data.nodes.find((n) => n.taskId === childTask.taskId);

    expect(rootNode).toBeDefined();
    expect(rootNode?.childTaskIds).toContain(childTask.taskId);

    expect(childNode).toBeDefined();
    expect(childNode?.parentTaskIds).toContain(rootTask.taskId);
  });

  it("2. GET /api/v1/approvals/:approvalId and POST /api/v1/approvals/:approvalId/decide support full approval UX", async () => {
    const server = buildFastifyServer({
      store: stateStore,
      coordinator,
      approvalControl,
      taskRouter,
      principals: [
        {
          principalId: "test-human",
          token: rawSecret,
          role: "operator",
          tenantId: "tenant-approval",
        },
      ],
    });

    // Create an approval request
    const req = approvalControl.requestApproval({
      runId: "run-appr-1",
      taskId: "task-appr-1",
      tenantId: "tenant-approval",
      operation: "run_command",
      parameters: { command: "deploy" },
      riskLevel: "CRITICAL",
      justification: "Deploying to production",
    });

    // 2a. Inspect approval via GET /api/v1/approvals/:approvalId
    const getRes = await server.inject({
      method: "GET",
      url: `/api/v1/approvals/${req.approvalId}`,
      headers: authHeader,
    });

    expect(getRes.statusCode).toBe(200);
    const getParsed = ApprovalResponseSchema.parse(JSON.parse(getRes.payload));
    expect(getParsed.success).toBe(true);
    expect(getParsed.data.approvalId).toBe(req.approvalId);
    expect(getParsed.data.status).toBe("PENDING");
    expect(getParsed.data.riskLevel).toBe("CRITICAL");

    // 2b. Decide approval via POST /api/v1/approvals/:approvalId/decide
    const decideRes = await server.inject({
      method: "POST",
      url: `/api/v1/approvals/${req.approvalId}/decide`,
      headers: authHeader,
      payload: {
        decision: "APPROVE",
        reason: "Authorized by security lead",
      },
    });

    expect(decideRes.statusCode).toBe(200);
    const decideParsed = ApprovalDecisionResponseSchema.parse(JSON.parse(decideRes.payload));
    expect(decideParsed.success).toBe(true);
    expect(decideParsed.data.approval.status).toBe("APPROVED");
    expect(decideParsed.data.approval.decidedBy).toBe("test-human");

    // 2c. Second decision fails with 409 CONFLICT
    const conflictRes = await server.inject({
      method: "POST",
      url: `/api/v1/approvals/${req.approvalId}/decide`,
      headers: authHeader,
      payload: { decision: "REJECT", reason: "Too late" },
    });
    expect(conflictRes.statusCode).toBe(409);
  });

  it("3. GET /api/v1/runs/:runId includes verification proof data (proofHash, verifierId, specId)", async () => {
    const server = buildFastifyServer({
      store: stateStore,
      coordinator,
      approvalControl,
      taskRouter,
      principals: [
        {
          principalId: "test-ver",
          token: rawSecret,
          role: "operator",
          tenantId: "tenant-ver",
        },
      ],
    });

    const task = coordinator.createTask({
      title: "Task with Verification",
      inputPayload: { tenantId: "tenant-ver" },
    });
    createAndActivateContract(stateStore, task.taskId, {
      policy: {
        ...createDefaultInProcessPolicy(`policy-${task.taskId}`),
        tenantId: "tenant-ver",
      },
    });
    const run = coordinator.createRun({
      taskId: task.taskId,
      idempotencyKey: "run-ver-idem",
    });

    // Record verification.completed event with proof details
    stateStore.transaction((tx) => {
      tx.appendEvent({
        eventId: "ev-ver-comp",
        runId: run.run.runId,
        eventType: "verification.completed",
        schemaVersion: 1,
        producer: "SovereignVerifier",
        timestamp: new Date().toISOString(),
        payload: {
          status: "VERIFIED",
          verified: true,
          proofHash: "sha256-proof-abcdef1234567890",
          verifierId: "DeterministicTestVerifier-v1",
          specId: "spec-exit-zero-01",
          reason: "All tests passed cleanly",
        },
      });
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${run.run.runId}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.verificationSummary).toBeDefined();
    expect(body.data.verificationSummary.verified).toBe(true);
    expect(body.data.verificationSummary.proofHash).toBe("sha256-proof-abcdef1234567890");
    expect(body.data.verificationSummary.verifierId).toBe("DeterministicTestVerifier-v1");
    expect(body.data.verificationSummary.specId).toBe("spec-exit-zero-01");
  });
});
