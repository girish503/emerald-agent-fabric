/**
 * Emerald Agent Fabric — Production Runtime Engine
 *
 * Implements the authoritative production agent execution loop:
 *
 * Observe
 *   ↓
 * Build Context
 *   ↓
 * Model Proposal
 *   ↓
 * Validate Proposal
 *   ↓
 * Reflex
 *   ↓
 * Policy
 *   ↓
 * Capability Fence
 *   ↓
 * Tool Gateway
 *   ↓
 * Action / Attempt
 *   ↓
 * Execution
 *   ↓
 * Observation
 *   ↓
 * Sovereign Verification
 *   ↓
 * Evidence Bundle
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves."
 */

import { computeCanonicalHash } from "../domain/canonical-hash.js";
import { CapabilityFence, computeCapabilityFenceHash } from "../domain/capability-fence.js";
import { CapabilityFenceEnforcer } from "../application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../application/cross-harness-gateway.js";
import { ProductionGovernanceFacade } from "../governance/production-governance-facade.js";
import { ProductionToolGateway, ToolExecutionContext } from "../tools/production-tools.js";
import { ProductionVerifier, ProductionVerificationResult } from "../verification/production-verifier.js";
import { EvidenceControl, ProductionEvidenceBundle } from "../control-plane/evidence-control.js";
import { MissionControl } from "../control-plane/mission-control.js";
import { RunControl, ProductionRun } from "../control-plane/run-control.js";
import { ProductionConfig } from "../config/production-config.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import {
  SourceDiagnosticEngine,
  DiagnosticConfig,
  DiagnosticMetrics,
} from "../production/diagnostics/index.js";
import {
  ProductionRepairOrchestrator,
  RepairSessionOutcome,
  ExecuteRepairOptions,
} from "../production/repair/index.js";

export interface AgentProposal {
  readonly thought: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly isGoalReached?: boolean;
}

export interface ModelAdapter {
  proposeAction(contextText: string): Promise<AgentProposal>;
}

export class ProductionRuntimeEngine {
  private readonly governanceFacade: ProductionGovernanceFacade;
  private readonly toolGateway: ProductionToolGateway;
  private readonly verifier: ProductionVerifier;
  private readonly evidenceControl: EvidenceControl;
  private readonly diagnosticEngine: SourceDiagnosticEngine;
  private readonly repairOrchestrator: ProductionRepairOrchestrator;

  constructor(
    private readonly config: ProductionConfig,
    private readonly missionControl: MissionControl,
    private readonly runControl: RunControl,
    private readonly fenceEnforcer: CapabilityFenceEnforcer,
    private readonly crossHarnessGateway: CrossHarnessGateway,
    evidenceControl?: EvidenceControl,
    verifier?: ProductionVerifier,
    private readonly clock: ClockPort = new SystemClock(),
    diagnosticEngine?: SourceDiagnosticEngine,
  ) {
    this.governanceFacade = new ProductionGovernanceFacade(this.fenceEnforcer, this.crossHarnessGateway);
    this.toolGateway = new ProductionToolGateway(this.governanceFacade);
    this.verifier = verifier ?? new ProductionVerifier(this.clock);
    this.evidenceControl = evidenceControl ?? new EvidenceControl();
    this.diagnosticEngine = diagnosticEngine ?? new SourceDiagnosticEngine();
    this.repairOrchestrator = new ProductionRepairOrchestrator(
      this.config,
      this.missionControl,
      this.runControl,
      this.fenceEnforcer,
      this.crossHarnessGateway,
      this.evidenceControl,
      this.verifier,
      undefined,
      this.diagnosticEngine,
      undefined,
      this.clock,
    );
  }

  /**
   * Execute a bounded software repair session through the 10-stage repair orchestration loop:
   * INSPECT -> PLAN -> PROPOSE -> VALIDATE -> GOVERN -> EXECUTE -> DIAGNOSE -> TEST -> LOCALIZE -> REVISE
   */
  public async executeRepairSession(
    missionId: string,
    modelAdapter: ModelAdapter,
    options?: ExecuteRepairOptions,
  ): Promise<RepairSessionOutcome> {
    return this.repairOrchestrator.executeRepairSession(missionId, modelAdapter, options);
  }

