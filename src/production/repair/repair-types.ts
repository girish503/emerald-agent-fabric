/**
 * Emerald Agent Fabric — Production V1.3: Repair Workflow & Session Types
 *
 * Core Principle:
 * "The model proposes. The runtime governs. The sandbox executes. Diagnostics explain. The verifier decides. The evidence proves."
 */

import { ProductionRun } from "../../control-plane/run-control.js";
import { ProductionEvidenceBundle } from "../../control-plane/evidence-control.js";
import { ProductionVerificationResult } from "../../verification/production-verifier.js";
import { DiagnosticMetrics } from "../diagnostics/diagnostic-feedback.js";

/**
 * Explicit 10-stage repair loop phases in strict sequential order.
 */
export type RepairLoopPhase =
  | "INSPECT"
  | "PLAN"
  | "PROPOSE"
  | "VALIDATE"
  | "GOVERN"
  | "EXECUTE"
  | "DIAGNOSE"
  | "TEST"
  | "LOCALIZE"
  | "REVISE";

/**
 * Standardized production failure and completion taxonomy.
 */
export type RepairFailureClassification =
  | "ENVIRONMENT_FAILURE"
  | "MODEL_PROPOSAL_FAILURE"
  | "GOVERNANCE_REJECTION"
  | "PATCH_FAILURE"
  | "VERIFICATION_FAILURE"
  | "RECOVERY_FAILURE"
  | "RUNTIME_FAILURE"
  | "TIMEOUT"
  | "CANCELLED"
  | "SOVEREIGN_VERIFIED_SUCCESS";

/**
 * Bounded test failure localization data structure (advisory, non-authoritative).
 */
export interface TestFailureLocalization {
  readonly localizationId: string;
  readonly testCommand: string;
  readonly exitCode: number;
  readonly failingTests: readonly string[];
  readonly failureMessages: readonly string[];
  readonly localizedFiles: readonly string[];
  readonly rawSummary: string;
  readonly durationMs: number;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly authoritative: false;
  readonly verificationAuthority: false;
  readonly terminalAuthority: false;
}

/**
 * Resource budgets and operational constraints for a repair session.
 */
export interface RepairSessionConfig {
  readonly maxSteps: number;
  readonly maxAttempts: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxFeedbackRoundsPerAction: number;
  readonly timeoutMs: number;
  readonly maxLocalizationBytes: number;
  readonly allowedWorkspacePaths?: readonly string[];
  readonly expectedFiles?: readonly string[];
  readonly autoCommitForbidden: true;
  readonly autoPushForbidden: true;
}

export const DEFAULT_REPAIR_CONFIG: RepairSessionConfig = {
  maxSteps: 6,
  maxAttempts: 8,
  maxModelCalls: 10,
  maxToolCalls: 20,
  maxFeedbackRoundsPerAction: 2,
  timeoutMs: 120_000,
  maxLocalizationBytes: 8192,
  autoCommitForbidden: true,
  autoPushForbidden: true,
};

/**
 * Snapshot of remaining resource budgets.
 */
export interface RepairSessionBudgets {
  remainingSteps: number;
  remainingAttempts: number;
  remainingModelCalls: number;
  remainingToolCalls: number;
  remainingTimeMs: number;
}

/**
 * Active in-memory and durable state of a repair session.
 */
export interface RepairSessionState {
  readonly sessionId: string;
  readonly runId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly contractHash: string;
  readonly initialGitHash: string;
  currentPhase: RepairLoopPhase;
  budgets: RepairSessionBudgets;
  readonly modifiedFiles: string[];
  readonly scopeViolations: string[];
  finalDiff: string;
  classification: RepairFailureClassification;
  sovereignVerified: boolean;
  activeAttemptId?: string;
  proposalHistoryCount: number;
  diagnosticsCount: number;
  localizationsCount: number;
  createdAt: string;
  updatedAt: string;
  stoppedReason?: string;
}

/**
 * Complete outcome of a finished repair session.
 */
export interface RepairSessionOutcome {
  readonly session: RepairSessionState;
  readonly run: ProductionRun;
  readonly evidence: ProductionEvidenceBundle;
  readonly verification: ProductionVerificationResult;
  readonly diagnosticMetrics?: DiagnosticMetrics;
  readonly reviewableDiff: string;
  readonly changedFiles: readonly string[];
  readonly unexpectedChanges: readonly string[];
  readonly durationMs: number;
}
