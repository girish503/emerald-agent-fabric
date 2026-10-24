/**
 * Emerald Agent Fabric — Production V1.5: Controlled Stage-by-Stage Failure Attribution
 *
 * Provides typed, evidence-backed attribution distinguishing model limitations,
 * task difficulty, prompting, patch application, governance, test execution,
 * and sovereign verification failure stages.
 */

export type AttributionStage =
  | "STAGE_1_TASK_INITIALIZATION"
  | "STAGE_2_MODEL_PROPOSAL"
  | "STAGE_3_PATCH_APPLICATION"
  | "STAGE_4_GOVERNANCE_SCOPE"
  | "STAGE_5_EXECUTION_SANDBOX"
  | "STAGE_6_DIAGNOSTIC_ADVISORY"
  | "STAGE_7_TEST_EXECUTION"
  | "STAGE_8_SOVEREIGN_VERIFICATION"
  | "STAGE_9_VERIFIED_SUCCESS"
  | "STAGE_UNKNOWN_INCONCLUSIVE";

export type AttributionFailureCode =
  | "FIXTURE_SETUP_ERROR"
  | "MODEL_EMPTY_RESPONSE"
  | "MODEL_PARSE_ERROR"
  | "MODEL_NO_TOOL_CALL"
  | "PATCH_SYNTAX_ERROR"
  | "PATCH_DIFF_CORRUPTED"
  | "PATCH_TARGET_NOT_FOUND"
  | "GOVERNANCE_CAPABILITY_DENIED"
  | "GOVERNANCE_SCOPE_VIOLATION"
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_PROCESS_CRASH"
  | "DIAGNOSTIC_LINT_FAILURE"
  | "TEST_PROCESS_FAILED"         // Test runner could not execute / exited non-zero before assertions
  | "TEST_ASSERTION_FAILED"       // Test executed normally but assertions failed
  | "VERIFIER_INVARIANT_FAILED"
  | "VERIFIER_DIFF_REJECTED"
  | "INCONCLUSIVE_INSUFFICIENT_EVIDENCE"
  | "SUCCESS_VERIFIED";

export interface StageAttributionRecord {
  readonly stage: AttributionStage;
  readonly code: AttributionFailureCode;
  readonly decisive: boolean; // Earliest decisive failure
  readonly reason: string;
  readonly evidenceRef?: string;
  readonly timestamp: string;
}

export interface DetailedFailureAttribution {
  readonly primaryStage: AttributionStage;
  readonly primaryCode: AttributionFailureCode;
  readonly primaryReason: string;
  readonly decisiveEvidenceRef: string;
  readonly stageRecords: readonly StageAttributionRecord[];
  readonly modelProposalValid: boolean;
  readonly patchAppliedSuccessfully: boolean;
  readonly testsExecuted: boolean;
  readonly testPassed: boolean;
  readonly sovereignVerified: boolean;
}

export interface FailureAttributionInput {
  readonly fixtureFailed?: boolean;
  readonly fixtureError?: string;
  readonly modelRawResponse?: string;
  readonly proposalValid?: boolean;
  readonly proposalError?: string;
  readonly patchApplied?: boolean;
  readonly patchError?: string;
  readonly governanceDenied?: boolean;
  readonly governanceReason?: string;
  readonly timedOut?: boolean;
  readonly processCrashed?: boolean;
  readonly diagnosticStatus?: "CLEAN" | "SYNTAX_ERROR" | "TYPE_ERROR" | "LINT_ERROR" | "TIMEOUT" | "UNSUPPORTED";
  readonly diagnosticOutputHash?: string;
  readonly testExecutionFailed?: boolean; // runner couldn't run
  readonly testAssertionFailed?: boolean; // runner ran, assertions failed
  readonly testExitCode?: number;
  readonly testOutput?: string;
  readonly verified?: boolean;
  readonly verificationProofHash?: string;
  readonly verificationFailureReason?: string;
  readonly scopeViolations?: readonly string[];
}

