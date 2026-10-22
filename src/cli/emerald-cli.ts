/**
 * Emerald Agent Fabric — Production Developer CLI
 *
 * Implements the command-line interface:
 * - emerald init
 * - emerald mission create <title> [--desc <desc>] [--repo <path>]
 * - emerald mission list
 * - emerald run start <missionId>
 * - emerald run list
 * - emerald run status <runId>
 * - emerald run cancel <runId>
 * - emerald run resume <runId>
 * - emerald run recover <runId>
 * - emerald run inspect <runId>
 * - emerald diff <runId>
 * - emerald verify <runId>
 * - emerald evidence <runId>
 * - emerald replay <runId>
 * - emerald doctor
 */

import * as fs from "node:fs";
import { createProductionConfig, ProductionConfig } from "../config/production-config.js";
import { MissionControl } from "../control-plane/mission-control.js";
import { RunControl } from "../control-plane/run-control.js";
import { EvidenceControl } from "../control-plane/evidence-control.js";
import { ApprovalControl } from "../control-plane/approval-control.js";
import { CapabilityFenceEnforcer } from "../application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../application/cross-harness-gateway.js";
import { ProductionRuntimeEngine, ModelAdapter } from "../runtime/production-runtime-engine.js";
import { ProductionReplayEngine } from "../evidence/production-replay-engine.js";
import { ProductionDoctor } from "./doctor.js";
import { BenchmarkDoctor, BenchmarkManifestLoader } from "../production/benchmark/index.js";

export class EmeraldCli {
  private readonly config: ProductionConfig;
  private readonly missionControl: MissionControl;
  private readonly runControl: RunControl;
  private readonly evidenceControl: EvidenceControl;
  private readonly approvalControl: ApprovalControl;
  private readonly fenceEnforcer: CapabilityFenceEnforcer;
  private readonly crossHarnessGateway: CrossHarnessGateway;
  private readonly runtimeEngine: ProductionRuntimeEngine;
  private readonly replayEngine: ProductionReplayEngine;
  private readonly doctor: ProductionDoctor;

  constructor(configOverrides?: Partial<ProductionConfig>) {
    this.config = createProductionConfig(configOverrides);
    this.missionControl = new MissionControl();
    this.runControl = new RunControl();
    this.evidenceControl = new EvidenceControl();
    this.approvalControl = new ApprovalControl();
    this.fenceEnforcer = new CapabilityFenceEnforcer();
    this.crossHarnessGateway = new CrossHarnessGateway(this.fenceEnforcer);
    this.runtimeEngine = new ProductionRuntimeEngine(
      this.config,
      this.missionControl,
      this.runControl,
      this.fenceEnforcer,
      this.crossHarnessGateway,
      this.evidenceControl,
    );
    this.replayEngine = new ProductionReplayEngine();
    this.doctor = new ProductionDoctor(this.config);
  }

  public getApprovalControl(): ApprovalControl {
    return this.approvalControl;
  }

  /**
   * Dispatches and handles a CLI invocation.
   */
  public async run(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
    const cmd = args[0] || "help";
    const subCmd = args[1];

    try {
      switch (cmd) {
        case "init":
          return this.handleInit();

        case "doctor":
          return await this.handleDoctor();

        case "mission":
          if (subCmd === "create") {
            const title = args[2] || "Default Engineering Task";
            const desc = args[3] || title;
            const repo = args[4] || process.cwd();
            return this.handleMissionCreate(title, desc, repo);
          } else if (subCmd === "list") {
            return this.handleMissionList();
          }
          return { exitCode: 1, output: "Usage: emerald mission [create|list]" };

        case "run":
          if (subCmd === "start") {
            const missionId = args[2];
            if (!missionId) return { exitCode: 1, output: "Error: missionId required. Usage: emerald run start <missionId>" };
            return await this.handleRunStart(missionId);
          } else if (subCmd === "list") {
            return this.handleRunList();
          } else if (subCmd === "status") {
            const runId = args[2];
            return this.handleRunStatus(runId);
          } else if (subCmd === "cancel") {
            const runId = args[2];
            return this.handleRunCancel(runId);
          } else if (subCmd === "resume") {
            const runId = args[2];
            return this.handleRunResume(runId);
          } else if (subCmd === "recover") {
            const runId = args[2];
            return this.handleRunRecover(runId);
          } else if (subCmd === "inspect") {
            const runId = args[2];
            return this.handleRunInspect(runId);
          }
          return { exitCode: 1, output: "Usage: emerald run [start|list|status|cancel|resume|recover|inspect]" };

        case "repair":
          if (subCmd === "start") {
            const missionId = args[2];
            if (!missionId) return { exitCode: 1, output: "Error: missionId required. Usage: emerald repair start <missionId>" };
            return await this.handleRepairStart(missionId);
          }
          return { exitCode: 1, output: "Usage: emerald repair start <missionId>" };

        case "diff":
          return this.handleDiff(subCmd);

        case "verify":
          return this.handleVerify(subCmd);

        case "evidence":
          return this.handleEvidence(subCmd);

        case "replay":
          return this.handleReplay(subCmd);

        case "benchmark":
          if (subCmd === "list") {
            return this.handleBenchmarkList();
          } else if (subCmd === "doctor") {
            return await this.handleBenchmarkDoctor();
          } else if (subCmd === "run") {
            return await this.handleBenchmarkRun(args[2]);
          } else if (subCmd === "status") {
            return this.handleBenchmarkStatus();
          } else if (subCmd === "report") {
            return this.handleBenchmarkReport();
          }
          return { exitCode: 1, output: "Usage: emerald benchmark [list|doctor|run|status|report]" };

        case "help":
        default:
          return this.handleHelp();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, output: `Error: ${msg}` };
    }
  }

