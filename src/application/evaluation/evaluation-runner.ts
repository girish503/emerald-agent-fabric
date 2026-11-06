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
import * as crypto from "node:crypto";
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
  translateEvaluationTaskCriteria,
  classifyTrialOutcome,
  type ModelCompletionClaimObservation,
  type TrialVerificationAssessment,
  type VerificationSpec,
  type VerificationResult,
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
import {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "../../ports/execution-provider.port.js";
import { RunCommandOutput } from "../../domain/tool-schemas.js";
import type { ActionSnapshot } from "../../domain/action.js";
import type { AttemptSnapshot } from "../../domain/attempt.js";
import type { MissionContract } from "../../domain/mission-contract.js";
import { DeterministicVerifier } from "../../domain/verification.js";
import { matchesProtectedPath } from "../../domain/policy.js";
import type { PersistedEvent } from "../../ports/state-store.port.js";

// ============================================================================
// 0. Constrained Host Execution Provider (Restricted Local Test Execution)
// ============================================================================

/**
 * ConstrainedHostExecutionProvider is a restricted, non-sandboxed host execution provider
 * intended exclusively for hermetic CPU-first tests and controlled, trusted benchmark fixtures
 * where container isolation is unavailable.
 *
 * Explicit Security Boundary & Threat Model:
 * 1. NOT a Security Sandbox: Host execution runs directly on the local host OS under current user
 *    privileges; it is NEVER marketed as container or virtualization isolation.
 *    Any Node script executed here runs with Node host capabilities.
 * 2. Trusted Fixtures Only: Suitable ONLY for controlled, trusted benchmark fixtures and test suites.
 *    Production agent workloads, multi-tenant operations, and adversarial/untrusted benchmark suites
 *    STRICTLY REQUIRE isolated Docker execution (DockerExecutionProvider).
 * 3. Strict Binary Allowlist: Only the current Node.js runtime executable ('node' or process.execPath)
 *    is permitted. All arbitrary system binaries (sh, bash, powershell, curl, rm, etc.) are REJECTED.
 * 4. Forbidden Flag Disallowlist: Node execution flags that permit arbitrary string eval or loader
 *    injection (-e, --eval, -p, --print, --loader, --import, --require, -r, --inspect*) are REJECTED.
 * 5. Workspace Boundary Containment:
 *    - targetCwd must resolve strictly inside request.workspace.hostPath.
 *    - The target script argument must be a relative or workspace path whose real canonical path
 *      starts with the workspace root, preventing path traversal and symlink boundary escape.
 * 6. Hermetic Environment Scrubbing: Host process.env is NEVER inherited. Only a minimal sanitized
 *    environment (NODE_ENV, PATH, SYSTEMROOT, TEMP/TMP bound to workspace) is passed, preventing
 *    leakage of API keys, tokens, or credentials.
 * 7. Hard Resource Limits: Synchronous bounded execution with strict timeout (max 15s), maxBuffer (max 1MB),
 *    killSignal SIGKILL, shell: false, windowsHide: true.
 */
export class ConstrainedHostExecutionProvider implements ExecutionProvider {
  readonly name = "host-constrained";
  readonly tenantModel = "NONE" as const;
  readonly cancellationModel = "COOPERATIVE" as const;

  // Forbidden Node arguments that allow code injection, eval, or debugging sockets
  private static readonly FORBIDDEN_NODE_FLAGS = new Set([
    "-e",
    "--eval",
    "-p",
    "--print",
    "-c",
    "--check",
    "--loader",
    "--import",
    "-r",
    "--require",
    "--inspect",
    "--inspect-brk",
    "--inspect-port",
    "--experimental-loader",
    "--experimental-default-type",
  ]);

  private trustedFixtureHashes?: ReadonlyMap<string, string>;
  private protectedPatterns?: readonly string[];
  private oracleDir?: string;

  configureOracleIntegrity(options: {
    trustedFixtureHashes: ReadonlyMap<string, string>;
    protectedPatterns: readonly string[];
    oracleDir?: string;
  }): void {
    this.trustedFixtureHashes = options.trustedFixtureHashes;
    this.protectedPatterns = options.protectedPatterns;
    this.oracleDir = options.oracleDir;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    request: ExecutionRequest<TInput>
  ): Promise<ExecutionResult<TOutput>> {
    const startTime = Date.now();
    const payload = request.inputPayload as {
      argv?: readonly string[];
      cwd?: string;
      maxOutputBytes?: number;
    } | undefined;

    const argv = payload?.argv ?? [];
    if (argv.length === 0) {
      return {
        status: "FAILED",
        error: { code: "EXECUTION_FAILED", message: "Empty argv in command execution request" },
        durationMs: Date.now() - startTime,
      };
    }

    const hostPath = request.workspace?.hostPath;
    if (!hostPath) {
      return {
        status: "FAILED",
        error: {
          code: "EXECUTION_FAILED",
          message: "Host execution requires an authoritative workspace (WORKSPACE_REQUIRED)",
          details: { code: "WORKSPACE_REQUIRED" },
        },
        durationMs: Date.now() - startTime,
      };
    }

    // 1. Strict Binary Allowlist Enforcement
    const requestedBinary = argv[0]!;
    const isAllowedBinary =
      requestedBinary === "node" ||
      requestedBinary === process.execPath ||
      path.basename(requestedBinary).toLowerCase() === "node.exe" ||
      path.basename(requestedBinary).toLowerCase() === "node";

    if (!isAllowedBinary) {
      return {
        status: "FAILED",
        error: {
          code: "EXECUTION_FAILED",
          message: `Host execution rejected (POLICY_DENIED): executable '${requestedBinary}' is unauthorized. In host-constrained mode, only the Node.js test runtime ('node') is permitted for trusted benchmark fixtures. Untrusted or arbitrary system commands require governed container isolation (DockerExecutionProvider).`,
          details: { code: "POLICY_DENIED", executable: requestedBinary },
        },
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Strict Argument Whitelisting / Disallowlist
    for (const arg of argv.slice(1)) {
      if (ConstrainedHostExecutionProvider.FORBIDDEN_NODE_FLAGS.has(arg)) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Host execution rejected (POLICY_DENIED): node flag '${arg}' is forbidden in host-constrained evaluation.`,
            details: { code: "POLICY_DENIED", flag: arg },
          },
          durationMs: Date.now() - startTime,
        };
      }
      if (arg.startsWith("-e=") || arg.startsWith("--eval=") || arg.startsWith("--inspect=")) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Host execution rejected (POLICY_DENIED): node option '${arg}' is forbidden in host-constrained evaluation.`,
            details: { code: "POLICY_DENIED", option: arg },
          },
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 3. Workspace Boundary Containment Enforcement
    let canonicalHostPath: string;
    try {
      canonicalHostPath = fs.realpathSync(hostPath);
    } catch {
      canonicalHostPath = path.resolve(hostPath);
    }

    const targetRelCwd = payload?.cwd ?? ".";
    const targetCwd = path.resolve(canonicalHostPath, targetRelCwd);
    let canonicalTargetCwd: string;
    try {
      canonicalTargetCwd = fs.realpathSync(targetCwd);
    } catch {
      canonicalTargetCwd = targetCwd;
    }

    const relToWorkspace = path.relative(canonicalHostPath, canonicalTargetCwd);
    if (relToWorkspace.startsWith("..") || path.isAbsolute(relToWorkspace)) {
      return {
        status: "FAILED",
        error: {
          code: "EXECUTION_FAILED",
          message: `Working directory '${targetRelCwd}' escapes workspace boundary '${canonicalHostPath}' (WORKSPACE_BOUNDARY_VIOLATION)`,
          details: { code: "WORKSPACE_BOUNDARY_VIOLATION" },
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Check script file target argument if present (first non-flag argument)
    let finalArgs = argv.slice(1);
    const scriptArgs = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (scriptArgs.length > 0) {
      const scriptTarget = scriptArgs[0]!;
      const resolvedScript = path.resolve(canonicalTargetCwd, scriptTarget);
      try {
        if (fs.existsSync(resolvedScript)) {
          const canonicalScript = fs.realpathSync(resolvedScript);
          const relScript = path.relative(canonicalHostPath, canonicalScript);
          if (relScript.startsWith("..") || path.isAbsolute(relScript)) {
            return {
              status: "FAILED",
              error: {
                code: "EXECUTION_FAILED",
                message: `Script target '${scriptTarget}' escapes workspace boundary (symlink or traversal detected) (WORKSPACE_BOUNDARY_VIOLATION)`,
                details: { code: "WORKSPACE_BOUNDARY_VIOLATION" },
              },
              durationMs: Date.now() - startTime,
            };
          }

          // Pre-Execution Oracle Integrity Check & Redirection
          const normRelScript = relScript.replace(/\\/g, "/");
          const isOracleScript =
            Boolean(this.trustedFixtureHashes?.has(normRelScript)) ||
            (this.protectedPatterns?.some((pat) => matchesProtectedPath(normRelScript, pat)) ?? false);

          if (isOracleScript) {
            // A. Validate current on-disk hash against trusted baseline
            if (this.trustedFixtureHashes?.has(normRelScript)) {
              const expectedHash = this.trustedFixtureHashes.get(normRelScript);
              const currentContent = fs.readFileSync(canonicalScript, "utf8");
              const currentHash = crypto.createHash("sha256").update(currentContent, "utf8").digest("hex");
              if (currentHash !== expectedHash) {
                return {
                  status: "FAILED",
                  error: {
                    code: "EXECUTION_FAILED",
                    message: `Oracle integrity violation: verification script '${normRelScript}' was modified on disk prior to execution (expected ${expectedHash}, got ${currentHash})`,
                    details: { code: "ASSERTION_FAILED", script: normRelScript },
                  },
                  durationMs: Date.now() - startTime,
                };
              }
            }

            // B. If oracleDir is configured and contains a pristine copy, redirect execution target to pristine copy
            if (this.oracleDir) {
              const pristineCopyPath = path.resolve(this.oracleDir, normRelScript);
              if (fs.existsSync(pristineCopyPath)) {
                const scriptIndex = finalArgs.indexOf(scriptTarget);
                if (scriptIndex !== -1) {
                  finalArgs = [...finalArgs];
                  finalArgs[scriptIndex] = pristineCopyPath;
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        return {
          status: "FAILED",
          error: {
            code: "EXECUTION_FAILED",
            message: `Failed to verify script containment: ${err instanceof Error ? err.message : String(err)}`,
            details: { code: "WORKSPACE_BOUNDARY_VIOLATION" },
          },
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 4. Hermetic Environment Scrubbing (Zero host secret leakage)
    const hermeticEnv: Record<string, string> = {
      NODE_ENV: "test",
      NODE_PATH: canonicalTargetCwd,
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "", // required on Windows for basic process spawn
      TEMP: canonicalTargetCwd,
      TMP: canonicalTargetCwd,
      EMERALD_EVALUATION: "1",
    };

    // 5. Hard Resource & Timeout Bounds
    const timeoutMs = Math.min(request.timeoutMs ?? 15000, 15000);
    const maxOutputBytes = Math.min(payload?.maxOutputBytes ?? 1024 * 1024, 1024 * 1024);

    const cmd = process.execPath;
    const args = finalArgs;

    try {
      const res = child_process.spawnSync(cmd, args, {
        cwd: canonicalTargetCwd,
        env: hermeticEnv,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        killSignal: "SIGKILL",
      });

      const durationMs = Date.now() - startTime;
      if (res.error) {
        if ((res.error as any).code === "ETIMEDOUT") {
          return {
            status: "TIMED_OUT",
            error: { code: "EXECUTION_TIMEOUT", message: `Process execution timed out after ${timeoutMs}ms` },
            durationMs,
          };
        }
      }

      const exitCode = typeof res.status === "number" ? res.status : (res.error ? 1 : 0);
      const stdout = res.stdout ?? "";
      const stderr = res.stderr ?? (res.error ? res.error.message : "");
      const combined = `${stdout}\n${stderr}`;
      const commandHash = crypto.createHash("sha256").update(combined, "utf8").digest("hex");

      const out: RunCommandOutput = {
        exitCode,
        stdout,
        stderr,
        durationMs,
        outputTruncated: false,
        commandHash,
      };

      return {
        status: "SUCCESS",
        output: out as unknown as TOutput,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return {
        status: "FAILED",
        error: { code: "EXECUTION_FAILED", message: err instanceof Error ? err.message : String(err) },
        durationMs,
      };
    }
  }
}

/** Backward-compatibility alias for ConstrainedHostExecutionProvider. */
export const LocalEvaluationExecutionProvider = ConstrainedHostExecutionProvider;

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
  /** Explicit opt-in for legacy unverified completion (must never produce VERIFIED_SUCCESS). Defaults to false for benchmark tasks. */
  readonly allowUnverifiedCompletion?: boolean;
  /** Optional execution provider override for command dispatch (defaults to LocalEvaluationExecutionProvider). */
  readonly executionProvider?: ExecutionProvider;
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
  /** Explicit opt-in for legacy unverified completion (must never produce VERIFIED_SUCCESS). Defaults to false for benchmark tasks. */
  readonly allowUnverifiedCompletion?: boolean;
  /** Optional execution provider override for command dispatch (defaults to LocalEvaluationExecutionProvider). */
  readonly executionProvider?: ExecutionProvider;
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
// 2B. Verification Authority & Execution-Attempt Correlation
// ============================================================================

export interface CorrelateVerificationEventsParams {
  readonly runId: string;
  readonly contract: MissionContract;
  readonly actions: readonly ActionSnapshot[];
  readonly getAttemptsForAction: (actionId: string) => readonly AttemptSnapshot[];
  readonly events: readonly PersistedEvent[];
  readonly fixtureHashes?: ReadonlyMap<string, string>;
  readonly workspaceDir?: string;
}

export interface SpecificationVerificationVerdict {
  readonly specId: string;
  readonly status: "VERIFIED" | "FAILED";
  readonly acceptedEvent?: PersistedEvent;
  readonly reasonCode?: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly targetAttempt?: {
    readonly actionId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
  };
}

/**
 * Pure, deterministic evaluation of verification event structural provenance and attempt-level correlation.
 *
 * Guarantees:
 * 1. Exact Run Correlation: e.runId === runId AND e.payload.runId === runId.
 * 2. Authoritative Verifier Provenance: e.producer === "application.verifier" AND verifierId === DeterministicVerifier.VERIFIER_ID.
 * 3. Schema Integrity: e.schemaVersion === 1.
 * 4. Contract Correlation: e.payload.details.contractId === contract.spec.contractId AND e.payload.details.contractVersion === contract.spec.version.
 * 5. Bound Specification Correlation: e.payload.specId belongs to contract.spec.verificationSpecs.
 * 6. Attempt-Level Correlation: Fails closed if attempt-level correlation metadata is missing or mismatched.
 *    Does not infer authority from event sequence ordering alone.
 * 7. Deduplication & Idempotency: Multiple verification events for the final execution attempt are idempotently resolved.
 */
export function correlateAuthoritativeVerificationEvents(
  params: CorrelateVerificationEventsParams
): Map<string, SpecificationVerificationVerdict> {
  const { runId, contract, actions, getAttemptsForAction, events } = params;
  const verdicts = new Map<string, SpecificationVerificationVerdict>();

  const boundSpecIds = new Set(contract.spec.verificationSpecs.map((s) => s.specId));

  const fixtureHashes = params.fixtureHashes;
  const workspaceDir = params.workspaceDir;

  for (const spec of contract.spec.verificationSpecs) {
    // Oracle Integrity Check: verify target script on disk matches immutable initial fixture hash
    if (spec.ruleKind === "EXIT_CODE_ZERO" && fixtureHashes && workspaceDir) {
      const expected = spec.expectedValue as Record<string, unknown> | undefined;
      const argv = Array.isArray(expected?.argv) ? (expected!.argv as readonly string[]) : undefined;
      if (argv && argv.length > 1) {
        const scriptRelPath = argv[1]!;
        if (fixtureHashes.has(scriptRelPath)) {
          const expectedHash = fixtureHashes.get(scriptRelPath)!;
          try {
            const diskPath = path.resolve(workspaceDir, scriptRelPath);
            if (fs.existsSync(diskPath)) {
              const diskContent = fs.readFileSync(diskPath, "utf8");
              const diskHash = crypto.createHash("sha256").update(diskContent, "utf8").digest("hex");
              if (diskHash !== expectedHash) {
                verdicts.set(spec.specId, {
                  specId: spec.specId,
                  status: "FAILED",
                  reasonCode: "ASSERTION_FAILED",
                  message: `Oracle integrity violation: verification script '${scriptRelPath}' was modified. Expected hash '${expectedHash}', observed '${diskHash}'.`,
                });
                continue;
              }
            } else {
              verdicts.set(spec.specId, {
                specId: spec.specId,
                status: "FAILED",
                reasonCode: "MISSING_EVIDENCE",
                message: `Oracle integrity violation: verification script '${scriptRelPath}' missing on disk.`,
              });
              continue;
            }
          } catch {
            verdicts.set(spec.specId, {
              specId: spec.specId,
              status: "FAILED",
              reasonCode: "ASSERTION_FAILED",
              message: `Oracle integrity violation: unable to read verification script '${scriptRelPath}'.`,
            });
            continue;
          }
        }
      }
    }

    // 1. Identify the target final execution attempt for this specification
    let targetAction: ActionSnapshot | undefined;
    if (spec.ruleKind === "EXIT_CODE_ZERO") {
      const expected = spec.expectedValue as Record<string, unknown> | undefined;
      const targetTool = (expected?.toolName as string) ?? "run_command";
      const targetArgv = Array.isArray(expected?.argv)
        ? (expected!.argv as readonly string[])
        : undefined;

      const matchingActions = actions.filter((a) => {
        if (a.toolName !== targetTool) return false;
        if (targetArgv) {
          const inputArgv = (a.inputPayload as any)?.argv;
          if (!Array.isArray(inputArgv)) return false;
          if (inputArgv.length !== targetArgv.length) return false;
          return inputArgv.every((v, i) => v === targetArgv[i]);
        }
        return true;
      });
      targetAction = matchingActions.length > 0 ? matchingActions[matchingActions.length - 1] : undefined;
    } else {
      // Output match or fallback rules: correlate with the last executed action
      targetAction = actions.length > 0 ? actions[actions.length - 1] : undefined;
    }

    let targetAttempt: AttemptSnapshot | undefined;
    if (targetAction) {
      const attempts = getAttemptsForAction(targetAction.actionId);
      targetAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
    }

    // 2. Filter and correlate events for this specification
    // Reject any event that violates structural provenance or attempt-level correlation.
    const candidateEvents = events.filter((e) => {
      // Check 1: Exact Run
      if (e.runId !== runId) return false;
      if (typeof e.payload !== "object" || e.payload === null) return false;
      const p = e.payload as any;
      if (p.runId !== runId) return false;

      // Check 2: Event Type & Schema Version
      if (e.eventType !== "verification.completed" || e.schemaVersion !== 1) return false;

      // Check 3: Authoritative Verifier Provenance (reject model-generated, evaluator-generated, etc.)
      if (e.producer !== "application.verifier") return false;
      if (typeof p.verifierId !== "string" || !p.verifierId.startsWith("deterministic-verifier")) return false;

      // Check 4: Bound Spec ID
      if (p.specId !== spec.specId || !boundSpecIds.has(p.specId)) return false;

      // Check 5: Contract Identity & Immutable Version Correlation
      const details = p.details;
      if (!details || typeof details !== "object") return false;
      if (details.contractId !== contract.spec.contractId || details.contractVersion !== contract.spec.version) {
        return false;
      }

      // Check 6: Attempt-Level Correlation Metadata (Must not be missing)
      // "Fail closed if attempt-level correlation metadata is missing or mismatched; do not infer authority from sequence ordering alone!"
      const hasAttemptNumber = typeof details.attemptNumber === "number";
      const hasAttemptId = typeof details.attemptId === "string" && details.attemptId.length > 0;
      if (!hasAttemptNumber && !hasAttemptId) {
        return false;
      }

      // Check 7: Correlation with Target Final Attempt
      if (targetAttempt) {
        if (hasAttemptNumber && details.attemptNumber !== targetAttempt.attemptNumber) {
          // Stale / previous execution attempt event
          return false;
        }
        if (hasAttemptId && details.attemptId !== targetAttempt.attemptId && details.attemptId !== "none") {
          // Stale attempt ID
          return false;
        }
        if (targetAction && typeof details.actionId === "string" && details.actionId !== targetAction.actionId && details.actionId !== "none") {
          // Stale action ID
          return false;
        }
      } else {
        // No execution attempt occurred (e.g. required command never executed)
        // Only accept failure events indicating missing command
        if (p.status !== "FAILED") {
          return false;
        }
      }

      return true;
    });

    // 3. Resolve authoritative verdict for this specification
    if (candidateEvents.length === 0) {
      // Missing authoritative verification event -> Fail Closed
      verdicts.set(spec.specId, {
        specId: spec.specId,
        status: "FAILED",
        reasonCode: "MISSING_EVIDENCE",
        message: targetAttempt
          ? `No authoritative verification event correlated with execution attempt ${targetAttempt.attemptNumber} (action ${targetAction?.actionId})`
          : `Required verification action was never executed for spec '${spec.specId}'`,
        targetAttempt: targetAttempt && targetAction
          ? {
              actionId: targetAction.actionId,
              attemptId: targetAttempt.attemptId,
              attemptNumber: targetAttempt.attemptNumber,
            }
          : undefined,
      });
    } else {
      // 4. Duplicate Event Handling & Verdict Resolution
      // If multiple events correlate with the final attempt, verify agreement or resolve deterministically
      const statuses = new Set(candidateEvents.map((e) => (e.payload as any).status));
      const hasFailure = statuses.has("FAILED");
      const resolvedStatus: "VERIFIED" | "FAILED" = hasFailure ? "FAILED" : "VERIFIED";

      // Pick the latest accepted event for audit details
      const acceptedEvent = candidateEvents[candidateEvents.length - 1]!;
      const p = acceptedEvent.payload as any;

      verdicts.set(spec.specId, {
        specId: spec.specId,
        status: resolvedStatus,
        acceptedEvent,
        reasonCode: p.reasonCode,
        message: p.message ?? (resolvedStatus === "VERIFIED" ? "Verified" : "Verification failed"),
        details: p.details,
        targetAttempt: targetAttempt && targetAction
          ? {
              actionId: targetAction.actionId,
              attemptId: targetAttempt.attemptId,
              attemptNumber: targetAttempt.attemptNumber,
            }
          : undefined,
      });
    }
  }

  return verdicts;
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

  const executionProvider =
    options.executionProvider ?? new LocalEvaluationExecutionProvider();

  const workerRuntime = new WorkerRuntime({
    workerId,
    coordinator,
    clock,
    workspacePort: workspaceAdapter,
    executionProvider,
    isIsolationAvailable: true,
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

  // Translate task success criteria into runtime VerificationSpecs
  const criteriaTranslation = translateEvaluationTaskCriteria(validatedTask);
  const verificationSpecs: VerificationSpec[] = criteriaTranslation.supported
    ? [...criteriaTranslation.verificationSpecs]
    : [];

  // Resolve whether unverified completion is authorized:
  // - If explicitly provided, respect caller's choice.
  // - For benchmark tasks (prefixed with 'task-rel-' or 'benchmark-'), default to false.
  // - If task has supported runtime verification specs, default to false (enforce sovereign gate).
  // - Otherwise, preserve legacy compatibility path for legacy tasks with unmapped workspace criteria.
  const isBenchmarkTask =
    validatedTask.taskId.startsWith("task-rel-") ||
    validatedTask.taskId.startsWith("benchmark-") ||
    validatedTask.taskId.startsWith("rel-");

  const allowUnverifiedCompletion =
    options.allowUnverifiedCompletion ??
    (!isBenchmarkTask && (!criteriaTranslation.supported || verificationSpecs.length === 0));

  const stepController = new AgentStepController({
    coordinator,
    stateStore: store,
    workerRuntime,
    agentBrain: liveBrain,
    clock,
    reflex: effectiveReflex,
    allowUnverifiedCompletion,
  });

  let wsHandle: any;
  let oracleDir: string | undefined;

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
      protectedPaths: validatedTask.mission.protectedPaths ?? ["test/**", "package.json"],
    });

    const contractLimits = validatedTask.mission.resourceLimits ?? {};
    const contract = createMissionContract({
      contractId: `eval-contract-${runtimeTask.taskId}`,
      version: 1,
      taskId: runtimeTask.taskId,
      policy,
      verificationSpecs,
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

    // 7. Populate Fixture Initial Files and Enforce Oracle Immutability
    oracleDir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-eval-oracle-"));
    const initialFixtureHashes = new Map<string, string>();
    const protectedPatterns = validatedTask.mission.protectedPaths ?? ["test/**", "package.json"];
    for (const [relPath, fileContent] of Object.entries(validatedTask.fixture.initialFiles)) {
      const fullPath = await workspaceAdapter.resolvePath(wsHandle.workspaceId, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileContent, "utf8");
      const hash = crypto.createHash("sha256").update(fileContent, "utf8").digest("hex");
      initialFixtureHashes.set(relPath, hash);
      const isProtected = protectedPatterns.some((pattern) => matchesProtectedPath(relPath, pattern));
      if (isProtected) {
        try { fs.chmodSync(fullPath, 0o444); } catch {}
        // Copy to pristine, agent-inaccessible oracle directory
        const oracleFullPath = path.resolve(oracleDir, relPath);
        fs.mkdirSync(path.dirname(oracleFullPath), { recursive: true });
        fs.writeFileSync(oracleFullPath, fileContent, "utf8");
        try { fs.chmodSync(oracleFullPath, 0o444); } catch {}
      }
    }

    if (executionProvider instanceof ConstrainedHostExecutionProvider) {
      executionProvider.configureOracleIntegrity({
        trustedFixtureHashes: initialFixtureHashes,
        protectedPatterns,
        oracleDir,
      });
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
          // Oracle Integrity Verification before post-run criteria execution
          if (argv.length > 1 && initialFixtureHashes.has(argv[1]!)) {
            const scriptRel = argv[1]!;
            const expectedHash = initialFixtureHashes.get(scriptRel)!;
            const fullScript = path.resolve(wsDir, scriptRel);
            if (fs.existsSync(fullScript)) {
              const currentContent = fs.readFileSync(fullScript, "utf8");
              const currentHash = crypto.createHash("sha256").update(currentContent, "utf8").digest("hex");
              if (currentHash !== expectedHash) {
                return {
                  exitCode: 1,
                  stdout: "",
                  stderr: `Oracle integrity violation: verification script '${scriptRel}' content hash mismatch. Expected ${expectedHash}, observed ${currentHash}.`,
                };
              }
            } else {
              return {
                exitCode: 1,
                stdout: "",
                stderr: `Oracle integrity violation: verification script '${scriptRel}' is missing on disk.`,
              };
            }
          }
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
      stepResult.terminalReason === "DEFERRED" ||
      stepResult.terminalReason === "COMPLETION_UNVERIFIABLE" ||
      stepResult.terminalReason === "POLICY_DENIED"
    ) {
      status = "BLOCKED";
      statusMessage = `Evaluation blocked by governance fencing: ${stepResult.terminalReason} (${stepResult.terminalMessage})`;
    } else if (stepResult.terminalReason === "CYCLE_DETECTED" || stepResult.terminalReason === "STAGNATION") {
      status = "FAILED";
      statusMessage = `Evaluation halted due to detected ineffective repetition: ${stepResult.terminalReason} (${stepResult.terminalMessage})`;
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

    // 10B. Compute Sovereign Milestone 2.25 Outcome Taxonomy
    const goalEntry = stepResult.transcript.find((entry) => entry.finishReason === "GOAL_REACHED");
    const modelCompletionClaim: ModelCompletionClaimObservation = {
      claimed: Boolean(goalEntry),
      stepNumber: goalEntry?.stepNumber,
      finishReason: goalEntry?.finishReason,
      rationale: goalEntry?.rationale,
      claimedAt: goalEntry?.timestamp,
    };

    // Authoritative Runtime Verification Event Provenance & Correlation
    const runEvents = store.getEventsForRun(run.runId);
    const wsRoot = await workspaceAdapter.resolvePath(wsHandle.workspaceId, ".");
    const verificationsMap = correlateAuthoritativeVerificationEvents({
      runId: run.runId,
      contract,
      actions: store.getActionsForRun(run.runId),
      getAttemptsForAction: (actionId) => store.getAttemptsForAction(actionId),
      events: runEvents,
      fixtureHashes: initialFixtureHashes,
      workspaceDir: wsRoot,
    });

    const finalSpecResults: VerificationResult[] = [];
    for (const spec of contract.spec.verificationSpecs) {
      const verdict = verificationsMap.get(spec.specId);
      if (verdict) {
        finalSpecResults.push({
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: spec.specId,
          status: verdict.status,
          evidenceIds: (verdict.acceptedEvent?.payload as any)?.evidenceIds ?? [],
          reasonCode: (verdict.reasonCode as any) ?? (verdict.status === "VERIFIED" ? undefined : "ASSERTION_FAILED"),
          message: verdict.message,
          details: verdict.details,
          verifiedAt: (verdict.acceptedEvent?.payload as any)?.verifiedAt ?? verdict.acceptedEvent?.timestamp ?? new Date().toISOString(),
        });
      }
    }

    const specCount = contract.spec.verificationSpecs.length;
    const finalPassedSpecs = finalSpecResults.filter((r) => r.status === "VERIFIED");
    const finalFailedSpecs = finalSpecResults.filter((r) => r.status === "FAILED");
    const allSpecsPassed = specCount > 0 && finalPassedSpecs.length === specCount;

    let verificationAssessment: TrialVerificationAssessment;

    if (stepResult.terminalReason === "COMPLETION_UNVERIFIABLE") {
      const isMissingSpecs = !criteriaTranslation.supported || specCount === 0;
      verificationAssessment = Object.freeze({
        decision: "UNVERIFIABLE",
        reasonCode: isMissingSpecs ? "NO_VERIFICATION_SPECS" : "VERIFIER_UNAVAILABLE",
        specCount,
        passedSpecCount: 0,
        failedSpecCount: 0,
        specResults: Object.freeze(finalSpecResults),
        criteriaResults: Object.freeze(criteriaResults),
        message: stepResult.terminalMessage,
      });
    } else if (specCount > 0) {
      if (stepResult.terminalReason === "COMPLETED" && allSpecsPassed) {
        verificationAssessment = Object.freeze({
          decision: "VERIFIED",
          reasonCode: "AUTHORITATIVE_VERIFIED",
          specCount,
          passedSpecCount: finalPassedSpecs.length,
          failedSpecCount: finalFailedSpecs.length,
          specResults: Object.freeze(finalSpecResults),
          criteriaResults: Object.freeze(criteriaResults),
          message: "Authoritative runtime verification passed for all contract specifications",
        });
      } else {
        const hasFailedSpecs = finalFailedSpecs.length > 0;
        verificationAssessment = Object.freeze({
          decision: "REJECTED",
          reasonCode: hasFailedSpecs ? "SPEC_ASSERTION_FAILED" : "EVIDENCE_DEFICIT",
          specCount,
          passedSpecCount: finalPassedSpecs.length,
          failedSpecCount: finalFailedSpecs.length,
          specResults: Object.freeze(finalSpecResults),
          criteriaResults: Object.freeze(criteriaResults),
          message: finalFailedSpecs[0]?.message ?? "Runtime verification specifications were not satisfied",
        });
      }
    } else {
      verificationAssessment = Object.freeze({
        decision: "UNVERIFIABLE",
        reasonCode: "NO_VERIFICATION_SPECS",
        specCount: 0,
        passedSpecCount: 0,
        failedSpecCount: 0,
        specResults: Object.freeze([]),
        criteriaResults: Object.freeze(criteriaResults),
        message: allowUnverifiedCompletion
          ? "Legacy unverified completion: no contract verification specifications declared"
          : "No contract verification specifications declared",
      });
    }

    const classifiedOutcome = classifyTrialOutcome({
      terminalReason: stepResult.terminalReason,
      terminalMessage: stepResult.terminalMessage,
      modelCompletionClaim,
      verificationAssessment,
      postRunCriteriaPassed: verificationPassed,
      allowUnverifiedCompletion,
    });

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
      finalOutcome: classifiedOutcome.outcome,
      completionClaim: modelCompletionClaim,
      verificationAssessment,
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
    if (oracleDir) {
      try {
        fs.rmSync(oracleDir, { recursive: true, force: true });
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
    allowUnverifiedCompletion: options.allowUnverifiedCompletion,
    executionProvider: options.executionProvider,
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