export class FailureAttributionClassifier {
  /**
   * Classify trial outcome into a stage-by-stage evidence-backed attribution record.
   */
  public classify(input: FailureAttributionInput): DetailedFailureAttribution {
    const timestamp = new Date().toISOString();
    const stageRecords: StageAttributionRecord[] = [];

    let decisiveStage: AttributionStage | null = null;
    let decisiveCode: AttributionFailureCode | null = null;
    let decisiveReason = "";
    let decisiveRef = "";

    const recordDecisive = (stage: AttributionStage, code: AttributionFailureCode, reason: string, ref: string) => {
      const isFirst = decisiveStage === null;
      stageRecords.push({
        stage,
        code,
        decisive: isFirst,
        reason,
        evidenceRef: ref,
        timestamp,
      });
      if (isFirst) {
        decisiveStage = stage;
        decisiveCode = code;
        decisiveReason = reason;
        decisiveRef = ref;
      }
    };

    // Stage 1: Task Initialization / Fixture Setup
    if (input.fixtureFailed) {
      recordDecisive(
        "STAGE_1_TASK_INITIALIZATION",
        "FIXTURE_SETUP_ERROR",
        input.fixtureError ?? "Task fixture failed baseline reproduction check",
        "fixture_check",
      );
    }

    // Stage 2: Model Proposal Validity
    if (input.modelRawResponse === undefined && input.proposalValid === false) {
      recordDecisive(
        "STAGE_2_MODEL_PROPOSAL",
        "MODEL_EMPTY_RESPONSE",
        input.proposalError ?? "Model emitted empty or undefined response",
        "model_raw_stream",
      );
    } else if (input.proposalValid === false) {
      const err = input.proposalError ?? "";
      const code: AttributionFailureCode = err.includes("No tool call")
        ? "MODEL_NO_TOOL_CALL"
        : "MODEL_PARSE_ERROR";
      recordDecisive(
        "STAGE_2_MODEL_PROPOSAL",
        code,
        input.proposalError ?? "Model emitted malformed or unparseable proposal",
        "proposal_parser",
      );
    }

    // Stage 3: Patch Application
    if (input.proposalValid && input.patchApplied === false) {
      recordDecisive(
        "STAGE_3_PATCH_APPLICATION",
        input.patchError?.includes("Target") ? "PATCH_TARGET_NOT_FOUND" : "PATCH_SYNTAX_ERROR",
        input.patchError ?? "Patch could not be applied cleanly to workspace",
        "patch_applier",
      );
    }

    // Stage 4: Governance / Scope Checking
    if (input.governanceDenied || (input.scopeViolations && input.scopeViolations.length > 0)) {
      recordDecisive(
        "STAGE_4_GOVERNANCE_SCOPE",
        input.scopeViolations && input.scopeViolations.length > 0 ? "GOVERNANCE_SCOPE_VIOLATION" : "GOVERNANCE_CAPABILITY_DENIED",
        input.governanceReason ?? `Scope or capability violation: ${input.scopeViolations?.join(", ")}`,
        "governance_fence",
      );
    }

    // Stage 5: Sandbox Execution / Timeout
    if (input.timedOut) {
      recordDecisive(
        "STAGE_5_EXECUTION_SANDBOX",
        "SANDBOX_TIMEOUT",
        "Execution exceeded hard timeout budget",
        "sandbox_timer",
      );
    } else if (input.processCrashed) {
      recordDecisive(
        "STAGE_5_EXECUTION_SANDBOX",
        "SANDBOX_PROCESS_CRASH",
        "Process terminated unexpectedly with fatal signal",
        "sandbox_runtime",
      );
    }

    // Stage 6: Advisory Source Diagnostics
    if (input.diagnosticStatus && input.diagnosticStatus !== "CLEAN" && input.diagnosticStatus !== "UNSUPPORTED") {
      recordDecisive(
        "STAGE_6_DIAGNOSTIC_ADVISORY",
        "DIAGNOSTIC_LINT_FAILURE",
        `Advisory diagnostic reported malformed source syntax: ${input.diagnosticStatus}`,
        input.diagnosticOutputHash ?? "diag_hash",
      );
    }

    // Stage 7: Test Execution (Distinguish test process failure from assertion failure)
    if (input.testExecutionFailed) {
      recordDecisive(
        "STAGE_7_TEST_EXECUTION",
        "TEST_PROCESS_FAILED",
        `Test command failed to execute cleanly (exit code: ${input.testExitCode ?? 1})`,
        "test_runner_process",
      );
    } else if (input.testAssertionFailed) {
      recordDecisive(
        "STAGE_7_TEST_EXECUTION",
        "TEST_ASSERTION_FAILED",
        "Test assertions executed and failed against mutated code",
        "test_assertions",
      );
    }

    // Stage 8: Sovereign Clean-Room Verification
    if (input.verified === false && input.verificationFailureReason) {
      recordDecisive(
        "STAGE_8_SOVEREIGN_VERIFICATION",
        "VERIFIER_INVARIANT_FAILED",
        `Sovereign verification failed: ${input.verificationFailureReason}`,
        "sovereign_verifier",
      );
    }

    // Stage 9: Success Verified
    if (input.verified === true) {
      return {
        primaryStage: "STAGE_9_VERIFIED_SUCCESS",
        primaryCode: "SUCCESS_VERIFIED",
        primaryReason: "Goal certified complete by sovereign clean-room verifier",
        decisiveEvidenceRef: input.verificationProofHash ?? "proof_hash",
        stageRecords: [
          {
            stage: "STAGE_9_VERIFIED_SUCCESS",
            code: "SUCCESS_VERIFIED",
            decisive: true,
            reason: "Sovereign verification passed with proof hash",
            evidenceRef: input.verificationProofHash,
            timestamp,
          },
        ],
        modelProposalValid: true,
        patchAppliedSuccessfully: true,
        testsExecuted: true,
        testPassed: true,
        sovereignVerified: true,
      };
    }

    // Inconclusive Fallback
    if (decisiveStage === null) {
      return {
        primaryStage: "STAGE_UNKNOWN_INCONCLUSIVE",
        primaryCode: "INCONCLUSIVE_INSUFFICIENT_EVIDENCE",
        primaryReason: "Insufficient evidence to decisively attribute failure stage",
        decisiveEvidenceRef: "none",
        stageRecords: [],
        modelProposalValid: input.proposalValid ?? false,
        patchAppliedSuccessfully: input.patchApplied ?? false,
        testsExecuted: !input.testExecutionFailed,
        testPassed: !input.testAssertionFailed,
        sovereignVerified: false,
      };
    }

    return {
      primaryStage: decisiveStage,
      primaryCode: decisiveCode!,
      primaryReason: decisiveReason,
      decisiveEvidenceRef: decisiveRef,
      stageRecords,
      modelProposalValid: input.proposalValid ?? (decisiveStage !== "STAGE_2_MODEL_PROPOSAL"),
      patchAppliedSuccessfully: input.patchApplied ?? (decisiveStage !== "STAGE_2_MODEL_PROPOSAL" && decisiveStage !== "STAGE_3_PATCH_APPLICATION"),
      testsExecuted: !input.testExecutionFailed && decisiveStage !== "STAGE_1_TASK_INITIALIZATION" && decisiveStage !== "STAGE_2_MODEL_PROPOSAL" && decisiveStage !== "STAGE_3_PATCH_APPLICATION",
      testPassed: !input.testAssertionFailed && !input.testExecutionFailed,
      sovereignVerified: false,
    };
  }
}
