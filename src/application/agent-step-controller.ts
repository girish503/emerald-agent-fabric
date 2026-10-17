/**
 * Governed Autonomous Agent Step Controller for Emerald Agent Fabric.
 *
 * Implements the bounded autonomous reasoning loop connecting:
 * Context Engine
 *     ↓
 * AgentBrainPort (untrusted reasoning)
 *     ↓
 * ActionProposal
 *     ↓
 * ProposalValidator (11-stage governance check)
 *     ↓
 * Action aggregate (authoritative domain intent)
 *     ↓
 * WorkerRuntime (governed lifecycle execution)
 *     ↓
 * Observation updates & loop control
 *
 * Architectural Invariants:
 * 1. Strictly Bounded: Controlled by finite budgets (maxSteps, maxWallClockMs, maxActions, maxConsecutiveFailures, maxProposalRejections).
 * 2. Authority Separation: StepController is an orchestrator. It does not validate schemas, authorize capabilities, or execute tools directly.
 * 3. Zero Direct Provider Calls: providerInvocationCount === 0 for StepController itself.
 * 4. Serial Action Invariant: At most one active Action per Run at any time.
 * 5. UNKNOWN Safety Stop: Halts immediately if execution uncertainty (UNKNOWN) occurs.
 * 6. Lease & Contract Governance: Enforces active lease fencing and active Mission Contract integrity before each step.
 * 7. Cancellable: Respects AbortSignal before and during execution steps without mutating terminal domain state unlawfully.
 * 8. Zero Persistence Mutation: Never bypasses domain or state store boundaries; introduces zero new database tables.
 */

import { ContextBudget } from "../domain/context.js";
import { ContextSnapshot } from "../domain/context.js";
import { ContextBudgetExceededError } from "../domain/errors.js";
import { ProposalRejectionReason } from "../domain/action-proposal.js";
import { staticToolRegistry, ToolName } from "../domain/tool.js";
import {
  createOutputPayloadEvidence,
  createProcessExitEvidence,
  type Evidence,
} from "../domain/evidence.js";
import {
  DeterministicVerifier,
  type VerificationResult,
} from "../domain/verification.js";
import type { MissionContract } from "../domain/mission-contract.js";
import {
  computeReflexContextHash,
  validateReflexDecision,
  type ReflexContext,
  type ReflexDecisionKind,
  type ReflexReasonCode,
} from "../domain/reflex.js";
import {
  createReflexEvidence,
  type ReflexEvidence,
} from "../domain/reflex-evidence.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { StateStorePort } from "../ports/state-store.port.js";
import { ToolRegistryPort } from "../ports/tool-registry.port.js";
import { ContextSourcePort } from "../ports/context-source.port.js";
import {
  AgentBrainPort,
  AgentBrainRequest,
  AgentBrainResult,
  BrainFinishReason,
} from "../ports/agent-brain.port.js";
import type { ReflexPort } from "../ports/reflex.port.js";
import { NoopReflex } from "../adapters/reflex/noop-reflex.js";
import { RunCoordinator } from "./run-coordinator.js";
import { WorkerActionStatus, WorkerRuntime } from "./worker-runtime.js";
import { ProposalValidator } from "./proposal-validator.js";
import { ContextSource } from "./context/context-source.js";
import { ContextEngine } from "./context/context-engine.js";

// ============================================================================
// 1. Budgets & Defaults
// ============================================================================

export interface StepControllerBudget {
  /** Maximum reasoning iterations allowed in this execution loop */
  readonly maxSteps: number;
  /** Maximum elapsed wall-clock milliseconds before the loop must terminate */
  readonly maxWallClockMs: number;
  /** Maximum number of logical Actions allowed to be executed */
  readonly maxActions: number;
  /** Maximum consecutive action execution failures before halting */
  readonly maxConsecutiveFailures: number;
  /** Maximum cumulative proposal validation rejections before halting */
  readonly maxProposalRejections: number;
}

export const DEFAULT_STEP_CONTROLLER_BUDGET: StepControllerBudget = Object.freeze({
  maxSteps: 10,
  maxWallClockMs: 60_000,
  maxActions: 10,
  maxConsecutiveFailures: 3,
  maxProposalRejections: 3,
});

// ============================================================================
// 2. Terminal Reasons & Transcript
// ============================================================================

