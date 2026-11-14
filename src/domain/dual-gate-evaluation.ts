/**
 * Dual-Gate Model Capability Evaluation Domain for Emerald Agent Fabric.
 *
 * Implements the domain model for clean-room capability evaluation across G1–G10,
 * specifically formalizing dual-gate evaluation for G2–G7 and G9:
 *
 * Gate A (Model Behavioral Capability):
 *   Evaluates whether the model demonstrates the target capability (structured JSON output,
 *   repository navigation targeting, defect diagnosis, single/multi-file repairs,
 *   regression awareness, temperature-0 consistency, failure recovery shift).
 *
 * Gate B (Independent System Verification):
 *   Independent system-owned evaluation of resulting workspace state and actions
 *   against ground truth oracles and automated test suites.
 *   The model NEVER grades itself; model-generated claims of success are disregarded.
 *
 * Both Gate A and Gate B must pass for a trial to succeed.
 * Statistical certification requires a minimum sample count and threshold pass rate.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";
import {
  CapabilityCertificationStatus,
  ModelCapabilityGateId,
} from "./model-routing.js";
import { ToolName } from "./tool.js";

// ============================================================================
// 1. Evaluation Task Definitions
// ============================================================================

export type EvaluationExecutionMode = "FIXTURE_VALIDATION" | "LIVE_MODEL_EVALUATION";

export interface GateABehavioralCriteria {
  /** Expected tool name the proposal must invoke */
  readonly expectedTool?: ToolName;
  /** Files the model's proposals must target or inspect */
  readonly expectedTargetFiles?: readonly string[];
  /** Expected line numbers, functions, or identifier substrings the model must touch or cite */
  readonly expectedCitations?: readonly string[];
  /** Action shift required for recovery (e.g. tool or argument divergence) */
  readonly requireActionShift?: boolean;
  /** Custom Gate A assessment logic */
  readonly customAssess?: (proposal: {
    toolName?: string;
    inputPayload?: unknown;
    rationale?: string;
  }) => { passed: boolean; score: number; rationale: string };
}

export interface GateBVerificationCriteria {
  /** Verifier type */
  readonly verifierType: "CLEANROOM_ORACLE" | "TEST_RUNNER" | "HASH_INVARIANT";
  /** Ground truth files that must exist in the cleanroom workspace */
  readonly expectedFiles?: Readonly<Record<string, string | ((content: string) => boolean)>>;
  /** Ground truth files that must NOT be modified (pass-to-pass regression prevention) */
  readonly immutableFiles?: readonly string[];
  /** Expected exit code of cleanroom verification command */
  readonly expectedExitCode?: number;
  /** Verification command or custom oracle function */
  readonly customVerify?: (workspaceRoot: string) => Promise<{ success: boolean; details?: string }>;
  /** Isolated in-process VM test runner configuration for execution-based repair verification (SEC-017) */
  readonly testRunner?: {
    readonly targetModule: string;
    readonly testAssertions: string;
  };
  /** Grounded code understanding diagnostic expectations for G3 */
  readonly diagnosticGrounding?: {
    readonly targetFile: string;
    readonly defectiveLineNumbers: readonly number[];
    readonly causalKeywords?: readonly string[];
    readonly requiredConcepts?: readonly string[];
    readonly forbiddenContradictions?: readonly string[];
    readonly healthyFiles?: readonly string[];
    readonly validateDiagnosis?: (diagnosisText: string, targetSource: string) => {
      readonly valid: boolean;
      readonly reason?: string;
    };
  };
}

export interface DualGateEvaluationTask {
  readonly taskId: string;
  readonly gateId: ModelCapabilityGateId;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly isNegativeCase?: boolean;
  readonly initialFiles: Readonly<Record<string, string>>;
  readonly inputPrompt: string;
  readonly allowedTools: readonly ToolName[];
  readonly resourceLimits: {
    readonly timeoutMs: number;
    readonly maxSteps: number;
    readonly maxOutputBytes: number;
    readonly stepTimeoutMs?: number;
  };
  readonly gateACriteria: GateABehavioralCriteria;
  readonly gateBCriteria: GateBVerificationCriteria;
}

// ============================================================================
// 2. Assessments and Trial Results
// ============================================================================

export interface GateAAssessment {
  readonly passed: boolean;
  readonly score: number; // 0.0 to 1.0
  readonly rationale: string;
  readonly details: readonly string[];
}

export interface GateBAssessment {
  readonly passed: boolean;
  readonly verifierType: "CLEANROOM_ORACLE" | "TEST_RUNNER" | "HASH_INVARIANT";
  readonly details: readonly string[];
  readonly independentEvidenceRef: string;
}

export interface EvaluationStepRecord {
  readonly stepNumber: number;
  readonly proposal: {
    readonly toolName?: string;
    readonly inputPayload?: unknown;
    readonly rationale?: string;
  };
  readonly toolObservation?: string;
  readonly accessedPath?: string;
  readonly durationMs: number;
}

export type TrialFailureClassification =
  | "MODEL_BEHAVIORAL_FAILURE"
  | "INDEPENDENT_VERIFICATION_FAILURE"
  | "TIMEOUT"
  | "HARNESS_ERROR"
  | "SECURITY_VIOLATION"
  | "CANCELLED";

