/**
 * Adversarial & Integration Tests for M4.1 Workstream A:
 * Durable Approval Governance, Contextual Binding, Single-Use, Expiry, Self-Approval Block,
 * Restart Recovery, and WAITING_APPROVAL / VERIFYING State Transitions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { RunCoordinator } from "../../src/application/run-coordinator.js";
import { createSqliteClient } from "../../src/adapters/persistence/sqlite-client.js";
import { SqliteStateStore } from "../../src/adapters/persistence/sqlite-state-store.js";
import { ApprovalControl } from "../../src/control-plane/approval-control.js";
import { EvidenceControl } from "../../src/control-plane/evidence-control.js";
import { MissionControl } from "../../src/control-plane/mission-control.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { createProductionConfig } from "../../src/config/production-config.js";
import { computeCapabilityFenceHash, type CapabilityFence } from "../../src/domain/capability-fence.js";
import { LeaseLostError } from "../../src/domain/errors.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { ProductionToolGateway } from "../../src/tools/production-tools.js";
import { ProductionRuntimeEngine } from "../../src/runtime/production-runtime-engine.js";
import { ProductionRepairOrchestrator } from "../../src/production/repair/repair-orchestrator.js";
import { ProductionVerifier } from "../../src/verification/production-verifier.js";
import { SettableClock } from "../../src/ports/clock.port.js";
import { createAndActivateContract } from "../application/test-helpers.js";

function buildActiveFence(
  workspacePath: string,
  contractHash: string,
  overrides: Partial<Omit<CapabilityFence, "hash">> = {}
): CapabilityFence {
  const raw: Omit<CapabilityFence, "hash"> = {
    fenceId: "fence-gov-1",
    subjectId: "agent-exec-1",
    roleId: "tester",
    harnessId: "IMPLEMENTATION_HARNESS",
    allowedCapabilities: ["READ_WORKSPACE", "EXECUTE_ANALYSIS"],
    forbiddenCapabilities: ["WRITE_REPOSITORY"],
    scope: {
      allowedWorkspacePaths: [workspacePath],
      forbiddenWorkspacePaths: [".git"],
      allowedTools: ["read_file", "run_command"],
      maxOperations: 100,
      maxMemoryBytes: 1000000,
      networkAllowed: false,
      gitWriteAllowed: false,
    },
    trustLabel: "GOVERNED_OBSERVATION",
    status: "ACTIVE",
    delegatedFenceIds: [],
    version: 1,
    missionContractId: "contract-gov-1",
    missionContractHash: contractHash,
    authoritative: false,
    terminalAuthority: false,
    sovereignAuthority: false,
    createdAt: "2026-11-12T10:00:00.000Z",
    expiresAt: "2026-11-12T12:00:00.000Z",
    ...overrides,
  };
  return { ...raw, hash: computeCapabilityFenceHash(raw) };
}

describe("M4.1 Workstream A — Approval Governance & Lifecycle", () => {
  let tmpDir: string;
  let clock: SettableClock;
  let enforcer: CapabilityFenceEnforcer;
  let gateway: CrossHarnessGateway;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-m41-gov-"));
    clock = new SettableClock(new Date("2026-11-12T10:30:00.000Z"));
    enforcer = new CapabilityFenceEnforcer(clock);
    gateway = new CrossHarnessGateway(enforcer, clock);
    enforcer.registerFence(buildActiveFence(tmpDir, "contract-hash-A"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. fails closed when ApprovalControl is omitted for high-risk operations", () => {
    const facade = new ProductionGovernanceFacade(enforcer, gateway, undefined, clock);
    const decision = facade.evaluateProposal({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      subjectId: "agent-exec-1",
      fenceId: "fence-gov-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "git push origin main" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    });

    expect(decision.authorized).toBe(false);
    expect(decision.requiresHumanApproval).toBe(true);
    expect(decision.approvalStatus).toBe("MISSING");
    expect(decision.runStatusHint).toBe("WAITING_APPROVAL");
  });

  it("2. blocks unapproved / PENDING actions and does not confuse PENDING with APPROVED", () => {
    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);

    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "git push origin main" },
      riskLevel: "CRITICAL",
      justification: "Release push",
    });
    expect(req.status).toBe("PENDING");

    const decision = facade.evaluateProposal({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-gov-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "git push origin main" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    });

    expect(decision.authorized).toBe(false);
    expect(decision.approvalStatus).toBe("PENDING");
    expect(decision.requiresHumanApproval).toBe(true);
    expect(decision.runStatusHint).toBe("WAITING_APPROVAL");
  });

  it("3. allows exact APPROVED action ONCE via single-use consumption and blocks replay", () => {
    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);

    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "npm run deploy" },
      riskLevel: "HIGH",
      justification: "Controlled staging deploy",
    });
    ac.approve(req.approvalId, "operator-alice", "Verified safe");

    const baseProposal = {
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      subjectId: "agent-exec-1",
      fenceId: "fence-gov-1",
      harnessType: "IMPLEMENTATION_HARNESS" as const,
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "npm run deploy" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    };

    // First use (note: no explicit approvalId needed; matches bound context!)
    const first = facade.evaluateProposal(baseProposal);
    expect(first.authorized).toBe(true);
    expect(first.approvalId).toBe(req.approvalId);
    expect(ac.getApproval(req.approvalId)?.status).toBe("CONSUMED");

    // Second invocation replay must be rejected fail-closed
    const replay = facade.evaluateProposal({ ...baseProposal, approvalId: req.approvalId });
    expect(replay.authorized).toBe(false);
    expect(replay.approvalStatus).toBe("CONSUMED");
  });

  it("4. rejects REJECTED approvals cleanly without infinite wait", () => {
    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);
    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "reboot" },
      riskLevel: "CRITICAL",
      justification: "Reboot host",
    });
    ac.reject(req.approvalId, "operator-bob", "Forbidden host action");

    const decision = facade.evaluateProposal({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-gov-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "reboot" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    });

    expect(decision.authorized).toBe(false);
    expect(decision.approvalStatus).toBe("REJECTED");
    expect(decision.requiresHumanApproval).toBe(false);
  });

  it("5. rejects EXPIRED approvals fail-closed", () => {
    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);
    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "npm run deploy" },
      riskLevel: "HIGH",
      justification: "Short window",
      ttlMs: 10_000,
    });
    ac.approve(req.approvalId, "operator-alice");

    // Advance past expiration
    clock.set(new Date("2026-11-12T10:31:00.000Z"));

    const decision = facade.evaluateProposal({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-gov-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "npm run deploy" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    });

    expect(decision.authorized).toBe(false);
    expect(decision.approvalStatus).toBe("EXPIRED");
    expect(ac.getApproval(req.approvalId)?.status).toBe("EXPIRED");
  });

  it("6. rejects tampered parameters, wrong tenant/task/contract/run bindings fail-closed", () => {
    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);
    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "npm run deploy --env=staging" },
      riskLevel: "HIGH",
      justification: "Staging deploy",
    });
    ac.approve(req.approvalId, "operator-alice");

    // Parameter tampering
    expect(
      facade.evaluateProposal({
        runId: "run-1",
        taskId: "task-1",
        tenantId: "tenant-A",
        approvalId: req.approvalId,
        subjectId: "agent-exec-1",
        fenceId: "fence-gov-1",
        harnessType: "IMPLEMENTATION_HARNESS",
        capability: "EXECUTE_ANALYSIS",
        toolName: "run_command",
        input: { command: "npm run deploy --env=prod" },
        workspacePath: tmpDir,
        missionContractHash: "contract-hash-A",
      }).approvalStatus
    ).toBe("MISMATCH");

    // Cross-tenant attempt
    expect(
      facade.evaluateProposal({
        runId: "run-1",
        taskId: "task-1",
        tenantId: "tenant-B",
        approvalId: req.approvalId,
        subjectId: "agent-exec-1",
        fenceId: "fence-gov-1",
        harnessType: "IMPLEMENTATION_HARNESS",
        capability: "EXECUTE_ANALYSIS",
        toolName: "run_command",
        input: { command: "npm run deploy --env=staging" },
        workspacePath: tmpDir,
        missionContractHash: "contract-hash-A",
      }).approvalStatus
    ).toBe("MISMATCH");

    // Contract swap attempt
    enforcer.registerFence(buildActiveFence(tmpDir, "contract-hash-B", { fenceId: "fence-gov-2" }));
    expect(
      facade.evaluateProposal({
        runId: "run-1",
        taskId: "task-1",
        tenantId: "tenant-A",
        approvalId: req.approvalId,
        subjectId: "agent-exec-1",
        fenceId: "fence-gov-2",
        harnessType: "IMPLEMENTATION_HARNESS",
        capability: "EXECUTE_ANALYSIS",
        toolName: "run_command",
        input: { command: "npm run deploy --env=staging" },
        workspacePath: tmpDir,
        missionContractHash: "contract-hash-B",
      }).approvalStatus
    ).toBe("MISMATCH");

    // Approval should still remain APPROVED (unconsumed) after mismatches
    expect(ac.getApproval(req.approvalId)?.status).toBe("APPROVED");
  });

  it("7. forbids self-approval by model/agent and execution subject", () => {
    const ac = new ApprovalControl(clock);
    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "git push origin feature" },
      riskLevel: "HIGH",
      justification: "Push branch",
    });

    expect(() => ac.approve(req.approvalId, "model")).toThrow(/self-approve/i);
    expect(() => ac.approve(req.approvalId, "agent")).toThrow(/self-approve/i);
    expect(() => ac.approve(req.approvalId, "   ")).toThrow(/non-empty/i);

    // Even if named non-generic, matching execution subjectId fails closed at verification
    ac.approve(req.approvalId, "agent-exec-1");
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);
    const res = facade.evaluateProposal({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-gov-1",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "git push origin feature" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    });
    expect(res.authorized).toBe(false);
    expect(res.approvalStatus).toBe("MISMATCH");
  });

  it("8. human approval never bypasses CapabilityFence denial and does not consume valid approval on fence denial", () => {
    enforcer.registerFence(
      buildActiveFence(tmpDir, "contract-hash-A", {
        fenceId: "fence-restricted",
        allowedCapabilities: ["READ_WORKSPACE"],
        scope: {
          allowedWorkspacePaths: [tmpDir],
          forbiddenWorkspacePaths: [".git"],
          allowedTools: ["read_file"],
          maxOperations: 100,
          maxMemoryBytes: 1000000,
          networkAllowed: false,
          gitWriteAllowed: false,
        },
      })
    );

    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);
    const req = ac.requestApproval({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "npm run deploy" },
      riskLevel: "HIGH",
      justification: "Should still be blocked by fence",
    });
    ac.approve(req.approvalId, "operator-alice");

    const decision = facade.evaluateProposal({
      runId: "run-1",
      taskId: "task-1",
      tenantId: "tenant-A",
      approvalId: req.approvalId,
      subjectId: "agent-exec-1",
      fenceId: "fence-restricted",
      harnessType: "IMPLEMENTATION_HARNESS",
      capability: "EXECUTE_ANALYSIS",
      toolName: "run_command",
      input: { command: "npm run deploy" },
      workspacePath: tmpDir,
      missionContractHash: "contract-hash-A",
    });

    expect(decision.authorized).toBe(false);
    expect(decision.controlId).toBe("N711");
    expect(ac.getApproval(req.approvalId)?.status).toBe("APPROVED");
  });

  it("9. persists approvals durably in SQLite across simulated process restart & wires ProductionRuntimeEngine / ProductionRepairOrchestrator", async () => {
    const dbPath = path.join(tmpDir, "state.db");
    const db1 = createSqliteClient({ location: dbPath });
    const store1 = new SqliteStateStore(db1);

    const ac1 = new ApprovalControl(clock, store1);
    const req = ac1.requestApproval({
      runId: "run-persist-1",
      taskId: "task-persist-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "git push origin release" },
      riskLevel: "CRITICAL",
      justification: "Durable restart check",
    });
    ac1.approve(req.approvalId, "operator-alice", "Approved before restart");
    store1.close();

    // Reopen SQLite database cleanly after restart
    const db2 = createSqliteClient({ location: dbPath });
    const store2 = new SqliteStateStore(db2);
    const ac2 = new ApprovalControl(clock, store2);

    const loaded = ac2.getApproval(req.approvalId);
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("APPROVED");
    expect(loaded!.approver).toBe("operator-alice");

    const facade2 = new ProductionGovernanceFacade(enforcer, gateway, ac2, clock);
    const toolGw = new ProductionToolGateway(facade2);

    // Without approval matching another command -> WAITING_APPROVAL metadata returned
    const unapprovedRes = await toolGw.executeTool(
      "run_command",
      { command: "npm run deploy --prod" },
      {
        runId: "run-persist-1",
        taskId: "task-persist-1",
        tenantId: "tenant-A",
        subjectId: "agent-exec-1",
        fenceId: "fence-gov-1",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: tmpDir,
        missionContractHash: "contract-hash-A",
      }
    );
    expect(unapprovedRes.success).toBe(false);
    expect(unapprovedRes.requiresHumanApproval).toBe(true);
    expect(unapprovedRes.runStatusHint).toBe("WAITING_APPROVAL");

    // Verify ProductionRuntimeEngine & ProductionRepairOrchestrator wire ApprovalControl internally (non-undefined)
    const runCtrl = new RunControl(undefined, store2, clock);
    const missionCtrl = new MissionControl(store2, clock);
    const engine = new ProductionRuntimeEngine(
      { workspaceRoot: tmpDir } as any,
      missionCtrl,
      runCtrl,
      enforcer,
      gateway,
      undefined,
      undefined,
      clock,
      undefined,
      store2,
      undefined,
      ac2
    );
    const orch = new ProductionRepairOrchestrator(
      { workspaceRoot: tmpDir } as any,
      missionCtrl,
      runCtrl,
      enforcer,
      gateway,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      clock,
      store2,
      undefined,
      ac2
    );
    expect((engine as any).governanceFacade.getApprovalControl()).toBe(ac2);
    expect((orch as any).governanceFacade.getApprovalControl()).toBe(ac2);

    store2.close();
  });

  it("10. RunCoordinator enforces full durable VERIFYING and WAITING_APPROVAL transitions and lease fencing", () => {
    const db = createSqliteClient({ location: ":memory:" });
    const store = new SqliteStateStore(db);
    const coordinator = new RunCoordinator(store, clock);

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

    coordinator.createTask({ taskId: "task-sm-1", title: "SM test", inputPayload: {} });
    createAndActivateContract(store, "task-sm-1");

    const { run: created } = coordinator.createRun({ runId: "run-sm-1", taskId: "task-sm-1", maxAttempts: 3 });
    coordinator.queueRun(created.runId);
    const claim1 = coordinator.claimRun(created.runId, "worker-1", 60_000);
    const lease1 = claim1.lease.leaseId;
    coordinator.startRun(created.runId, "worker-1", lease1);

    // Stale worker cannot start verification
    expect(() => coordinator.startVerification(created.runId, "worker-2", "lease-stale")).toThrow();

    // RUNNING -> VERIFYING
    const verifyingRes = coordinator.startVerification(created.runId, "worker-1", lease1);
    expect(verifyingRes.run.status).toBe("VERIFYING");
    expect(verifyingRes.event.eventType).toBe("verification.started");

    // VERIFYING -> WAITING_APPROVAL (releases worker lease)
    const waitingRes = coordinator.requestApprovalTransition(
      created.runId,
      "appr-sm-1",
      "run_command",
      { workerId: "worker-1", leaseId: lease1 }
    );
    expect(waitingRes.run.status).toBe("WAITING_APPROVAL");
    expect(waitingRes.run.leaseExpiresAt).toBeNull();
    expect(waitingRes.event.eventType).toBe("run.waiting_approval");

    // Stale worker cannot complete a run in WAITING_APPROVAL
    expect(() => coordinator.completeRun(created.runId, "worker-1", lease1, {})).toThrow();

    // Operator approves -> WAITING_APPROVAL -> QUEUED
    const resumed = coordinator.resumeFromApproval(created.runId, "appr-sm-1", "operator-alice");
    expect(resumed.run.status).toBe("QUEUED");
    expect(resumed.event.eventType).toBe("run.queued");

    // New worker claims -> completes via VERIFYING -> COMPLETED
    const claim2 = coordinator.claimRun(created.runId, "worker-2", 60_000);
    const lease2 = claim2.lease.leaseId;
    coordinator.startRun(created.runId, "worker-2", lease2);
    coordinator.startVerification(created.runId, "worker-2", lease2);
    const completed = coordinator.completeRun(created.runId, "worker-2", lease2, { ok: true });
    expect(completed.run.status).toBe("COMPLETED");

    // Reject flow on another run: WAITING_APPROVAL -> FAILED
    const { run: created2 } = coordinator.createRun({ runId: "run-sm-2", taskId: "task-sm-1" });
    coordinator.queueRun(created2.runId);
    const claim3 = coordinator.claimRun(created2.runId, "worker-1", 60_000);
    const lease3 = claim3.lease.leaseId;
    coordinator.startRun(created2.runId, "worker-1", lease3);
    coordinator.requestApprovalTransition(created2.runId, "appr-sm-2", "run_command", {
      workerId: "worker-1",
      leaseId: lease3,
    });
    const rejected = coordinator.rejectApprovalTransition(created2.runId, "appr-sm-2", "operator-bob", "Denied push");
    expect(rejected.run.status).toBe("FAILED");
    expect((rejected.run.errorPayload as any)?.code).toBe("APPROVAL_REJECTED");

    store.close();
  });

  it("11. blocks split-args high-risk commands (rm+args, git+args, shell -c) and null bytes unless explicitly approved", async () => {
    const ac = new ApprovalControl(clock);
    const facade = new ProductionGovernanceFacade(enforcer, gateway, ac, clock);
    const toolGw = new ProductionToolGateway(facade);

    for (const maliciousInput of [
      { command: "rm", args: ["-rf", "/"] },
      { command: "GIT", argv: ["PUSH", "origin", "main"] },
      { command: "sh", args: ["-c", "echo pwned"] },
      { command: "powershell.exe", args: ["-Command", "Get-Date"] },
      { command: "echo", args: ["ok;rm -rf /"] },
    ]) {
      const dec = facade.evaluateProposal({
        runId: "run-args-1",
        taskId: "task-args-1",
        tenantId: "tenant-A",
        subjectId: "agent-exec-1",
        fenceId: "fence-gov-1",
        harnessType: "IMPLEMENTATION_HARNESS",
        capability: "EXECUTE_ANALYSIS",
        toolName: "run_command",
        input: maliciousInput,
        workspacePath: tmpDir,
        missionContractHash: "contract-hash-A",
      });
      expect(dec.authorized).toBe(false);
      expect(dec.requiresHumanApproval).toBe(true);
    }

    const nullReq = ac.requestApproval({
      runId: "run-args-1",
      taskId: "task-args-1",
      tenantId: "tenant-A",
      contractHash: "contract-hash-A",
      operation: "run_command",
      parameters: { command: "node", args: ["bad\0arg"] },
      riskLevel: "HIGH",
      justification: "Verify defense-in-depth null-byte check inside gateway",
    });
    ac.approve(nullReq.approvalId, "operator-alice");

    const nullRes = await toolGw.executeTool(
      "run_command",
      { command: "node", args: ["bad\0arg"] },
      {
        runId: "run-args-1",
        taskId: "task-args-1",
        tenantId: "tenant-A",
        approvalId: nullReq.approvalId,
        subjectId: "agent-exec-1",
        fenceId: "fence-gov-1",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: tmpDir,
        missionContractHash: "contract-hash-A",
      }
    );
    expect(nullRes.success).toBe(false);
    expect(nullRes.error).toContain("Null bytes denied");
  });

  it("12. enforces active-lease fencing on RunCoordinator.requestApprovalTransition when fencing is omitted", () => {
    const db = createSqliteClient({ location: ":memory:" });
    const store = new SqliteStateStore(db);
    const coordinator = new RunCoordinator(store, clock);

    store.transaction((tx) => {
      tx.insertWorker({
        workerId: "worker-1",
        hostname: "localhost",
        pid: 1001,
        status: "ACTIVE",
        createdAt: clock.nowIso(),
        lastHeartbeatAt: clock.nowIso(),
      });
    });

    coordinator.createTask({ taskId: "task-fence-1", title: "Fence check", inputPayload: {} });
    createAndActivateContract(store, "task-fence-1");
    const { run } = coordinator.createRun({ runId: "run-fence-1", taskId: "task-fence-1", maxAttempts: 1 });
    coordinator.queueRun(run.runId);
    const claim = coordinator.claimRun(run.runId, "worker-1", 60_000);
    coordinator.startRun(run.runId, "worker-1", claim.lease.leaseId);

    // Omitting fencing on an actively leased run must fail closed with LeaseLostError
    expect(() =>
      coordinator.requestApprovalTransition(run.runId, "appr-no-fence", "run_command")
    ).toThrow(LeaseLostError);

    // Stale workerId/leaseId also throws
    expect(() =>
      coordinator.requestApprovalTransition(run.runId, "appr-stale-fence", "run_command", {
        workerId: "worker-other",
        leaseId: claim.lease.leaseId,
      })
    ).toThrow(LeaseLostError);

    store.close();
  });

  it("13. ProductionRuntimeEngine halts into WAITING_APPROVAL without verifying/completing, and RepairOrchestrator consumes single-use approval once", async () => {
    const workspaceDir = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "app.js"), "export const v = 1;\n", "utf8");

    const prodConfig = createProductionConfig({ workspaceRoot: workspaceDir });

    // 13a. ProductionRuntimeEngine halts cleanly in WAITING_APPROVAL on unapproved high-risk args
    const mc1 = new MissionControl(undefined, clock);
    const rc1 = new RunControl(undefined, undefined, clock);
    const ev1 = new EvidenceControl();
    const ac1 = new ApprovalControl(clock);
    const enforcer1 = new CapabilityFenceEnforcer(clock);
    const gw1 = new CrossHarnessGateway(enforcer1, clock);
    const engine = new ProductionRuntimeEngine(
      prodConfig,
      mc1,
      rc1,
      enforcer1,
      gw1,
      ev1,
      new ProductionVerifier(clock),
      clock,
      undefined,
      undefined,
      undefined,
      ac1
    );
    const mission1 = mc1.createMission({
      title: "Engine WAITING_APPROVAL halt",
      description: "Propose unapproved git push",
      repositoryPath: workspaceDir,
    });
    const engineOutcome = await engine.executeRun(mission1.missionId, {
      proposeAction: async () => ({
        thought: "Push changes",
        toolName: "run_command",
        toolInput: { command: "git", args: ["push", "origin", "main"] },
        isGoalReached: false,
      }),
    });
    expect(engineOutcome.run.status).toBe("WAITING_APPROVAL");
    expect(engineOutcome.verification.verified).toBe(false);
    expect(engineOutcome.evidence.disposition).toBe("REJECTED");
    expect(ev1.getTimeline(engineOutcome.run.runId).some((e) => e.eventType === "run.waiting_approval")).toBe(true);

    // 13b. RepairOrchestrator halts in WAITING_APPROVAL when unapproved, and consumes approval only once when approved
    const mc2 = new MissionControl(undefined, clock);
    const rc2 = new RunControl(undefined, undefined, clock);
    const ev2 = new EvidenceControl();
    const ac2 = new ApprovalControl(clock);
    const enforcer2 = new CapabilityFenceEnforcer(clock);
    const gw2 = new CrossHarnessGateway(enforcer2, clock);
    const orch = new ProductionRepairOrchestrator(
      prodConfig,
      mc2,
      rc2,
      enforcer2,
      gw2,
      ev2,
      new ProductionVerifier(clock),
      undefined,
      undefined,
      undefined,
      undefined,
      clock,
      undefined,
      undefined,
      ac2
    );

    const mission2 = mc2.createMission({
      title: "RepairOrchestrator WAITING_APPROVAL halt",
      description: "Stop cleanly when unapproved shell command proposed",
      repositoryPath: workspaceDir,
    });
    const unapprovedRepair = await orch.executeRepairSession(mission2.missionId, {
      proposeAction: async () => ({
        thought: "Run unapproved shell",
        toolName: "run_command",
        toolInput: { command: "git", args: ["push", "origin", "HEAD"] },
        isGoalReached: false,
      }),
    });
    expect(unapprovedRepair.run.status).toBe("WAITING_APPROVAL");
    expect(unapprovedRepair.verification.verified).toBe(false);

    // Approved single-use execution: pre-check in orchestrator uses consumeApproval: false so gateway consumes once
    const approvedCmd =
      process.platform === "win32"
        ? { command: "cmd", args: ["/c", "echo", "approved-ok"] }
        : { command: "sh", args: ["-c", "echo approved-ok"] };
    let createdApprovalId: string | null = null;
    let proposalCount = 0;
    const mission3 = mc2.createMission({
      title: "RepairOrchestrator single-use consume check",
      description: "Pre-check must not exhaust single-use approval before gateway executes tool",
      repositoryPath: workspaceDir,
    });
    const approvedRepair = await orch.executeRepairSession(
      mission3.missionId,
      {
        proposeAction: async () => {
          proposalCount++;
          if (proposalCount === 1) {
            const activeRun = rc2.listRuns().find((r) => r.missionId === mission3.missionId)!;
            const req = ac2.requestApproval({
              runId: activeRun.runId,
              taskId: mission3.taskId,
              tenantId: mission3.contract.spec.policy.tenantId,
              contractHash: mission3.contract.contentHash,
              operation: "run_command",
              parameters: approvedCmd,
              riskLevel: "HIGH",
              justification: "Single-use execution test",
              singleUse: true,
            });
            ac2.approve(req.approvalId, "operator-alice", "Approved once");
            createdApprovalId = req.approvalId;
            return {
              thought: "Run approved high-risk wrapper",
              toolName: "run_command",
              toolInput: approvedCmd,
              isGoalReached: false,
            };
          }
          return {
            thought: "Approved action completed cleanly",
            toolName: "git_status",
            toolInput: {},
            isGoalReached: true,
          };
        },
      },
      {
        testCommand: { cmd: "node", args: ["-e", "process.exit(0)"] },
      }
    );
    expect(createdApprovalId).not.toBeNull();
    expect(ac2.getApproval(createdApprovalId!)?.status).toBe("CONSUMED");
    expect(approvedRepair.run.status).toBe("COMPLETED");
    expect(ev2.getTimeline(approvedRepair.run.runId).some((e) => e.eventType === "tool.executed")).toBe(true);
  });
});