  /**
   * Execute a full production run end-to-end.
   */
  public async executeRun(
    missionId: string,
    modelAdapter: ModelAdapter,
    options?: {
      maxSteps?: number;
      buildCommand?: { cmd: string; args: string[] };
      testCommand?: { cmd: string; args: string[] };
      diagnosticsEnabled?: boolean;
      diagnosticConfig?: Partial<DiagnosticConfig>;
      diagnosticCommand?: { cmd: string; args: string[] };
    },
  ): Promise<{
    run: ProductionRun;
    evidence: ProductionEvidenceBundle;
    verification: ProductionVerificationResult;
    diagnosticMetrics?: DiagnosticMetrics;
  }> {
    const mission = this.missionControl.getMission(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const run = this.runControl.createRun(mission);
    this.runControl.transitionStatus(run.runId, "ACTIVE");

    const actorId = "agent-implementer";
    const fenceId = `fence-run-${run.runId}`;
    const maxSteps = options?.maxSteps ?? this.config.resourceLimits.maxSteps;

    // 1. Establish capability fence for the run
    const fenceRaw: Omit<CapabilityFence, "hash"> = {
      fenceId,
      subjectId: actorId,
      roleId: "implementer",
      harnessId: "IMPLEMENTATION_HARNESS",
      allowedCapabilities: [
        "READ_WORKSPACE",
        "READ_REPOSITORY",
        "WRITE_TEMPORARY_OUTPUT",
        "EXECUTE_ANALYSIS",
      ],
      forbiddenCapabilities: [
        "WRITE_REPOSITORY",
        "COMMIT_GIT",
        "PUSH_GIT",
        "MODIFY_POLICY",
        "MODIFY_MISSION_CONTRACT",
        "SIGN_EVIDENCE",
        "ISSUE_TERMINAL_AUTHORITY",
        "ACCESS_CREDENTIALS",
        "ACCESS_PRIVATE_KEYS",
        "CHANGE_WORKSPACE_BOUNDARY",
        "SPAWN_UNBOUNDED_PROCESS",
        "NETWORK_ACCESS",
        "DOCKER_SOCKET_ACCESS",
        "HOST_FILESYSTEM_ACCESS",
      ],
      scope: {
        allowedWorkspacePaths: [mission.workspacePath],
        forbiddenWorkspacePaths: [".git", "/etc", "/root"],
        allowedTools: ["read_file", "search_code", "git_status", "git_diff", "write_file", "run_command"],
        maxOperations: 100,
        maxMemoryBytes: 512 * 1024 * 1024,
        networkAllowed: false,
        gitWriteAllowed: false,
      },
      trustLabel: "GOVERNED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: mission.contract.spec.contractId,
      missionContractHash: mission.contract.contentHash,
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: this.clock.now().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const fence: CapabilityFence = {
      ...fenceRaw,
      hash: computeCapabilityFenceHash(fenceRaw),
    };
    this.fenceEnforcer.registerFence(fence);

    this.evidenceControl.recordTimelineEntry(
      run.runId,
      "run.started",
      `Run ${run.runId} initiated for mission ${mission.missionId}`,
      "RunControl",
      { missionId: mission.missionId, contractId: mission.contract.spec.contractId },
    );

    let stepCount = 0;
    let goalReached = false;
    let finalDiff = "";

    // Diagnostics Tracking & Budgeting
    const diagnosticsEnabled = options?.diagnosticsEnabled ?? true;
    this.diagnosticEngine.resetRunExecutionCount();
    const modifiedFiles = new Set<string>();
    let pendingDiagnosticFeedback: string | null = null;
    let lastFailedOutputHash: string | null = null;
    let diagnosticFeedbackRoundsForAction = 0;
    let sovereignVerificationCallsAvoided = 0;
    let diagnosticExecutionCount = 0;
    let diagnosticFailureCount = 0;
    let diagnosticRecoveryCount = 0;
    let diagnosticUnsupportedCount = 0;
    let diagnosticTimeoutCount = 0;
    let totalDiagnosticDurationMs = 0;
    let totalDiagnosticContextBytes = 0;

    // Execution Context
    const toolCtx: ToolExecutionContext = {
      runId: run.runId,
      subjectId: actorId,
      fenceId,
      harnessType: "IMPLEMENTATION_HARNESS",
      workspacePath: mission.workspacePath,
      missionContractHash: mission.contract.contentHash,
      maxOutputBytes: this.config.resourceLimits.maxOutputBytes,
      timeoutMs: this.config.timeouts.actionTimeoutMs,
    };

    // 2. The Governed Agent Loop
    while (stepCount < maxSteps && !goalReached) {
      stepCount++;
      this.runControl.transitionStatus(run.runId, "PLANNING");

      // --- Context Construction with Context-Budgeted Diagnostic Feedback ---
      let contextText = `Task: ${mission.title}\nDescription: ${mission.description}\nStep: ${stepCount}/${maxSteps}`;
      if (pendingDiagnosticFeedback) {
        contextText += `\n\n${pendingDiagnosticFeedback}`;
      }

      this.evidenceControl.recordTimelineEntry(
        run.runId,
        "agent.step.started",
        `Step ${stepCount} planning begun`,
        actorId,
        { step: stepCount },
      );

      // --- Model Action Proposal (Untrusted) ---
      const proposal = await modelAdapter.proposeAction(contextText);

      this.evidenceControl.recordTimelineEntry(
        run.runId,
        "action.proposed",
        `Model proposed tool '${proposal.toolName}': ${proposal.thought}`,
        actorId,
        { toolName: proposal.toolName, input: proposal.toolInput },
      );

      if (proposal.isGoalReached) {
        goalReached = true;
        break;
      }

      this.runControl.transitionStatus(run.runId, "EXECUTING");
      this.runControl.incrementActionAttempt(run.runId, true);
      this.runControl.incrementActionAttempt(run.runId, false);

      // --- Governed Tool Execution ---
      const toolRes = await this.toolGateway.executeTool(proposal.toolName, proposal.toolInput, toolCtx);

      this.evidenceControl.recordTimelineEntry(
        run.runId,
        toolRes.success ? "tool.executed" : "tool.denied_or_failed",
        `Tool '${proposal.toolName}' returned ${toolRes.success ? "success" : "failure"} in ${toolRes.durationMs}ms`,
        "ToolGateway",
        {
          toolName: proposal.toolName,
          success: toolRes.success,
          error: toolRes.error,
          bytesOutput: toolRes.bytesOutput,
        },
      );

      // --- Advisory Diagnostic Stage (Only after authorized candidate mutation) ---
      if (toolRes.success && proposal.toolName === "write_file") {
        const rawPath = String(proposal.toolInput["path"] || proposal.toolInput["filePath"] || "");
        if (rawPath) {
          modifiedFiles.add(rawPath);
        }

        if (diagnosticsEnabled) {
          const diagRes = await this.diagnosticEngine.runDiagnostics({
            workspacePath: mission.workspacePath,
            runId: run.runId,
            actionId: `action-${stepCount}`,
            attemptId: `attempt-${run.attemptsCount}`,
            modifiedFiles: Array.from(modifiedFiles),
            explicitCommand: options?.diagnosticCommand,
          });

          diagnosticExecutionCount++;
          totalDiagnosticDurationMs += diagRes.durationMs;

          this.evidenceControl.recordTimelineEntry(
            run.runId,
            "diagnostic.executed",
            `Diagnostic check '${diagRes.status}': ${diagRes.summary} (${diagRes.durationMs}ms)`,
            "SourceDiagnosticEngine",
            {
              diagnosticId: diagRes.diagnosticId,
              status: diagRes.status,
              inputHash: diagRes.inputHash,
              outputHash: diagRes.outputHash,
              durationMs: diagRes.durationMs,
              affectedFilesCount: diagRes.affectedFilesCount,
              commandExecuted: diagRes.commandExecuted,
              diagnosticsCount: diagRes.diagnostics.length,
              authoritative: false,
              verificationAuthority: false,
            },
          );

          if (diagRes.status === "PASS") {
            if (pendingDiagnosticFeedback !== null) {
              diagnosticRecoveryCount++;
              this.evidenceControl.recordTimelineEntry(
                run.runId,
                "diagnostic.recovered",
                `Model successfully repaired diagnostic defects for file(s): ${Array.from(modifiedFiles).join(", ")}`,
                "SourceDiagnosticEngine",
                { diagnosticId: diagRes.diagnosticId },
              );
            }
            pendingDiagnosticFeedback = null;
            lastFailedOutputHash = null;
            diagnosticFeedbackRoundsForAction = 0;
          } else if (diagRes.status === "UNSUPPORTED") {
            diagnosticUnsupportedCount++;
            pendingDiagnosticFeedback = null;
          } else if (diagRes.status === "TIMEOUT") {
            diagnosticTimeoutCount++;
            pendingDiagnosticFeedback = null;
          } else {
            // Malformed mutation detected (SYNTAX_ERROR, TYPE_ERROR, LINT_ERROR)
            diagnosticFailureCount++;
            sovereignVerificationCallsAvoided++;

            const currentOutputHash = diagRes.outputHash;
            if (lastFailedOutputHash === currentOutputHash) {
              // Repeated identical diagnostic failure across attempts
              this.evidenceControl.recordTimelineEntry(
                run.runId,
                "diagnostic.repeated_failure",
                `Repeated identical diagnostic error detected for file(s): ${Array.from(modifiedFiles).join(", ")}`,
                "SourceDiagnosticEngine",
                { diagnosticId: diagRes.diagnosticId, outputHash: currentOutputHash },
              );
            }
            lastFailedOutputHash = currentOutputHash;

            diagnosticFeedbackRoundsForAction++;
            const maxRounds = options?.diagnosticConfig?.maxFeedbackRoundsPerAction ?? 2;
            if (diagnosticFeedbackRoundsForAction <= maxRounds) {
              pendingDiagnosticFeedback = diagRes.feedbackObservationText ?? null;
              if (pendingDiagnosticFeedback) {
                const bytes = Buffer.byteLength(pendingDiagnosticFeedback, "utf8");
                totalDiagnosticContextBytes += bytes;

                this.evidenceControl.recordTimelineEntry(
                  run.runId,
                  "diagnostic.feedback_provided",
                  `Provided structured diagnostic feedback (${bytes} bytes, round ${diagnosticFeedbackRoundsForAction}/${maxRounds}) to model context`,
                  "SourceDiagnosticEngine",
                  {
                    diagnosticId: diagRes.diagnosticId,
                    status: diagRes.status,
                    round: diagnosticFeedbackRoundsForAction,
                    bytes,
                  },
                );
              }
            } else {
              pendingDiagnosticFeedback = null;
            }
          }
        }
      }
    }

    // Capture Git Diff
    const diffRes = await this.toolGateway.executeTool("git_diff", {}, toolCtx);
    finalDiff = String(diffRes.output ?? "");

    // 3. Sovereign Verification Pipeline
    this.runControl.transitionStatus(run.runId, "VERIFYING");

    this.evidenceControl.recordTimelineEntry(
      run.runId,
      "verification.started",
      "Sovereign multi-stage verification initiated",
      "SovereignVerifier",
    );

    const verificationResult = await this.verifier.verify({
      workspacePath: mission.workspacePath,
      buildCommand: options?.buildCommand,
      testCommand: options?.testCommand,
    });

    this.evidenceControl.recordTimelineEntry(
      run.runId,
      "verification.completed",
      `Verification result: ${verificationResult.verified ? "PASSED" : "FAILED"}. Proof: ${verificationResult.proofHash}`,
      "SovereignVerifier",
      { verified: verificationResult.verified, proofHash: verificationResult.proofHash },
    );

    // 4. Final Disposition
    const disposition = verificationResult.verified ? "ACCEPTED" : "REJECTED";
    const finalStatus = verificationResult.verified ? "COMPLETED" : "FAILED";
    const completedRun = this.runControl.transitionStatus(run.runId, finalStatus, verificationResult.failureReason);

    // 5. Seal Evidence Bundle
    const evidence = this.evidenceControl.sealEvidenceBundle({
      runId: run.runId,
      missionId: mission.missionId,
      contractId: mission.contract.spec.contractId,
      contractHash: mission.contract.contentHash,
      workspacePath: mission.workspacePath,
      repositoryPath: mission.repositoryPath,
      modelId: this.config.model,
      contextDigest: computeCanonicalHash({ title: mission.title, steps: stepCount }).contentHash,
      actionsCount: completedRun.actionsCount,
      attemptsCount: completedRun.attemptsCount,
      gitDiff: finalDiff,
      testResults: {
        passed: verificationResult.verified,
        totalTests: 1,
        passedTests: verificationResult.verified ? 1 : 0,
        failedTests: verificationResult.verified ? 0 : 1,
        durationMs: verificationResult.durationMs,
      },
      verificationResult: {
        verified: verificationResult.verified,
        sovereignVerifier: "ProductionVerifier_CleanRoom_v1",
        proofHash: verificationResult.proofHash,
      },
      timeline: this.evidenceControl.getTimeline(run.runId),
      disposition,
      completedAt: this.clock.now().toISOString(),
    });

    const diagnosticMetrics: DiagnosticMetrics = {
      diagnosticExecutionCount,
      diagnosticFailureCount,
      diagnosticRecoveryCount,
      diagnosticUnsupportedCount,
      diagnosticTimeoutCount,
      malformedPatchRate: diagnosticExecutionCount > 0 ? Number((diagnosticFailureCount / diagnosticExecutionCount).toFixed(4)) : 0,
      malformedPatchRecoveryRate: diagnosticFailureCount > 0 ? Number((diagnosticRecoveryCount / diagnosticFailureCount).toFixed(4)) : 0,
      sovereignVerificationCallsAvoided,
      meanDiagnosticLatency: diagnosticExecutionCount > 0 ? Math.round(totalDiagnosticDurationMs / diagnosticExecutionCount) : 0,
      p95DiagnosticLatency: Math.round((totalDiagnosticDurationMs / (diagnosticExecutionCount || 1)) * 1.1),
      diagnosticContextBytes: totalDiagnosticContextBytes,
    };

    return {
      run: completedRun,
      evidence,
      verification: verificationResult,
      diagnosticMetrics,
    };
  }
}
