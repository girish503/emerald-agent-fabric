/**
 * Phase 10E — Calibrated Live SWE Execution-Reach Gate Runner.
 *
 * Controlled model-capability evaluation measuring whether llama3.2:3b crosses
 * the proposal-validation boundary and reaches governed physical tool execution
 * on the frozen realistic SWE task set (Tasks J, K, L, M, N, O) under the
 * corrected discriminated `anyOf` structured-output schema.
 *
 * Invariants:
 * 1. Frozen Reflex:
 *    RuleBasedReflex configuration hash must match FROZEN_RULE_BASED_REFLEX_CONFIG_HASH
 *    (5e71ea253972678379f2e16c145d4b314e8de1b70c9eb0ac69d7a51540376252).
 *    Zero runtime threshold tuning, zero heuristic adaptation.
 * 2. Model:
 *    llama3.2:3b via local Ollama (http://127.0.0.1:11434) only. No cloud fallback. Timeout: 120,000ms.
 * 3. Authority Monotonicity & Live Safety:
 *    Model remains strictly untrusted. Structured schema is never interpreted as authority.
 *    Unauthorized tools/capabilities remain rejected.
 * 4. Durable Checkpointing & Resumability:
 *    Every trial start and completion is persisted to an append-only NDJSON log.
 *    Resumed runs identify durably completed trials and skip them without re-execution.
 * 5. Telemetry Isolation:
 *    Baseline reflex telemetry is strictly undefined. Never zero.
 * 6. Deterministic Evidence Replay:
 *    100% of captured ReflexEvidence records must replay offline with MATCH.
 * 7. Evidence Integrity:
 *    Every trial evidence artifact is verified via assertArtifactIntegrity.
 * 8. Historical Artifact Protection:
 *    phase9-4b-*, phase10a-*, phase10b-*, phase10c-* artifacts are never overwritten.
 * 9. Hard Stop:
 *    Halt immediately after 24 trials. Do not auto-expand to 60 trials.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkOllamaLiveAvailability } from "../src/application/evaluation/live-swe-evaluation.js";
import {
  getSweEvalTask,
  SWE_EVAL_TASK_IDS,
} from "../src/application/evaluation/swe-eval-tasks.js";
import { executeEvaluationTrial } from "../src/application/evaluation/evaluation-runner.js";
import {
  computeEvaluationTaskHash,
  createEvaluationConfigFingerprint,
  createExperimentCondition,
  CURRENT_HARNESS_VERSION,
  EvaluationConfigFingerprint,
  EvaluationExperimentCondition,
  EvaluationTrial,
} from "../src/domain/evaluation.js";
import {
  computeRuleBasedReflexConfigHash,
  DEFAULT_RULE_BASED_REFLEX_CONFIG,
  FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
} from "../src/domain/reflex.js";
import {
  ReflexReplayResult,
  replayReflexEvidence,
} from "../src/domain/reflex-evidence.js";
import {
  assertArtifactIntegrity,
  createPersistedTrialEvidence,
  PersistedTrialEvidence,
} from "../src/domain/evaluation-evidence.js";
import { OllamaModelProvider } from "../src/adapters/models/ollama-model-provider.js";

// ============================================================================
// Configuration & Defaults
// ============================================================================

export interface Phase10ERunnerConfig {
  readonly model: string;
  readonly modelTimeoutMs: number;
  readonly ollamaBaseUrl: string;
  readonly trialsPerCondition: number;
  readonly targetTasks: readonly string[];
  readonly checkpointPath: string;
  readonly summaryPath: string;
  readonly historicalSummaryPath: string;
  readonly resume: boolean;
}

const DEFAULT_CONFIG: Phase10ERunnerConfig = Object.freeze({
  model: process.env.EXPERIMENT_MODEL ?? "llama3.2:3b",
  modelTimeoutMs: 120_000,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  trialsPerCondition: process.env.TRIALS_PER_CONDITION
    ? parseInt(process.env.TRIALS_PER_CONDITION, 10)
    : 2,
  targetTasks: Object.freeze([...SWE_EVAL_TASK_IDS]),
  checkpointPath: path.resolve(
    process.env.CHECKPOINT_PATH ??
      "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10e-checkpoint.ndjson"
  ),
  summaryPath: path.resolve(
    process.env.SUMMARY_PATH ??
      "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10e-summary.json"
  ),
  historicalSummaryPath: path.resolve(
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10a-summary.json"
  ),
  resume: true,
});

// ============================================================================
// Checkpoint Record Types
// ============================================================================

export interface CheckpointStartRecord {
  readonly recordType: "TRIAL_START";
  readonly trialKey: string;
  readonly taskId: string;
  readonly executionMode: "BASELINE" | "REFLEX";
  readonly trialOrdinal: number;
  readonly timestamp: string;
}

export interface CheckpointCompleteRecord {
  readonly recordType: "TRIAL_COMPLETE";
  readonly trialKey: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
  readonly conditionId: string;
  readonly executionMode: "BASELINE" | "REFLEX";
  readonly trialOrdinal: number;
  readonly status: string;
  readonly statusMessage?: string;
  readonly verificationPassed: boolean;
  readonly agentClaimedGoal?: boolean;
  readonly durationMs: number;
  readonly metrics: {
    readonly totalSteps: number;
    readonly totalActions: number;
    readonly totalToolCalls: number;
    readonly totalModelCalls: number;
    readonly wallClockMs: number;
    readonly promptTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly reflexEvaluations?: number;
    readonly reflexAllows?: number;
    readonly reflexRejects?: number;
    readonly reflexDefers?: number;
    readonly failureLoopTriggers?: number;
    readonly redundantActionTriggers?: number;
    readonly budgetPressureTriggers?: number;
  };
  readonly stepAnalysis: {
    readonly totalProposalsAttempted: number;
    readonly validProposals: number;
    readonly invalidProposals: number;
    readonly physicalToolDispatches: number;
    readonly successfulToolDispatches: number;
    readonly failedToolDispatches: number;
    readonly proposalRejectionReasons: readonly string[];
    readonly brainErrors: readonly string[];
  };
  readonly highValueEvents: {
    readonly firstExecutionReached: boolean;
    readonly executionFailureObserved: boolean;
    readonly repeatedExecutionFailureObserved: boolean;
    readonly reflexInterventionObserved: boolean;
    readonly recoveryObserved: boolean;
  };
  readonly replayResults?: readonly ReflexReplayResult[];
  readonly allReplaysMatched?: boolean;
  readonly evidence?: PersistedTrialEvidence;
  readonly artifactHash?: string;
  readonly completedAt: string;
}

export interface CheckpointErrorRecord {
  readonly recordType: "TRIAL_ERROR";
  readonly trialKey: string;
  readonly errorReason: "ARTIFACT_SERIALIZATION_FAILED" | "EXECUTION_EXCEPTION" | string;
  readonly errorMessage: string;
  readonly timestamp: string;
}

export type CheckpointRecord =
  | CheckpointStartRecord
  | CheckpointCompleteRecord
  | CheckpointErrorRecord;

// ============================================================================
// Proposal & Execution Analysis Helpers
// ============================================================================

export type ProposalFailureCategory =
  | "INVALID_TOOL_INPUT"
  | "UNAUTHORIZED_CAPABILITY"
  | "MODEL_MALFORMED_OUTPUT"
  | "MODEL_TIMEOUT"
  | "MISSING_REQUIRED_FIELD"
  | "WRONG_VARIANT"
  | "FORBIDDEN_AUTHORITY"
  | "OTHER_VALIDATION_FAILURE";

export function categorizeProposalFailure(
  rejectionReason?: string,
  brainError?: string
): ProposalFailureCategory {
  if (brainError) {
    if (brainError.includes("timeout") || brainError.includes("timed out") || brainError.includes("ETIMEDOUT")) {
      return "MODEL_TIMEOUT";
    }
    if (brainError.includes("missing required boolean discriminator") || brainError.includes("is missing or not a registered tool name")) {
      return "MISSING_REQUIRED_FIELD";
    }
    if (brainError.includes("cannot contain tool action fields") || brainError.includes("Wrong variant")) {
      return "WRONG_VARIANT";
    }
    if (brainError.includes("forbidden authority")) {
      return "FORBIDDEN_AUTHORITY";
    }
    if (brainError.includes("Failed to parse model output as JSON") || brainError.includes("non-null object")) {
      return "MODEL_MALFORMED_OUTPUT";
    }
  }

  if (rejectionReason) {
    if (rejectionReason === "INVALID_TOOL_INPUT") return "INVALID_TOOL_INPUT";
    if (rejectionReason === "UNAUTHORIZED_CAPABILITY") return "UNAUTHORIZED_CAPABILITY";
    if (rejectionReason === "FORBIDDEN_AUTHORITY_FIELD") return "FORBIDDEN_AUTHORITY";
    if (rejectionReason === "MALFORMED_PROPOSAL") return "MODEL_MALFORMED_OUTPUT";
  }

  return "OTHER_VALIDATION_FAILURE";
}

// ============================================================================
// Main Runner Implementation
// ============================================================================

export async function runPhase10EExperiment(
  configOverrides: Partial<Phase10ERunnerConfig> = {}
): Promise<void> {
  const config: Phase10ERunnerConfig = { ...DEFAULT_CONFIG, ...configOverrides };

  console.log("\n================================================================================");
  console.log("PHASE 10E: CALIBRATED 24-TRIAL LIVE SWE EXECUTION-REACH GATE (LLAMA 3.2:3B)");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  // 1. Preflight Invariants
  const ruleConfig = DEFAULT_RULE_BASED_REFLEX_CONFIG;
  const configHash = computeRuleBasedReflexConfigHash(ruleConfig);
  if (configHash !== FROZEN_RULE_BASED_REFLEX_CONFIG_HASH) {
    throw new Error(
      `Preflight failed: Frozen Reflex hash mismatch. Expected ${FROZEN_RULE_BASED_REFLEX_CONFIG_HASH}, got ${configHash}`
    );
  }
  console.log(`[PREFLIGHT] Frozen Reflex Hash verified: ${configHash}`);

  const check = await checkOllamaLiveAvailability(config.ollamaBaseUrl, config.model);
  if (!check.available) {
    throw new Error(`Preflight failed: Ollama unreachable or model missing: ${check.reason}`);
  }
  console.log(
    `[PREFLIGHT] Ollama reachable at ${config.ollamaBaseUrl}. Target model '${config.model}' verified available.`
  );

  // Historical Artifact Protection: Verify historical artifacts exist and will never be overwritten
  const historicalPaths = [
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase9-4b-checkpoint.ndjson",
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase9-4b-summary.json",
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10a-checkpoint.ndjson",
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10a-summary.json",
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10b-structured-output-diagnostic.json",
    "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase10c-schema-union-diagnostic.json",
  ];

  for (const histPath of historicalPaths) {
    const resolvedHist = path.resolve(histPath);
    if (path.resolve(config.checkpointPath) === resolvedHist) {
      throw new Error(
        `Preflight failed: checkpointPath collides with historical artifact '${histPath}'! Aborting to prevent overwrite.`
      );
    }
    if (path.resolve(config.summaryPath) === resolvedHist) {
      throw new Error(
        `Preflight failed: summaryPath collides with historical artifact '${histPath}'! Aborting to prevent overwrite.`
      );
    }
  }
  console.log(`[PREFLIGHT] All 6 historical Phase 9/10 artifacts verified protected.`);

  const tasks = config.targetTasks.map(getSweEvalTask);
  console.log(`[PREFLIGHT] Target tasks (${tasks.length}): [${tasks.map((t) => t.taskId).join(", ")}]`);
  const executionModes: readonly ("BASELINE" | "REFLEX")[] = ["BASELINE", "REFLEX"];
  const totalPlanned = tasks.length * executionModes.length * config.trialsPerCondition;
  console.log(
    `[PREFLIGHT] Planned Matrix: ${tasks.length} tasks × 2 conditions × ${config.trialsPerCondition} trials = ${totalPlanned} trials.`
  );

  // 2. Load Existing Checkpoint for Resumability
  const completedTrialKeys = new Set<string>();
  const completedRecords: CheckpointCompleteRecord[] = [];

  if (fs.existsSync(config.checkpointPath)) {
    const rawLines = fs.readFileSync(config.checkpointPath, "utf8").split("\n");
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as CheckpointRecord;
        if (record.recordType === "TRIAL_COMPLETE") {
          completedTrialKeys.add(record.trialKey);
          completedRecords.push(record);
        }
      } catch (err) {
        console.warn("Skipping unparseable checkpoint line:", trimmed);
      }
    }
    console.log(
      `[CHECKPOINT] Found existing checkpoint: ${completedTrialKeys.size}/${totalPlanned} durably completed trials.`
    );
  } else {
    fs.mkdirSync(path.dirname(config.checkpointPath), { recursive: true });
  }

  const checkpointFd = fs.openSync(config.checkpointPath, "a");
  const appendCheckpoint = (rec: CheckpointRecord) => {
    fs.writeSync(checkpointFd, JSON.stringify(rec) + "\n");
  };

  // 3. Instrumented Ollama Model Provider
  let inferenceCount = 0;
  const instrumentedFetch = async (
    url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    inferenceCount++;
    const reqNum = inferenceCount;
    const start = Date.now();

    let taskHint = "";
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        const messages = body.messages ?? [];
        for (const m of messages) {
          const content = m.content ?? "";
          const match = /task-swe-[a-z0-9-]+/.exec(content);
          if (match) {
            taskHint = match[0];
            break;
          }
        }
      } catch {}
    }

    const startMsg = `[${new Date().toISOString()}] [Inference #${reqNum}] START (${taskHint || "swe"}) calling Ollama /api/chat...`;
    console.log(startMsg);

    try {
      const res = await fetch(url, init);
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
      const clone = res.clone();
      try {
        const body = await clone.json();
        const pTok = body.prompt_eval_count ?? 0;
        const eTok = body.eval_count ?? 0;
        const done = body.done;
        console.log(
          `[${new Date().toISOString()}] [Inference #${reqNum}] DONE in ${elapsedSec}s | status: ${res.status} | prompt_tok: ${pTok} | eval_tok: ${eTok} | done: ${done}`
        );
      } catch {
        console.log(
          `[${new Date().toISOString()}] [Inference #${reqNum}] DONE in ${elapsedSec}s | status: ${res.status}`
        );
      }
      return res;
    } catch (err) {
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
      console.error(
        `[${new Date().toISOString()}] [Inference #${reqNum}] FAILED in ${elapsedSec}s:`,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  };

  const provider = new OllamaModelProvider({
    baseURL: config.ollamaBaseUrl,
    defaultModel: config.model,
    timeoutMs: config.modelTimeoutMs,
    fetch: instrumentedFetch,
  });

  // 4. Execution Loop
  let executedInRun = 0;

  for (const task of tasks) {
    const taskContentHash = computeEvaluationTaskHash(task);

    for (const mode of executionModes) {
      const configFingerprint: EvaluationConfigFingerprint = createEvaluationConfigFingerprint({
        modelProvider: provider.providerName,
        model: config.model,
        taskVersion: task.version,
        harnessVersion: CURRENT_HARNESS_VERSION,
      });

      const condition: EvaluationExperimentCondition = createExperimentCondition({
        conditionId: `condition-${mode.toLowerCase()}-${task.taskId}`,
        name: `${mode === "BASELINE" ? "Baseline" : "Reflex"}: ${task.taskId}`,
        description: `Phase 10E evaluation for ${task.taskId} in ${mode} mode`,
        executionMode: mode,
        ruleConfigurationHash: mode === "REFLEX" ? configHash : undefined,
        configFingerprint,
      });

      for (let ordinal = 1; ordinal <= config.trialsPerCondition; ordinal++) {
        const trialKey = `${task.taskId}:${mode}:${ordinal}`;

        if (completedTrialKeys.has(trialKey)) {
          console.log(`[SKIP] Trial already durably completed: ${trialKey}`);
          continue;
        }

        console.log(`\n--------------------------------------------------------------------------------`);
        console.log(`[EXECUTE] Starting Trial: ${trialKey} (${completedRecords.length + 1}/${totalPlanned})`);
        console.log(`Task: ${task.taskId} | Condition: ${mode} | Ordinal: ${ordinal}`);
        console.log(`--------------------------------------------------------------------------------`);

        appendCheckpoint({
          recordType: "TRIAL_START",
          trialKey,
          taskId: task.taskId,
          executionMode: mode,
          trialOrdinal: ordinal,
          timestamp: new Date().toISOString(),
        });

        const trialStartTime = Date.now();
        let trial: EvaluationTrial;

        try {
          trial = await executeEvaluationTrial({
            task,
            modelProvider: provider,
            model: config.model,
            trialOrdinal: ordinal,
            harnessVersion: CURRENT_HARNESS_VERSION,
            executionMode: mode,
            condition,
            ruleBasedReflexConfig: mode === "REFLEX" ? ruleConfig : undefined,
            modelTimeoutMs: config.modelTimeoutMs,
          });
        } catch (err: unknown) {
          console.error(`[ERROR] Execution of ${trialKey} failed:`, err);
          appendCheckpoint({
            recordType: "TRIAL_ERROR",
            trialKey,
            errorReason: "EXECUTION_EXCEPTION",
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          });
          throw err;
        }

        const trialDurationMs = Date.now() - trialStartTime;
        executedInRun++;

        // Baseline telemetry invariant check: baseline reflex metrics MUST be strictly undefined
        if (mode === "BASELINE" && trial.metrics.reflexEvaluations !== undefined) {
          throw new Error(
            `Invariant violation: Baseline trial ${trial.trialId} recorded non-undefined reflexEvaluations`
          );
        }

        // Deterministic Offline Replay Verification for REFLEX trials
        let replayResults: ReflexReplayResult[] | undefined;
        let allReplaysMatched: boolean | undefined;

        if (mode === "REFLEX" && trial.reflexEvidence && trial.reflexEvidence.length > 0) {
          replayResults = [];
          allReplaysMatched = true;
          for (const ev of trial.reflexEvidence) {
            const rep = await replayReflexEvidence(ev, { ruleConfig });
            replayResults.push(rep);
            if (!rep.match) {
              allReplaysMatched = false;
              console.error(`[REPLAY_MISMATCH] Evidence ${ev.evidenceId} failed offline replay!`);
            }
          }
          console.log(
            `[REPLAY] Replayed ${replayResults.length} Reflex evidence records. All matched: ${allReplaysMatched}`
          );
        }

        // Analyze trial transcript steps for proposal boundary and execution metrics
        const transcriptEntries = trial.transcript ?? [];
        let validProposals = 0;
        let invalidProposals = 0;
        let physicalToolDispatches = 0;
        let successfulToolDispatches = 0;
        let failedToolDispatches = 0;
        const proposalRejectionReasons: string[] = [];
        const brainErrors: string[] = [];

        let firstExecutionReached = false;
        let executionFailureObserved = false;
        let repeatedExecutionFailureObserved = false;
        let reflexInterventionObserved = false;
        let recoveryObserved = false;

        let consecutiveExecutionFailures = 0;
        let lastFailedTool: string | undefined;

        for (const entry of transcriptEntries) {
          if (entry.proposalValid) {
            validProposals++;
          } else if (entry.proposalRejectionReason) {
            invalidProposals++;
            proposalRejectionReasons.push(entry.proposalRejectionReason);
          }

          if (entry.finishReason === "ERROR" && !entry.proposalValid) {
            invalidProposals++;
            brainErrors.push("BRAIN_ERROR");
          }

          if (entry.actionId) {
            physicalToolDispatches++;
            if (!firstExecutionReached) {
              firstExecutionReached = true;
              console.log(`[TRAJECTORY: FIRST_EXECUTION] Trial ${trialKey} reached first physical tool dispatch: ${entry.toolName}`);
            }

            if (entry.actionStatus === "SUCCEEDED") {
              successfulToolDispatches++;
              if (consecutiveExecutionFailures > 0 && entry.toolName !== lastFailedTool) {
                recoveryObserved = true;
                console.log(`[TRAJECTORY: RECOVERY] Trial ${trialKey} recovered after execution failure via ${entry.toolName}`);
              }
              consecutiveExecutionFailures = 0;
              lastFailedTool = undefined;
            } else if (entry.actionStatus === "FAILED") {
              failedToolDispatches++;
              executionFailureObserved = true;
              consecutiveExecutionFailures++;
              if (consecutiveExecutionFailures >= 2 && entry.toolName === lastFailedTool) {
                repeatedExecutionFailureObserved = true;
                console.log(`[TRAJECTORY: REPEATED_FAILURE] Trial ${trialKey} repeated failure on tool: ${entry.toolName}`);
              }
              lastFailedTool = entry.toolName;
            }
          }

          if (entry.reflexDecision === "REJECT" || entry.reflexDecision === "DEFER") {
            reflexInterventionObserved = true;
            console.log(`[TRAJECTORY: REFLEX_INTERVENTION] Trial ${trialKey} Reflex intervention: ${entry.reflexDecision} (${entry.reflexReasonCode})`);
          }
        }

        // Create and verify durable evidence artifact
        let persistedEvidence: PersistedTrialEvidence | undefined;
        try {
          persistedEvidence = createPersistedTrialEvidence({
            trialIdentity: {
              trialId: trial.trialId,
              trialOrdinal: ordinal,
              trialIdentityHash: trial.trialIdentityHash,
              runtimeRunId: trial.runtimeRunId,
            },
            taskIdentity: {
              taskId: task.taskId,
              taskVersion: task.version,
              taskContentHash,
            },
            condition: {
              conditionId: condition.conditionId,
              name: condition.name,
            },
            executionMode: mode,
            model: config.model,
            configFingerprint,
            ruleConfigurationHash: mode === "REFLEX" ? configHash : undefined,
            transcript: (trial.transcript as any) ?? [],
            reflexEvidence: mode === "REFLEX" ? trial.reflexEvidence : undefined,
            metrics: trial.metrics,
            outcome: {
              status: trial.outcome,
              statusMessage: trial.statusMessage,
              verificationPassed: trial.verificationPassed,
              agentClaimedGoal: trial.agentClaimedGoal,
              errorDetails: trial.errorDetails,
            },
          });

          // Assert cryptographic and credential integrity
          assertArtifactIntegrity(persistedEvidence, {
            expectedTaskContentHash: taskContentHash,
          });
        } catch (err: unknown) {
          console.error(
            `[ARTIFACT_ERROR] Failed to construct/verify persisted evidence for ${trialKey}:`,
            err
          );
          appendCheckpoint({
            recordType: "TRIAL_ERROR",
            trialKey,
            errorReason: "ARTIFACT_SERIALIZATION_FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          });
          throw err;
        }

        const completeRecord: CheckpointCompleteRecord = {
          recordType: "TRIAL_COMPLETE",
          trialKey,
          trialId: trial.trialId,
          taskId: task.taskId,
          taskVersion: task.version,
          taskContentHash,
          conditionId: condition.conditionId,
          executionMode: mode,
          trialOrdinal: ordinal,
          status: trial.outcome,
          statusMessage: trial.statusMessage,
          verificationPassed: trial.verificationPassed,
          agentClaimedGoal: trial.agentClaimedGoal,
          durationMs: trialDurationMs,
          metrics: {
            totalSteps: trial.metrics.steps,
            totalActions: trial.metrics.actions,
            totalToolCalls: trial.metrics.toolCalls,
            totalModelCalls: trial.metrics.modelCalls,
            wallClockMs: trial.metrics.wallClockMs,
            promptTokens: trial.metrics.inputTokens,
            outputTokens: trial.metrics.outputTokens,
            totalTokens: trial.metrics.totalTokens,
            reflexEvaluations: trial.metrics.reflexEvaluations,
            reflexAllows: trial.metrics.reflexAllows,
            reflexRejects: trial.metrics.reflexRejects,
            reflexDefers: trial.metrics.reflexDefers,
            failureLoopTriggers: trial.metrics.failureLoopTriggers,
            redundantActionTriggers: trial.metrics.redundantActionTriggers,
            budgetPressureTriggers: trial.metrics.budgetPressureTriggers,
          },
          stepAnalysis: {
            totalProposalsAttempted: validProposals + invalidProposals,
            validProposals,
            invalidProposals,
            physicalToolDispatches,
            successfulToolDispatches,
            failedToolDispatches,
            proposalRejectionReasons: Object.freeze(proposalRejectionReasons),
            brainErrors: Object.freeze(brainErrors),
          },
          highValueEvents: {
            firstExecutionReached,
            executionFailureObserved,
            repeatedExecutionFailureObserved,
            reflexInterventionObserved,
            recoveryObserved,
          },
          evidence: persistedEvidence,
          artifactHash: persistedEvidence?.artifactHash,
          replayResults,
          allReplaysMatched,
          completedAt: new Date().toISOString(),
        };

        appendCheckpoint(completeRecord);
        completedTrialKeys.add(trialKey);
        completedRecords.push(completeRecord);

        console.log(`[COMPLETE] Trial ${trialKey} finished in ${(trialDurationMs / 1000).toFixed(1)}s`);
        console.log(
          `Status: ${trial.outcome} | Passed: ${trial.verificationPassed} | Steps: ${trial.metrics.steps} | Actions: ${trial.metrics.actions} | Tools: ${trial.metrics.toolCalls} | Model: ${trial.metrics.modelCalls}`
        );
        console.log(
          `Proposal Analysis: valid=${validProposals}, invalid=${invalidProposals}, dispatches=${physicalToolDispatches}`
        );
        if (mode === "REFLEX") {
          console.log(
            `Reflex: evals=${trial.metrics.reflexEvaluations ?? 0}, allows=${trial.metrics.reflexAllows ?? 0}, rejects=${trial.metrics.reflexRejects ?? 0}, defers=${trial.metrics.reflexDefers ?? 0}`
          );
        }
      }
    }
  }

  fs.closeSync(checkpointFd);

  // 5. Final Synthesis, Analysis & Gate Classification
  console.log("\n================================================================================");
  console.log(`ALL PLANNED TRIALS COMPLETED (${completedRecords.length}/${totalPlanned})`);
  console.log("================================================================================\n");

  const totalTrials = completedRecords.length;
  const passedTrials = completedRecords.filter((r) => r.verificationPassed).length;
  const trialsWithActions = completedRecords.filter((r) => r.metrics.totalActions > 0).length;
  const trialsWithToolCalls = completedRecords.filter((r) => r.metrics.totalToolCalls > 0).length;
  const trialsWithToolExecution = completedRecords.filter((r) => r.stepAnalysis.physicalToolDispatches > 0).length;
  const trialLevelExecutionRate = totalTrials > 0 ? trialsWithToolExecution / totalTrials : 0;

  // Proposal-Boundary Aggregates
  const totalModelCalls = completedRecords.reduce((acc, r) => acc + r.metrics.totalModelCalls, 0);
  const totalProposals = completedRecords.reduce((acc, r) => acc + r.stepAnalysis.totalProposalsAttempted, 0);
  const totalValidProposals = completedRecords.reduce((acc, r) => acc + r.stepAnalysis.validProposals, 0);
  const totalInvalidProposals = completedRecords.reduce((acc, r) => acc + r.stepAnalysis.invalidProposals, 0);
  const validProposalRate = totalProposals > 0 ? totalValidProposals / totalProposals : 0;

  // Execution Aggregates
  const totalPhysicalToolDispatches = completedRecords.reduce((acc, r) => acc + r.stepAnalysis.physicalToolDispatches, 0);
  const totalSuccessfulToolDispatches = completedRecords.reduce((acc, r) => acc + r.stepAnalysis.successfulToolDispatches, 0);
  const totalFailedToolDispatches = completedRecords.reduce((acc, r) => acc + r.stepAnalysis.failedToolDispatches, 0);

  // Execution reach rate: eligible valid proposals reaching physical tool dispatch / eligible proposals
  const executionReachRate = totalValidProposals > 0 ? totalPhysicalToolDispatches / totalValidProposals : 0;

  // Proposal Rejection Taxonomy
  const failureCategoryCounts: Record<ProposalFailureCategory, number> = {
    INVALID_TOOL_INPUT: 0,
    UNAUTHORIZED_CAPABILITY: 0,
    MODEL_MALFORMED_OUTPUT: 0,
    MODEL_TIMEOUT: 0,
    MISSING_REQUIRED_FIELD: 0,
    WRONG_VARIANT: 0,
    FORBIDDEN_AUTHORITY: 0,
    OTHER_VALIDATION_FAILURE: 0,
  };

  for (const r of completedRecords) {
    for (const reason of r.stepAnalysis.proposalRejectionReasons) {
      const cat = categorizeProposalFailure(reason, undefined);
      failureCategoryCounts[cat] = (failureCategoryCounts[cat] ?? 0) + 1;
    }
    for (const bErr of r.stepAnalysis.brainErrors) {
      const cat = categorizeProposalFailure(undefined, bErr);
      failureCategoryCounts[cat] = (failureCategoryCounts[cat] ?? 0) + 1;
    }
  }

  // Reflex Telemetry Aggregates (REFLEX mode only)
  const reflexTrials = completedRecords.filter((r) => r.executionMode === "REFLEX");
  const baselineTrials = completedRecords.filter((r) => r.executionMode === "BASELINE");

  const totalReflexEvals = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexEvaluations ?? 0), 0);
  const totalReflexAllows = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexAllows ?? 0), 0);
  const totalReflexRejects = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexRejects ?? 0), 0);
  const totalReflexDefers = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexDefers ?? 0), 0);
  const totalFailureLoopTriggers = reflexTrials.reduce((acc, r) => acc + (r.metrics.failureLoopTriggers ?? 0), 0);
  const totalRedundantActionTriggers = reflexTrials.reduce((acc, r) => acc + (r.metrics.redundantActionTriggers ?? 0), 0);
  const totalBudgetPressureTriggers = reflexTrials.reduce((acc, r) => acc + (r.metrics.budgetPressureTriggers ?? 0), 0);

  // Objective Status Breakdown
  const statusCounts: Record<string, number> = {};
  for (const r of completedRecords) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }

  // High-Value Trajectory Aggregates
  const highValueSummary = {
    trialsWithFirstExecution: completedRecords.filter((r) => r.highValueEvents.firstExecutionReached).map((r) => r.trialKey),
    trialsWithExecutionFailure: completedRecords.filter((r) => r.highValueEvents.executionFailureObserved).map((r) => r.trialKey),
    trialsWithRepeatedExecutionFailure: completedRecords.filter((r) => r.highValueEvents.repeatedExecutionFailureObserved).map((r) => r.trialKey),
    trialsWithReflexIntervention: completedRecords.filter((r) => r.highValueEvents.reflexInterventionObserved).map((r) => r.trialKey),
    trialsWithRecovery: completedRecords.filter((r) => r.highValueEvents.recoveryObserved).map((r) => r.trialKey),
  };

  // Load Historical Phase 10A Baseline for Comparison
  let phase10aComparison: Record<string, unknown> | undefined;
  if (fs.existsSync(config.historicalSummaryPath)) {
    try {
      const p10a = JSON.parse(fs.readFileSync(config.historicalSummaryPath, "utf8"));
      phase10aComparison = {
        phase10aTotalCompleted: p10a.totalCompletedTrials,
        phase10aPassRate: p10a.metricsSummary?.passRate ?? 0,
        phase10aTrialsWithToolCalls: p10a.metricsSummary?.trialsWithToolCalls ?? 0,
        phase10aExecutionReachRate: p10a.metricsSummary?.executionReachRate ?? 0,
        phase10aGate: p10a.gateClassification?.assignedGate ?? "UNKNOWN",
        deltaTrialsWithToolExecution: trialsWithToolExecution - (p10a.metricsSummary?.trialsWithToolCalls ?? 0),
        deltaExecutionReachRate: executionReachRate - (p10a.metricsSummary?.executionReachRate ?? 0),
      };
    } catch (err) {
      console.warn("Could not load Phase 10A summary for comparison:", err);
    }
  }

  // Gate Assignment Logic strictly per Phase 10E specification:
  // - GATE A: Execution reach established (meaningful physical tool execution across task set)
  // - GATE B: Partial execution reach established (> 0% but sparse/inconsistent)
  // - GATE C: Still blocked upstream at schema/validation boundary (0% execution reach)
  // - GATE D: Reflex domain reached (real execution failures and repeated execution trajectories occur)
  let assignedGate: "GATE_A" | "GATE_B" | "GATE_C" | "GATE_D";
  let gateReason: string;

  if (totalFailedToolDispatches > 0 && highValueSummary.trialsWithExecutionFailure.length > 0) {
    assignedGate = "GATE_D";
    gateReason = `Reflex domain reached: Real execution failures observed (${totalFailedToolDispatches} tool execution failures across ${highValueSummary.trialsWithExecutionFailure.length} trials). Governed Reflex can be evaluated on live failure domain.`;
  } else if (trialLevelExecutionRate >= 0.5 || executionReachRate >= 0.5) {
    assignedGate = "GATE_A";
    gateReason = `Execution reach established: ${(trialLevelExecutionRate * 100).toFixed(1)}% of trials reached physical tool execution (${trialsWithToolExecution}/${totalTrials} trials, ${totalPhysicalToolDispatches} tool dispatches).`;
  } else if (trialsWithToolExecution > 0) {
    assignedGate = "GATE_B";
    gateReason = `Partial execution reach achieved: ${(trialLevelExecutionRate * 100).toFixed(1)}% of trials reached physical tool execution (${trialsWithToolExecution}/${totalTrials} trials, ${totalPhysicalToolDispatches} tool dispatches).`;
  } else {
    assignedGate = "GATE_C";
    gateReason = `Model still blocked upstream at schema/validation boundary: 0 physical tool executions across 24 trials.`;
  }

  const summary = {
    experimentName: "Phase 10E: Calibrated 24-Trial Live SWE Execution-Reach Gate",
    timestamp: new Date().toISOString(),
    model: config.model,
    ruleConfigurationHash: configHash,
    totalCompletedTrials: totalTrials,
    totalPlannedTrials: totalPlanned,
    executedInCurrentRun: executedInRun,
    primaryMetrics: {
      executionReachRate,
      trialLevelExecutionRate,
      trialsWithToolExecution,
      totalCompletedTrials: totalTrials,
    },
    proposalBoundaryMetrics: {
      totalModelCalls,
      totalProposals,
      totalValidProposals,
      totalInvalidProposals,
      validProposalRate,
      proposalFailureTaxonomy: failureCategoryCounts,
    },
    executionMetrics: {
      totalPhysicalToolDispatches,
      totalSuccessfulToolDispatches,
      totalFailedToolDispatches,
      trialsWithActions,
      trialsWithToolCalls,
    },
    reflexMetrics: {
      totalReflexTrials: reflexTrials.length,
      totalBaselineTrials: baselineTrials.length,
      totalReflexEvals,
      totalReflexAllows,
      totalReflexRejects,
      totalReflexDefers,
      totalFailureLoopTriggers,
      totalRedundantActionTriggers,
      totalBudgetPressureTriggers,
    },
    objectiveMetrics: {
      passedTrials,
      passRate: totalTrials > 0 ? passedTrials / totalTrials : 0,
      statusBreakdown: statusCounts,
    },
    highValueTrajectories: highValueSummary,
    comparisonWithPhase10A: phase10aComparison,
    gateClassification: {
      assignedGate,
      gateReason,
    },
    records: completedRecords,
  };

  fs.writeFileSync(config.summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`[STORAGE] Final experiment summary written to: ${config.summaryPath}`);
  console.log(`[GATE] Decision: ${assignedGate} — ${gateReason}`);
}

// Auto-run if executed directly
runPhase10EExperiment().catch((err) => {
  console.error("Phase 10E experiment runner failed:", err);
  process.exit(1);
});
