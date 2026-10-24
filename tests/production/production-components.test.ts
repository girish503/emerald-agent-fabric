/**
 * Emerald Agent Fabric — Production Components Test Suite
 *
 * Comprehensive tests for:
 * 1. ProductionConfig
 * 2. MissionControl
 * 3. RunControl
 * 4. ApprovalControl
 * 5. ProductionGovernanceFacade
 * 6. ProductionToolGateway
 * 7. ProductionVerifier
 * 8. ProductionEvidenceManager & Replay
 * 9. ProductionRecoveryService
 * 10. ProductionDoctor & EmeraldCli
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProductionConfig, ProductionConfig } from "../../src/config/production-config.js";
import { MissionControl } from "../../src/control-plane/mission-control.js";
import { RunControl } from "../../src/control-plane/run-control.js";
import { ApprovalControl } from "../../src/control-plane/approval-control.js";
import { EvidenceControl } from "../../src/control-plane/evidence-control.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { ProductionGovernanceFacade } from "../../src/governance/production-governance-facade.js";
import { ProductionToolGateway, ToolExecutionContext } from "../../src/tools/production-tools.js";
import { ProductionVerifier } from "../../src/verification/production-verifier.js";
import { ProductionReplayEngine } from "../../src/evidence/production-replay-engine.js";
import { ProductionRecoveryService } from "../../src/recovery/production-recovery-service.js";
import { ProductionDoctor } from "../../src/cli/doctor.js";
import { EmeraldCli } from "../../src/cli/emerald-cli.js";
import { ModelAdapter } from "../../src/runtime/production-runtime-engine.js";
import { CapabilityFence, computeCapabilityFenceHash } from "../../src/domain/capability-fence.js";

describe("Emerald Production Build V1: Components", () => {
  let tempDir: string;
  let config: ProductionConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-prod-test-"));
    config = createProductionConfig({
      workspaceRoot: tempDir,
      dbPath: path.join(tempDir, "test.sqlite"),
      modelProvider: "mock",
      executionProvider: "in-process",
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ============================================================================
  // 1. ProductionConfig
  // ============================================================================
  describe("1. ProductionConfig", () => {
    it("1.1 defaults to local-only, zero-cost, open-source settings", () => {
      expect(config.localOnly).toBe(true);
      expect(config.modelProvider).toBe("mock");
      expect(config.timeouts.runTimeoutMs).toBe(300000);
      expect(config.resourceLimits.maxSteps).toBe(50);
    });

    it("1.2 overrides work deterministically", () => {
      const custom = createProductionConfig({
        model: "deepseek-coder:6.7b",
        verificationPolicy: "standard",
      });
      expect(custom.model).toBe("deepseek-coder:6.7b");
      expect(custom.verificationPolicy).toBe("standard");
    });
  });

  // ============================================================================
  // 2. MissionControl
  // ============================================================================
  describe("2. MissionControl", () => {
    it("2.1 creates governed mission with bound MissionContract", () => {
      const mc = new MissionControl();
      const mission = mc.createMission({
        title: "Fix auth module",
        description: "Repair tokens",
        repositoryPath: tempDir,
      });

      expect(mission.missionId).toBeDefined();
      expect(mission.contract.spec.contractId).toBe(`contract-${mission.missionId}`);
      expect(mission.contract.contentHash).toHaveLength(64);
      expect(mission.status).toBe("ACTIVE");
    });

    it("2.2 retrieves and lists missions", () => {
      const mc = new MissionControl();
      const m1 = mc.createMission({ title: "Task 1", description: "D1", repositoryPath: tempDir });
      const m2 = mc.createMission({ title: "Task 2", description: "D2", repositoryPath: tempDir });

      expect(mc.getMission(m1.missionId)?.title).toBe("Task 1");
      expect(mc.getMission(m2.missionId)?.title).toBe("Task 2");
      expect(mc.listMissions()).toHaveLength(2);
    });

    it("2.3 revokes mission with reason", () => {
      const mc = new MissionControl();
      const m = mc.createMission({ title: "Task 1", description: "D1", repositoryPath: tempDir });
      mc.revokeMission(m.missionId, "Security breach");

      expect(mc.getMission(m.missionId)?.status).toBe("REVOKED");
      expect(mc.getMission(m.missionId)?.revocationReason).toBe("Security breach");
    });
  });

  // ============================================================================
  // 3. RunControl
  // ============================================================================
  describe("3. RunControl", () => {
    it("3.1 creates run bound to mission and contract hash", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const mission = mc.createMission({ title: "Task", description: "Desc", repositoryPath: tempDir });
      const run = rc.createRun(mission, "worker-1");

      expect(run.runId).toBeDefined();
      expect(run.missionId).toBe(mission.missionId);
      expect(run.contractHash).toBe(mission.contract.contentHash);
      expect(run.status).toBe("CREATED");
    });

    it("3.2 transitions run status through lifecycle", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const m = mc.createMission({ title: "T", description: "D", repositoryPath: tempDir });
      const r = rc.createRun(m);

      expect(rc.transitionStatus(r.runId, "ACTIVE").status).toBe("ACTIVE");
      expect(rc.transitionStatus(r.runId, "PLANNING").status).toBe("PLANNING");
      expect(rc.transitionStatus(r.runId, "EXECUTING").status).toBe("EXECUTING");
      expect(rc.transitionStatus(r.runId, "VERIFYING").status).toBe("VERIFYING");
      expect(rc.transitionStatus(r.runId, "COMPLETED").status).toBe("COMPLETED");
    });

    it("3.3 cancels and resumes run", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const m = mc.createMission({ title: "T", description: "D", repositoryPath: tempDir });
      const r = rc.createRun(m);

      expect(rc.cancelRun(r.runId, "Abort").status).toBe("CANCELLED");
      expect(rc.resumeRun(r.runId).status).toBe("ACTIVE");
    });
  });

  // ============================================================================
  // 4. ApprovalControl
  // ============================================================================
  describe("4. ApprovalControl", () => {
    it("4.1 requests human approval for high risk actions", () => {
      const ac = new ApprovalControl();
      const req = ac.requestApproval({
        runId: "run-1",
        operation: "git_push",
        parameters: { remote: "origin", branch: "master" },
        riskLevel: "CRITICAL",
        justification: "Deploy changes to production",
      });

      expect(req.approvalId).toBeDefined();
      expect(req.status).toBe("PENDING");
      expect(ac.listPending()).toHaveLength(1);
    });

    it("4.2 operator can approve or reject", () => {
      const ac = new ApprovalControl();
      const req1 = ac.requestApproval({ runId: "r1", operation: "op1", parameters: {}, riskLevel: "HIGH", justification: "j1" });
      const req2 = ac.requestApproval({ runId: "r2", operation: "op2", parameters: {}, riskLevel: "HIGH", justification: "j2" });

      ac.approve(req1.approvalId, "operator-alice");
      ac.reject(req2.approvalId, "operator-bob", "Too risky");

      expect(ac.getApproval(req1.approvalId)?.status).toBe("APPROVED");
      expect(ac.getApproval(req2.approvalId)?.status).toBe("REJECTED");
      expect(ac.listPending()).toHaveLength(0);
    });
  });

  // ============================================================================
  // 5. ProductionGovernanceFacade
  // ============================================================================
  describe("5. ProductionGovernanceFacade", () => {
    let enforcer: CapabilityFenceEnforcer;
    let gateway: CrossHarnessGateway;
    let facade: ProductionGovernanceFacade;

    beforeEach(() => {
      enforcer = new CapabilityFenceEnforcer();
      gateway = new CrossHarnessGateway(enforcer);
      facade = new ProductionGovernanceFacade(enforcer, gateway);
    });

    it("5.1 authorizes valid tool proposals within capability fence", () => {
      const fenceRaw: Omit<CapabilityFence, "hash"> = {
        fenceId: "f1",
        subjectId: "agent-1",
        roleId: "implementer",
        harnessId: "IMPLEMENTATION_HARNESS",
        allowedCapabilities: ["READ_WORKSPACE"],
        forbiddenCapabilities: ["WRITE_REPOSITORY"],
        scope: {
          allowedWorkspacePaths: [tempDir],
          forbiddenWorkspacePaths: [".git"],
          allowedTools: ["read_file"],
          maxOperations: 100,
          maxMemoryBytes: 1000000,
          networkAllowed: false,
          gitWriteAllowed: false,
        },
        trustLabel: "GOVERNED_OBSERVATION",
        status: "ACTIVE",
        delegatedFenceIds: [],
        version: 1,
        missionContractId: "contract-1",
        missionContractHash: "hash-1",
        authoritative: false,
        terminalAuthority: false,
        sovereignAuthority: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      };
      enforcer.registerFence({ ...fenceRaw, hash: computeCapabilityFenceHash(fenceRaw) });

      const decision = facade.evaluateProposal({
        runId: "run-1",
        subjectId: "agent-1",
        fenceId: "f1",
        harnessType: "IMPLEMENTATION_HARNESS",
        capability: "READ_WORKSPACE",
        toolName: "read_file",
        input: { path: "src/index.ts" },
        workspacePath: tempDir,
        missionContractHash: "hash-1",
      });

      expect(decision.authorized).toBe(true);
    });

    it("5.2 rejects tool outside allowedTools scope (N711)", () => {
      const fenceRaw: Omit<CapabilityFence, "hash"> = {
        fenceId: "f2",
        subjectId: "agent-2",
        roleId: "implementer",
        harnessId: "IMPLEMENTATION_HARNESS",
        allowedCapabilities: ["READ_WORKSPACE"],
        forbiddenCapabilities: ["WRITE_REPOSITORY"],
        scope: {
          allowedWorkspacePaths: [tempDir],
          forbiddenWorkspacePaths: [".git"],
          allowedTools: ["read_file"],
          maxOperations: 100,
          maxMemoryBytes: 1000000,
          networkAllowed: false,
          gitWriteAllowed: false,
        },
        trustLabel: "GOVERNED_OBSERVATION",
        status: "ACTIVE",
        delegatedFenceIds: [],
        version: 1,
        missionContractId: "contract-2",
        missionContractHash: "hash-2",
        authoritative: false,
        terminalAuthority: false,
        sovereignAuthority: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      };
      enforcer.registerFence({ ...fenceRaw, hash: computeCapabilityFenceHash(fenceRaw) });

      const decision = facade.evaluateProposal({
        runId: "run-2",
        subjectId: "agent-2",
        fenceId: "f2",
        harnessType: "IMPLEMENTATION_HARNESS",
        capability: "READ_WORKSPACE",
        toolName: "write_file", // not allowed in scope!
        input: { path: "src/index.ts" },
        workspacePath: tempDir,
        missionContractHash: "hash-2",
      });

      expect(decision.authorized).toBe(false);
      expect(decision.controlId).toBe("N711");
    });
  });

  // ============================================================================
  // 6. ProductionToolGateway
  // ============================================================================
  describe("6. ProductionToolGateway", () => {
    let enforcer: CapabilityFenceEnforcer;
    let gateway: CrossHarnessGateway;
    let facade: ProductionGovernanceFacade;
    let tools: ProductionToolGateway;
    let toolCtx: ToolExecutionContext;

    beforeEach(() => {
      enforcer = new CapabilityFenceEnforcer();
      gateway = new CrossHarnessGateway(enforcer);
      facade = new ProductionGovernanceFacade(enforcer, gateway);
      tools = new ProductionToolGateway(facade);

      const fenceRaw: Omit<CapabilityFence, "hash"> = {
        fenceId: "f-tools",
        subjectId: "agent-tools",
        roleId: "implementer",
        harnessId: "IMPLEMENTATION_HARNESS",
        allowedCapabilities: ["READ_WORKSPACE", "READ_REPOSITORY", "WRITE_TEMPORARY_OUTPUT", "EXECUTE_ANALYSIS"],
        forbiddenCapabilities: ["WRITE_REPOSITORY"],
        scope: {
          allowedWorkspacePaths: [tempDir],
          forbiddenWorkspacePaths: [".git"],
          allowedTools: ["read_file", "search_code", "git_status", "git_diff", "write_file", "run_command"],
          maxOperations: 100,
          maxMemoryBytes: 1000000,
          networkAllowed: false,
          gitWriteAllowed: false,
        },
        trustLabel: "GOVERNED_OBSERVATION",
        status: "ACTIVE",
        delegatedFenceIds: [],
        version: 1,
        missionContractId: "contract-tools",
        missionContractHash: "hash-tools",
        authoritative: false,
        terminalAuthority: false,
        sovereignAuthority: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      };
      enforcer.registerFence({ ...fenceRaw, hash: computeCapabilityFenceHash(fenceRaw) });

      toolCtx = {
        runId: "run-tools",
        subjectId: "agent-tools",
        fenceId: "f-tools",
        harnessType: "IMPLEMENTATION_HARNESS",
        workspacePath: tempDir,
        missionContractHash: "hash-tools",
      };
    });

    it("6.1 writes and reads files inside workspace root", async () => {
      const writeRes = await tools.executeTool("write_file", { path: "src/hello.ts", content: "console.log('hi');" }, toolCtx);
      expect(writeRes.success).toBe(true);

      const readRes = await tools.executeTool("read_file", { path: "src/hello.ts" }, toolCtx);
      expect(readRes.success).toBe(true);
      expect(readRes.output).toBe("console.log('hi');");
    });

    it("6.2 searches code patterns inside workspace", async () => {
      await tools.executeTool("write_file", { path: "src/app.ts", content: "function calculateTax() { return 0.2; }" }, toolCtx);
      const searchRes = await tools.executeTool("search_code", { pattern: "calculateTax" }, toolCtx);
      expect(searchRes.success).toBe(true);
      const results = searchRes.output as Array<{ file: string; text: string }>;
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.text).toContain("calculateTax");
    });

    it("6.3 path traversal outside workspace is blocked fail-closed", async () => {
      const res = await tools.executeTool("read_file", { path: "../../secret.txt" }, toolCtx);
      expect(res.success).toBe(false);
      expect(res.error).toContain("traversal");
    });

    it("6.4 search_code does not follow directory junctions escaping workspace and prevents external leakage", async () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-search-ext-"));
      try {
        fs.writeFileSync(path.join(externalDir, "secret.ts"), "const LEAKED_PASSWORD = 'TOP_SECRET_SEARCH_DATA';", "utf8");

        const junctionPath = path.join(tempDir, "ext_junction");
        fs.symlinkSync(externalDir, junctionPath, "junction");

        const searchRes = await tools.executeTool("search_code", { pattern: "TOP_SECRET_SEARCH_DATA" }, toolCtx);
        expect(searchRes.success).toBe(true);
        const results = searchRes.output as Array<{ file: string; text: string }>;
        expect(results.length).toBe(0);
      } finally {
        try {
          fs.rmSync(externalDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    });

    it("6.5 search_code does not follow in-workspace directory junctions, preventing duplicate results and recursion loops", async () => {
      await tools.executeTool("write_file", { path: "src/token.ts", content: "const UNIQUE_TOKEN = 'SEARCH_TOKEN_123';" }, toolCtx);

      const srcDir = path.join(tempDir, "src");
      const linkSubdir = path.join(tempDir, "link_src");
      fs.symlinkSync(srcDir, linkSubdir, "junction");

      const searchRes = await tools.executeTool("search_code", { pattern: "SEARCH_TOKEN_123" }, toolCtx);
      expect(searchRes.success).toBe(true);
      const results = searchRes.output as Array<{ file: string; text: string }>;
      expect(results.length).toBe(1);
      expect(results[0]?.file).toBe("src/token.ts");
    });

    it("6.6 search_code respects .git and node_modules exclusions", async () => {
      const gitDir = path.join(tempDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, "internal.ts"), "const GIT_INTERNAL = 'EXCLUDE_GIT_KEY';", "utf8");

      const nodeModulesDir = path.join(tempDir, "node_modules", "package");
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      fs.writeFileSync(path.join(nodeModulesDir, "dep.ts"), "const DEP_KEY = 'EXCLUDE_NODE_MODULES_KEY';", "utf8");

      const gitSearch = await tools.executeTool("search_code", { pattern: "EXCLUDE_GIT_KEY" }, toolCtx);
      expect(gitSearch.success).toBe(true);
      expect((gitSearch.output as any[]).length).toBe(0);

      const nmSearch = await tools.executeTool("search_code", { pattern: "EXCLUDE_NODE_MODULES_KEY" }, toolCtx);
      expect(nmSearch.success).toBe(true);
      expect((nmSearch.output as any[]).length).toBe(0);
    });

    it("6.7 search_code fails safely on broken junctions or inaccessible directories without crashing", async () => {
      const brokenTarget = path.join(os.tmpdir(), "emerald-broken-" + Date.now());
      const brokenLink = path.join(tempDir, "broken_junction");
      fs.symlinkSync(brokenTarget, brokenLink, "junction");

      await tools.executeTool("write_file", { path: "src/valid.ts", content: "const VALID = 'STILL_FOUND_KEY';" }, toolCtx);

      const searchRes = await tools.executeTool("search_code", { pattern: "STILL_FOUND_KEY" }, toolCtx);
      expect(searchRes.success).toBe(true);
      const results = searchRes.output as Array<{ file: string; text: string }>;
      expect(results.length).toBe(1);
      expect(results[0]?.text).toContain("STILL_FOUND_KEY");
    });

    it("6.8 search_code path argument validates containment and rejects escaping paths fail-closed", async () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-search-ext2-"));
      try {
        const junctionPath = path.join(tempDir, "escaping_sub_junc");
        fs.symlinkSync(externalDir, junctionPath, "junction");

        const relRes = await tools.executeTool("search_code", { pattern: "test", path: "../../external" }, toolCtx);
        expect(relRes.success).toBe(false);
        expect(relRes.error).toContain("traversal");

        const juncRes = await tools.executeTool("search_code", { pattern: "test", path: "escaping_sub_junc" }, toolCtx);
        expect(juncRes.success).toBe(false);
        expect(juncRes.error).toContain("traversal");

        await tools.executeTool("write_file", { path: "src/module.ts", content: "const SUB_VAL = 'IN_SUBPATH';" }, toolCtx);
        const subRes = await tools.executeTool("search_code", { pattern: "IN_SUBPATH", path: "src" }, toolCtx);
        expect(subRes.success).toBe(true);
        const results = subRes.output as Array<{ file: string; text: string }>;
        expect(results.length).toBe(1);
      } finally {
        try {
          fs.rmSync(externalDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    });
  });

  // ============================================================================
  // 7. ProductionVerifier
  // ============================================================================
  describe("7. ProductionVerifier", () => {
    it("7.1 verifies successful workspace with exit code 0", async () => {
      const verifier = new ProductionVerifier();
      const res = await verifier.verify({
        workspacePath: tempDir,
      });

      expect(res.verified).toBe(true);
      expect(res.proofHash).toHaveLength(64);
      expect(res.stages.every((s) => s.passed)).toBe(true);
    });
  });

  // ============================================================================
  // 8. ProductionEvidenceManager & Replay
  // ============================================================================
  describe("8. ProductionEvidenceManager & Replay", () => {
    it("8.1 seals evidence bundle and replay reconstructs historical run", () => {
      const ec = new EvidenceControl();
      ec.recordTimelineEntry("run-rep-1", "run.started", "Run started", "RunControl");
      ec.recordTimelineEntry("run-rep-1", "tool.executed", "File write", "ToolGateway", { toolName: "write_file" });

      const bundle = ec.sealEvidenceBundle({
        runId: "run-rep-1",
        missionId: "mission-1",
        contractId: "contract-1",
        contractHash: "hash-1",
        workspacePath: tempDir,
        repositoryPath: tempDir,
        modelId: "mock-model",
        contextDigest: "ctx-hash",
        actionsCount: 1,
        attemptsCount: 1,
        gitDiff: "+ test diff",
        testResults: { passed: true, totalTests: 5, passedTests: 5, failedTests: 0, durationMs: 120 },
        verificationResult: { verified: true, sovereignVerifier: "Verifier_v1", proofHash: "proof-123" },
        timeline: ec.getTimeline("run-rep-1"),
        disposition: "ACCEPTED",
        completedAt: new Date().toISOString(),
      });

      expect(bundle.bundleDigest).toHaveLength(64);

      const replay = new ProductionReplayEngine();
      const report = replay.reconstructRun(bundle);
      expect(report.runId).toBe("run-rep-1");
      expect(report.reconstructedSuccessfully).toBe(true);
      expect(report.verification.verified).toBe(true);
    });
  });

  // ============================================================================
  // 9. ProductionRecoveryService
  // ============================================================================
  describe("9. ProductionRecoveryService", () => {
    it("9.1 recovers interrupted active runs safely after crash", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const recovery = new ProductionRecoveryService(rc);

      const m = mc.createMission({ title: "T", description: "D", repositoryPath: tempDir });
      const r = rc.createRun(m);
      rc.transitionStatus(r.runId, "EXECUTING");

      const outcomes = recovery.recoverInterruptedRuns();
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]?.runId).toBe(r.runId);
      expect(outcomes[0]?.statusBefore).toBe("EXECUTING");
      expect(rc.getRun(r.runId)?.status).toBe("FAILED"); // Interrupted execution fenced
    });

    it("9.2 preserves terminal state immutability when recoverRun is called on COMPLETED run", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const recovery = new ProductionRecoveryService(rc);

      const m = mc.createMission({ title: "T", description: "D", repositoryPath: tempDir });
      const r = rc.createRun(m);
      rc.transitionStatus(r.runId, "COMPLETED");

      const outcome = recovery.recoverRun(r.runId);
      expect(outcome.statusBefore).toBe("COMPLETED");
      expect(outcome.statusAfter).toBe("COMPLETED");
      expect(outcome.safeToResume).toBe(false);
      expect(rc.getRun(r.runId)?.status).toBe("COMPLETED");
    });

    it("9.3 preserves terminal status for FAILED, CANCELLED, and TIMED_OUT runs idempotently", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const recovery = new ProductionRecoveryService(rc);

      const m = mc.createMission({ title: "T", description: "D", repositoryPath: tempDir });

      for (const terminalStatus of ["FAILED", "CANCELLED", "TIMED_OUT", "QUARANTINED"] as const) {
        const r = rc.createRun(m);
        rc.transitionStatus(r.runId, terminalStatus);

        const outcome1 = recovery.recoverRun(r.runId);
        expect(outcome1.statusBefore).toBe(terminalStatus);
        expect(outcome1.statusAfter).toBe(terminalStatus);
        expect(outcome1.safeToResume).toBe(false);
        expect(rc.getRun(r.runId)?.status).toBe(terminalStatus);

        // Repeated recovery attempt is idempotent
        const outcome2 = recovery.recoverRun(r.runId);
        expect(outcome2.statusAfter).toBe(terminalStatus);
        expect(rc.getRun(r.runId)?.status).toBe(terminalStatus);
      }
    });

    it("9.4 revokes exact capability fence matching workerId during recovery", () => {
      const mc = new MissionControl();
      const rc = new RunControl();
      const fe = new CapabilityFenceEnforcer();
      const recovery = new ProductionRecoveryService(rc, fe);

      const m = mc.createMission({ title: "T", description: "D", repositoryPath: tempDir });
      const workerId = "repair-worker-run-test";
      const r = rc.createRun(m, workerId);
      rc.transitionStatus(r.runId, "EXECUTING");

      const fenceId = `fence-${r.runId}`;
      fe.registerFence({
        fenceId,
        subjectId: workerId,
        roleId: "repair_orchestrator",
        harnessId: "IMPLEMENTATION_HARNESS",
        allowedCapabilities: ["READ_WORKSPACE"],
        forbiddenCapabilities: [],
        scope: {
          allowedWorkspacePaths: [tempDir],
          forbiddenWorkspacePaths: [],
          allowedTools: ["read_file"],
          maxOperations: 10,
          maxMemoryBytes: 1024 * 1024,
          networkAllowed: false,
          gitWriteAllowed: false,
        },
        trustLabel: "GOVERNED_OBSERVATION",
        status: "ACTIVE",
        delegatedFenceIds: [],
        version: 1,
        missionContractId: "c1",
        missionContractHash: "h1",
        authoritative: false,
        terminalAuthority: false,
        sovereignAuthority: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        hash: "dummyhash",
      });

      expect(fe.getActiveFenceForSubject(workerId)).toBeDefined();

      const outcome = recovery.recoverRun(r.runId);
      expect(outcome.leasesFenced).toBeGreaterThanOrEqual(1);
      expect(fe.getActiveFenceForSubject(workerId)).toBeUndefined();
    });
  });

  // ============================================================================
  // 10. ProductionDoctor & EmeraldCli
  // ============================================================================
  describe("10. ProductionDoctor & EmeraldCli", () => {
    it("10.1 doctor runs all diagnostics and reports status", async () => {
      const doctor = new ProductionDoctor(config);
      const report = await doctor.runDiagnostics();

      expect(report.checks.length).toBeGreaterThanOrEqual(5);
      const components = report.checks.map((c) => c.component);
      expect(components).toContain("Node.js Runtime");
      expect(components).toContain("Git CLI");
      expect(components).toContain("Workspace Filesystem");
      expect(components).toContain("SQLite State Store");
    });

    it("10.2 EmeraldCli dispatches commands cleanly", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const initRes = await cli.run(["init"]);
      expect(initRes.exitCode).toBe(0);
      expect(initRes.output).toContain("Initialized");

      const docRes = await cli.run(["doctor"]);
      expect(docRes.output).toContain("Diagnostics");

      const missionRes = await cli.run(["mission", "create", "BugFixTask", "Fix memory bug", tempDir]);
      expect(missionRes.exitCode).toBe(0);
      expect(missionRes.output).toContain("Created Mission");
    });

    it("10.3 EmeraldCli benchmark run rejects unknown task ID with exit code 1", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "non-existent-task-id"]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Task not found: non-existent-task-id");
    });

    it("10.4 EmeraldCli benchmark run executes offline reference with sovereign verification", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--offline", "--temp-dir", tempDir]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("Task ID:                 swe-easy-001");
      expect(res.output).toContain("Condition:               CONTROL_C_HUMAN_REFERENCE");
      expect(res.output).toContain("Model / Adapter:         human-reference-expert");
      expect(res.output).toContain("Classification:          SOVEREIGN_VERIFIED_SUCCESS");
      expect(res.output).toContain("Sovereign Verification:  PASSED");
      expect(res.output).toContain("Deterministic Replay:    VERIFIED (3 sweeps)");
      expect(res.output).toContain("Reviewable Git Diff:");
      expect(res.output).toContain("+    if (this.tokens >= cost) {");
    });

    it("10.5 EmeraldCli benchmark run defaults to first task when taskId is omitted", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "--offline", "--temp-dir", tempDir]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("Task ID:                 swe-easy-001");
      expect(res.output).toContain("Classification:          SOVEREIGN_VERIFIED_SUCCESS");
    });

    it("10.6 EmeraldCli benchmark run honestly reports adapter without falsely claiming Ollama", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--offline", "--temp-dir", tempDir]);
      expect(res.output).toContain("Model / Adapter:         human-reference-expert");
      expect(res.output).not.toContain("qwen");
      expect(res.output).not.toContain("ollama");
    });

    it("10.7 EmeraldCli benchmark run fails safely when local Ollama is unreachable", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--endpoint", "http://127.0.0.1:59999"]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Error: Local Ollama server is unreachable at http://127.0.0.1:59999");
      expect(res.output).toContain("Please start Ollama or run with '--offline'");
    });

    it("10.8 EmeraldCli benchmark run propagates verification failure and exit-code 1 when repair fails", async () => {
      const failingAdapter: ModelAdapter = {
        async proposeAction() {
          return {
            thought: "Propose no-op change that fails verification",
            toolName: "read_file",
            toolInput: { path: "token-bucket.js" },
            isGoalReached: true,
          };
        },
      };

      const cli = new EmeraldCli({ workspaceRoot: tempDir }, failingAdapter);
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--temp-dir", tempDir]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Classification:");
      expect(res.output).toContain("Sovereign Verification:  FAILED");
      expect(res.output).not.toContain("SOVEREIGN_VERIFIED_SUCCESS");
    });

    it("10.9 EmeraldCli benchmark run rejects invalid condition with exit code 1", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--condition", "INVALID_CONDITION"]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Error: Invalid condition 'INVALID_CONDITION'");
      expect(res.output).toContain("Supported conditions: CONTROL_A_MODEL_ONLY");
    });

    it("10.10 EmeraldCli benchmark run rejects unsupported adapter with exit code 1", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--adapter", "openai"]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Error: Unsupported adapter 'openai'");
      expect(res.output).toContain("Supported adapters: 'ollama', 'offline', 'human-reference'");
    });

    it("10.11 EmeraldCli benchmark run validates missing or empty option values", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });

      const res1 = await cli.run(["benchmark", "run", "swe-easy-001", "--model"]);
      expect(res1.exitCode).toBe(1);
      expect(res1.output).toContain("Error: Missing required value for option '--model'");

      const res2 = await cli.run(["benchmark", "run", "swe-easy-001", "--model="]);
      expect(res2.exitCode).toBe(1);
      expect(res2.output).toContain("Error: Missing required value for option '--model'");

      const res3 = await cli.run(["benchmark", "run", "swe-easy-001", "--adapter"]);
      expect(res3.exitCode).toBe(1);
      expect(res3.output).toContain("Error: Missing required value for option '--adapter'");

      const res4 = await cli.run(["benchmark", "run", "swe-easy-001", "--endpoint", "--offline"]);
      expect(res4.exitCode).toBe(1);
      expect(res4.output).toContain("Error: Missing required value for option '--endpoint'");

      const res5 = await cli.run(["benchmark", "run", "swe-easy-001", "--temp-dir"]);
      expect(res5.exitCode).toBe(1);
      expect(res5.output).toContain("Error: Missing required value for option '--temp-dir'");

      const res6 = await cli.run(["benchmark", "run", "swe-easy-001", "--condition"]);
      expect(res6.exitCode).toBe(1);
      expect(res6.output).toContain("Error: Missing required value for option '--condition'");
    });

    it("10.12 EmeraldCli benchmark run rejects conflict between --offline and non-human-reference condition", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--offline", "--condition", "CONTROL_B_GOVERNED_RUNTIME"]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Error: Conflict: '--offline' mode cannot be combined with condition 'CONTROL_B_GOVERNED_RUNTIME'");
    });

    it("10.13 EmeraldCli benchmark run rejects conflict between --adapter ollama and --offline / CONTROL_C", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });

      const res1 = await cli.run(["benchmark", "run", "swe-easy-001", "--adapter", "ollama", "--offline"]);
      expect(res1.exitCode).toBe(1);
      expect(res1.output).toContain("Error: Conflict: Adapter 'ollama' cannot be combined with '--offline' mode");

      const res2 = await cli.run(["benchmark", "run", "swe-easy-001", "--adapter", "ollama", "--condition", "CONTROL_C_HUMAN_REFERENCE"]);
      expect(res2.exitCode).toBe(1);
      expect(res2.output).toContain("Error: Conflict: Adapter 'ollama' cannot be used with condition 'CONTROL_C_HUMAN_REFERENCE'");
    });

    it("10.14 EmeraldCli benchmark run reports missing model when Ollama does not have model installed", async () => {
      const cli = new EmeraldCli({ workspaceRoot: tempDir });
      const res = await cli.run(["benchmark", "run", "swe-easy-001", "--model", "nonexistent-model-xyz-12345"]);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("Error: Model 'nonexistent-model-xyz-12345' is not installed in local Ollama library");
      expect(res.output).toContain("ollama pull nonexistent-model-xyz-12345");
    });
  });
});
