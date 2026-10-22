/**
 * Emerald Agent Fabric — Production Benchmark Types (v0.1)
 *
 * Defines typed specifications, task definitions, failure taxonomies,
 * model feasibility matrices, and trial outcome structures.
 */

export type BenchmarkDifficulty = "EASY" | "MEDIUM" | "HARD";

export interface BenchmarkTask {
  readonly taskId: string;
  readonly title: string;
  readonly difficulty: BenchmarkDifficulty;
  readonly language: string;
  readonly issue: string;
  readonly expectedBehavior: string;
  readonly sourceFile: string;
  readonly testFile: string;
  readonly testCommand: { readonly cmd: string; readonly args: readonly string[] };
  readonly verificationCommand: { readonly cmd: string; readonly args: readonly string[] };
  readonly initialCode: string;
  readonly testCode: string;
}

export type BenchmarkCondition =
  | "CONTROL_A_MODEL_ONLY"
  | "CONTROL_B_GOVERNED_RUNTIME"
  | "CONTROL_B0_BASELINE"
  | "CONTROL_B1_DIAGNOSTIC"
  | "CONTROL_B2_REPAIR_ORCHESTRATION"
  | "CONTROL_C_HUMAN_REFERENCE";

export type BenchmarkFailureClass =
  | "ENVIRONMENT_FAILURE"
  | "MODEL_PROPOSAL_FAILURE"
  | "GOVERNANCE_REJECTION"
  | "PATCH_FAILURE"
  | "SOVEREIGN_VERIFIED_SUCCESS"
  | "VERIFICATION_FAILURE"
  | "RECOVERY_FAILURE"
  | "RUNTIME_FAILURE"
  | "TIMEOUT"
  | "CANCELLED";

export type ModelFeasibilityStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "INFEASIBLE"
  | "MISCONFIGURED";

export interface ModelHardwareProfile {
  readonly modelName: string;
  readonly quantization: string;
  readonly modelSizeBytes: number;
  readonly hostRamTotalMb: number;
  readonly hostRamFreeMb: number;
  readonly cpuCores: number;
  readonly cpuModel: string;
  readonly gpuName: string;
  readonly ollamaVersion: string;
  readonly feasibility: ModelFeasibilityStatus;
  readonly reason?: string;
}

export interface BenchmarkMetrics {
  readonly runtimeMs: number;
  readonly modelRuntimeMs: number;
  readonly toolRuntimeMs: number;
  readonly verificationRuntimeMs: number;
  readonly filesRead: number;
  readonly filesWritten: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface BenchmarkSafetyMetrics {
  readonly capabilityViolations: number;
  readonly pathTraversalAttempts: number;
  readonly unauthorizedToolExecutions: number;
  readonly crossHarnessLeaks: number;
  readonly authorityExNihiloAttempts: number;
}

export interface BenchmarkTrialResult {
  readonly taskId: string;
  readonly condition: BenchmarkCondition;
  readonly modelName: string;
  readonly missionId: string;
  readonly runId: string;
  readonly classification: BenchmarkFailureClass;
  readonly verified: boolean;
  readonly attemptsCount: number;
  readonly toolCallsCount: number;
  readonly proposalsCount: number;
  readonly rejectedProposalsCount: number;
  readonly mutationsCount: number;
  readonly gitDiff: string;
  readonly verificationProofHash?: string;
  readonly evidenceBundleDigest?: string;
  readonly replayVerified: boolean;
  readonly metrics: BenchmarkMetrics;
  readonly safety: BenchmarkSafetyMetrics;
  readonly timelineEventsCount: number;
  readonly failureReason?: string;
  readonly diagnosticMetrics?: {
    readonly diagnosticExecutionCount: number;
    readonly diagnosticFailureCount: number;
    readonly diagnosticRecoveryCount: number;
    readonly diagnosticUnsupportedCount: number;
    readonly diagnosticTimeoutCount: number;
    readonly malformedPatchRate: number;
    readonly malformedPatchRecoveryRate: number;
    readonly sovereignVerificationCallsAvoided: number;
    readonly meanDiagnosticLatency: number;
    readonly p95DiagnosticLatency: number;
    readonly diagnosticContextBytes: number;
  };
}

export interface BenchmarkManifest {
  readonly manifestVersion: string;
  readonly manifestHash: string;
  readonly createdAt: string;
  readonly taskCount: number;
  readonly tasks: readonly BenchmarkTask[];
}
