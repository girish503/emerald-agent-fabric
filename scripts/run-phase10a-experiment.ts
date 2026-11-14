/**
 * Phase 10A — Calibrated 24-Trial Execution-Reach Gate Runner.
 *
 * Controlled model-capability evaluation measuring whether llama3.2:3b crosses
 * the proposal-validation boundary and reaches governed tool execution on realistic
 * multi-file SWE tasks (Tasks J, K, L, M, N, O) under frozen RuleBasedReflex.
 *
 * Invariants:
 * 1. Frozen Reflex:
 *    RuleBasedReflex configuration hash must match FROZEN_RULE_BASED_REFLEX_CONFIG_HASH.
 *    Zero runtime threshold tuning, zero heuristic adaptation.
 * 2. Model:
 *    llama3.2:3b via local Ollama. Timeout: 120,000ms.
 * 3. Authority Monotonicity:
 *    EffectiveAuthorityAfterReflex ⊆ EffectiveAuthorityBeforeReflex.
 * 4. Durable Checkpointing & Resumability:
 *    Every trial start and completion is persisted to an append-only NDJSON log.
 *    Resumed runs identify durably completed trials and skip them without re-execution.
 * 5. Telemetry Isolation:
 *    Baseline reflex telemetry is strictly undefined.
 * 6. Deterministic Evidence Replay:
 *    100% of captured ReflexEvidence records must replay offline with MATCH.
 * 7. Evidence Integrity:
 *    Every trial evidence artifact is verified via verifyArtifactIntegrity.
 * 8. Historical Artifact Protection:
 *    phase9-4b-* artifacts are never overwritten.
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

export interface Phase10ARunnerConfig {
  readonly model: string;
  readonly modelTimeoutMs: number;
  readonly ollamaBaseUrl: string;
  readonly trialsPerCondition: number;
  readonly targetTasks: readonly string[];
  readonly checkpointPath: string;
  readonly summaryPath: string;
  readonly resume: boolean;
}

const DEFAULT_CONFIG: Phase10ARunnerConfig = Object.freeze({
  model: process.env.EXPERIMENT_MODEL ?? "llama3.2:3b",
  modelTimeoutMs: 120_000,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  trialsPerCondition: process.env.TRIALS_PER_CONDITION
    ? parseInt(process.env.TRIALS_PER_CONDITION, 10)
    : 2,
  targetTasks: Object.freeze([...SWE_EVAL_TASK_IDS]),
  checkpointPath: path.resolve(
    process.env.CHECKPOINT_PATH ??
      path.resolve(__dirname, "../tests/fixtures/phase10a-checkpoint.ndjson")
  ),
  summaryPath: path.resolve(
    process.env.SUMMARY_PATH ??
      path.resolve(__dirname, "../tests/fixtures/phase10a-summary.json")
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
  readonly verificationPassed: boolean;
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
  readonly replayResults?: readonly ReflexReplayResult[];
  readonly allReplaysMatched?: boolean;
  readonly evidence?: PersistedTrialEvidence;
  readonly artifactHash?: string;
  readonly completedAt: string;
}

export interface CheckpointErrorRecord {
  readonly recordType: "TRIAL_ERROR";
  readonly trialKey: string;
  readonly errorReason: "ARTIFACT_SERIALIZATION_FAILED" | string;
  readonly errorMessage: string;
  readonly timestamp: string;
}

export type CheckpointRecord =
  | CheckpointStartRecord
  | CheckpointCompleteRecord
  | CheckpointErrorRecord;

// ============================================================================
// Main Runner Implementation
// ============================================================================

export async function runPhase10AExperiment(
  configOverrides: Partial<Phase10ARunnerConfig> = {}
): Promise<void> {
  const config: Phase10ARunnerConfig = { ...DEFAULT_CONFIG, ...configOverrides };

  console.log("\n================================================================================");
  console.log("PHASE 10A: CALIBRATED 24-TRIAL EXECUTION-REACH GATE (LLAMA 3.2:3B)");
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

  // Historical Artifact Protection: Verify historical Phase 9 artifacts exist and will not be overwritten
  const phase9CheckpointPath = path.resolve(
    path.resolve(__dirname, "../tests/fixtures/phase9-4b-checkpoint.ndjson")
  );
  if (fs.existsSync(phase9CheckpointPath)) {
    if (path.resolve(config.checkpointPath) === phase9CheckpointPath) {
      throw new Error(
        `Preflight failed: checkpointPath points to historical Phase 9-4B artifact! Aborting to prevent overwrite.`
      );
    }
    console.log(`[PREFLIGHT] Historical Phase 9.4B artifacts protected.`);
  }

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
        description: `Phase 10A evaluation for ${task.taskId} in ${mode} mode`,
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

        // Baseline telemetry invariant check
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
          verificationPassed: trial.verificationPassed,
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
        if (mode === "REFLEX") {
          console.log(
            `Reflex: evals=${trial.metrics.reflexEvaluations ?? 0}, allows=${trial.metrics.reflexAllows ?? 0}, rejects=${trial.metrics.reflexRejects ?? 0}, defers=${trial.metrics.reflexDefers ?? 0}`
          );
        }
      }
    }
  }

  fs.closeSync(checkpointFd);

  // 5. Final Synthesis & Gate Classification
  console.log("\n================================================================================");
  console.log(`ALL PLANNED TRIALS COMPLETED (${completedRecords.length}/${totalPlanned})`);
  console.log("================================================================================\n");

  const totalTrials = completedRecords.length;
  const passedTrials = completedRecords.filter((r) => r.verificationPassed).length;
  const trialsWithActions = completedRecords.filter((r) => r.metrics.totalActions > 0).length;
  const trialsWithToolCalls = completedRecords.filter((r) => r.metrics.totalToolCalls > 0).length;
  const executionReachRate = totalTrials > 0 ? trialsWithActions / totalTrials : 0;

  // Gate Assignment Logic
  let assignedGate: "GATE_A" | "GATE_B" | "GATE_C" | "GATE_D";
  let gateReason: string;

  if (completedRecords.length < totalPlanned) {
    assignedGate = "GATE_D";
    gateReason = `Incomplete run: ${completedRecords.length}/${totalPlanned} completed.`;
  } else if (executionReachRate >= 0.5) {
    assignedGate = "GATE_A";
    gateReason = `Substantial execution reach achieved (${(executionReachRate * 100).toFixed(1)}% of trials dispatched actions). Expansion to 60-trial matrix justified.`;
  } else if (executionReachRate > 0) {
    assignedGate = "GATE_B";
    gateReason = `Partial execution reach achieved (${(executionReachRate * 100).toFixed(1)}% of trials dispatched actions). Smallest justified next experiment recommended.`;
  } else {
    assignedGate = "GATE_C";
    gateReason = `Model still blocked upstream at schema/capability boundary (0% execution reach across 24 trials). Model capability bottleneck confirmed.`;
  }

  const reflexTrials = completedRecords.filter((r) => r.executionMode === "REFLEX");
  const baselineTrials = completedRecords.filter((r) => r.executionMode === "BASELINE");

  const totalReflexEvals = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexEvaluations ?? 0), 0);
  const totalReflexAllows = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexAllows ?? 0), 0);
  const totalReflexRejects = reflexTrials.reduce((acc, r) => acc + (r.metrics.reflexRejects ?? 0), 0);

  const summary = {
    experimentName: "Phase 10A: Calibrated 24-Trial Execution-Reach Gate",
    timestamp: new Date().toISOString(),
    model: config.model,
    ruleConfigurationHash: configHash,
    totalCompletedTrials: totalTrials,
    totalPlannedTrials: totalPlanned,
    executedInCurrentRun: executedInRun,
    metricsSummary: {
      passedTrials,
      passRate: totalTrials > 0 ? passedTrials / totalTrials : 0,
      trialsWithActions,
      trialsWithToolCalls,
      executionReachRate,
      totalReflexTrials: reflexTrials.length,
      totalBaselineTrials: baselineTrials.length,
      totalReflexEvals,
      totalReflexAllows,
      totalReflexRejects,
    },
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
runPhase10AExperiment().catch((err) => {
  console.error("Phase 10A experiment runner failed:", err);
  process.exit(1);
});