export type StepControllerTerminalReason =
  | "COMPLETED"
  | "NO_ACTION"
  | "MAX_STEPS"
  | "MAX_WALL_CLOCK"
  | "MAX_ACTIONS"
  | "MAX_FAILURES"
  | "MAX_PROPOSAL_REJECTIONS"
  | "CANCELLED"
  | "LEASE_LOST"
  | "CONTRACT_REVOKED"
  | "UNKNOWN_EXECUTION"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "BRAIN_FAILURE"
  | "DEFERRED";

export interface StepTranscriptEntry {
  readonly stepNumber: number;
  readonly contextSnapshotId: string;
  readonly contextHash: string;
  readonly contextEstimatedTokens: number;
  readonly contextBytes: number;
  readonly contextObservationsCount: number;
  readonly proposalId?: string;
  readonly toolName?: ToolName;
  readonly inputHash?: string;
  readonly inputPayload?: unknown;
  readonly rationale?: string;
  readonly finishReason?: BrainFinishReason;
  readonly proposalValid: boolean;
  readonly proposalRejectionReason?: ProposalRejectionReason;
  readonly proposalRejectionMessage?: string;
  readonly reflexDecision?: ReflexDecisionKind;
  readonly reflexReasonCode?: ReflexReasonCode;
  readonly reflexRationale?: string;
  readonly reflexEvidence?: ReflexEvidence;
  readonly reflexError?: string;
  readonly reflexDurationMs?: number;
  readonly actionId?: string;
  readonly actionStatus?: WorkerActionStatus;
  readonly actionOutput?: unknown;
  readonly actionError?: unknown;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface StepControllerResult {
  readonly runId: string;
  readonly taskId: string;
  readonly terminalReason: StepControllerTerminalReason;
  readonly terminalMessage: string;
  readonly totalSteps: number;
  readonly totalActions: number;
  readonly totalProposalRejections: number;
  readonly totalConsecutiveFailures: number;
  readonly totalWallClockMs: number;
  readonly transcript: readonly StepTranscriptEntry[];
  readonly lastContextSnapshot?: ContextSnapshot;
}

// ============================================================================
// 3. Controller Configuration & Parameters
// ============================================================================

export interface AgentStepControllerOptions {
  readonly coordinator: RunCoordinator;
  readonly stateStore: StateStorePort;
  readonly workerRuntime: WorkerRuntime;
  readonly agentBrain: AgentBrainPort;
  readonly proposalValidator?: ProposalValidator;
  readonly toolRegistry?: ToolRegistryPort;
  readonly contextSource?: ContextSourcePort;
  readonly clock?: ClockPort;
  readonly defaultBudget?: Partial<StepControllerBudget>;
  readonly reflex?: ReflexPort;
}


export interface RunStepLoopParams {
  readonly runId: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly workspace?: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly containerMountPath?: string;
  };
  readonly budget?: Partial<StepControllerBudget>;
  readonly contextBudget?: ContextBudget;
  readonly abortSignal?: AbortSignal;
}

// ============================================================================
// 4. Step Controller Implementation
// ============================================================================

export class AgentStepController {
  private readonly coordinator: RunCoordinator;
  private readonly stateStore: StateStorePort;
  private readonly workerRuntime: WorkerRuntime;
  private readonly agentBrain: AgentBrainPort;
  private readonly proposalValidator: ProposalValidator;
  private readonly toolRegistry: ToolRegistryPort;
  private readonly contextSource: ContextSourcePort;
  private readonly clock: ClockPort;
  private readonly defaultBudget: StepControllerBudget;
  private readonly reflex: ReflexPort;

  constructor(options: AgentStepControllerOptions) {
    this.coordinator = options.coordinator;
    this.stateStore = options.stateStore;
    this.workerRuntime = options.workerRuntime;
    this.agentBrain = options.agentBrain;
    this.toolRegistry = options.toolRegistry ?? staticToolRegistry;
    this.clock = options.clock ?? new SystemClock();
    this.reflex = options.reflex ?? new NoopReflex();

    this.proposalValidator =
      options.proposalValidator ??
      new ProposalValidator({
        coordinator: this.coordinator,
        stateStore: this.stateStore,
        toolRegistry: this.toolRegistry,
        clock: this.clock,
      });

    this.contextSource =
      options.contextSource ?? new ContextSource(this.stateStore);

    this.defaultBudget = Object.freeze({
      ...DEFAULT_STEP_CONTROLLER_BUDGET,
      ...options.defaultBudget,
    });
  }