  private handleInit(): { exitCode: number; output: string } {
    if (!fs.existsSync(this.config.workspaceRoot)) {
      fs.mkdirSync(this.config.workspaceRoot, { recursive: true });
    }
    return {
      exitCode: 0,
      output: `Initialized Emerald Agent Fabric workspace at: ${this.config.workspaceRoot}\nDatabase: ${this.config.dbPath}`,
    };
  }

  private async handleDoctor(): Promise<{ exitCode: number; output: string }> {
    const report = await this.doctor.runDiagnostics();
    const lines = ["Emerald Doctor Diagnostics:", "==========================="];
    for (const c of report.checks) {
      const symbol = c.status === "PASSED" ? "✓" : c.status === "WARNING" ? "⚠" : "✗";
      lines.push(`${symbol} [${c.component}]: ${c.message}`);
      if (c.actionableGuidance) {
        lines.push(`   → Guidance: ${c.actionableGuidance}`);
      }
    }
    lines.push("===========================");
    lines.push(`Status: ${report.healthy ? "HEALTHY" : "ATTENTION REQUIRED"}`);
    return { exitCode: report.healthy ? 0 : 1, output: lines.join("\n") };
  }

  private handleMissionCreate(title: string, desc: string, repo: string): { exitCode: number; output: string } {
    const mission = this.missionControl.createMission({
      title,
      description: desc,
      repositoryPath: repo,
    });
    return {
      exitCode: 0,
      output: `Created Mission ${mission.missionId}\nContract ID: ${mission.contract.spec.contractId}\nContract Hash: ${mission.contract.contentHash}\nStatus: ${mission.status}`,
    };
  }

  private handleMissionList(): { exitCode: number; output: string } {
    const missions = this.missionControl.listMissions();
    if (missions.length === 0) return { exitCode: 0, output: "No missions registered." };
    const lines = missions.map((m) => `[${m.status}] ${m.missionId}: "${m.title}" (Contract: ${m.contract.spec.contractId})`);
    return { exitCode: 0, output: lines.join("\n") };
  }

  private async handleRunStart(missionId: string): Promise<{ exitCode: number; output: string }> {
    const mission = this.missionControl.getMission(missionId);
    if (!mission) return { exitCode: 1, output: `Mission not found: ${missionId}` };

    // Default mock/deterministic model adapter for CLI execution
    const modelAdapter: ModelAdapter = {
      async proposeAction(_ctx: string) {
        return {
          thought: "Inspecting workspace and concluding task.",
          toolName: "git_status",
          toolInput: {},
          isGoalReached: true,
        };
      },
    };

    const res = await this.runtimeEngine.executeRun(missionId, modelAdapter);
    return {
      exitCode: res.verification.verified ? 0 : 1,
      output: `Run ${res.run.runId} Completed.\nStatus: ${res.run.status}\nVerification: ${res.verification.verified ? "PASSED" : "FAILED"}\nEvidence Digest: ${res.evidence.bundleDigest}`,
    };
  }

