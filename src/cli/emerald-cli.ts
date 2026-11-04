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
 * - emerald recovery sweep|watch
 * - emerald submit --db <file> (--task <text> | --operation <name>) [--input <json>] [--capabilities <csv>]
 * - emerald inspect --db <file> --run-id <id>
 * - emerald worker --db <file> [--once] [--model-provider <fixture|ollama|in-process>] [--model <name>] [--ollama-base-url <url>] [--workspace-root <dir>] [--worker-id <id>] [--lease-ttl-ms <n>] [--poll-interval-ms <n>] [--max-runs <n>]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { artifactDirectory } from "../adapters/workspace/git-artifact-exporter.js";
import { createProductionConfig, ProductionConfig } from "../config/production-config.js";
import { MissionControl } from "../control-plane/mission-control.js";
import { RunControl } from "../control-plane/run-control.js";
import { EvidenceControl } from "../control-plane/evidence-control.js";
import { ApprovalControl } from "../control-plane/approval-control.js";
import { CapabilityFenceEnforcer } from "../application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../application/cross-harness-gateway.js";
import { ProductionRuntimeEngine, ModelAdapter, AgentProposal } from "../runtime/production-runtime-engine.js";
import { ProductionReplayEngine } from "../evidence/production-replay-engine.js";
import { ProductionDoctor } from "./doctor.js";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import { RunCoordinator } from "../application/run-coordinator.js";
import { submitDurableTask } from "../application/durable-submission.js";
import { TaskRouterService } from "../application/task-router.js";
import { WorkerHostConfigError, runWorkerHost } from "../application/worker-host.js";
import { SystemClock } from "../ports/clock.port.js";
import {
  RecoveryHostConfigError,
  runRecoveryHost,
  runRecoverySweepOnce,
  summarizeSweep,
  sweepNeedsOperator,
} from "../recovery/recovery-host.js";
import {
  formatLaunchGateDiagnostics,
  readTenantLaunchGateDiagnostics,
} from "../recovery/quarantine-diagnostics.js";
import {
  BenchmarkDoctor,
  BenchmarkManifestLoader,
  BenchmarkRunner,
  OllamaModelAdapter,
  BenchmarkCondition,
} from "../production/benchmark/index.js";

export const SUPPORTED_BENCHMARK_CONDITIONS: readonly BenchmarkCondition[] = [
  "CONTROL_A_MODEL_ONLY",
  "CONTROL_B_GOVERNED_RUNTIME",
  "CONTROL_B0_BASELINE",
  "CONTROL_B1_DIAGNOSTIC",
  "CONTROL_B2_REPAIR_ORCHESTRATION",
  "CONTROL_B3_MINIMAL_EVIDENCE",
  "CONTROL_B4_ANCHORED_EDITING",
  "CONTROL_B5_ANCHORED_DEMONSTRATION",
  "CONTROL_C_HUMAN_REFERENCE",
] as const;

