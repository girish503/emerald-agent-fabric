/**
 * Worker host: the process-level shell around WorkerRuntime (`emerald worker`).
 *
 * It owns ONLY process concerns - opening the explicitly named database, the claim loop, structured logging and
 * shutdown. Claiming, lease fencing/renewal, execution, timeouts, terminal transitions and workspace handling all stay in
 * WorkerRuntime / RunCoordinator; recovery stays with `emerald recovery` (a worker never recovers other workers' runs).
 *
 * Shutdown: the first abort stops claiming NEW runs and lets the in-flight run finish (WorkerRuntime has no way to abort
 * a provider). A host that must stop immediately simply dies; the run's lease then expires and recovery takes over.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../adapters/persistence/sqlite-state-store.js";
import { InProcessExecutionProvider } from "../adapters/execution/in-process-execution-provider.js";
import { GovernedAgentExecutionProvider } from "../adapters/execution/governed-agent-execution-provider.js";
import { OllamaModelProvider } from "../adapters/models/ollama-model-provider.js";
import { NodeFsWorkspaceAdapter } from "../adapters/workspace/node-fs-workspace-adapter.js";
import { NodeFsRepositoryImporter } from "../adapters/workspace/node-fs-repository-importer.js";
import { GitArtifactExporter, assertGitAvailable } from "../adapters/workspace/git-artifact-exporter.js";
import { SlowOperation, DeterministicOperation, EchoOperation, SumOperation } from "../domain/operation.js";
import { ModelRequestCancelledError, ModelRequestTimeoutError } from "../domain/errors.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../ports/model-provider.port.js";
import { AgentBrainPort } from "../ports/agent-brain.port.js";
import { SystemClock } from "../ports/clock.port.js";
import { AgentStepController } from "./agent-step-controller.js";
import { LiveAgentBrain } from "./live-agent-brain.js";
import { RunCoordinator } from "./run-coordinator.js";
import { WorkerRuntime } from "./worker-runtime.js";

export class WorkerHostConfigError extends Error {}

export interface WorkerLogRecord {
  readonly ts: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface WorkerHostOptions {
  /** Existing SQLite file. A worker never creates or defaults a database. */
  readonly dbPath: string;
  readonly workerId?: string;
  /** Existing directory for per-run workspaces; without it runs execute with no workspace. */
  readonly workspaceRoot?: string;
  /**
   * Existing directory that receives each run's artifact (patch + manifest) before its workspace is
   * disposed. It must not overlap the workspace root. Requires git. Without it nothing is preserved.
   */
  readonly artifactRoot?: string;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
  /** Exit when no run is queued instead of polling. */
  readonly once?: boolean;
  /** Exit after this many claimed runs. */
  readonly maxRuns?: number;
  readonly signal: AbortSignal;
  readonly log?: (record: WorkerLogRecord) => void;
  /**
   * Model provider selection for governed agent execution:
   * - "in-process": deterministic built-in operations (echo, sum, slow) via InProcessExecutionProvider (default).
   * - "fixture": 100% offline, deterministic fixture model via GovernedAgentExecutionProvider.
   * - "ollama": live local open-weight model execution via OllamaModelProvider.
   */
  readonly modelProvider?: "in-process" | "fixture" | "ollama";
  /** Local model identifier (e.g. "llama3.2" for ollama, or custom fixture name). */
  readonly model?: string;
  /** Custom Ollama base URL (defaults to http://127.0.0.1:11434). */
  readonly ollamaBaseUrl?: string;
  /** Inference timeout limit in ms for the model provider (defaults to 120000 ms for ollama). */
  readonly modelTimeoutMs?: number;
  /** Optional custom AgentBrainPort for testing or direct dependency injection. */
  readonly agentBrain?: AgentBrainPort;
}

export interface WorkerHostResult {
  readonly workerId: string;
  readonly runsProcessed: number;
  readonly errors: number;
}

/** The deterministic operations a stock worker can execute. */
export const BUILT_IN_OPERATIONS: readonly DeterministicOperation[] = [new EchoOperation(), new SumOperation(), new SlowOperation()];