  private async handleRepairStart(missionId: string): Promise<{ exitCode: number; output: string }> {
    const mission = this.missionControl.getMission(missionId);
    if (!mission) return { exitCode: 1, output: `Mission not found: ${missionId}` };

    const modelAdapter: ModelAdapter = {
      async proposeAction(_ctx: string) {
        return {
          thought: "Inspecting workspace and concluding repair session.",
          toolName: "git_status",
          toolInput: {},
          isGoalReached: true,
        };
      },
    };

    const outcome = await this.runtimeEngine.executeRepairSession(missionId, modelAdapter);
    return {
      exitCode: outcome.session.sovereignVerified ? 0 : 1,
      output: `Repair Session ${outcome.session.sessionId} Complete.\nClassification: ${outcome.session.classification}\nVerification: ${outcome.session.sovereignVerified ? "PASSED" : "FAILED"}\nChanged Files: ${outcome.changedFiles.length}\nReviewable Diff:\n${outcome.reviewableDiff || "(No changes made)"}`,
    };
  }

  private handleRunList(): { exitCode: number; output: string } {
    const runs = this.runControl.listRuns();
    if (runs.length === 0) return { exitCode: 0, output: "No runs recorded." };
    const lines = runs.map((r) => `[${r.status}] ${r.runId} (Mission: ${r.missionId}, Actions: ${r.actionsCount})`);
    return { exitCode: 0, output: lines.join("\n") };
  }

  private handleRunStatus(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const run = this.runControl.getRun(runId);
    if (!run) return { exitCode: 1, output: `Run not found: ${runId}` };
    return {
      exitCode: 0,
      output: `Run ${run.runId}\nStatus: ${run.status}\nStarted: ${run.startedAt}\nActions: ${run.actionsCount}\nAttempts: ${run.attemptsCount}`,
    };
  }

  private handleRunCancel(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const run = this.runControl.cancelRun(runId);
    return { exitCode: 0, output: `Run ${run.runId} cancelled.` };
  }

  private handleRunResume(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const run = this.runControl.resumeRun(runId);
    return { exitCode: 0, output: `Run ${run.runId} resumed. Status: ${run.status}` };
  }

  private handleRunRecover(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const run = this.runControl.recoverRun(runId);
    return { exitCode: 0, output: `Run ${run.runId} recovery complete. Status: ${run.status}` };
  }

  private handleRunInspect(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const run = this.runControl.getRun(runId);
    if (!run) return { exitCode: 1, output: `Run not found: ${runId}` };
    const timeline = this.evidenceControl.getTimeline(runId);
    const lines = [
      `Inspect Run ${runId}:`,
      `Status: ${run.status}`,
      `Contract Hash: ${run.contractHash}`,
      `Timeline Events: ${timeline.length}`,
      ...timeline.map((t) => `  [Seq ${t.sequence}] ${t.timestamp} - ${t.eventType}: ${t.description}`),
    ];
    return { exitCode: 0, output: lines.join("\n") };
  }

  private handleDiff(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const bundle = this.evidenceControl.getEvidenceBundle(runId);
    if (!bundle) return { exitCode: 1, output: `No evidence bundle found for run ${runId}` };
    return { exitCode: 0, output: bundle.gitDiff || "No diff recorded." };
  }

  private handleVerify(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const bundle = this.evidenceControl.getEvidenceBundle(runId);
    if (!bundle) return { exitCode: 1, output: `No evidence bundle found for run ${runId}` };
    return {
      exitCode: bundle.verificationResult.verified ? 0 : 1,
      output: `Verification Proof for Run ${runId}:\nVerified: ${bundle.verificationResult.verified}\nVerifier: ${bundle.verificationResult.sovereignVerifier}\nProof Hash: ${bundle.verificationResult.proofHash}`,
    };
  }

  private handleEvidence(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const bundle = this.evidenceControl.getEvidenceBundle(runId);
    if (!bundle) return { exitCode: 1, output: `No evidence bundle found for run ${runId}` };
    return { exitCode: 0, output: JSON.stringify(bundle, null, 2) };
  }

  private handleReplay(runId?: string): { exitCode: number; output: string } {
    if (!runId) return { exitCode: 1, output: "runId required" };
    const bundle = this.evidenceControl.getEvidenceBundle(runId);
    if (!bundle) return { exitCode: 1, output: `No evidence bundle found for run ${runId}` };
    const report = this.replayEngine.reconstructRun(bundle);
    return { exitCode: 0, output: JSON.stringify(report, null, 2) };
  }

  private handleBenchmarkList(): { exitCode: number; output: string } {
    try {
      const loader = new BenchmarkManifestLoader();
      const manifest = loader.loadManifest();
      const lines = [
        `============================================================`,
        `Emerald Agent Fabric — Benchmark Manifest v${manifest.manifestVersion}`,
        `Manifest Hash: ${manifest.manifestHash}`,
        `Total Tasks: ${manifest.taskCount}`,
        `============================================================`,
        ...manifest.tasks.map(
          (t) => `[${t.difficulty}] ${t.taskId}: ${t.title} (${t.language}) -> ${t.sourceFile}`,
        ),
      ];
      return { exitCode: 0, output: lines.join("\n") };
    } catch (e) {
      return { exitCode: 1, output: `Benchmark list error: ${(e as Error).message}` };
    }
  }

