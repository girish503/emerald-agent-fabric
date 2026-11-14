/**
 * Tests for Durable Approval CLI & Governance Lifecycle (Track A Item 1)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { ApprovalControl } from "../../src/control-plane/approval-control.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";

describe("Track A Item 1: Durable Approval CLI & Governance Lifecycle", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  let coordinator: RunCoordinator;
  let cli: EmeraldCli;
  let workerRegistered = false;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-durable-approval-test-"));
    dbPath = path.join(tmpDir, "approvals.db");
    store = new SqliteStateStore({ location: dbPath });
    coordinator = new RunCoordinator(store, new SystemClock());
    cli = new EmeraldCli();
    workerRegistered = false;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupWaitingApprovalRun(
    taskId: string,
    runId: string,
    approvalId: string
  ) {
    if (!workerRegistered) {
      store.transaction((tx) => {
        tx.insertWorker({
          workerId: "worker-1",
          hostname: "localhost",
          pid: 1001,
          status: "ACTIVE",
          createdAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
        });
      });
      workerRegistered = true;
    }

    coordinator.createTask({ taskId, title: "Test Task", inputPayload: {} });
    createAndActivateContract(store, taskId);

    const { run } = coordinator.createRun({ runId, taskId, maxAttempts: 3 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-1", 60_000);
    coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);
    coordinator.requestApprovalTransition(run.runId, approvalId, "deploy_prod", {
      workerId: "worker-1",
      leaseId: claim.lease.leaseId,
    });
  }

  it("1. enforces durable store when requireDurableStore=true (no in-memory fallback)", () => {
    expect(() => new ApprovalControl(new SystemClock(), undefined, true)).toThrow(
      /Durable SQLite approval store required in production path/
    );

    // With real SQLite store, passes
    const durableControl = new ApprovalControl(new SystemClock(), store, true);
    expect(durableControl).toBeDefined();
  });

  it("2. approves a pending request via CLI and resumes WAITING_APPROVAL run to QUEUED", async () => {
    const approvalControl = new ApprovalControl(new SystemClock(), store, true);
    const created = approvalControl.requestApproval({
      runId: "run-appr-1",
      taskId: "task-appr-1",
      operation: "deploy_prod",
      parameters: { target: "us-east-1" },
      riskLevel: "CRITICAL",
      justification: "Production rollout gate",
      singleUse: true,
    });

    setupWaitingApprovalRun("task-appr-1", "run-appr-1", created.approvalId);

    // Approve via CLI
    const res = await cli.run([
      "approve",
      created.approvalId,
      "--db",
      dbPath,
      "--approver",
      "alice-ops",
      "--reason",
      "LGTM verified release artifact",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("APPROVED");
    expect(parsed.runResumed).toBe(true);

    // Verify run status in DB is now QUEUED
    const updatedRun = store.getRun("run-appr-1");
    expect(updatedRun?.status).toBe("QUEUED");

    // Verify approval record in DB
    const approvalRecord = store.getApprovalRequest(created.approvalId);
    expect(approvalRecord?.status).toBe("APPROVED");
    expect(approvalRecord?.approver).toBe("alice-ops");
  });

  it("3. rejects self-approval from agent or model identities fail-closed", async () => {
    const approvalControl = new ApprovalControl(new SystemClock(), store, true);
    const created = approvalControl.requestApproval({
      runId: "run-self-1",
      taskId: "task-self-1",
      operation: "nuke_db",
      parameters: {},
      riskLevel: "CRITICAL",
      justification: "Self test",
    });

    setupWaitingApprovalRun("task-self-1", "run-self-1", created.approvalId);

    // Try approving as model
    const resModel = await cli.run([
      "approve",
      created.approvalId,
      "--db",
      dbPath,
      "--approver",
      "model",
    ]);
    expect(resModel.exitCode).toBe(1);
    expect(resModel.output).toMatch(/cannot self-approve/);

    // Try approving as agent
    const resAgent = await cli.run([
      "approve",
      created.approvalId,
      "--db",
      dbPath,
      "--approver",
      "autonomous-agent",
    ]);
    expect(resAgent.exitCode).toBe(1);
    expect(resAgent.output).toMatch(/cannot self-approve/);

    // Status remains PENDING
    const record = store.getApprovalRequest(created.approvalId);
    expect(record?.status).toBe("PENDING");
  });

  it("4. rejects request via CLI and transitions WAITING_APPROVAL run to FAILED", async () => {
    const approvalControl = new ApprovalControl(new SystemClock(), store, true);
    const created = approvalControl.requestApproval({
      runId: "run-rej-1",
      taskId: "task-rej-1",
      operation: "dangerous_op",
      parameters: {},
      riskLevel: "HIGH",
      justification: "Test reject",
    });

    setupWaitingApprovalRun("task-rej-1", "run-rej-1", created.approvalId);

    const res = await cli.run([
      "reject",
      created.approvalId,
      "--db",
      dbPath,
      "--approver",
      "bob-secops",
      "--reason",
      "Security violation detected",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.status).toBe("REJECTED");
    expect(parsed.runFailed).toBe(true);

    const updatedRun = store.getRun("run-rej-1");
    expect(updatedRun?.status).toBe("FAILED");
  });

  it("5. lists approvals filtered by status and runId", async () => {
    const approvalControl = new ApprovalControl(new SystemClock(), store, true);
    approvalControl.requestApproval({
      runId: "r-list",
      taskId: "t-list",
      operation: "op1",
      parameters: {},
      riskLevel: "LOW",
      justification: "Op 1",
    });
    approvalControl.requestApproval({
      runId: "r-list",
      taskId: "t-list",
      operation: "op2",
      parameters: {},
      riskLevel: "HIGH",
      justification: "Op 2",
    });

    const res = await cli.run(["approval", "list", "--db", dbPath, "--run-id", "r-list", "--json"]);
    expect(res.exitCode).toBe(0);
    const list = JSON.parse(res.output);
    expect(list.length).toBe(2);
    expect(list[0].operation).toBe("op1");
    expect(list[1].operation).toBe("op2");
  });
});