  /**
   * Executes the bounded autonomous step loop for an actively leased Run.
   */
  async runStepLoop(params: RunStepLoopParams): Promise<StepControllerResult> {
    const { runId, workerId, leaseId } = params;

    if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
      throw new Error("runStepLoop requires a non-empty runId");
    }
    if (!workerId || typeof workerId !== "string" || workerId.trim().length === 0) {
      throw new Error("runStepLoop requires a non-empty workerId");
    }
    if (!leaseId || typeof leaseId !== "string" || leaseId.trim().length === 0) {
      throw new Error("runStepLoop requires a non-empty leaseId");
    }

    const effectiveBudget: StepControllerBudget = Object.freeze({
      ...this.defaultBudget,
      ...params.budget,
    });

    const startTime = this.clock.now().getTime();
    const transcript: StepTranscriptEntry[] = [];
    let stepCount = 0;
    let actionCount = 0;
    let consecutiveFailures = 0;
    let proposalRejections = 0;
    let lastContextSnapshot: ContextSnapshot | undefined;

    // Helper to assemble final StepControllerResult
    const assembleResult = (
      reason: StepControllerTerminalReason,
      message: string,
      taskId: string
    ): StepControllerResult => {
      const totalWallClockMs = this.clock.now().getTime() - startTime;
      return Object.freeze({
        runId,
        taskId,
        terminalReason: reason,
        terminalMessage: message,
        totalSteps: stepCount,
        totalActions: actionCount,
        totalProposalRejections: proposalRejections,
        totalConsecutiveFailures: consecutiveFailures,
        totalWallClockMs,
        transcript: Object.freeze([...transcript]),
        ...(lastContextSnapshot ? { lastContextSnapshot } : {}),
      });
    };

    // Initial pre-loop authoritative validation
    const initialRun = this.stateStore.getRun(runId);
    if (!initialRun) {
      return assembleResult("LEASE_LOST", `Run '${runId}' not found in state store`, "unknown");
    }
    const taskId = initialRun.taskId;

    // ------------------------------------------------------------------------
    // The Autonomous Step Loop
    // ------------------------------------------------------------------------
    while (true) {
      const nowMs = this.clock.now().getTime();
      const elapsedMs = nowMs - startTime;

      // 1. Check Cancellation
      if (params.abortSignal?.aborted) {
        return assembleResult("CANCELLED", "Autonomous loop aborted by AbortSignal", taskId);
      }

      // 2. Check Wall-Clock Budget
      if (elapsedMs >= effectiveBudget.maxWallClockMs) {
        return assembleResult(
          "MAX_WALL_CLOCK",
          `Wall clock ceiling reached (${elapsedMs}ms >= ${effectiveBudget.maxWallClockMs}ms)`,
          taskId
        );
      }

      // 3. Check Step Budget
      if (stepCount >= effectiveBudget.maxSteps) {
        return assembleResult(
          "MAX_STEPS",
          `Maximum reasoning steps ceiling reached (${stepCount} >= ${effectiveBudget.maxSteps})`,
          taskId
        );
      }

      // 4. Check Action Budget
      if (actionCount >= effectiveBudget.maxActions) {
        return assembleResult(
          "MAX_ACTIONS",
          `Maximum action execution ceiling reached (${actionCount} >= ${effectiveBudget.maxActions})`,
          taskId
        );
      }

      // 5. Check Proposal Rejection Budget
      if (proposalRejections >= effectiveBudget.maxProposalRejections) {
        return assembleResult(
          "MAX_PROPOSAL_REJECTIONS",
          `Maximum proposal rejections ceiling reached (${proposalRejections} >= ${effectiveBudget.maxProposalRejections})`,
          taskId
        );
      }

      // 6. Check Consecutive Failures Budget
      if (consecutiveFailures >= effectiveBudget.maxConsecutiveFailures) {
        return assembleResult(
          "MAX_FAILURES",
          `Maximum consecutive action failures ceiling reached (${consecutiveFailures} >= ${effectiveBudget.maxConsecutiveFailures})`,
          taskId
        );
      }

      // 7. Verify Authoritative Run & Lease Ownership
      const currentRun = this.stateStore.getRun(runId);
      if (!currentRun) {
        return assembleResult("LEASE_LOST", `Run '${runId}' not found during loop step`, taskId);
      }

      if (currentRun.leaseId !== leaseId || currentRun.currentWorkerId !== workerId) {
        return assembleResult(
          "LEASE_LOST",
          `Worker lease ownership lost for run '${runId}' (expected lease: '${currentRun.leaseId}', held: '${leaseId}')`,
          taskId
        );
      }

      if (currentRun.leaseExpiresAt && this.clock.nowIso() >= currentRun.leaseExpiresAt) {
        return assembleResult(
          "LEASE_LOST",
          `Worker lease expired at '${currentRun.leaseExpiresAt}'`,
          taskId
        );
      }

      const terminalStatuses: readonly string[] = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"];
      if (terminalStatuses.includes(currentRun.status)) {
        return assembleResult(
          "COMPLETED",
          `Run reached terminal status '${currentRun.status}'`,
          taskId
        );
      }

      // 8. Verify Mission Contract Lifecycle
      if (!currentRun.contractBinding) {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Run '${runId}' has no bound Mission Contract`,
          taskId
        );
      }

      const contract = this.stateStore.getContract(
        currentRun.contractBinding.contractId,
        currentRun.contractBinding.version
      );
      if (!contract || contract.lifecycle.status !== "ACTIVE") {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Bound Mission Contract '${currentRun.contractBinding.contractId}' is not ACTIVE`,
          taskId
        );
      }

