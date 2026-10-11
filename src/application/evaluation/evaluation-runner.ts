/**
 * Phase 7.1 — Evaluation Runner for Emerald Agent Fabric.
 *
 * Implements the application-layer evaluation runner executing reproducible
 * EvaluationTaskDefinition specifications against the governed Emerald runtime:
 *
 * EvaluationTaskDefinition
 *         ↓
 * EvaluationRunner
 *         ↓
 * AgentStepController
 *         ↓
 * Authoritative Emerald Governance (MissionContract, Policy, Gateway, Workspace)
 *         ↓
 * Runtime Run (SQLite Durable State)
 *         ↓
 * EvaluationRunResult
 *
 * Principles:
 * 1. Zero Model/Provider Bias: The runner accepts any ModelProviderPort and treats model output as untrusted.
 * 2. Governance Supremacy: Evaluation tasks declare required capabilities, but cannot bypass
 *    MissionContracts, PolicyEvaluators, ProposalValidators, or Workspace boundaries.
 * 3. Objective Truth: Success is decided exclusively by evaluating EvaluationCriteria against physical workspace
 *    evidence. Agent self-claims ("isGoalReached: true") are strictly recorded, but do not dictate success.
 * 4. Deterministic Fingerprinting: Every result embeds canonical taskContentHash and configFingerprint.
 * 5. Strict Metric Semantics: Preserves observed zeros vs undefined token metrics without fabrication.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteStateStore } from "../../adapters/persistence/sqlite-state-store.js";
import { NodeFsWorkspaceAdapter } from "../../adapters/workspace/node-fs-workspace-adapter.js";
import {
  AgentStepController,
  StepControllerResult,
} from "../agent-step-controller.js";
import { LiveAgentBrain } from "../live-agent-brain.js";
import { RunCoordinator } from "../run-coordinator.js";
import { WorkerRuntime } from "../worker-runtime.js";
import {
  computeEvaluationTaskHash,
  createEvaluationConfigFingerprint,
  createEvaluationMetrics,
  createEvaluationTrialFromRunResult,
  createExecutionPolicy,
  createMissionContract,
  createResourceLimits,
  evaluateObjectiveCriteria,
  EvaluationConfigFingerprint,
  EvaluationMetrics,
  EvaluationRunResult,
  EvaluationStatus,
  EvaluationTaskDefinition,
  EvaluationTrial,
  validateEvaluationTask,
  CriteriaReader,
  CURRENT_HARNESS_VERSION,
  MAX_TRIAL_ORDINAL,
  assertExecutionModeSupported,
  EvaluationExecutionMode,
  isValidEvaluationExecutionMode,
  EvaluationExperimentCondition,
  ReflexEvidence,
} from "../../domain/index.js";
import {
  ModelProviderPort,
  ModelProviderRequest,
  ModelProviderResponse,
} from "../../ports/model-provider.port.js";
import { SettableClock } from "../../ports/clock.port.js";
import type { ReflexPort } from "../../ports/reflex.port.js";
import {
  type RuleBasedReflexConfig,
  computeRuleBasedReflexConfigHash,
} from "../../domain/reflex.js";
import { RuleBasedReflex } from "../../adapters/reflex/rule-based-reflex.js";

// ============================================================================
// 1. Runner Options
// ============================================================================

export interface ExecuteEvaluationRunOptions {
  readonly task: EvaluationTaskDefinition;
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly trialNumber?: number;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
  readonly executionMode?: EvaluationExecutionMode;
  readonly condition?: EvaluationExperimentCondition;
  readonly reflex?: ReflexPort;
  readonly ruleBasedReflexConfig?: RuleBasedReflexConfig;
  readonly modelTimeoutMs?: number;
}

export interface ExecuteEvaluationTrialOptions {
  readonly task: EvaluationTaskDefinition;
  readonly modelProvider: ModelProviderPort;
  readonly model: string;
  readonly trialOrdinal: number;
  readonly trialId?: string;
  readonly harnessVersion?: string;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
  readonly executionMode?: EvaluationExecutionMode;
  readonly condition?: EvaluationExperimentCondition;
  readonly reflex?: ReflexPort;
  readonly ruleBasedReflexConfig?: RuleBasedReflexConfig;
  readonly modelTimeoutMs?: number;
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
      this.totalLatencyMs += Date.now() - start;
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
      this.totalLatencyMs += Date.now() - start;
      throw err;
    }
  }
}

// ============================================================================
// 3. Evaluation Runner Implementation
// ============================================================================

export async function executeEvaluationRun(
  options: ExecuteEvaluationRunOptions
): Promise<EvaluationRunResult> {
  // 0. Preflight execution mode check
  const executionMode: EvaluationExecutionMode =
    options.executionMode ?? options.condition?.executionMode ?? "BASELINE";

  if (!isValidEvaluationExecutionMode(executionMode)) {
    throw new Error(`Invalid evaluation execution mode: '${executionMode}'`);
  }

  const reflexConfigured = Boolean(options.reflex || options.ruleBasedReflexConfig);
  assertExecutionModeSupported(executionMode, { reflexConfigured });

  // 1. Validate task specification
  const validatedTask = validateEvaluationTask(options.task);
  const taskContentHash = computeEvaluationTaskHash(validatedTask);

  // 2. Build configuration fingerprint
  const trialNumber = options.trialNumber ?? 1;
  const harnessVersion = options.harnessVersion ?? CURRENT_HARNESS_VERSION;
  const configFingerprint: EvaluationConfigFingerprint = createEvaluationConfigFingerprint({
    modelProvider: options.modelProvider.providerName,
    model: options.model,
    taskVersion: validatedTask.version,
    harnessVersion,
    generationConfig: options.generationConfig,
  });

  const evaluationRunId = `eval-run-${validatedTask.taskId}-v${validatedTask.version}-t${trialNumber}-${Date.now()}`;
  const startedAt = new Date().toISOString();

  // 3. Setup ephemeral execution environment
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-eval-task-ws-"));
  const store = new SqliteStateStore();
  const clock = new SettableClock(new Date(startedAt));
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
    ...(options.modelTimeoutMs !== undefined ? { timeoutMs: options.modelTimeoutMs } : {}),
  });

  let effectiveReflex: ReflexPort | undefined = options.reflex;
  if (!effectiveReflex && executionMode === "REFLEX" && options.ruleBasedReflexConfig) {
    effectiveReflex = new RuleBasedReflex(options.ruleBasedReflexConfig);
  }

  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: liveBrain,
    clock,
    reflex: effectiveReflex,
  });

  let wsHandle: any;

  try {
    // 4. Create authoritative Task & Contract in runtime
    const runtimeTask = coordinator.createTask({
      title: `Evaluation Task: ${validatedTask.taskId} v${validatedTask.version}`,
      description: validatedTask.description,
      inputPayload: {
        evaluationRunId,
        taskId: validatedTask.taskId,
        taskVersion: validatedTask.version,
        taskContentHash,
      },
    });

    const policy = createExecutionPolicy({
      policyId: `eval-policy-${runtimeTask.taskId}`,
      allowedCapabilities: validatedTask.mission.requiredCapabilities,
      isolationRequirement: "ISOLATED",
    });

    const contractLimits = validatedTask.mission.resourceLimits ?? {};
    const contract = createMissionContract({
      contractId: `eval-contract-${runtimeTask.taskId}`,
      version: 1,
      taskId: runtimeTask.taskId,
      policy,
      verificationSpecs: [],
      resourceLimits: createResourceLimits({
        timeoutMs: contractLimits.timeoutMs ?? 60000,
        maxAttempts: contractLimits.maxAttempts ?? 3,
        maxOutputBytes: contractLimits.maxOutputBytes ?? 1048576,
      }),
      credentialScopes: ["workspace:eval:scope"],
    });

    store.insertContract(contract);
    store.activateContract(contract.spec.contractId, contract.spec.version);

    // 5. Register Worker & Start Runtime Run
    coordinator.registerWorker({
      workerId,
      hostname: "localhost",
      pid: process.pid,
      status: "ACTIVE",
      createdAt: clock.nowIso(),
      lastHeartbeatAt: clock.nowIso(),
    });

    const { run } = coordinator.createRun({ taskId: runtimeTask.taskId });
    coordinator.queueRun(run.runId);
    const claimResult = coordinator.claimRun(run.runId, workerId, 300000);
    coordinator.startRun(run.runId, workerId, claimResult.lease.leaseId);

    // 6. Provision Isolated Workspace
    wsHandle = await workspaceAdapter.provisionWorkspace({
      workspaceId: `ws-eval-${runtimeTask.taskId}`,
      runId: run.runId,
      taskId: runtimeTask.taskId,
      maxWorkspaceBytes: 10 * 1024 * 1024,
      maxFileSizeBytes: 1024 * 1024,
    });

    // 7. Populate Fixture Initial Files
    for (const [relPath, content] of Object.entries(validatedTask.fixture.initialFiles)) {
      const fullPath = await workspaceAdapter.resolvePath(wsHandle.workspaceId, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    }

    // 8. Execute Governed Step Loop
    const stepResult: StepControllerResult = await stepController.runStepLoop({
      runId: run.runId,
      workerId,
      leaseId: claimResult.lease.leaseId,
      workspace: wsHandle,
      budget: {
        maxSteps: validatedTask.budget.maxSteps,
        maxActions: validatedTask.budget.maxActions,
        maxWallClockMs: validatedTask.budget.maxWallClockMs,
        maxConsecutiveFailures: validatedTask.budget.maxConsecutiveFailures,
        maxProposalRejections: validatedTask.budget.maxProposalRejections,
      },
      abortSignal: options.abortSignal,
    });

    // 9. Evaluate Objective Criteria against Workspace
    const criteriaReader: CriteriaReader = {
      async readFile(relPath: string): Promise<string | null> {
        try {
          const resolved = await workspaceAdapter.resolvePath(wsHandle.workspaceId, relPath);
          if (!fs.existsSync(resolved)) return null;
          return fs.readFileSync(resolved, "utf8");
        } catch {
          return null;
        }
      },
      async fileExists(relPath: string): Promise<boolean> {
        try {
          const resolved = await workspaceAdapter.resolvePath(wsHandle.workspaceId, relPath);
          return fs.existsSync(resolved);
        } catch {
          return false;
        }
      },
      async executeCommand(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        try {
          if (!argv || argv.length === 0) {
            return { exitCode: 1, stdout: "", stderr: "Empty command argv" };
          }
          const wsDir = await workspaceAdapter.resolvePath(wsHandle.workspaceId, ".");
          const cmd = argv[0] === "node" ? process.execPath : argv[0]!;
          const args = argv.slice(1);
          const result = child_process.spawnSync(cmd, args, {
            cwd: wsDir,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            shell: false,
            windowsHide: true,
            encoding: "utf8",
          });
          return {
            exitCode: result.status ?? (result.error ? 1 : 0),
            stdout: result.stdout ?? "",
            stderr: (result.stderr ?? "") + (result.error ? `\n${result.error.message}` : ""),
          };
        } catch (err: unknown) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };

    const criteriaResults = await evaluateObjectiveCriteria(
      validatedTask.successCriteria,
      criteriaReader
    );

    const verificationPassed =
      criteriaResults.length > 0 && criteriaResults.every((c) => c.passed);

    // Check if agent explicitly claimed the mission goal was reached
    const agentClaimedGoal = stepResult.transcript.some(
      (entry) => entry.finishReason === "GOAL_REACHED"
    );

    // 10. Map Evaluation Outcome Taxonomy
    let status: EvaluationStatus;
    let statusMessage: string;

    if (stepResult.terminalReason === "BRAIN_FAILURE") {
      status = "ERROR";
      statusMessage = `Evaluation halted due to model/brain failure: ${stepResult.terminalMessage}`;
    } else if (
      stepResult.terminalReason === "MAX_STEPS" ||
      stepResult.terminalReason === "MAX_ACTIONS" ||
      stepResult.terminalReason === "MAX_WALL_CLOCK"
    ) {
      status = "TIMED_OUT";
      statusMessage = `Evaluation exhausted resource ceiling: ${stepResult.terminalReason} (${stepResult.terminalMessage})`;
    } else if (stepResult.terminalReason === "CANCELLED") {
      status = "CANCELLED";
      statusMessage = "Evaluation run cancelled via AbortSignal";
    } else if (
      stepResult.terminalReason === "CONTRACT_REVOKED" ||
      stepResult.terminalReason === "LEASE_LOST" ||
      stepResult.terminalReason === "MAX_PROPOSAL_REJECTIONS" ||
      stepResult.terminalReason === "UNKNOWN_EXECUTION" ||
      stepResult.terminalReason === "DEFERRED"
    ) {
      status = "BLOCKED";
      statusMessage = `Evaluation blocked by governance fencing: ${stepResult.terminalReason} (${stepResult.terminalMessage})`;
    } else {
      // Step loop concluded without error; objective verification dictates PASSED vs FAILED
      if (verificationPassed) {
        status = "PASSED";
        statusMessage = "All objective evaluation criteria verified successfully";
      } else {
        status = "FAILED";
        statusMessage = "Objective verification criteria failed against physical workspace";
      }
    }

    // 11. Compile Exact Metrics
    const toolLatency = stepResult.transcript.reduce(
      (acc, e) => acc + (e.actionStatus ? e.durationMs : 0),
      0
    );

    let reflexEvaluations: number | undefined = undefined;
    let reflexAllows: number | undefined = undefined;
    let reflexRejects: number | undefined = undefined;
    let reflexDefers: number | undefined = undefined;
    let failureLoopTriggers: number | undefined = undefined;
    let redundantActionTriggers: number | undefined = undefined;
    let budgetPressureTriggers: number | undefined = undefined;
    let reflexLatencyMs: number | undefined = undefined;

    if (executionMode === "REFLEX") {
      reflexEvaluations = 0;
      reflexAllows = 0;
      reflexRejects = 0;
      reflexDefers = 0;
      failureLoopTriggers = 0;
      redundantActionTriggers = 0;
      budgetPressureTriggers = 0;
      reflexLatencyMs = 0;

      for (const entry of stepResult.transcript) {
        const decision = entry.reflexEvidence ? entry.reflexEvidence.decision : entry.reflexDecision;
        const reasonCode = entry.reflexEvidence ? entry.reflexEvidence.reasonCode : entry.reflexReasonCode;

        if (decision !== undefined) {
          reflexEvaluations++;
          if (decision === "ALLOW") {
            reflexAllows++;
          } else if (decision === "REJECT") {
            reflexRejects++;
          } else if (decision === "DEFER") {
            reflexDefers++;
          }
        }
        if (typeof entry.reflexDurationMs === "number") {
          reflexLatencyMs += entry.reflexDurationMs;
        }
        if (reasonCode === "REPEATED_FAILURE") {
          failureLoopTriggers++;
        } else if (reasonCode === "REDUNDANT_ACTION") {
          redundantActionTriggers++;
        } else if (reasonCode === "RESOURCE_PRESSURE") {
          budgetPressureTriggers++;
        }
      }
    }

    const metrics: EvaluationMetrics = createEvaluationMetrics({
      steps: stepResult.totalSteps,
      actions: stepResult.totalActions,
      attempts: stepResult.transcript.filter((e) => e.actionId !== undefined).length,
      modelCalls: trackingProvider.calls,
      toolCalls: stepResult.totalActions,
      proposalRejections: stepResult.totalProposalRejections,
      executionFailures: stepResult.transcript.filter((e) => e.actionStatus === "FAILED").length,
      modelFailures: trackingProvider.failures,
      wallClockMs: stepResult.totalWallClockMs,
      modelLatencyMs: trackingProvider.totalLatencyMs,
      toolLatencyMs: toolLatency,
      inputTokens: trackingProvider.promptTokens,
      outputTokens: trackingProvider.outputTokens,
      totalTokens: trackingProvider.totalTokens,
      reflexEvaluations,
      reflexAllows,
      reflexRejects,
      reflexDefers,
      failureLoopTriggers,
      redundantActionTriggers,
      budgetPressureTriggers,
      reflexLatencyMs,
    });

    let ruleConfigurationHash: string | undefined = undefined;
    if (executionMode === "REFLEX") {
      if (options.condition?.ruleConfigurationHash) {
        ruleConfigurationHash = options.condition.ruleConfigurationHash;
      } else if (options.ruleBasedReflexConfig) {
        ruleConfigurationHash = computeRuleBasedReflexConfigHash(options.ruleBasedReflexConfig);
      }
    }

    const capturedReflexEvidence: ReflexEvidence[] = [];
    const evidenceReferencesList: string[] = [];
    for (const entry of stepResult.transcript) {
      if (typeof entry.actionId === "string") {
        evidenceReferencesList.push(entry.actionId);
      }
      if (entry.reflexEvidence) {
        capturedReflexEvidence.push(entry.reflexEvidence);
        evidenceReferencesList.push(entry.reflexEvidence.evidenceId);
      }
    }

    const completedAt = new Date().toISOString();

    // 12. Build Final Structured Result
    return Object.freeze({
      evaluationRunId,
      taskId: validatedTask.taskId,
      taskVersion: validatedTask.version,
      taskContentHash,
      configFingerprint,
      trialNumber,
      executionMode,
      ruleConfigurationHash,
      runId: run.runId,
      status,
      statusMessage,
      verificationPassed,
      agentClaimedGoal,
      criteriaResults,
      metrics,
      evidenceReferences: Object.freeze(evidenceReferencesList),
      reflexEvidence: capturedReflexEvidence.length > 0 ? Object.freeze(capturedReflexEvidence) : undefined,
      transcript: Object.freeze([...stepResult.transcript]),
      startedAt,
      completedAt,
    });
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

// ============================================================================
// 4. Evaluation Trial Runner Implementation
// ============================================================================

export async function executeEvaluationTrial(
  options: ExecuteEvaluationTrialOptions
): Promise<EvaluationTrial> {
  if (
    typeof options.trialOrdinal !== "number" ||
    !Number.isInteger(options.trialOrdinal) ||
    options.trialOrdinal < 1 ||
    options.trialOrdinal > MAX_TRIAL_ORDINAL
  ) {
    throw new Error(
      `trialOrdinal must be a positive integer between 1 and ${MAX_TRIAL_ORDINAL}`
    );
  }

  const runResult = await executeEvaluationRun({
    task: options.task,
    modelProvider: options.modelProvider,
    model: options.model,
    trialNumber: options.trialOrdinal,
    harnessVersion: options.harnessVersion,
    generationConfig: options.generationConfig,
    abortSignal: options.abortSignal,
    executionMode: options.executionMode,
    condition: options.condition,
    reflex: options.reflex,
    ruleBasedReflexConfig: options.ruleBasedReflexConfig,
    modelTimeoutMs: options.modelTimeoutMs,
  });

  return createEvaluationTrialFromRunResult(runResult, options.trialOrdinal, {
    trialId: options.trialId,
    ruleConfigurationHash: runResult.ruleConfigurationHash,
    errorDetails:
      runResult.status === "ERROR" || runResult.status === "BLOCKED"
        ? runResult.statusMessage
        : undefined,
  });
}