const defaultLog = (record: WorkerLogRecord): void => {
  process.stdout.write(JSON.stringify(record) + "\n");
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 100% offline deterministic fixture model provider.
 * Requires zero network access, zero daemon processes, and zero model downloads.
 */
export class DeterministicFixtureModelProvider implements ModelProviderPort {
  readonly providerName = "fixture";
  readonly model: string;
  private callCount = 0;

  constructor(model: string = "fixture-agent") {
    this.model = model;
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    if (request.abortSignal?.aborted) {
      throw new ModelRequestCancelledError("Fixture model request was cancelled by signal");
    }
    if (request.timeoutMs <= 0) {
      throw new ModelRequestTimeoutError("Fixture model request exceeded timeout limit");
    }

    this.callCount++;

    const promptText = (request.input ?? []).map((m) => m.content).join("\n");
    const userMsg = request.input?.find((m) => m.role === "user");
    const userContent = userMsg?.content ?? "";

    // Negative testing hook: deliberate fail-closed invalid tool proposal
    if (
      promptText.includes("fail-closed") ||
      promptText.includes("invalid tool") ||
      promptText.includes("invalid_tool")
    ) {
      return {
        requestId: request.requestId,
        model: this.model,
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "non_existent_unregistered_tool",
          inputPayload: { invalid: true },
          rationale: "Deliberately proposing an invalid tool for testing",
        }),
        finishReason: "STOP",
        durationMs: 5,
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      };
    }

    // Identify target file from task objective if specified
    const objectiveMatch = userContent.match(/### Task Objective & Criteria\s*\n([^\n]+)/);
    const taskObjective = objectiveMatch?.[1] ?? userContent;

    // Check if read_file observation is already present in context observations
    const hasReadObservation =
      userContent.includes("read_file") &&
      (userContent.includes("FILE_CONTENT") ||
        userContent.includes("TOOL_OUTPUT") ||
        userContent.includes("File Content:") ||
        userContent.includes("Observation (TOOL_OUTPUT)"));

    const fileMatch =
      taskObjective.match(/(?:read|inspect|file)\s+([a-zA-Z0-9_\-./\\]+)/i) ??
      taskObjective.match(/\b([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\b/);
    const targetFile = fileMatch ? fileMatch[1] : undefined;

    if (targetFile && !hasReadObservation) {
      return {
        requestId: request.requestId,
        model: this.model,
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "read_file",
          inputPayload: { path: targetFile },
          rationale: `Reading ${targetFile} to complete task inspection`,
        }),
        finishReason: "STOP",
        durationMs: 10,
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      };
    }

    // Support read-only code search workflow
    const hasSearchObservation =
      userContent.includes("search_code") &&
      (userContent.includes("matches") ||
        userContent.includes("TOOL_OUTPUT") ||
        userContent.includes("Observation (TOOL_OUTPUT)"));

    const isSearchTask = taskObjective.toLowerCase().includes("search");
    if (isSearchTask && !hasSearchObservation) {
      const patternMatch = taskObjective.match(/pattern\s+([a-zA-Z0-9_\-]+)/i);
      const query = patternMatch ? patternMatch[1] : "emerald";
      return {
        requestId: request.requestId,
        model: this.model,
        outputText: JSON.stringify({
          isGoalReached: false,
          toolName: "search_code",
          inputPayload: { query },
          rationale: `Searching workspace for query '${query}'`,
        }),
        finishReason: "STOP",
        durationMs: 10,
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      };
    }

    return {
      requestId: request.requestId,
      model: this.model,
      outputText: JSON.stringify({
        isGoalReached: true,
        rationale: "Task objective satisfied and verified",
      }),
      finishReason: "STOP",
      durationMs: 10,
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
    };
  }
}