export type TrialDiagnosticRootCause =
  | "MODEL_REQUEST_TIMEOUT"
  | "TRIAL_WALL_CLOCK_TIMEOUT"
  | "TOOL_EXECUTION_TIMEOUT"
  | "MODEL_PROVIDER_FAILURE"
  | "INVALID_TOOL_PROPOSAL"
  | "HARNESS_FAILURE"
  | "BEHAVIORAL_FAILURE"
  | "INDEPENDENT_VERIFICATION_FAILURE"
  | "SECURITY_VIOLATION"
  | "CALLER_ABORTED"
  | "WORKSPACE_CLEANUP_FAILURE";

export interface DualGateTrialResult {
  readonly trialId: string;
  readonly trialIndex: number;
  readonly taskId: string;
  readonly gateId: ModelCapabilityGateId;
  readonly modelId: string;
  readonly modelDigest: string;
  readonly harnessVersion: string;
  readonly evaluationMode: EvaluationExecutionMode;
  readonly gateA: GateAAssessment;
  readonly gateB: GateBAssessment;
  readonly overallPassed: boolean;
  readonly durationMs: number;
  readonly observedAt: string;
  readonly configHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly trialEvidenceHash: string;
  readonly failureClassification?: TrialFailureClassification;
  readonly diagnosticRootCause?: TrialDiagnosticRootCause;
  readonly stepsExecuted?: number;
  readonly stepRecords?: readonly EvaluationStepRecord[];
}

// ============================================================================
// 3. Statistical Gate Thresholds & Summary
// ============================================================================

export interface GateEvaluationThreshold {
  readonly minTrials: number;
  readonly minPassRate: number; // 0.0 to 1.0
  readonly maxTimeoutRate: number; // e.g. 0.05
}

export const GATE_EVALUATION_THRESHOLDS: Readonly<Record<ModelCapabilityGateId, GateEvaluationThreshold>> = Object.freeze({
  G1_STRUCTURED_JSON: Object.freeze({ minTrials: 10, minPassRate: 1.0, maxTimeoutRate: 0.0 }),
  G2_REPO_NAVIGATION: Object.freeze({ minTrials: 5, minPassRate: 0.8, maxTimeoutRate: 0.1 }),
  G3_CODE_UNDERSTANDING: Object.freeze({ minTrials: 5, minPassRate: 0.7, maxTimeoutRate: 0.1 }),
  G4_SINGLE_FILE_REPAIR: Object.freeze({ minTrials: 5, minPassRate: 0.7, maxTimeoutRate: 0.1 }),
  G5_MULTI_FILE_REPAIR: Object.freeze({ minTrials: 5, minPassRate: 0.6, maxTimeoutRate: 0.1 }),
  G6_REGRESSION_AWARENESS: Object.freeze({ minTrials: 5, minPassRate: 0.9, maxTimeoutRate: 0.05 }),
  G7_BEHAVIORAL_CONSISTENCY: Object.freeze({ minTrials: 3, minPassRate: 1.0, maxTimeoutRate: 0.0 }),
  G8_CONTEXT_RETENTION: Object.freeze({ minTrials: 5, minPassRate: 0.9, maxTimeoutRate: 0.05 }),
  G9_FAILURE_RECOVERY: Object.freeze({ minTrials: 5, minPassRate: 0.8, maxTimeoutRate: 0.1 }),
  G10_COMPLETION_SIGNAL: Object.freeze({ minTrials: 5, minPassRate: 0.8, maxTimeoutRate: 0.1 }),
});

export interface GateStatisticalSummary {
  readonly gateId: ModelCapabilityGateId;
  readonly modelId: string;
  readonly modelDigest: string;
  readonly harnessVersion: string;
  readonly evaluationMode: EvaluationExecutionMode;
  readonly totalTrials: number;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly timedOutTrials: number;
  readonly gateAPassCount: number;
  readonly gateBPassCount: number;
  readonly successRate: number;
  readonly minLatencyMs: number;
  readonly medianLatencyMs: number;
  readonly p90LatencyMs: number;
  readonly maxLatencyMs: number;
  readonly status: CapabilityCertificationStatus;
  readonly reasons: readonly string[];
  readonly failureBreakdown?: Readonly<Record<string, number>>;
  readonly rootCauseBreakdown?: Readonly<Record<string, number>>;
}

// ============================================================================
// 4. Canonical Hash Utilities
// ============================================================================

export function computeTrialEvidenceHash(trial: {
  trialId: string;
  taskId: string;
  gateId: string;
  modelId: string;
  modelDigest: string;
  harnessVersion: string;
  evaluationMode: string;
  observedAt: string;
  configHash: string;
  inputHash: string;
  outputHash: string;
  gateAPassed: boolean;
  gateBPassed: boolean;
  overallPassed: boolean;
}): string {
  return sha256Hex(
    canonicalJsonStringify({
      trialId: trial.trialId,
      taskId: trial.taskId,
      gateId: trial.gateId,
      modelId: trial.modelId,
      modelDigest: trial.modelDigest,
      harnessVersion: trial.harnessVersion,
      evaluationMode: trial.evaluationMode,
      observedAt: trial.observedAt,
      configHash: trial.configHash,
      inputHash: trial.inputHash,
      outputHash: trial.outputHash,
      gateAPassed: trial.gateAPassed,
      gateBPassed: trial.gateBPassed,
      overallPassed: trial.overallPassed,
    })
  );
}
