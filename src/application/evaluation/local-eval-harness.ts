/**
 * Phase 6.4 — Local Evaluation Harness for Emerald Agent Fabric.
 *
 * Implements a minimal, reproducible, typed evaluation runner that tests
 * end-to-end governed agent execution with a local open-source model.
 *
 * Execution Pipeline:
 * ContextEngine -> LiveAgentBrain -> ModelProviderPort -> UNTRUSTED ActionProposal
 *   -> ProposalValidator -> Capability Policy -> WorkerRuntime -> ToolExecutionGateway -> Workspace
 *
 * Principles:
 * 1. Zero Commercial Dependencies: ₹0 cost, zero API keys, zero cloud models.
 * 2. Pure Least Privilege: Contracts authorize only explicitly required capabilities.
 * 3. Exact Metric Accounting: Measures wall-clock time, model calls, tool calls,
 *    latencies, and token counts (only when supplied by the model provider, never fabricated).
 * 4. Deterministic Verification: Verifies resulting workspace state deterministically.
 * 5. Complete Workspace Isolation: Operates inside temporary directories and cleans up reliably.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../../adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  StepControllerBudget,
  StepControllerResult,
  StepControllerTerminalReason,
  StepTranscriptEntry,
} from "../agent-step-controller.js";
import { LiveAgentBrain } from "../live-agent-brain.js";
import { RunCoordinator } from "../run-coordinator.js";
import { WorkerRuntime } from "../worker-runtime.js";
import {
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  ToolName,
} from "../../domain/index.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../ports/model-provider.port.js";
import { SettableClock } from "../../ports/clock.port.js";

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export interface LocalEvalTaskDefinition {
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly initialFiles?: Readonly<Record<string, string>>;
  readonly expectedFiles?: Readonly<Record<string, string | ((content: string) => boolean)>>;
  readonly customVerify?: (workspaceRoot: string) => Promise<{ success: boolean; details?: string }>;
}

export interface LocalEvalEvidenceRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly stepNumber: number;
  readonly contextSnapshotHash: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly actionId?: string;
  readonly toolName?: ToolName;
  readonly durationMs: number;
  readonly result: "ACCEPTED" | "REJECTED" | "EXECUTED" | "EXECUTION_FAILED" | "NO_ACTION" | "GOAL_REACHED";
  readonly error?: string;
}

export interface LocalEvalMetrics {
  readonly taskSuccess: boolean;
  readonly proposalAcceptanceRate: number;
  readonly proposalRejectionCount: number;
  readonly stepsUsed: number;
  readonly actionsUsed: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly executionFailures: number;
  readonly modelFailures: number;
  readonly totalWallClockMs: number;
  readonly modelLatencyMs: number;
  readonly toolLatencyMs: number;
  readonly verificationResult: {
    readonly success: boolean;
    readonly details?: string;
  };
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface LocalEvalRunResult {
  readonly taskId: string;
  readonly runId: string;
  readonly terminalReason: StepControllerTerminalReason;
  readonly terminalMessage: string;
  readonly metrics: LocalEvalMetrics;
  readonly evidence: readonly LocalEvalEvidenceRecord[];
  readonly transcript: readonly StepTranscriptEntry[];
}

export interface ExecuteLocalEvaluationOptions {
  readonly task: LocalEvalTaskDefinition;
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly allowedCapabilities?: readonly string[];
  readonly budget?: Partial<StepControllerBudget>;
  readonly abortSignal?: AbortSignal;
}

// ============================================================================
// 2. Metrics Tracking Model Provider Wrapper
// ============================================================================

class MetricsTrackingModelProvider implements ModelProviderPort {
  readonly providerName: string;
  calls = 0;
  failures = 0;
  totalLatencyMs = 0;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;

  constructor(private readonly inner: ModelProviderPort) {
    this.providerName = inner.providerName;
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls++;
    const start = Date.now();
    try {
      const response = await this.inner.generate(request);
      this.totalLatencyMs += (Date.now() - start);
      if (response.usage) {
        if (typeof response.usage.inputTokens === "number") {
          this.promptTokens = (this.promptTokens ?? 0) + response.usage.inputTokens;
        }
        if (typeof response.usage.outputTokens === "number") {
          this.outputTokens = (this.outputTokens ?? 0) + response.usage.outputTokens;
        }
        if (typeof response.usage.totalTokens === "number") {
          this.totalTokens = (this.totalTokens ?? 0) + response.usage.totalTokens;
        }
      }
      return response;
    } catch (err) {
      this.failures++;
      this.totalLatencyMs += (Date.now() - start);
      throw err;
    }
  }
}

// ============================================================================
// 3. Evaluation Runner
// ============================================================================

export async function executeLocalEvaluationRun(
  options: ExecuteLocalEvaluationOptions
): Promise<LocalEvalRunResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-eval-ws-"));
  const store = new SqliteStateStore();
  const clock = new SettableClock(new Date());
  const workspaceAdapter = new NodeFsWorkspaceAdapter({ workspaceRoot: tempDir });
  const coordinator = new RunCoordinator(store, clock);
  const workerId = `eval-worker-${Date.now()}`;

  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort: workspaceAdapter,
  });

  const trackingProvider = new MetricsTrackingModelProvider(options.modelProvider);
  const liveBrain = new LiveAgentBrain({
    modelProvider: trackingProvider,
    model: options.model,
  });

  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: liveBrain,
    clock,
    // Evaluation harness contract declares no verification specs; explicit opt-in keeps its legacy behaviour.
    // NOTE: taskSuccess here therefore means 'model claimed completion', not 'verified' (see 2.23 docs).
    allowUnverifiedCompletion: true,
  });

  let wsHandle: any;

  try {
    const task = coordinator.createTask({
      title: options.task.title,
      description: options.task.description,
      inputPayload: { evalTaskId: options.task.taskId },
    });

    const allowedCaps = options.allowedCapabilities ?? [
      "workspace.file.read",
      "workspace.file.write",
    ];

    const policy = createExecutionPolicy({
      policyId: `eval-policy-${task.taskId}`,
      allowedCapabilities: allowedCaps,
      isolationRequirement: "ISOLATED",
    });

    const contract = createMissionContract({
      contractId: `eval-contract-${task.taskId}`,
      version: 1,
      taskId: task.taskId,
      policy,
      verificationSpecs: [],
      resourceLimits: createResourceLimits({
        timeoutMs: 60000,
        maxAttempts: 3,
        maxOutputBytes: 1048576,
      }),
      credentialScopes: ["workspace:scope"],
    });

    store.insertContract(contract);
    store.activateContract(contract.spec.contractId, contract.spec.version);

    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: task.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, 300000);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-${task.taskId}`,
      runId: run.runId,
      taskId: task.taskId,
      maxWorkspaceBytes: 10 * 1024 * 1024,
      maxFileSizeBytes: 1024 * 1024,
    });

    if (options.task.initialFiles) {
      for (const [relPath, content] of Object.entries(options.task.initialFiles)) {
        const fullPath = await workspaceAdapter.resolvePath(wsHandle.workspaceId, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf8");
      }
    }

    const stepResult: StepControllerResult = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: claimResult.lease.leaseId,
      workspace: wsHandle,
      budget: options.budget,
      abortSignal: options.abortSignal,
    });

    // Verification
    let verificationResult: { success: boolean; details?: string } = { success: true };
    if (options.task.expectedFiles) {
      for (const [relPath, expected] of Object.entries(options.task.expectedFiles)) {
        const fullPath = await workspaceAdapter.resolvePath(wsHandle.workspaceId, relPath);
        if (!fs.existsSync(fullPath)) {
          verificationResult = {
            success: false,
            details: `Expected file '${relPath}' was not found in workspace`,
          };
          break;
        }
        const content = fs.readFileSync(fullPath, "utf8");
        if (typeof expected === "string") {
          if (content.trim() !== expected.trim()) {
            verificationResult = {
              success: false,
              details: `Content mismatch in '${relPath}'. Expected '${expected}', received '${content}'`,
            };
            break;
          }
        } else if (typeof expected === "function") {
          if (!expected(content)) {
            verificationResult = {
              success: false,
              details: `Content assertion failed for '${relPath}'`,
            };
            break;
          }
        }
      }
    }

    if (verificationResult.success && options.task.customVerify) {
      const wsRoot = await workspaceAdapter.resolvePath(wsHandle.workspaceId, ".");
      verificationResult = await options.task.customVerify(wsRoot);
    }

    const taskSuccess =
      verificationResult.success &&
      (stepResult.terminalReason === "COMPLETED" || stepResult.terminalReason === "NO_ACTION");

    const evidence: LocalEvalEvidenceRecord[] = stepResult.transcript.map((entry) => {
      let resultType: LocalEvalEvidenceRecord["result"] = "NO_ACTION";
      if (entry.finishReason === "GOAL_REACHED") {
        resultType = "GOAL_REACHED";
      } else if (entry.actionId) {
        resultType = entry.actionStatus === "SUCCEEDED" ? "EXECUTED" : "EXECUTION_FAILED";
      } else if (entry.proposalValid === false || entry.proposalRejectionReason) {
        resultType = "REJECTED";
      } else if (entry.proposalValid === true && entry.proposalId) {
        resultType = "ACCEPTED";
      }

      return {
        runId: stepResult.runId,
        taskId: stepResult.taskId,
        stepNumber: entry.stepNumber,
        contextSnapshotHash: entry.contextHash,
        modelProvider: options.modelProvider.providerName,
        model: options.model,
        actionId: entry.actionId,
        toolName: entry.toolName,
        durationMs: entry.durationMs,
        result: resultType,
        error: entry.actionError ? String(entry.actionError) : entry.proposalRejectionMessage,
      };
    });

    const totalProposals = stepResult.transcript.filter((e) => e.proposalId !== undefined).length;
    const acceptedProposals = stepResult.transcript.filter(
      (e) => e.proposalValid && e.proposalId !== undefined
    ).length;
    const proposalAcceptanceRate =
      totalProposals > 0 ? acceptedProposals / totalProposals : taskSuccess ? 1.0 : 0.0;

    const toolLatency = stepResult.transcript.reduce(
      (acc, e) => acc + (e.actionStatus ? e.durationMs : 0),
      0
    );

    const metrics: LocalEvalMetrics = {
      taskSuccess,
      proposalAcceptanceRate,
      proposalRejectionCount: stepResult.totalProposalRejections,
      stepsUsed: stepResult.totalSteps,
      actionsUsed: stepResult.totalActions,
      modelCalls: trackingProvider.calls,
      toolCalls: stepResult.totalActions,
      executionFailures: stepResult.transcript.filter((e) => e.actionStatus === "FAILED").length,
      modelFailures: trackingProvider.failures,
      totalWallClockMs: stepResult.totalWallClockMs,
      modelLatencyMs: trackingProvider.totalLatencyMs,
      toolLatencyMs: toolLatency,
      verificationResult,
      promptTokens: trackingProvider.promptTokens,
      outputTokens: trackingProvider.outputTokens,
      totalTokens: trackingProvider.totalTokens,
    };

    return {
      taskId: stepResult.taskId,
      runId: stepResult.runId,
      terminalReason: stepResult.terminalReason,
      terminalMessage: stepResult.terminalMessage,
      metrics,
      evidence,
      transcript: stepResult.transcript,
    };
  } finally {
    if (wsHandle) {
      try {
        await workspaceAdapter.disposeWorkspace(wsHandle.workspaceId);
      } catch {
        // Best effort
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
}