export async function runWorkerHost(options: WorkerHostOptions): Promise<WorkerHostResult> {
  if (!options.dbPath || options.dbPath === ":memory:") {
    throw new WorkerHostConfigError("dbPath must be the path of an existing database file");
  }
  if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) {
    throw new WorkerHostConfigError(`Database not found (a worker never creates one; use 'emerald submit' first): ${options.dbPath}`);
  }
  if (options.workspaceRoot !== undefined && (!fs.existsSync(options.workspaceRoot) || !fs.statSync(options.workspaceRoot).isDirectory())) {
    throw new WorkerHostConfigError(`workspaceRoot must be an existing directory (it is never created): ${options.workspaceRoot}`);
  }
  if (options.artifactRoot !== undefined) {
    if (!fs.existsSync(options.artifactRoot) || !fs.statSync(options.artifactRoot).isDirectory()) {
      throw new WorkerHostConfigError(`artifactRoot must be an existing directory (it is never created): ${options.artifactRoot}`);
    }
    if (options.workspaceRoot === undefined) {
      throw new WorkerHostConfigError("artifactRoot requires workspaceRoot: artifacts are exported from run workspaces");
    }
    const artifactReal = fs.realpathSync(options.artifactRoot);
    const workspaceReal = fs.realpathSync(options.workspaceRoot);
    const within = (parent: string, child: string): boolean => {
      const rel = path.relative(parent, child);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (within(workspaceReal, artifactReal) || within(artifactReal, workspaceReal)) {
      throw new WorkerHostConfigError("artifactRoot and workspaceRoot must not contain one another");
    }
    try {
      assertGitAvailable();
    } catch (err: unknown) {
      throw new WorkerHostConfigError(err instanceof Error ? err.message : String(err));
    }
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 3_600_000) {
    throw new WorkerHostConfigError("pollIntervalMs must be an integer between 10 and 3600000");
  }
  if (options.maxRuns !== undefined && (!Number.isInteger(options.maxRuns) || options.maxRuns < 1)) {
    throw new WorkerHostConfigError("maxRuns must be a positive integer");
  }
  if (
    options.modelProvider !== undefined &&
    !["in-process", "fixture", "ollama"].includes(options.modelProvider)
  ) {
    throw new WorkerHostConfigError(
      `Unsupported model provider: '${options.modelProvider}'. Supported: in-process, fixture, ollama`
    );
  }

  const log = options.log ?? defaultLog;
  const stamp = (event: string, extra: Record<string, unknown> = {}): WorkerLogRecord => ({ ts: new Date().toISOString(), event, ...extra });
  const workerId = options.workerId ?? `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  const clock = new SystemClock();
  const store = new SqliteStateStore({ location: options.dbPath });
  try {
    let workspace: NodeFsWorkspaceAdapter | undefined;
    if (options.workspaceRoot) {
      try {
        workspace = new NodeFsWorkspaceAdapter({ workspaceRoot: options.workspaceRoot });
      } catch (err: unknown) {
        throw new WorkerHostConfigError(`Invalid workspaceRoot: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const coordinator = new RunCoordinator(store, clock, undefined, workspace);
    let runtime: WorkerRuntime;

    try {
      if (options.modelProvider === "fixture" || options.modelProvider === "ollama") {
        let brain: AgentBrainPort;
        if (options.agentBrain) {
          brain = options.agentBrain;
        } else if (options.modelProvider === "ollama") {
          const ollama = new OllamaModelProvider({
            baseURL: options.ollamaBaseUrl,
            defaultModel: options.model,
          });
          brain = new LiveAgentBrain({
            modelProvider: ollama,
            model: options.model ?? "llama3.2",
            timeoutMs: options.modelTimeoutMs ?? 120000,
            enableDynamicToolFiltering: true,
            clock,
          });
        } else {
          const fixtureModel = new DeterministicFixtureModelProvider(options.model ?? "fixture-agent");
          brain = new LiveAgentBrain({
            modelProvider: fixtureModel,
            model: options.model ?? "fixture-agent",
            clock,
          });
        }

        const governedProvider = new GovernedAgentExecutionProvider({
          clock,
        });

        runtime = new WorkerRuntime({
          workerId,
          hostname: os.hostname(),
          pid: process.pid,
          coordinator,
          clock,
          leaseTtlMs: options.leaseTtlMs,
          workspacePort: workspace,
          executionProvider: governedProvider,
          repositoryImporter: new NodeFsRepositoryImporter(),
          ...(options.artifactRoot ? { artifactExporter: new GitArtifactExporter({ artifactRoot: options.artifactRoot }) } : {}),
        });

        const stepController = new AgentStepController({
          coordinator,
          stateStore: store,
          workerRuntime: runtime,
          agentBrain: brain,
          clock,
        });

        governedProvider.setStepController(stepController);
      } else {
        const executionProvider = new InProcessExecutionProvider(BUILT_IN_OPERATIONS);
        runtime = new WorkerRuntime({
          workerId,
          hostname: os.hostname(),
          pid: process.pid,
          coordinator,
          clock,
          leaseTtlMs: options.leaseTtlMs,
          workspacePort: workspace,
          executionProvider,
          repositoryImporter: new NodeFsRepositoryImporter(),
          ...(options.artifactRoot ? { artifactExporter: new GitArtifactExporter({ artifactRoot: options.artifactRoot }) } : {}),
        });
      }
    } catch (err: unknown) {
      throw new WorkerHostConfigError(`Invalid worker configuration: ${err instanceof Error ? err.message : String(err)}`);
    }

    log(
      stamp("worker.started", {
        workerId,
        dbPath: options.dbPath,
        once: options.once ?? false,
        workspaceRoot: options.workspaceRoot ?? null,
        modelProvider: options.modelProvider ?? "in-process",
        model: options.model ?? null,
      })
    );
    let runsProcessed = 0;
    let errors = 0;
    // A ref'd timer keeps the process alive while idle-polling is awaiting only an abort signal.
    const keepAlive = setInterval(() => {}, 2_147_483_647);
    try {
      while (!options.signal.aborted) {
        let result;
        try {
          result = await runtime.runOnce();
        } catch (err: unknown) {
          errors++;
          log(stamp("worker.error", { workerId, error: err instanceof Error ? err.message : String(err) }));
          if (options.once) break;
          await abortableSleep(pollIntervalMs, options.signal);
          continue;
        }
        if (result.status === "IDLE") {
          if (options.once) break;
          await abortableSleep(pollIntervalMs, options.signal);
          continue;
        }
        runsProcessed++;
        log(stamp("worker.run.finished", { workerId, runId: result.runId, status: result.status }));
        if (options.maxRuns !== undefined && runsProcessed >= options.maxRuns) break;
      }
    } finally {
      clearInterval(keepAlive);
      log(stamp("worker.stopped", { workerId, runsProcessed, errors }));
    }
    return { workerId, runsProcessed, errors };
  } finally {
    store.close();
  }
}
