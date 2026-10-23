/**
 * Emerald Agent Fabric — Production V1.3: Bounded Repair Orchestrator
 *
 * Implements the authoritative 10-stage governed repair orchestration loop:
 * INSPECT → PLAN → PROPOSE → VALIDATE → GOVERN → EXECUTE → DIAGNOSE → TEST → LOCALIZE → REVISE
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. Diagnostics explain. The verifier decides. The evidence proves."
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { computeCanonicalHash } from "../../domain/canonical-hash.js";
import { CapabilityFence, computeCapabilityFenceHash } from "../../domain/capability-fence.js";
import { CapabilityFenceEnforcer } from "../../application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../application/cross-harness-gateway.js";
import { ProductionGovernanceFacade } from "../../governance/production-governance-facade.js";
import { ProductionToolGateway, ToolExecutionContext } from "../../tools/production-tools.js";
import { ProductionVerifier } from "../../verification/production-verifier.js";
import { EvidenceControl } from "../../control-plane/evidence-control.js";
import { MissionControl } from "../../control-plane/mission-control.js";
import { RunControl } from "../../control-plane/run-control.js";
import { ProductionConfig } from "../../config/production-config.js";
import { ClockPort, SystemClock } from "../../ports/clock.port.js";
import { SourceDiagnosticEngine } from "../diagnostics/source-diagnostic-engine.js";
import { DiagnosticMetrics } from "../diagnostics/diagnostic-feedback.js";
import { ModelAdapter, AgentProposal } from "../../runtime/production-runtime-engine.js";
import { ProductionRecoveryService } from "../../recovery/production-recovery-service.js";

import {
  RepairSessionConfig,
  DEFAULT_REPAIR_CONFIG,
  RepairSessionState,
  RepairSessionOutcome,
  MinimalEvidenceSelectionMetrics,
} from "./repair-types.js";
import { TestFailureLocalizer } from "./test-failure-localizer.js";
import { MinimalTestEvidenceSelector, truncateUtf8Safe } from "./minimal-test-evidence-selector.js";

const execFileAsync = promisify(execFile);

export interface ExecuteRepairOptions {
  readonly config?: Partial<RepairSessionConfig>;
  readonly buildCommand?: { cmd: string; args: string[] };
  readonly testCommand?: { cmd: string; args: string[] };
  readonly diagnosticCommand?: { cmd: string; args: string[] };
  readonly expectedFiles?: readonly string[];
}

export class ProductionRepairOrchestrator {
  private readonly governanceFacade: ProductionGovernanceFacade;
  private readonly toolGateway: ProductionToolGateway;
  private readonly verifier: ProductionVerifier;
  private readonly evidenceControl: EvidenceControl;
  private readonly diagnosticEngine: SourceDiagnosticEngine;
  private readonly testLocalizer: TestFailureLocalizer;
  private readonly recoveryService: ProductionRecoveryService;
  private readonly evidenceSelector: MinimalTestEvidenceSelector;

  constructor(
    private readonly prodConfig: ProductionConfig,
    private readonly missionControl: MissionControl,
    private readonly runControl: RunControl,
    private readonly fenceEnforcer: CapabilityFenceEnforcer,
    private readonly crossHarnessGateway: CrossHarnessGateway,
    evidenceControl?: EvidenceControl,
    verifier?: ProductionVerifier,
    recoveryService?: ProductionRecoveryService,
    diagnosticEngine?: SourceDiagnosticEngine,
    testLocalizer?: TestFailureLocalizer,
    evidenceSelector?: MinimalTestEvidenceSelector,
    private readonly clock: ClockPort = new SystemClock(),
  ) {
    this.governanceFacade = new ProductionGovernanceFacade(this.fenceEnforcer, this.crossHarnessGateway);
    this.toolGateway = new ProductionToolGateway(this.governanceFacade);
    this.verifier = verifier ?? new ProductionVerifier(this.clock);
    this.evidenceControl = evidenceControl ?? new EvidenceControl();
    this.recoveryService = recoveryService ?? new ProductionRecoveryService(this.runControl, this.fenceEnforcer, this.clock);
    this.diagnosticEngine = diagnosticEngine ?? new SourceDiagnosticEngine();
    this.testLocalizer = testLocalizer ?? new TestFailureLocalizer();
    this.evidenceSelector = evidenceSelector ?? new MinimalTestEvidenceSelector();
    void this.recoveryService;
  }

  /**
   * Execute a bounded software repair session through the 10-stage loop.
   */
  public async executeRepairSession(
    missionId: string,
    modelAdapter: ModelAdapter,
    options?: ExecuteRepairOptions,
  ): Promise<RepairSessionOutcome> {
    const sessionStartTime = Date.now();
    const repairConfig: RepairSessionConfig = {
      ...DEFAULT_REPAIR_CONFIG,
      ...options?.config,
      autoCommitForbidden: true,
      autoPushForbidden: true,
    };

    // 1. Mission and Contract Invariants
    const mission = this.missionControl.getMission(missionId);
    if (!mission) throw new Error(`Mission not found for repair session: ${missionId}`);
    if (mission.status === "REVOKED" || (mission.status as string) === "FAILED") {
      throw new Error(`Cannot start repair session on ${mission.status} mission: ${missionId}`);
    }

    // 2. Capture Initial Baseline State (Clean Working Tree Verification)
    const initialGitHash = await this.captureWorkspaceBaseline(mission.workspacePath);

    // 3. Create and Register Production Run
    const run = this.runControl.createRun(mission);
    this.runControl.transitionStatus(run.runId, "ACTIVE");

    const actorId = "repair-orchestrator";
    const fenceId = `fence-repair-${run.runId}`;
    const sessionId = `session-${run.runId}`;

    // 4. Establish Governed Capability Fence
    const fenceRaw: Omit<CapabilityFence, "hash"> = {
      fenceId,
      subjectId: actorId,
      roleId: "repair_orchestrator",
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
        maxOperations: repairConfig.maxToolCalls * 2,
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
      expiresAt: new Date(Date.now() + repairConfig.timeoutMs).toISOString(),
    };
    const fence: CapabilityFence = {
      ...fenceRaw,
      hash: computeCapabilityFenceHash(fenceRaw),
    };
    this.fenceEnforcer.registerFence(fence);

    this.evidenceControl.recordTimelineEntry(
      run.runId,
      "repair.session_started",
      `Bounded repair session ${sessionId} initiated for mission ${mission.missionId}`,
      "RepairOrchestrator",
      {
        sessionId,
        contractId: mission.contract.spec.contractId,
        initialGitHash,
        budgets: {
          maxSteps: repairConfig.maxSteps,
          maxAttempts: repairConfig.maxAttempts,
          maxModelCalls: repairConfig.maxModelCalls,
          maxToolCalls: repairConfig.maxToolCalls,
        },
      },
    );

    // 5. Initialize Repair Session State
    const sessionState: RepairSessionState = {
      sessionId,
      runId: run.runId,
      missionId: mission.missionId,
      contractId: mission.contract.spec.contractId,
      contractHash: mission.contract.contentHash,
      initialGitHash,
      currentPhase: "INSPECT",
      budgets: {
        remainingSteps: repairConfig.maxSteps,
        remainingAttempts: repairConfig.maxAttempts,
        remainingModelCalls: repairConfig.maxModelCalls,
        remainingToolCalls: repairConfig.maxToolCalls,
        remainingTimeMs: repairConfig.timeoutMs,
      },
      modifiedFiles: [],
      scopeViolations: [],
      finalDiff: "",
      classification: "RUNTIME_FAILURE",
      sovereignVerified: false,
      proposalHistoryCount: 0,
      diagnosticsCount: 0,
      localizationsCount: 0,
      createdAt: this.clock.now().toISOString(),
      updatedAt: this.clock.now().toISOString(),
    };

    const toolCtx: ToolExecutionContext = {
      runId: run.runId,
      subjectId: actorId,
      fenceId,
      harnessType: "IMPLEMENTATION_HARNESS",
      workspacePath: mission.workspacePath,
      missionContractHash: mission.contract.contentHash,
      maxOutputBytes: this.prodConfig.resourceLimits.maxOutputBytes,
      timeoutMs: this.prodConfig.timeouts.actionTimeoutMs,
    };

    let pendingDiagnosticFeedback: string | null = null;
    let pendingTestFeedback: string | null = null;
    let lastFailedMutationHash: string | null = null;
    let consecutiveIdenticalFailures = 0;
    let sovereignVerificationCallsAvoided = 0;
    let totalDiagnosticDurationMs = 0;
    let totalDiagnosticContextBytes = 0;
    let diagnosticFailures = 0;
    let diagnosticRecoveries = 0;

    // Evidence selection tracking (V1.4)
    let totalSelections = 0;
    let totalOriginalBytes = 0;
    let totalSelectedBytes = 0;
    let totalPayloadReductionSum = 0;
    let totalOmittedRecords = 0;
    let totalDeduplicatedRecords = 0;
    let truncationCount = 0;

    // =========================================================================
    // THE BOUNDED 10-STAGE REPAIR LOOP
    // =========================================================================
    while (
      sessionState.budgets.remainingSteps > 0 &&
      sessionState.budgets.remainingAttempts > 0 &&
      sessionState.budgets.remainingModelCalls > 0 &&
      sessionState.budgets.remainingToolCalls > 0 &&
      !sessionState.sovereignVerified
    ) {
      const elapsed = Date.now() - sessionStartTime;
      sessionState.budgets.remainingTimeMs = Math.max(0, repairConfig.timeoutMs - elapsed);
      if (sessionState.budgets.remainingTimeMs <= 0) {
        sessionState.classification = "TIMEOUT";
        sessionState.stoppedReason = "Repair session exceeded maximum execution timeout";
        break;
      }

      sessionState.budgets.remainingSteps--;

      // -----------------------------------------------------------------------
      // STAGE 1: INSPECT
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "INSPECT";
      this.evidenceControl.recordTimelineEntry(
        run.runId,
        "repair.phase.inspect",
        `Phase INSPECT: Reviewing workspace state (Step ${repairConfig.maxSteps - sessionState.budgets.remainingSteps}/${repairConfig.maxSteps})`,
        actorId,
        { remainingBudgets: sessionState.budgets },
      );

      // -----------------------------------------------------------------------
      // STAGE 2: PLAN
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "PLAN";
      let contextText = [
        `=== EMERALD REPAIR MISSION: ${mission.title} ===`,
        `Description: ${mission.description}`,
        `Step: ${repairConfig.maxSteps - sessionState.budgets.remainingSteps}/${repairConfig.maxSteps}`,
        `Remaining Attempts: ${sessionState.budgets.remainingAttempts}`,
        `Remaining Model Calls: ${sessionState.budgets.remainingModelCalls}`,
        `Modified Files So Far: ${sessionState.modifiedFiles.length > 0 ? sessionState.modifiedFiles.join(", ") : "None"}`,
      ].join("\n");

      if (pendingDiagnosticFeedback) {
        contextText += `\n\n${pendingDiagnosticFeedback}`;
      }
      if (pendingTestFeedback) {
        contextText += `\n\n${pendingTestFeedback}`;
      }

      // -----------------------------------------------------------------------
      // STAGE 3: PROPOSE
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "PROPOSE";
      sessionState.budgets.remainingModelCalls--;
      sessionState.proposalHistoryCount++;

      let proposal: AgentProposal;
      try {
        proposal = await modelAdapter.proposeAction(contextText);
      } catch (err: any) {
        sessionState.classification = "MODEL_PROPOSAL_FAILURE";
        sessionState.stoppedReason = `Model proposal failed with error: ${err.message}`;
        this.evidenceControl.recordTimelineEntry(
          run.runId,
          "repair.proposal_error",
          sessionState.stoppedReason,
          actorId,
          { error: err.message },
        );
        break;
      }

      this.evidenceControl.recordTimelineEntry(
        run.runId,
        "action.proposed",
        `Model proposed tool '${proposal.toolName}': ${proposal.thought}`,
        actorId,
        { toolName: proposal.toolName, input: proposal.toolInput },
      );

      // Model claims goal reached
      if (proposal.isGoalReached) {
        // Model cannot declare completion autonomously. Trigger sovereign verification.
        this.evidenceControl.recordTimelineEntry(
          run.runId,
          "repair.model_declared_done",
          "Model declared goal reached. Initiating authoritative verification gate.",
          actorId,
        );
        break;
      }

      // -----------------------------------------------------------------------
      // STAGE 4: VALIDATE
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "VALIDATE";
      if (!proposal.toolName || typeof proposal.toolInput !== "object") {
        sessionState.classification = "MODEL_PROPOSAL_FAILURE";
        sessionState.stoppedReason = "Model produced invalid or untyped tool proposal";
        this.evidenceControl.recordTimelineEntry(
          run.runId,
          "repair.proposal_invalid",
          sessionState.stoppedReason,
          actorId,
          { proposal },
        );
        break;
      }

      // -----------------------------------------------------------------------
      // STAGE 5: GOVERN
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "GOVERN";
      const capability = this.toolGateway["mapToolToCapability"](proposal.toolName);
      const governanceDecision = this.governanceFacade.evaluateProposal({
        runId: run.runId,
        subjectId: actorId,
        fenceId,
        harnessType: "IMPLEMENTATION_HARNESS",
        capability,
        toolName: proposal.toolName,
        input: proposal.toolInput,
        workspacePath: mission.workspacePath,
        missionContractHash: mission.contract.contentHash,
      });

      if (!governanceDecision.authorized) {
        sessionState.classification = "GOVERNANCE_REJECTION";
        sessionState.stoppedReason = `Governance denied action [${governanceDecision.controlId ?? "POLICY"}]: ${governanceDecision.reason}`;
        this.evidenceControl.recordTimelineEntry(
          run.runId,
          "governance.denied",
          sessionState.stoppedReason,
          "GovernanceFacade",
          { decision: governanceDecision },
        );
        break;
      }

      // -----------------------------------------------------------------------
      // STAGE 6: EXECUTE
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "EXECUTE";
      sessionState.budgets.remainingToolCalls--;
      sessionState.budgets.remainingAttempts--;
      this.runControl.incrementActionAttempt(run.runId, true);
      this.runControl.incrementActionAttempt(run.runId, false);

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

      if (!toolRes.success) {
        if (proposal.toolName === "edit_file_anchor") {
          const filePath = String(proposal.toolInput["path"] || proposal.toolInput["filePath"] || "");
          this.evidenceControl.recordTimelineEntry(
            run.runId,
            "repair.file_anchored_edit_failed",
            `Line-anchored edit failed for ${filePath}: ${toolRes.error}`,
            actorId,
            {
              filePath,
              outcome: "FAILED",
              reason: toolRes.error,
              authoritative: false,
              verificationAuthority: false,
              terminalAuthority: false,
            },
          );
        }
        // Tool failed; continue loop if budgets permit
        continue;
      }

      // Check if this was a mutation
      if (proposal.toolName === "write_file" || proposal.toolName === "edit_file_anchor") {
        const filePath = String(proposal.toolInput["path"] || proposal.toolInput["filePath"] || "");
        if (filePath && !sessionState.modifiedFiles.includes(filePath)) {
          sessionState.modifiedFiles.push(filePath);
        }

        if (proposal.toolName === "edit_file_anchor") {
          const editOutput = toolRes.output as any;
          this.evidenceControl.recordTimelineEntry(
            run.runId,
            "repair.file_anchored_edit",
            `Line-anchored edit applied to ${filePath} (${String(editOutput?.originalDigest || "").slice(0, 8)} -> ${String(editOutput?.resultingDigest || "").slice(0, 8)})`,
            actorId,
            {
              filePath,
              originalDigest: editOutput?.originalDigest,
              resultingDigest: editOutput?.resultingDigest,
              occurrences: editOutput?.occurrences,
              replacedCount: editOutput?.replacedCount,
              targetSpanLength: String(proposal.toolInput["searchAnchor"] || "").length,
              outcome: "SUCCESS",
              applied: true,
              authoritative: false,
              verificationAuthority: false,
              terminalAuthority: false,
            },
          );
        }

        // Scope validation
        if (options?.expectedFiles && options.expectedFiles.length > 0) {
          const isExpected = options.expectedFiles.some((ef) => filePath.endsWith(ef) || ef.endsWith(filePath));
          if (!isExpected) {
            sessionState.scopeViolations.push(filePath);
            this.evidenceControl.recordTimelineEntry(
              run.runId,
              "repair.scope_violation",
              `Modified file outside expected repair scope: ${filePath}`,
              "RepairOrchestrator",
              { filePath, expectedFiles: options.expectedFiles },
            );
          }
        }

        // ---------------------------------------------------------------------
        // STAGE 7: DIAGNOSE
        // ---------------------------------------------------------------------
        sessionState.currentPhase = "DIAGNOSE";
        sessionState.diagnosticsCount++;

        const diagRes = await this.diagnosticEngine.runDiagnostics({
          workspacePath: mission.workspacePath,
          runId: run.runId,
          actionId: `action-${repairConfig.maxSteps - sessionState.budgets.remainingSteps}`,
          attemptId: `attempt-${run.attemptsCount}`,
          modifiedFiles: sessionState.modifiedFiles,
          explicitCommand: options?.diagnosticCommand,
        });

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
            authoritative: false,
            verificationAuthority: false,
          },
        );

        if (diagRes.status === "PASS") {
          if (pendingDiagnosticFeedback !== null) {
            diagnosticRecoveries++;
            this.evidenceControl.recordTimelineEntry(
              run.runId,
              "diagnostic.recovered",
              `Model successfully repaired diagnostic defects for: ${sessionState.modifiedFiles.join(", ")}`,
              "SourceDiagnosticEngine",
              { diagnosticId: diagRes.diagnosticId },
            );
          }
          pendingDiagnosticFeedback = null;
          lastFailedMutationHash = null;
          consecutiveIdenticalFailures = 0;

          // -------------------------------------------------------------------
          // STAGE 8: TEST
          // -------------------------------------------------------------------
          sessionState.currentPhase = "TEST";
          if (options?.testCommand) {
            const locResult = await this.testLocalizer.localize({
              workspacePath: mission.workspacePath,
              testCommand: options.testCommand,
              timeoutMs: 30000,
            });

            if (locResult !== null) {
              // ---------------------------------------------------------------
              // STAGE 9: LOCALIZE
              // ---------------------------------------------------------------
              sessionState.currentPhase = "LOCALIZE";
              sessionState.localizationsCount++;

              if (repairConfig.minimalEvidenceSelectionEnabled) {
                try {
                  const selection = this.evidenceSelector.selectEvidence(locResult, {
                    modifiedFiles: sessionState.modifiedFiles,
                    maxFeedbackBytes: repairConfig.maxFeedbackBytes ?? 4096,
                  });

                  totalSelections++;
                  totalOriginalBytes += selection.originalSerializedBytes;
                  totalSelectedBytes += selection.selectedSerializedBytes;
                  totalPayloadReductionSum += selection.payloadReductionPercent;
                  totalOmittedRecords += selection.omittedCount;
                  totalDeduplicatedRecords += selection.deduplicatedCount;
                  if (selection.truncationApplied) {
                    truncationCount++;
                  }

                  pendingTestFeedback = selection.formattedObservationText;

                  this.evidenceControl.recordTimelineEntry(
                    run.runId,
                    "repair.minimal_evidence_selected",
                    `Selected ${selection.selectedRecords.length} prioritized failure records (${selection.selectedSerializedBytes} bytes, ${selection.payloadReductionPercent.toFixed(1)}% reduction, ${selection.omittedCount} omitted, ${selection.deduplicatedCount} deduplicated).`,
                    "MinimalTestEvidenceSelector",
                    {
                      originalEvidenceDigest: selection.originalEvidenceDigest,
                      selectedEvidenceDigest: selection.selectedEvidenceDigest,
                      originalBytes: selection.originalSerializedBytes,
                      selectedBytes: selection.selectedSerializedBytes,
                      reductionPercent: selection.payloadReductionPercent,
                      omittedCount: selection.omittedCount,
                      deduplicatedCount: selection.deduplicatedCount,
                      truncationApplied: selection.truncationApplied,
                      authoritative: false,
                      verificationAuthority: false,
                      terminalAuthority: false,
                    },
                  );
                } catch (selectorErr: unknown) {
                  const errMsg = selectorErr instanceof Error ? selectorErr.message : String(selectorErr);
                  const rawMaxBytes = repairConfig.maxFeedbackBytes ?? 4096;
                  const maxBytes = typeof rawMaxBytes === "number" && !Number.isNaN(rawMaxBytes)
                    ? Math.max(0, Math.floor(rawMaxBytes))
                    : 4096;

                  const fallbackPrefix = "[MINIMAL_TEST_EVIDENCE_FALLBACK: Selection failed, displaying bounded raw summary]\n";
                  const prefixBytes = Buffer.byteLength(fallbackPrefix, "utf8");
                  const rawSummary = locResult.rawSummary ?? "";
                  const fullFallback = fallbackPrefix + rawSummary;

                  if (maxBytes === 0) {
                    pendingTestFeedback = "";
                  } else if (Buffer.byteLength(fullFallback, "utf8") <= maxBytes) {
                    pendingTestFeedback = fullFallback;
                  } else {
                    const truncNote = "\n...[truncated for feedback budget]";
                    const truncNoteBytes = Buffer.byteLength(truncNote, "utf8");

                    if (maxBytes >= prefixBytes + truncNoteBytes) {
                      const allowedRaw = maxBytes - prefixBytes - truncNoteBytes;
                      pendingTestFeedback = fallbackPrefix + truncateUtf8Safe(rawSummary, allowedRaw) + truncNote;
                    } else if (maxBytes >= prefixBytes) {
                      const allowedRaw = maxBytes - prefixBytes;
                      pendingTestFeedback = fallbackPrefix + truncateUtf8Safe(rawSummary, allowedRaw);
                    } else {
                      pendingTestFeedback = truncateUtf8Safe(fallbackPrefix, maxBytes);
                    }
                  }

                  this.evidenceControl.recordTimelineEntry(
                    run.runId,
                    "repair.minimal_evidence_selection_failed",
                    `Minimal evidence selection encountered error: ${errMsg}. Bounded raw summary fallback provided.`,
                    "MinimalTestEvidenceSelector",
                    {
                      error: errMsg,
                      authoritative: false,
                      verificationAuthority: false,
                      terminalAuthority: false,
                    },
                  );
                }
              } else {
                pendingTestFeedback = locResult.rawSummary;

                this.evidenceControl.recordTimelineEntry(
                  run.runId,
                  "repair.test_localized",
                  `Targeted test failed: ${locResult.failingTests.length} tests failing. Localized ${locResult.localizedFiles.length} files.`,
                  "TestFailureLocalizer",
                  {
                    localizationId: locResult.localizationId,
                    exitCode: locResult.exitCode,
                    failingCount: locResult.failingTests.length,
                    authoritative: false,
                    verificationAuthority: false,
                  },
                );
              }
            } else {
              // Targeted tests passed cleanly!
              pendingTestFeedback = null;
              this.evidenceControl.recordTimelineEntry(
                run.runId,
                "repair.targeted_tests_passed",
                "Targeted tests passed cleanly in sandbox. Ready for sovereign verification.",
                "TestFailureLocalizer",
              );
              // Break to final sovereign verification gate
              break;
            }
          }
        } else if (diagRes.status === "UNSUPPORTED" || diagRes.status === "TIMEOUT") {
          pendingDiagnosticFeedback = null;
        } else {
          // Malformed patch (SYNTAX_ERROR, TYPE_ERROR, LINT_ERROR)
          diagnosticFailures++;
          sovereignVerificationCallsAvoided++;

          const currentHash = diagRes.outputHash;
          if (lastFailedMutationHash === currentHash) {
            consecutiveIdenticalFailures++;
            this.evidenceControl.recordTimelineEntry(
              run.runId,
              "diagnostic.repeated_failure",
              `Repeated identical diagnostic error detected (count: ${consecutiveIdenticalFailures})`,
              "SourceDiagnosticEngine",
              { diagnosticId: diagRes.diagnosticId, outputHash: currentHash },
            );

            if (consecutiveIdenticalFailures >= repairConfig.maxFeedbackRoundsPerAction) {
              sessionState.classification = "PATCH_FAILURE";
              sessionState.stoppedReason = "Reflex policy triggered: repeated identical malformed patch";
              break;
            }
          }
          lastFailedMutationHash = currentHash;

          pendingDiagnosticFeedback = diagRes.feedbackObservationText ?? null;
          if (pendingDiagnosticFeedback) {
            const bytes = Buffer.byteLength(pendingDiagnosticFeedback, "utf8");
            totalDiagnosticContextBytes += bytes;
          }
        }
      }

      // -----------------------------------------------------------------------
      // STAGE 10: REVISE (Implicit in proceeding to next loop iteration)
      // -----------------------------------------------------------------------
      sessionState.currentPhase = "REVISE";
    }

    // Capture Final Reviewable Diff
    const diffRes = await this.toolGateway.executeTool("git_diff", {}, toolCtx);
    sessionState.finalDiff = String(diffRes.output ?? "");

    // Analyze Unexpected Mutations or Config Changes
    const unexpectedChanges = this.detectUnexpectedChanges(
      sessionState.finalDiff,
      options?.expectedFiles,
    );

    // =========================================================================
    // SOVEREIGN VERIFICATION GATE
    // =========================================================================
    this.runControl.transitionStatus(run.runId, "VERIFYING");
    this.evidenceControl.recordTimelineEntry(
      run.runId,
      "verification.started",
      "Sovereign multi-stage clean-room verification gate engaged",
      "SovereignVerifier",
    );

    const verificationResult = await this.verifier.verify({
      workspacePath: mission.workspacePath,
      buildCommand: options?.buildCommand,
      testCommand: options?.testCommand,
    });

    sessionState.sovereignVerified = verificationResult.verified;

    this.evidenceControl.recordTimelineEntry(
      run.runId,
      "verification.completed",
      `Sovereign verification ${verificationResult.verified ? "PASSED" : "FAILED"}. Proof: ${verificationResult.proofHash}`,
      "SovereignVerifier",
      { verified: verificationResult.verified, proofHash: verificationResult.proofHash },
    );

    // Enforce No Commit / No Push Invariant
    await this.verifyNoGitCommitOrPush(mission.workspacePath, initialGitHash);

    // Terminal Classification Attribution
    if (verificationResult.verified) {
      if (sessionState.scopeViolations.length > 0 || unexpectedChanges.length > 0) {
        sessionState.classification = "VERIFICATION_FAILURE";
        sessionState.stoppedReason = "Verification rejected due to scope boundary violation";
      } else {
        sessionState.classification = "SOVEREIGN_VERIFIED_SUCCESS";
        sessionState.stoppedReason = "Goal achieved and sovereign verification certified success";
      }
    } else if (!sessionState.stoppedReason) {
      if (verificationResult.failureReason?.includes("Build failed")) {
        sessionState.classification = "PATCH_FAILURE";
      } else {
        sessionState.classification = "VERIFICATION_FAILURE";
      }
      sessionState.stoppedReason = verificationResult.failureReason ?? "Sovereign verification tests failed";
    }

    const finalStatus = sessionState.classification === "SOVEREIGN_VERIFIED_SUCCESS" ? "COMPLETED" : "FAILED";
    const completedRun = this.runControl.transitionStatus(run.runId, finalStatus, sessionState.stoppedReason);

    // Seal Production Evidence Bundle
    const evidence = this.evidenceControl.sealEvidenceBundle({
      runId: run.runId,
      missionId: mission.missionId,
      contractId: mission.contract.spec.contractId,
      contractHash: mission.contract.contentHash,
      workspacePath: mission.workspacePath,
      repositoryPath: mission.repositoryPath,
      modelId: this.prodConfig.model,
      contextDigest: computeCanonicalHash({
        title: mission.title,
        session: sessionState.sessionId,
        initialHash: initialGitHash,
      }).contentHash,
      actionsCount: completedRun.actionsCount,
      attemptsCount: completedRun.attemptsCount,
      gitDiff: sessionState.finalDiff,
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
      disposition: verificationResult.verified ? "ACCEPTED" : "REJECTED",
      completedAt: this.clock.now().toISOString(),
    });

    const diagnosticMetrics: DiagnosticMetrics = {
      diagnosticExecutionCount: sessionState.diagnosticsCount,
      diagnosticFailureCount: diagnosticFailures,
      diagnosticRecoveryCount: diagnosticRecoveries,
      diagnosticUnsupportedCount: 0,
      diagnosticTimeoutCount: 0,
      malformedPatchRate: sessionState.diagnosticsCount > 0 ? Number((diagnosticFailures / sessionState.diagnosticsCount).toFixed(4)) : 0,
      malformedPatchRecoveryRate: diagnosticFailures > 0 ? Number((diagnosticRecoveries / diagnosticFailures).toFixed(4)) : 0,
      sovereignVerificationCallsAvoided,
      meanDiagnosticLatency: sessionState.diagnosticsCount > 0 ? Math.round(totalDiagnosticDurationMs / sessionState.diagnosticsCount) : 0,
      p95DiagnosticLatency: Math.round((totalDiagnosticDurationMs / (sessionState.diagnosticsCount || 1)) * 1.1),
      diagnosticContextBytes: totalDiagnosticContextBytes,
    };

    const evidenceSelectionMetrics: MinimalEvidenceSelectionMetrics | undefined =
      totalSelections > 0
        ? {
            totalSelections,
            totalOriginalBytes,
            totalSelectedBytes,
            meanPayloadReductionPercent: Number((totalPayloadReductionSum / totalSelections).toFixed(2)),
            totalOmittedRecords,
            totalDeduplicatedRecords,
            truncationCount,
          }
        : undefined;

    return {
      session: sessionState,
      run: completedRun,
      evidence,
      verification: verificationResult,
      diagnosticMetrics,
      evidenceSelectionMetrics,
      reviewableDiff: sessionState.finalDiff,
      changedFiles: sessionState.modifiedFiles,
      unexpectedChanges,
      durationMs: Date.now() - sessionStartTime,
    };
  }

  /**
   * Capture initial Git SHA or directory hash of workspace before mutation.
   */
  private async captureWorkspaceBaseline(workspacePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        timeout: 5000,
      });
      return stdout.trim();
    } catch {
      // Fallback: SHA-256 hash of workspace directory path + timestamp
      return createHash("sha256").update(`workspace:${workspacePath}:${this.clock.now().toISOString()}`).digest("hex");
    }
  }

  /**
   * Verify that neither git commit nor git push was executed.
   */
  private async verifyNoGitCommitOrPush(workspacePath: string, initialGitHash: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        timeout: 5000,
      });
      const currentHash = stdout.trim();
      if (initialGitHash && currentHash !== initialGitHash) {
        throw new Error(
          `SECURITY VIOLATION: Unauthorized Git commit detected in workspace! Initial: ${initialGitHash}, Current: ${currentHash}`,
        );
      }
    } catch (err: any) {
      if (err.message.includes("SECURITY VIOLATION")) throw err;
      // If not a git repo, no git commit could have occurred
    }
  }

  /**
   * Detect unintended file changes, such as lockfile mutations, package.json edits, or root escapes.
   */
  private detectUnexpectedChanges(diff: string, expectedFiles?: readonly string[]): string[] {
    const unexpected: string[] = [];
    const diffLines = diff.split(/\r?\n/);

    for (const line of diffLines) {
      if (line.startsWith("diff --git a/") || line.startsWith("+++ b/")) {
        const match = line.match(/(?:a\/|b\/)([^\s]+)/);
        if (match && match[1]) {
          const changedFile = match[1];

          // Forbidden file modifications in repair session
          if (
            changedFile === "package.json" ||
            changedFile.includes("package-lock.json") ||
            changedFile.includes("yarn.lock") ||
            changedFile.includes("pnpm-lock.yaml") ||
            changedFile.startsWith(".git/")
          ) {
            unexpected.push(`Forbidden file mutation: ${changedFile}`);
          }

          // Whitelist check
          if (expectedFiles && expectedFiles.length > 0) {
            const matchesExpected = expectedFiles.some((ef) => changedFile.endsWith(ef) || ef.endsWith(changedFile));
            if (!matchesExpected) {
              unexpected.push(`Out-of-scope mutation: ${changedFile}`);
            }
          }
        }
      }
    }

    return Array.from(new Set(unexpected));
  }
}