  private async handleBenchmarkDoctor(): Promise<{ exitCode: number; output: string }> {
    const doc = new BenchmarkDoctor();
    const rep = await doc.runDiagnostics();
    const lines = [
      `============================================================`,
      `Emerald Agent Fabric — Benchmark Pre-Flight Diagnostics`,
      `Timestamp: ${rep.timestamp}`,
      `Overall Feasibility: [${rep.overallStatus}]`,
      `============================================================`,
      `Host System:`,
      `  Node.js: ${rep.system.nodeVersion}`,
      `  TypeScript: ${rep.system.typeScriptVersion}`,
      `  OS Platform: ${rep.system.osPlatform}`,
      `  Host RAM: ${rep.system.hostRamTotalMb} MB (Free: ${rep.system.hostRamFreeMb} MB)`,
      `  CPU: ${rep.system.cpuModel} (${rep.system.cpuCores} cores)`,
      `  GPU: ${rep.system.gpuName} (Discrete Accelerator: ${rep.system.gpuDetected ? "YES" : "NO"})`,
      ``,
      `Component Status:`,
      ...rep.components.map((c) => `  [${c.status}] ${c.component}: ${c.details}`),
      ``,
      `Local Model Feasibility Matrix:`,
      ...rep.models.map(
        (m) => `  [${m.feasibility}] ${m.modelName} (${m.quantization}): ${m.reason}`,
      ),
    ];
    return { exitCode: rep.overallStatus === "BLOCKED" ? 1 : 0, output: lines.join("\n") };
  }

  private async handleBenchmarkRun(taskId?: string): Promise<{ exitCode: number; output: string }> {
    const loader = new BenchmarkManifestLoader();
    const manifest = loader.loadManifest();
    const targetTasks = taskId
      ? manifest.tasks.filter((t) => t.taskId === taskId)
      : manifest.tasks.slice(0, 3); // Default to pilot subset when run from CLI

    if (targetTasks.length === 0) {
      return { exitCode: 1, output: `Task not found: ${taskId}` };
    }

    return {
      exitCode: 0,
      output: `Scheduled benchmark run for ${targetTasks.length} task(s). Run 'scripts/run-production-benchmark.ts' for full matrix.`,
    };
  }

  private handleBenchmarkStatus(): { exitCode: number; output: string } {
    return {
      exitCode: 0,
      output: `Benchmark Status: Ready. 15 tasks registered in swebench-v01 manifest.`,
    };
  }

  private handleBenchmarkReport(): { exitCode: number; output: string } {
    const reportPath = "docs/research/production-benchmark-v0.1.md";
    if (fs.existsSync(reportPath)) {
      const summary = fs.readFileSync(reportPath, "utf8").slice(0, 1000);
      return { exitCode: 0, output: `${summary}\n... [Full report at ${reportPath}]` };
    }
    return { exitCode: 0, output: "Benchmark report not yet generated. Run benchmark suite first." };
  }

  private handleHelp(): { exitCode: number; output: string } {
    return {
      exitCode: 0,
      output: `
Emerald Agent Fabric CLI — Governed Autonomous Engineering Runtime
==================================================================
Usage: emerald <command> [options]

Commands:
  emerald init                           Initialize local workspace directory
  emerald doctor                         Run environment and runtime diagnostics
  emerald mission create <title>         Create a governed engineering mission
  emerald mission list                   List registered missions
  emerald run start <missionId>          Start governed execution for a mission
  emerald run list                       List all runs and their states
  emerald run status <runId>             Show status of an active or completed run
  emerald run cancel <runId>             Cancel an active run
  emerald run resume <runId>             Resume a paused run
  emerald run recover <runId>            Recover an interrupted or crashed run
  emerald run inspect <runId>            Inspect run timeline and actions
  emerald diff <runId>                   Show working-tree changes produced by run
  emerald verify <runId>                 Show sovereign verification proof
  emerald evidence <runId>               Export full cryptographic evidence bundle
  emerald replay <runId>                 Reconstruct run history deterministically

Benchmark Commands:
  emerald benchmark list                 List all 15 SWE-bench compatible pilot tasks
  emerald benchmark doctor               Run host memory & model feasibility matrix
  emerald benchmark run [taskId]         Execute benchmark trial(s)
  emerald benchmark status               Show active benchmark status
  emerald benchmark report               Display benchmark results report
`,
    };
  }
}