export const SUPPORTED_BENCHMARK_ADAPTERS = ["ollama", "offline", "human-reference"] as const;

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

  constructor(
    configOverrides?: Partial<ProductionConfig>,
    private readonly customModelAdapter?: ModelAdapter,
  ) {
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

        case "recovery":
          return await this.handleRecovery(args.slice(1));

        case "submit":
          return this.handleSubmit(args.slice(1));

        case "router":
          return this.handleRouter(args.slice(1));

        case "artifact":
          return this.handleArtifact(args.slice(1));

        case "inspect":
          return this.handleInspect(args.slice(1));

        case "worker":
          return await this.handleWorker(args.slice(1));

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
            return await this.handleBenchmarkRun(args.slice(2));
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

  /**
   * emerald recovery sweep|watch|status — the host entry point for crash recovery and read-only diagnostics.
   * Exit codes: 0 ok, 1 error (including a watch that hit sweep errors), 2 sweep finished but runs need
   * an operator (held, failed closed, or workspace cleanup failed).
   */
  private async handleRecovery(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
    const sub = args[0];
    if (sub === "status") {
      return this.handleRecoveryStatus(args.slice(1));
    }

    const usage =
      "Usage: emerald recovery <sweep|watch|status> --db <file> --workers-stopped [--workspace-root <dir>] [--interval-ms <n>]";
    if (sub !== "sweep" && sub !== "watch") return { exitCode: 1, output: usage };

    const valueFlags = new Set(["--db", "--workspace-root", "--interval-ms"]);
    const booleanFlags = new Set(["--workers-stopped"]);
    const flags = new Map<string, string>();
    const switches = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (booleanFlags.has(a)) {
        if (switches.has(a)) return { exitCode: 1, output: `Error: ${a} given more than once. ${usage}` };
        switches.add(a);
        continue;
      }
      if (!a.startsWith("--")) return { exitCode: 1, output: `Error: unexpected argument '${a}'. ${usage}` };
      if (!valueFlags.has(a)) return { exitCode: 1, output: `Error: unknown option '${a}'. ${usage}` };
      if (flags.has(a)) return { exitCode: 1, output: `Error: ${a} given more than once. ${usage}` };
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { exitCode: 1, output: `Error: ${a} requires a value. ${usage}` };
      flags.set(a, value);
      i++;
    }

    // No default database: the interactive `emerald run` commands use the in-memory control plane,
    // so a default path would silently act on (or report success for) the wrong file.
    const dbPath = flags.get("--db");
    if (!dbPath) return { exitCode: 1, output: `Error: --db is required. ${usage}` };
    const options = {
      dbPath,
      workspaceRoot: flags.get("--workspace-root"),
      acknowledgeNoActiveWorkers: switches.has("--workers-stopped"),
    };

    try {
      if (sub === "sweep") {
        const result = await runRecoverySweepOnce(options);
        return { exitCode: sweepNeedsOperator(result) ? 2 : 0, output: JSON.stringify(summarizeSweep(result), null, 2) };
      }

      const rawInterval = flags.get("--interval-ms") ?? "5000";
      const intervalMs = /^\d+$/.test(rawInterval) ? Number(rawInterval) : Number.NaN;
      if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 86_400_000) {
        return { exitCode: 1, output: "Error: --interval-ms must be a plain integer between 100 and 86400000" };
      }
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let sweepErrors = 0;
      try {
        ({ sweepErrors } = await runRecoveryHost({ ...options, intervalMs, signal: controller.signal }));
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      return { exitCode: sweepErrors > 0 ? 1 : 0, output: sweepErrors > 0 ? `Stopped after ${sweepErrors} sweep error(s); see recovery.error log records` : "" };
    } catch (err: unknown) {
      if (err instanceof RecoveryHostConfigError) return { exitCode: 1, output: `Error: ${err.message}` };
      return { exitCode: 1, output: `Error: recovery failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * emerald recovery status --db <file> [--run-id <id>] [--json]
   * Read-only operator diagnostic query of persisted tenant launch-gate records.
   * Restricts output strictly to the eight existing schema columns.
   */
  private handleRecoveryStatus(args: readonly string[]): { exitCode: number; output: string } {
    const usage = "Usage: emerald recovery status --db <file> [--run-id <id>] [--json]";
    let isJson = false;
    const rest: string[] = [];
    for (const a of args) {
      if (a === "--json") {
        if (isJson) return { exitCode: 1, output: `Error: --json given more than once. ${usage}` };
        isJson = true;
      } else {
        rest.push(a);
      }
    }

    const parsed = this.parseValueFlags(rest, ["--db", "--run-id"], usage);
    if ("error" in parsed) return parsed.error;
    const dbPath = parsed.flags.get("--db");
    const runId = parsed.flags.get("--run-id");
    if (!dbPath) return { exitCode: 1, output: `Error: --db is required. ${usage}` };
    if (dbPath === ":memory:") return { exitCode: 1, output: `Error: --db <file> is required (not :memory:). ${usage}` };

    const result = readTenantLaunchGateDiagnostics({ dbPath, runId });
    if (result.status === "ERROR") {
      return { exitCode: 1, output: `Error: ${result.error}` };
    }
    if (result.status === "NOT_FOUND") {
      return { exitCode: 0, output: isJson ? "null" : result.message };
    }
    if (result.records.length === 0) {
      return { exitCode: 0, output: isJson ? "[]" : "No tenant launch gates found." };
    }
    if (isJson) {
      return { exitCode: 0, output: JSON.stringify(runId ? result.records[0] : result.records, null, 2) };
    }
    return { exitCode: 0, output: formatLaunchGateDiagnostics(result.records) };
  }

  /** Strict `--flag value` parser shared by the durable-store commands (no positional arguments). */
  private parseValueFlags(
    args: readonly string[],
    allowed: readonly string[],
    usage: string
  ): { flags: Map<string, string> } | { error: { exitCode: number; output: string } } {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!a.startsWith("--")) return { error: { exitCode: 1, output: `Error: unexpected argument '${a}'. ${usage}` } };
      if (!allowed.includes(a)) return { error: { exitCode: 1, output: `Error: unknown option '${a}'. ${usage}` } };
      if (flags.has(a)) return { error: { exitCode: 1, output: `Error: ${a} given more than once. ${usage}` } };
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: { exitCode: 1, output: `Error: ${a} requires a value. ${usage}` } };
      flags.set(a, value);
      i++;
    }
    return { flags };
  }

  /**
   * emerald submit — durably submit a deterministic task to a FILE-BACKED SQLite database (created and migrated
   * if absent; this is the only command that may create it). Prints {taskId, runId, status} as JSON. Unlike the
   * interactive `emerald run` commands this never uses the in-memory control plane.
   */
  private handleSubmit(args: readonly string[]): { exitCode: number; output: string } {
    const usage =
      "Usage: emerald submit --db <file> (--task <text> | --operation <name>) [--repo <dir>] [--input <json>] [--capabilities <csv>] [--max-attempts <n>] [--timeout-ms <n>] [--idempotency-key <key>]";
    const parsed = this.parseValueFlags(
      args,
      ["--db", "--operation", "--task", "--repo", "--input", "--capabilities", "--max-attempts", "--timeout-ms", "--idempotency-key"],
      usage
    );
    if ("error" in parsed) return parsed.error;
    const { flags } = parsed;
    const dbPath = flags.get("--db");
    const operation = flags.get("--operation");
    const task = flags.get("--task");
    if (!dbPath || dbPath === ":memory:") return { exitCode: 1, output: `Error: --db <file> is required (not :memory:). ${usage}` };
    if (!operation && !task) return { exitCode: 1, output: `Error: either --task or --operation is required. ${usage}` };
    let repositoryPath: string | undefined;
    if (flags.has("--repo")) {
      if (!task || flags.has("--input")) {
        return { exitCode: 1, output: `Error: --repo requires --task and cannot be combined with --input. ${usage}` };
      }
      repositoryPath = path.resolve(flags.get("--repo")!);
      try {
        if (!fs.statSync(repositoryPath).isDirectory()) {
          return { exitCode: 1, output: `Error: --repo is not a directory: ${repositoryPath}` };
        }
      } catch {
        return { exitCode: 1, output: `Error: --repo directory not found: ${repositoryPath}` };
      }
    }
    let input: unknown = null;
    if (flags.has("--input")) {
      try {
        input = JSON.parse(flags.get("--input")!);
      } catch {
        return { exitCode: 1, output: "Error: --input must be valid JSON" };
      }
    }
    const intFlag = (name: string): number | undefined | "bad" => {
      const raw = flags.get(name);
      if (raw === undefined) return undefined;
      return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : "bad";
    };
    const maxAttempts = intFlag("--max-attempts");
    const timeoutMs = intFlag("--timeout-ms");
    if (maxAttempts === "bad" || timeoutMs === "bad") return { exitCode: 1, output: "Error: --max-attempts and --timeout-ms must be positive integers" };

    const capabilities = flags.has("--capabilities")
      ? flags
          .get("--capabilities")!
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : undefined;

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store, new SystemClock());
      const submitted = submitDurableTask(store, coordinator, {
        operation,
        task,
        input,
        maxAttempts,
        timeoutMs,
        idempotencyKey: flags.get("--idempotency-key"),
        capabilities,
        repositoryPath,
      });
      return { exitCode: 0, output: JSON.stringify(submitted) };
    } finally {
      store.close();
    }
  }

  /**
   * emerald router <submit|tick|status|cancel> — one-shot commands over the durable Task Router (Milestone 2.18).
   * No daemon: every command opens the file database, does one bounded piece of work, prints JSON and exits, so each
   * is restart-safe (all state lives in SQLite). `submit` may create the database; the others never do.
   * `tick` requires an explicit --max-concurrent (1 or 2). A busy database exits 2 so a scheduler can retry.
   * Delivery is at-least-once; cancellation records a state change and never asserts a process stopped.
   */
  private handleRouter(args: readonly string[]): { exitCode: number; output: string } {
    const sub = args[0];
    const rest = args.slice(1);
    const usage =
      "Usage: emerald router submit --db <file> --key <submissionKey> (--task <text> | --operation <name>) [--parent-task <taskId>] [--repo <dir>] [--input <json>] [--capabilities <csv>] [--max-attempts <n>] [--timeout-ms <n>] | " +
      "emerald router tick --db <file> --max-concurrent <1|2> | " +
      "emerald router status --db <file> --root <taskId> | " +
      "emerald router cancel --db <file> --root <taskId> [--reason <text>]";
    const fail = (message: string) => ({ exitCode: 1, output: `Error: ${message}. ${usage}` });
    const requireExistingDb = (dbPath: string | undefined) => {
      if (!dbPath) return fail("--db is required");
      if (dbPath === ":memory:" || !fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
        return { exitCode: 1, output: `Error: database not found (router ${sub} never creates one): ${dbPath}` };
      }
      return null;
    };
    const withRouter = <T>(
      dbPath: string,
      cap: 1 | 2,
      op: (router: TaskRouterService, coordinator: RunCoordinator, store: SqliteStateStore) => T
    ): T => {
      const store = new SqliteStateStore({ location: dbPath });
      try {
        const clock = new SystemClock();
        const coordinator = new RunCoordinator(store, clock);
        return op(new TaskRouterService(store, coordinator, clock, { maxConcurrentRuns: cap }), coordinator, store);
      } finally {
        store.close();
      }
    };
    const busy = (err: unknown) =>
      err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message)
        ? { exitCode: 2, output: JSON.stringify({ error: "DATABASE_BUSY", message: err.message, retryable: true }) }
        : null;

    try {
      if (sub === "tick") {
        const parsed = this.parseValueFlags(rest, ["--db", "--max-concurrent"], usage);
        if ("error" in parsed) return parsed.error;
        const cap = parsed.flags.get("--max-concurrent");
        if (cap !== "1" && cap !== "2") return fail("--max-concurrent is required and must be 1 or 2");
        const dbErr = requireExistingDb(parsed.flags.get("--db"));
        if (dbErr) return dbErr;
        const result = withRouter(parsed.flags.get("--db")!, Number(cap) as 1 | 2, (router) => router.dispatchTick());
        return { exitCode: 0, output: JSON.stringify(result) };
      }

      if (sub === "status") {
        const parsed = this.parseValueFlags(rest, ["--db", "--root"], usage);
        if ("error" in parsed) return parsed.error;
        const root = parsed.flags.get("--root");
        if (!root) return fail("--root is required");
        const dbErr = requireExistingDb(parsed.flags.get("--db"));
        if (dbErr) return dbErr;
        const result = withRouter(parsed.flags.get("--db")!, 1, (router) => router.getTaskTreeStatus(root));
        return { exitCode: 0, output: JSON.stringify(result) };
      }

      if (sub === "cancel") {
        const parsed = this.parseValueFlags(rest, ["--db", "--root", "--reason"], usage);
        if ("error" in parsed) return parsed.error;
        const root = parsed.flags.get("--root");
        if (!root) return fail("--root is required");
        const dbErr = requireExistingDb(parsed.flags.get("--db"));
        if (dbErr) return dbErr;
        const result = withRouter(parsed.flags.get("--db")!, 1, (router) =>
          router.cancelTaskTree(root, parsed.flags.get("--reason") ?? "Cancelled via emerald router cancel")
        );
        return { exitCode: 0, output: JSON.stringify(result) };
      }

      if (sub === "submit") {
        const parsed = this.parseValueFlags(
          rest,
          ["--db", "--key", "--operation", "--task", "--parent-task", "--repo", "--input", "--capabilities", "--max-attempts", "--timeout-ms"],
          usage
        );
        if ("error" in parsed) return parsed.error;
        const { flags } = parsed;
        const dbPath = flags.get("--db");
        const key = flags.get("--key");
        const operation = flags.get("--operation");
        const task = flags.get("--task");
        if (!dbPath || dbPath === ":memory:") return fail("--db <file> is required (not :memory:)");
        if (!key || key.trim().length === 0) return fail("--key is required");
        if (!operation && !task) return fail("either --task or --operation is required");
        let repositoryPath: string | undefined;
        if (flags.has("--repo")) {
          if (!task || flags.has("--input")) return fail("--repo requires --task and cannot be combined with --input");
          repositoryPath = path.resolve(flags.get("--repo")!);
          try {
            if (!fs.statSync(repositoryPath).isDirectory()) return fail(`--repo is not a directory: ${repositoryPath}`);
          } catch {
            return fail(`--repo directory not found: ${repositoryPath}`);
          }
        }
        let input: unknown = null;
        if (flags.has("--input")) {
          try {
            input = JSON.parse(flags.get("--input")!);
          } catch {
            return fail("--input must be valid JSON");
          }
        }
        const intFlag = (name: string): number | undefined | "bad" => {
          const raw = flags.get(name);
          if (raw === undefined) return undefined;
          return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : "bad";
        };
        const maxAttempts = intFlag("--max-attempts");
        const timeoutMs = intFlag("--timeout-ms");
        if (maxAttempts === "bad" || timeoutMs === "bad") return fail("--max-attempts and --timeout-ms must be positive integers");
        const capabilities = flags.has("--capabilities")
          ? flags.get("--capabilities")!.split(",").map((c) => c.trim()).filter(Boolean)
          : undefined;
        const parentTaskId = flags.get("--parent-task");

        const result = withRouter(dbPath, 1, (router, coordinator, store) => {
          // The run is created in CREATED (never queued here); the router admits it under its cap.
          const submitted = submitDurableTask(store, coordinator, {
            operation,
            task,
            input,
            maxAttempts,
            timeoutMs,
            idempotencyKey: key,
            capabilities,
            repositoryPath,
            deferQueue: true,
          });
          try {
            const routed = router.submitTask({
              submissionKey: key,
              taskId: submitted.taskId,
              ...(parentTaskId ? { parentTaskId } : {}),
              ...(maxAttempts !== undefined ? { maxAttempts } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            });
            return { taskId: routed.taskId, runId: routed.runId, status: coordinator.getRun(routed.runId)?.status ?? null, duplicate: routed.duplicate };
          } catch (err: unknown) {
            // Topology/conflict rejection: do not leave an unrouted CREATED run behind.
            if (!submitted.deduplicated) {
              try {
                coordinator.cancelRun(submitted.runId, "Router submission rejected");
              } catch {
                // already terminal; nothing further to clean up
              }
            }
            throw err;
          }
        });
        return { exitCode: 0, output: JSON.stringify(result) };
      }

      return { exitCode: 1, output: usage };
    } catch (err: unknown) {
      const b = busy(err);
      if (b) return b;
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, output: `Error: ${msg}` };
    }
  }

  /**
   * emerald worker — the production worker process: claims QUEUED runs from an EXISTING database and executes them through
   * WorkerRuntime (lease renewal, fencing, terminal transitions). Runs until SIGINT/SIGTERM (finishing the in-flight run)
   * unless --once (exit when nothing is queued) or --max-runs. It never creates the database and never performs recovery.
   * Exit codes: 0 clean stop, 1 configuration error or (with --once) a runtime error.
   */
  private async handleWorker(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
    const usage =
      "Usage: emerald worker --db <file> [--once] [--model-provider <fixture|ollama|in-process>] [--model <name>] [--model-timeout-ms <n>] [--ollama-base-url <url>] [--workspace-root <dir>] [--artifact-root <dir>] [--worker-id <id>] [--lease-ttl-ms <n>] [--poll-interval-ms <n>] [--max-runs <n>]";
    const valueFlags = [
      "--db",
      "--workspace-root",
      "--artifact-root",
      "--worker-id",
      "--lease-ttl-ms",
      "--poll-interval-ms",
      "--max-runs",
      "--model-provider",
      "--model",
      "--model-timeout-ms",
      "--ollama-base-url",
    ];
    let once = false;
    const rest: string[] = [];
    for (const a of args) {
      if (a === "--once") {
        if (once) return { exitCode: 1, output: `Error: --once given more than once. ${usage}` };
        once = true;
      } else rest.push(a);
    }
    const parsed = this.parseValueFlags(rest, valueFlags, usage);
    if ("error" in parsed) return parsed.error;
    const { flags } = parsed;
    const dbPath = flags.get("--db");
    if (!dbPath) return { exitCode: 1, output: `Error: --db is required (a worker has no default database). ${usage}` };

    const modelProviderRaw = flags.get("--model-provider");
    if (
      modelProviderRaw !== undefined &&
      !["in-process", "fixture", "ollama"].includes(modelProviderRaw)
    ) {
      return {
        exitCode: 1,
        output: `Error: unsupported --model-provider '${modelProviderRaw}'. Supported: fixture, ollama, in-process`,
      };
    }
    const modelProvider = modelProviderRaw as "in-process" | "fixture" | "ollama" | undefined;

    const intFlag = (name: string): number | undefined | "bad" => {
      const raw = flags.get(name);
      if (raw === undefined) return undefined;
      return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : "bad";
    };
    const leaseTtlMs = intFlag("--lease-ttl-ms");
    const pollIntervalMs = intFlag("--poll-interval-ms");
    const maxRuns = intFlag("--max-runs");
    const modelTimeoutMs = intFlag("--model-timeout-ms");
    if (leaseTtlMs === "bad" || pollIntervalMs === "bad" || maxRuns === "bad" || modelTimeoutMs === "bad") {
      return { exitCode: 1, output: "Error: --lease-ttl-ms, --poll-interval-ms, --max-runs and --model-timeout-ms must be positive integers" };
    }

    const controller = new AbortController();
    const stop = (): void => {
      if (controller.signal.aborted) process.exit(130); // second signal: stop now; the lease expires and recovery takes over
      controller.abort();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const result = await runWorkerHost({
        dbPath,
        workerId: flags.get("--worker-id"),
        workspaceRoot: flags.get("--workspace-root"),
        artifactRoot: flags.get("--artifact-root"),
        leaseTtlMs,
        pollIntervalMs,
        maxRuns,
        once,
        signal: controller.signal,
        modelProvider,
        model: flags.get("--model"),
        modelTimeoutMs,
        ollamaBaseUrl: flags.get("--ollama-base-url"),
      });
      return { exitCode: once && result.errors > 0 ? 1 : 0, output: "" };
    } catch (err: unknown) {
      if (err instanceof WorkerHostConfigError) return { exitCode: 1, output: `Error: ${err.message}` };
      return { exitCode: 1, output: `Error: worker failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }

  /**
   * emerald artifact show — read-only view of the artifact a worker exported for a run: the manifest of changed
   * files (with the run's status when --db is given) or, with --patch, the raw patch. Never modifies anything.
   */
  private handleArtifact(args: readonly string[]): { exitCode: number; output: string } {
    const usage =
      "Usage: emerald artifact show --artifact-root <dir> --run-id <id> [--attempt <n>] [--patch] [--db <file>]";
    if (args[0] !== "show") return { exitCode: 1, output: usage };

    let showPatch = false;
    const rest: string[] = [];
    for (const a of args.slice(1)) {
      if (a === "--patch") {
        if (showPatch) return { exitCode: 1, output: `Error: --patch given more than once. ${usage}` };
        showPatch = true;
      } else rest.push(a);
    }
    const parsed = this.parseValueFlags(rest, ["--artifact-root", "--run-id", "--attempt", "--db"], usage);
    if ("error" in parsed) return parsed.error;
    const { flags } = parsed;
    const root = flags.get("--artifact-root");
    const runId = flags.get("--run-id");
    if (!root || !runId) return { exitCode: 1, output: `Error: --artifact-root and --run-id are required. ${usage}` };
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { exitCode: 1, output: `Error: artifact root not found: ${root}` };
    }

    let attempt: number | undefined;
    if (flags.has("--attempt")) {
      const raw = flags.get("--attempt")!;
      if (!/^\d+$/.test(raw) || Number(raw) < 1) return { exitCode: 1, output: "Error: --attempt must be a positive integer" };
      attempt = Number(raw);
    }

    let runDir: string;
    try {
      runDir = path.dirname(artifactDirectory(root, runId, 1));
    } catch {
      return { exitCode: 1, output: "Error: --run-id is not a valid run id" };
    }
    if (!fs.existsSync(runDir)) return { exitCode: 1, output: `No artifact found for run ${runId}` };

    if (attempt === undefined) {
      const attempts = fs
        .readdirSync(runDir)
        .map((name) => /^attempt-(\d+)$/.exec(name))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
      attempt = attempts[attempts.length - 1];
      if (attempt === undefined) return { exitCode: 1, output: `No artifact found for run ${runId}` };
    }

    const dir = artifactDirectory(root, runId, attempt);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return {
        exitCode: 1,
        output: `No exported artifact for run ${runId} attempt ${attempt} (the run may still be in progress, or its export failed)`,
      };
    }
    if (showPatch) return { exitCode: 0, output: fs.readFileSync(path.join(dir, "patch.diff"), "utf8") };

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    let runStatus: string | null = null;
    const dbPath = flags.get("--db");
    if (dbPath !== undefined) {
      if (dbPath === ":memory:" || !fs.existsSync(dbPath)) {
        return { exitCode: 1, output: `Error: database not found (artifact show never creates one): ${dbPath}` };
      }
      const store = new SqliteStateStore({ location: dbPath });
      try {
        runStatus = new RunCoordinator(store, new SystemClock()).getRun(runId)?.status ?? null;
      } finally {
        store.close();
      }
    }
    return { exitCode: 0, output: JSON.stringify({ runId, attempt, runStatus, manifest }) };
  }

  /** emerald inspect — read-only view of a run and its persisted event history from an EXISTING database file. */
  private handleInspect(args: readonly string[]): { exitCode: number; output: string } {
    const usage = "Usage: emerald inspect --db <file> --run-id <id>";
    const parsed = this.parseValueFlags(args, ["--db", "--run-id"], usage);
    if ("error" in parsed) return parsed.error;
    const dbPath = parsed.flags.get("--db");
    const runId = parsed.flags.get("--run-id");
    if (!dbPath || !runId) return { exitCode: 1, output: `Error: --db and --run-id are required. ${usage}` };
    if (dbPath === ":memory:" || !fs.existsSync(dbPath)) return { exitCode: 1, output: `Error: database not found (inspect never creates one): ${dbPath}` };

    const store = new SqliteStateStore({ location: dbPath });
    try {
      const coordinator = new RunCoordinator(store, new SystemClock());
      const run = coordinator.getRun(runId);
      if (!run) return { exitCode: 1, output: `Run not found: ${runId}` };
      const events = coordinator.getEventsForRun(runId).map((e) => ({
        sequence: e.sequence,
        timestamp: e.timestamp,
        eventType: e.eventType,
        payload: e.payload,
      }));
      return {
        exitCode: 0,
        output: JSON.stringify({
          runId: run.runId,
          taskId: run.taskId,
          status: run.status,
          attemptCount: run.attemptCount,
          workerId: run.currentWorkerId,
          leaseId: run.leaseId,
          leaseExpiresAt: run.leaseExpiresAt,
          result: run.resultPayload,
          error: run.errorPayload,
          events,
        }),
      };
    } finally {
      store.close();
    }
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

  private async handleBenchmarkRun(
    rawArgs?: string | readonly string[],
  ): Promise<{ exitCode: number; output: string }> {
    const rawList = Array.isArray(rawArgs)
      ? rawArgs
      : typeof rawArgs === "string"
        ? [rawArgs]
        : [];

    let taskId: string | undefined;
    let modelName = "qwen2.5-coder:3b";
    let isOffline = false;
    let explicitAdapter: string | undefined;
    let customTempDir: string | undefined;
    let endpoint = "http://127.0.0.1:11434";
    let conditionOverride: BenchmarkCondition | undefined;

    for (let i = 0; i < rawList.length; i++) {
      const arg = rawList[i]!;

      if (arg === "--offline" || arg === "--control-c") {
        isOffline = true;
      } else if (arg === "--model" || arg.startsWith("--model=")) {
        let val: string;
        if (arg === "--model") {
          const next = rawList[i + 1];
          if (!next || next.startsWith("--") || next.trim() === "") {
            return { exitCode: 1, output: "Error: Missing required value for option '--model'." };
          }
          val = rawList[++i]!;
        } else {
          val = arg.slice("--model=".length).trim();
          if (!val) {
            return { exitCode: 1, output: "Error: Missing required value for option '--model'." };
          }
        }
        modelName = val;
      } else if (arg === "--adapter" || arg.startsWith("--adapter=")) {
        let val: string;
        if (arg === "--adapter") {
          const next = rawList[i + 1];
          if (!next || next.startsWith("--") || next.trim() === "") {
            return { exitCode: 1, output: "Error: Missing required value for option '--adapter'." };
          }
          val = rawList[++i]!;
        } else {
          val = arg.slice("--adapter=".length).trim();
          if (!val) {
            return { exitCode: 1, output: "Error: Missing required value for option '--adapter'." };
          }
        }
        const normalized = val.toLowerCase();
        if (!SUPPORTED_BENCHMARK_ADAPTERS.includes(normalized as any) && normalized !== "custom") {
          return {
            exitCode: 1,
            output: `Error: Unsupported adapter '${val}'. Supported adapters: ${SUPPORTED_BENCHMARK_ADAPTERS.map((a) => `'${a}'`).join(", ")}.`,
          };
        }
        explicitAdapter = normalized;
        if (normalized === "offline" || normalized === "human-reference") {
          isOffline = true;
        }
      } else if (arg === "--endpoint" || arg.startsWith("--endpoint=")) {
        let val: string;
        if (arg === "--endpoint") {
          const next = rawList[i + 1];
          if (!next || next.startsWith("--") || next.trim() === "") {
            return { exitCode: 1, output: "Error: Missing required value for option '--endpoint'." };
          }
          val = rawList[++i]!;
        } else {
          val = arg.slice("--endpoint=".length).trim();
          if (!val) {
            return { exitCode: 1, output: "Error: Missing required value for option '--endpoint'." };
          }
        }
        endpoint = val;
      } else if (arg === "--temp-dir" || arg.startsWith("--temp-dir=")) {
        let val: string;
        if (arg === "--temp-dir") {
          const next = rawList[i + 1];
          if (!next || next.startsWith("--") || next.trim() === "") {
            return { exitCode: 1, output: "Error: Missing required value for option '--temp-dir'." };
          }
          val = rawList[++i]!;
        } else {
          val = arg.slice("--temp-dir=".length).trim();
          if (!val) {
            return { exitCode: 1, output: "Error: Missing required value for option '--temp-dir'." };
          }
        }
        customTempDir = val;
      } else if (arg === "--condition" || arg.startsWith("--condition=")) {
        let val: string;
        if (arg === "--condition") {
          const next = rawList[i + 1];
          if (!next || next.startsWith("--") || next.trim() === "") {
            return { exitCode: 1, output: "Error: Missing required value for option '--condition'." };
          }
          val = rawList[++i]!;
        } else {
          val = arg.slice("--condition=".length).trim();
          if (!val) {
            return { exitCode: 1, output: "Error: Missing required value for option '--condition'." };
          }
        }
        if (!SUPPORTED_BENCHMARK_CONDITIONS.includes(val as BenchmarkCondition)) {
          return {
            exitCode: 1,
            output: `Error: Invalid condition '${val}'. Supported conditions: ${SUPPORTED_BENCHMARK_CONDITIONS.join(", ")}.`,
          };
        }
        conditionOverride = val as BenchmarkCondition;
      } else if (!arg.startsWith("-") && !taskId) {
        taskId = arg;
      } else if (arg.startsWith("-")) {
        return { exitCode: 1, output: `Error: Unknown option '${arg}'.` };
      }
    }

    // Validate adapter and condition compatibility
    if (isOffline && conditionOverride && conditionOverride !== "CONTROL_C_HUMAN_REFERENCE") {
      return {
        exitCode: 1,
        output: `Error: Conflict: '--offline' mode cannot be combined with condition '${conditionOverride}'. Offline execution only supports 'CONTROL_C_HUMAN_REFERENCE'.`,
      };
    }

    if (explicitAdapter === "ollama" && isOffline) {
      return {
        exitCode: 1,
        output: `Error: Conflict: Adapter 'ollama' cannot be combined with '--offline' mode.`,
      };
    }

    if (explicitAdapter === "ollama" && conditionOverride === "CONTROL_C_HUMAN_REFERENCE") {
      return {
        exitCode: 1,
        output: `Error: Conflict: Adapter 'ollama' cannot be used with condition 'CONTROL_C_HUMAN_REFERENCE' (human reference baseline).`,
      };
    }

    if (conditionOverride === "CONTROL_C_HUMAN_REFERENCE") {
      isOffline = true;
    }

    const loader = new BenchmarkManifestLoader();
    const manifest = loader.loadManifest();

    if (!taskId) {
      taskId = manifest.tasks[0]?.taskId ?? "swe-easy-001";
    }

    const task = manifest.tasks.find((t) => t.taskId === taskId);
    if (!task) {
      return { exitCode: 1, output: `Task not found: ${taskId}` };
    }

    let condition: BenchmarkCondition;
    let adapter: ModelAdapter;
    let effectiveModelName: string;

    if (this.customModelAdapter) {
      condition = conditionOverride ?? (isOffline ? "CONTROL_C_HUMAN_REFERENCE" : "CONTROL_B_GOVERNED_RUNTIME");
      adapter = this.customModelAdapter;
      effectiveModelName = modelName !== "qwen2.5-coder:3b" ? modelName : "custom-test-adapter";
    } else if (isOffline) {
      condition = "CONTROL_C_HUMAN_REFERENCE";
      effectiveModelName = "human-reference-expert";
      adapter = {
        async proposeAction(): Promise<AgentProposal> {
          return {
            thought: "Offline human reference baseline",
            toolName: "read_file",
            toolInput: { path: task.sourceFile },
          };
        },
      };
    } else {
      // Local Ollama inference
      const probe = await this.probeOllama(endpoint, modelName);
      if (!probe.reachable) {
        return {
          exitCode: 1,
          output: `Error: Local Ollama server is unreachable at ${endpoint}. Please start Ollama or run with '--offline' for offline reference mode.`,
        };
      }
      if (!probe.modelAvailable) {
        const installedList =
          probe.installedModels && probe.installedModels.length > 0
            ? probe.installedModels.join(", ")
            : "none";
        return {
          exitCode: 1,
          output: `Error: Model '${modelName}' is not installed in local Ollama library. Installed models: ${installedList}. Run 'ollama pull ${modelName}' to install it, or specify an installed model with '--model <name>'.`,
        };
      }
      condition = conditionOverride ?? "CONTROL_B_GOVERNED_RUNTIME";
      effectiveModelName = modelName;
      adapter = new OllamaModelAdapter(modelName, endpoint, 60000, false);
    }

    const runner = new BenchmarkRunner(loader);
    const tempBaseDir = customTempDir ?? os.tmpdir();

    try {
      const result = await runner.runTrial(
        task,
        condition,
        adapter,
        effectiveModelName,
        tempBaseDir,
      );

      const lines = [
        `Benchmark Trial Results:`,
        `========================`,
        `Task ID:                 ${result.taskId}`,
        `Condition:               ${result.condition}`,
        `Model / Adapter:         ${result.modelName}`,
        `Classification:          ${result.classification}`,
        `Sovereign Verification:  ${result.verified ? "PASSED" : "FAILED"}`,
        `Verification Proof:      ${result.verificationProofHash ?? "None"}`,
        `Evidence Bundle Digest:  ${result.evidenceBundleDigest ?? "None"}`,
        `Deterministic Replay:    ${result.replayVerified ? "VERIFIED (3 sweeps)" : "FAILED"}`,
        `Changed Files:           ${result.metrics.filesWritten} (${result.metrics.linesAdded} lines added, ${result.metrics.linesRemoved} lines removed)`,
        `Total Latency:           ${result.metrics.runtimeMs}ms`,
      ];

      if (result.failureReason) {
        lines.push(`Failure Reason:          ${result.failureReason}`);
      }

      lines.push(``, `Reviewable Git Diff:`, `--------------------`);
      if (result.gitDiff && result.gitDiff.trim().length > 0) {
        lines.push(result.gitDiff.trim());
      } else {
        lines.push(`(No files modified)`);
      }

      const isSuccess =
        result.classification === "SOVEREIGN_VERIFIED_SUCCESS" && result.verified;
      const exitCode = isSuccess ? 0 : 1;

      return { exitCode, output: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, output: `Benchmark trial failed with error: ${msg}` };
    }
  }

  private async probeOllama(
    endpoint: string,
    modelName: string,
  ): Promise<{ reachable: boolean; modelAvailable: boolean; installedModels?: string[] }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { reachable: false, modelAvailable: false };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const installed = (data.models || []).map((m) => m.name);

      const targetPrefix = modelName.split(":")[0]?.toLowerCase() || "";
      const isAvailable = installed.some((name) => {
        const lower = name.toLowerCase();
        const modelLower = modelName.toLowerCase();
        return (
          lower === modelLower ||
          lower.startsWith(`${modelLower}:`) ||
          lower === `${modelLower}:latest` ||
          (targetPrefix.length > 0 && lower.split(":")[0] === targetPrefix)
        );
      });

      return {
        reachable: true,
        modelAvailable: isAvailable,
        installedModels: installed,
      };
    } catch {
      return { reachable: false, modelAvailable: false };
    }
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
  emerald router submit|tick|status|cancel --db <file> ...
                                         One-shot durable Task Router commands (tick needs --max-concurrent 1|2)
  emerald diff <runId>                   Show working-tree changes produced by run
  emerald verify <runId>                 Show sovereign verification proof
  emerald evidence <runId>               Export full cryptographic evidence bundle
  emerald replay <runId>                 Reconstruct run history deterministically
  emerald submit --db <file> (--task <text> | --operation <name>) [--input <json>] [--capabilities <csv>]
                                         Durably submit a task or operation (creates the SQLite file)
  emerald inspect --db <file> --run-id <id>
                                         Show a durable run and its event history (read-only)
  emerald worker --db <file> [--once] [--model-provider <fixture|ollama|in-process>] [--model <name>] [--ollama-base-url <url>] [--workspace-root <dir>] [--lease-ttl-ms <n>]
                                         Claim and execute queued runs from an existing database
                                         (modes: in-process, fixture, ollama; Ctrl+C finishes the in-flight run)
  emerald recovery status --db <file> [--run-id <id>] [--json]
                                         Show read-only tenant launch-gate diagnostic status (8 fields only)
  emerald recovery sweep --db <file> --workers-stopped [--workspace-root <dir>]
                                         Run one crash-recovery sweep (exit 0 clean, 2 needs operator)
  emerald recovery watch --db <file> --workers-stopped [--workspace-root <dir>] [--interval-ms <n>]
                                         Run crash recovery continuously until Ctrl+C
                                         Only for SQLite databases written by the RunCoordinator (not the
                                         in-memory 'emerald run' state). Stop all workers first: worker
                                         leases are not renewed, so a live long-running worker would be
                                         treated as crashed. The database and --workspace-root must exist.

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