      // ----------------------------------------------------------------------
      // Begin Step Execution
      // ----------------------------------------------------------------------
      stepCount++;
      const stepStartTime = this.clock.now().getTime();
      const stepTimestamp = this.clock.nowIso();

      // Step A: Build Authoritative ContextSnapshot
      let contextSnapshot: ContextSnapshot;
      try {
        const candidates = await this.contextSource.gatherCandidateObservations(runId);
        contextSnapshot = ContextEngine.build({
          runId,
          taskId,
          candidates,
          budget: params.contextBudget,
          createdAt: stepTimestamp,
        });
        lastContextSnapshot = contextSnapshot;
      } catch (err: unknown) {
        if (err instanceof ContextBudgetExceededError) {
          return assembleResult("CONTEXT_BUDGET_EXCEEDED", err.message, taskId);
        }
        throw err;
      }

      // Step B: Query Agent Brain (Untrusted Model Output)
      let brainResult: AgentBrainResult;
      try {
        const brainRequest: AgentBrainRequest = {
          runId,
          contextSnapshot,
          availableTools: this.toolRegistry.listTools(),
          sequenceNumber: stepCount,
          abortSignal: params.abortSignal,
        };
        brainResult = await this.agentBrain.proposeAction(brainRequest);
      } catch (err: unknown) {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "BRAIN_FAILURE",
          `Agent Brain invocation failed: ${err instanceof Error ? err.message : String(err)}`,
          taskId
        );
      }

      // Step C: Inspect Brain Termination Signals
      if (brainResult.finishReason === "ERROR") {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: "ERROR",
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "BRAIN_FAILURE",
          `Agent Brain reported error: ${brainResult.error ?? "unknown error"}`,
          taskId
        );
      }

      if (brainResult.finishReason === "CONTEXT_LIMIT") {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: "CONTEXT_LIMIT",
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "CONTEXT_BUDGET_EXCEEDED",
          "Agent Brain reached context limit ceiling",
          taskId
        );
      }

      if (brainResult.finishReason === "GOAL_REACHED") {
        // Authoritative Physical Verification Completion Gate (Phase 13B)
        // MODEL_GOAL_REACHED != RUN_COMPLETED
        // isGoalReached: true is strictly an untrusted model proposal.
        const verificationEvaluation = this.evaluateCompletionVerification(
          runId,
          contract
        );

        if (!verificationEvaluation.verified) {
          proposalRejections++;
          transcript.push(
            Object.freeze({
              stepNumber: stepCount,
              contextSnapshotId: contextSnapshot.snapshotId,
              contextHash: contextSnapshot.contextHash,
              contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
              contextBytes: contextSnapshot.totalBytes,
              contextObservationsCount: contextSnapshot.observations.length,
              finishReason: "GOAL_REACHED",
              proposalValid: false,
              proposalRejectionReason: "UNVERIFIED_COMPLETION_CLAIM",
              proposalRejectionMessage: `Goal reached claim rejected: ${verificationEvaluation.failureReason}`,
              durationMs: this.clock.now().getTime() - stepStartTime,
              timestamp: stepTimestamp,
            })
          );

          // Goal claim rejected: bounded next model step if budget permits
          continue;
        }

        // Verified goal reached: physical verification invariant satisfied
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: "GOAL_REACHED",
            proposalValid: true,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );

        return assembleResult(
          "COMPLETED",
          "Agent Brain concluded step loop with verified completion (GOAL_REACHED)",
          taskId
        );
      }

      if (!brainResult.proposal) {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            finishReason: brainResult.finishReason,
            proposalValid: false,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );

        return assembleResult(
          "NO_ACTION",
          `Agent Brain produced no action proposal (${brainResult.finishReason})`,
          taskId
        );
      }

      // Re-verify contract active status before proposal validation
      const activeContract = this.stateStore.getContract(
        currentRun.contractBinding.contractId,
        currentRun.contractBinding.version
      );
      if (!activeContract || activeContract.lifecycle.status !== "ACTIVE") {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Bound Mission Contract '${currentRun.contractBinding.contractId}' is not ACTIVE`,
          taskId
        );
      }

      // Step D: Validate ActionProposal (11-Stage Pipeline)
      const validationResult = this.proposalValidator.validate(brainResult.proposal, {
        runId,
        contextSnapshot,
        workerId,
        leaseId,
        run: currentRun,
        contract: activeContract,
      });

      if (!validationResult.valid) {
        proposalRejections++;
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: (brainResult.proposal as any)?.proposalId,
            toolName: (brainResult.proposal as any)?.toolName,
            inputPayload: (brainResult.proposal as any)?.inputPayload,
            rationale: (brainResult.proposal as any)?.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: false,
            proposalRejectionReason: validationResult.reason,
            proposalRejectionMessage: validationResult.message,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );

        // Rejection does not execute physical actions. Loop continues if budget permits.
        continue;
      }

      // Step D.2: Evaluate Validated Proposal via Governed Reflex Interceptor
      const rawReflexContext: ReflexContext = {
        runId,
        taskId,
        stepNumber: stepCount,
        taskDescription: activeContract.spec.taskId,
        failureCount: consecutiveFailures,
        recentActionHistory: transcript
          .filter((t) => t.toolName)
          .slice(-10)
          .map((t) => ({
            toolName: t.toolName!,
            status: t.actionStatus ?? "UNKNOWN",
            sequenceNumber: t.stepNumber,
            inputHash: t.inputHash,
            failureReason: t.actionError ? String(t.actionError) : undefined,
          })),
        workspacePath: params.workspace?.hostPath,
        resourceUsage: {
          elapsedWallClockMs: elapsedMs,
          actionsExecuted: actionCount,
          stepsExecuted: stepCount,
        },
      };
      const reflexContextHash = computeReflexContextHash(rawReflexContext);
      const reflexContext: ReflexContext = Object.freeze({
        ...rawReflexContext,
        contextHash: reflexContextHash,
      });

      let reflexDecisionResult;
      let reflexEvidence: ReflexEvidence | undefined = undefined;
      let reflexDurationMs: number | undefined = undefined;

      const reflexStartMonotonic = performance.now();
      try {
        const unvalidatedDecision = await this.reflex.evaluate(
          validationResult.proposal,
          reflexContext
        );
        reflexDurationMs = Math.max(0, Math.round(performance.now() - reflexStartMonotonic));
        reflexDecisionResult = validateReflexDecision(unvalidatedDecision);

        if (!(this.reflex instanceof NoopReflex)) {
          try {
            reflexEvidence = createReflexEvidence({
              runId,
              sequenceNumber: stepCount,
              proposal: validationResult.proposal,
              context: reflexContext,
              decision: reflexDecisionResult,
              reflexImplementation: (this.reflex as any).name ?? "RuleBasedReflex",
              ruleConfigurationHash: (this.reflex as any).activeConfigHash ?? "0".repeat(64),
              ruleConfig: (this.reflex as any).activeConfig,
              evaluatedAt: stepTimestamp,
            });
          } catch {
            // Defense-in-depth: do not crash reasoning loop if evidence construction fails
          }
        }
      } catch (err: unknown) {
        if (
          params.abortSignal?.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return assembleResult(
            "CANCELLED",
            "Execution loop cancelled via AbortSignal during Reflex evaluation",
            taskId
          );
        }

        const elapsedReflexMs = Math.max(0, Math.round(performance.now() - reflexStartMonotonic));
        proposalRejections++;
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: validationResult.proposal.proposalId,
            toolName: validationResult.proposal.toolName,
            inputPayload: validationResult.proposal.inputPayload,
            rationale: validationResult.proposal.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: true,
            reflexReasonCode: "UNSUPPORTED_ACTION",
            reflexError: err instanceof Error ? err.message : String(err),
            reflexDurationMs: elapsedReflexMs,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        continue;
      }

      if (reflexDecisionResult.decision === "REJECT") {
        proposalRejections++;
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: validationResult.proposal.proposalId,
            toolName: validationResult.proposal.toolName,
            inputPayload: validationResult.proposal.inputPayload,
            rationale: validationResult.proposal.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: true,
            reflexDecision: "REJECT",
            reflexReasonCode: reflexDecisionResult.reasonCode,
            reflexRationale: reflexDecisionResult.rationale,
            reflexEvidence,
            reflexDurationMs,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        continue;
      }

      if (reflexDecisionResult.decision === "DEFER") {
        transcript.push(
          Object.freeze({
            stepNumber: stepCount,
            contextSnapshotId: contextSnapshot.snapshotId,
            contextHash: contextSnapshot.contextHash,
            contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
            contextBytes: contextSnapshot.totalBytes,
            contextObservationsCount: contextSnapshot.observations.length,
            proposalId: validationResult.proposal.proposalId,
            toolName: validationResult.proposal.toolName,
            inputPayload: validationResult.proposal.inputPayload,
            rationale: validationResult.proposal.rationale,
            finishReason: brainResult.finishReason,
            proposalValid: true,
            reflexDecision: "DEFER",
            reflexReasonCode: reflexDecisionResult.reasonCode,
            reflexRationale: reflexDecisionResult.rationale,
            reflexEvidence,
            reflexDurationMs,
            durationMs: this.clock.now().getTime() - stepStartTime,
            timestamp: stepTimestamp,
          })
        );
        return assembleResult(
          "DEFERRED",
          `Reflex deferred proposal execution [${reflexDecisionResult.reasonCode}]: ${
            reflexDecisionResult.rationale ?? reflexDecisionResult.reasonCode
          }`,
          taskId
        );
      }

      // Step E: Create Authoritative Domain Action Aggregate
      const { action } = this.proposalValidator.createActionFromProposal(
        validationResult,
        currentRun,
        { now: stepTimestamp }
      );

      // Pre-Execution Fencing & Cancellation Check
      if (params.abortSignal?.aborted) {
        return assembleResult(
          "CANCELLED",
          `Aborted prior to executing Action '${action.actionId}'`,
          taskId
        );
      }

      // Pre-Execution Wall Clock Ceiling Check
      const preExecElapsedMs = this.clock.now().getTime() - startTime;
      if (preExecElapsedMs >= effectiveBudget.maxWallClockMs) {
        return assembleResult(
          "MAX_WALL_CLOCK",
          `Wall clock ceiling reached prior to executing Action '${action.actionId}' (${preExecElapsedMs}ms >= ${effectiveBudget.maxWallClockMs}ms)`,
          taskId
        );
      }

      // Pre-Execution Action Ceiling Check
      if (actionCount >= effectiveBudget.maxActions) {
        return assembleResult(
          "MAX_ACTIONS",
          `Maximum action execution ceiling reached prior to executing Action '${action.actionId}' (${actionCount} >= ${effectiveBudget.maxActions})`,
          taskId
        );
      }

      // Pre-Execution Lease Ownership & Expiration Check
      const preExecRun = this.stateStore.getRun(runId);
      if (!preExecRun || preExecRun.leaseId !== leaseId || preExecRun.currentWorkerId !== workerId) {
        return assembleResult(
          "LEASE_LOST",
          `Lease lost prior to executing Action '${action.actionId}'`,
          taskId
        );
      }
      if (preExecRun.leaseExpiresAt && this.clock.nowIso() >= preExecRun.leaseExpiresAt) {
        return assembleResult(
          "LEASE_LOST",
          `Lease expired prior to executing Action '${action.actionId}' (expired at '${preExecRun.leaseExpiresAt}')`,
          taskId
        );
      }

      // Pre-Execution Mission Contract Active Status Check
      const preExecContract = this.stateStore.getContract(
        currentRun.contractBinding.contractId,
        currentRun.contractBinding.version
      );
      if (!preExecContract || preExecContract.lifecycle.status !== "ACTIVE") {
        return assembleResult(
          "CONTRACT_REVOKED",
          `Mission Contract '${currentRun.contractBinding.contractId}' is no longer ACTIVE prior to executing Action '${action.actionId}'`,
          taskId
        );
      }

      // Step F: Execute Action via WorkerRuntime (Serial Execution)
      actionCount++;
      const actionResult = await this.workerRuntime.executeAction({
        runId,
        actionId: action.actionId,
        sequenceNumber: action.sequenceNumber,
        toolName: action.toolName,
        inputPayload: action.inputPayload,
        leaseId,
        workspace: params.workspace,
        timeoutMs: contract.spec.resourceLimits.timeoutMs,
        maxOutputBytes: contract.spec.resourceLimits.maxOutputBytes,
        abortSignal: params.abortSignal,
      });

      // Record Completed Step Transcript
      transcript.push(
        Object.freeze({
          stepNumber: stepCount,
          contextSnapshotId: contextSnapshot.snapshotId,
          contextHash: contextSnapshot.contextHash,
          contextEstimatedTokens: contextSnapshot.totalEstimatedTokens,
          contextBytes: contextSnapshot.totalBytes,
          contextObservationsCount: contextSnapshot.observations.length,
          proposalId: validationResult.proposal.proposalId,
          toolName: validationResult.proposal.toolName,
          inputHash: action.inputHash,
          inputPayload: action.inputPayload,
          rationale: validationResult.proposal.rationale,
          finishReason: brainResult.finishReason,
          proposalValid: true,
          reflexDecision: reflexDecisionResult.decision,
          reflexReasonCode: reflexDecisionResult.reasonCode,
          reflexRationale: reflexDecisionResult.rationale,
          reflexEvidence,
          reflexDurationMs,
          actionId: action.actionId,
          actionStatus: actionResult.status,
          actionOutput: actionResult.output,
          actionError: actionResult.error,
          durationMs: this.clock.now().getTime() - stepStartTime,
          timestamp: stepTimestamp,
        })
      );


      // Step G: Process Action Execution Outcome
      if (actionResult.status === "UNKNOWN") {
        // Critical UNKNOWN safety stop: outcome is physically uncertain
        return assembleResult(
          "UNKNOWN_EXECUTION",
          `Action '${action.actionId}' produced UNKNOWN execution outcome: physical side effects are uncertain`,
          taskId
        );
      }

      if (actionResult.status === "FENCED") {
        return assembleResult(
          "LEASE_LOST",
          `Action '${action.actionId}' execution fenced due to lost lease`,
          taskId
        );
      }

      if (actionResult.status === "CANCELLED") {
        return assembleResult(
          "CANCELLED",
          `Action '${action.actionId}' was cancelled during execution`,
          taskId
        );
      }

      if (actionResult.status === "FAILED" || actionResult.status === "TIMED_OUT") {
        consecutiveFailures++;
      } else if (actionResult.status === "SUCCEEDED") {
        consecutiveFailures = 0;
      }
    }
  }

  /**
   * Authoritative Completion Verification Gate (Phase 13B).
   *
   * Enforces the unskippable invariant:
   *   MODEL_GOAL_REACHED != RUN_COMPLETED
   *
   * Verifies that all required verification specifications in the bound MissionContract
   * have executed and succeeded based strictly on durable Action and Attempt state
   * in SQLite.
   */
  private evaluateCompletionVerification(
    runId: string,
    contract: MissionContract
  ): {
    readonly verified: boolean;
    readonly failureReason?: string;
    readonly specResults: readonly VerificationResult[];
  } {
    const vSpecs = contract.spec.verificationSpecs;
    if (!vSpecs || vSpecs.length === 0) {
      return { verified: true, specResults: [] };
    }

    const actions = this.stateStore.getActionsForRun(runId);
    const specResults: VerificationResult[] = [];

    for (const spec of vSpecs) {
      const expected = spec.expectedValue as Record<string, unknown> | undefined;

      // 1. Check optional prerequisite: source mutation (write_file)
      if (expected?.requireMutation) {
        const hasSuccessfulWrite = actions.some((a) => {
          if (a.toolName !== "write_file") return false;
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          return attempts.some((att) => att.status === "SUCCEEDED");
        });
        if (!hasSuccessfulWrite) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: "Prerequisite source mutation was not performed (no successful 'write_file' found).",
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
          };
        }
      }

      // 2. Check optional prerequisite: diff inspection (git_diff)
      if (expected?.requireDiff) {
        const hasSuccessfulDiff = actions.some((a) => {
          if (a.toolName !== "git_diff") return false;
          const attempts = this.stateStore.getAttemptsForAction(a.actionId);
          return attempts.some((att) => att.status === "SUCCEEDED");
        });
        if (!hasSuccessfulDiff) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: "Prerequisite diff inspection was not performed (no successful 'git_diff' found).",
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
          };
        }
      }

      // 3. Rule Kind Evaluation
      if (spec.ruleKind === "EXIT_CODE_ZERO") {
        const targetTool = (expected?.toolName as string) ?? "run_command";
        const targetArgv = Array.isArray(expected?.argv)
          ? (expected!.argv as readonly string[])
          : undefined;

        // Find actions matching target verification tool and argv
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

        if (matchingActions.length === 0) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: `Required verification command '${targetTool}${targetArgv ? " " + JSON.stringify(targetArgv) : ""}' was never executed.`,
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
          };
        }

        // Evaluate the latest matching action and its latest attempt
        const latestAction = matchingActions[matchingActions.length - 1];
        if (!latestAction) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: `Required verification command was not found.`,
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
          };
        }

        const attempts = this.stateStore.getAttemptsForAction(latestAction.actionId);
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
        if (!latestAttempt) {
          const failureResult: VerificationResult = Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds: [],
            reasonCode: "MISSING_EVIDENCE",
            message: `Verification action '${latestAction.actionId}' has no recorded attempts.`,
            verifiedAt: this.clock.nowIso(),
          });
          this.coordinator.recordVerificationResult(runId, failureResult);
          return {
            verified: false,
            failureReason: failureResult.message,
            specResults: [...specResults, failureResult],
          };
        }

        const exitCode =
          latestAttempt.exitCode !== null && latestAttempt.exitCode !== undefined
            ? latestAttempt.exitCode
            : (latestAttempt.outputPayload as any)?.exitCode !== undefined
            ? (latestAttempt.outputPayload as any).exitCode
            : null;

        const evidenceList: Evidence[] = [];
        const exitEvidence = createProcessExitEvidence(runId, {
          exitCode: typeof exitCode === "number" ? exitCode : null,
          signal: null,
        });
        evidenceList.push(exitEvidence);
        this.coordinator.recordEvidence(runId, exitEvidence);

        if (latestAttempt.outputPayload !== null && latestAttempt.outputPayload !== undefined) {
          const outputEvidence = createOutputPayloadEvidence(runId, latestAttempt.outputPayload);
          evidenceList.push(outputEvidence);
          this.coordinator.recordEvidence(runId, outputEvidence);
        }

        const verificationResult = DeterministicVerifier.verify(
          evidenceList,
          spec,
          this.clock.nowIso()
        );
        this.coordinator.recordVerificationResult(runId, verificationResult);
        specResults.push(verificationResult);

        if (verificationResult.status !== "VERIFIED") {
          return {
            verified: false,
            failureReason: `Verification rule 'EXIT_CODE_ZERO' failed: ${verificationResult.message}`,
            specResults,
          };
        }
      } else {
        // Fallback for EXACT_OUTPUT_MATCH or OUTPUT_HASH_MATCH
        const lastAction = actions[actions.length - 1];
        const attempts = lastAction ? this.stateStore.getAttemptsForAction(lastAction.actionId) : [];
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;

        const evidenceList: Evidence[] = [];
        if (latestAttempt?.outputPayload !== null && latestAttempt?.outputPayload !== undefined) {
          const outputEvidence = createOutputPayloadEvidence(runId, latestAttempt.outputPayload);
          evidenceList.push(outputEvidence);
          this.coordinator.recordEvidence(runId, outputEvidence);
        }

        const verificationResult = DeterministicVerifier.verify(
          evidenceList,
          spec,
          this.clock.nowIso()
        );
        this.coordinator.recordVerificationResult(runId, verificationResult);
        specResults.push(verificationResult);

        if (verificationResult.status !== "VERIFIED") {
          return {
            verified: false,
            failureReason: `Verification rule '${spec.ruleKind}' failed: ${verificationResult.message}`,
            specResults,
          };
        }
      }
    }

    return { verified: true, specResults };
  }
}
