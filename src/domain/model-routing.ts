/**
 * Governed Model Routing Domain Model for Emerald Agent Fabric.
 *
 * Invariants:
 * 1. ₹0-Cost & Open-Weight Only: proprietary hosted inference is rejected fail-closed.
 * 2. Evidence-Backed Authority: a model is routable for a role only when every required capability gate
 *    has unexpired PASSED evidence recorded against the same model digest. Registration, a model's name,
 *    its description and its declared capabilities are never evidence.
 * 3. Identity: a registry digest is an identity only when `digestVerified` is true. Unverified digests are
 *    recorded as null and can never match an installed model.
 * 4. Honest measurements: expected, observed and timeout latency values are kept separate. A value that was
 *    not measured is null, never an estimate presented as a measurement.
 * 5. Contract Preservation: fallback keeps the task contract, role, required gates, tenant and budgets.
 * 6. Attempt Orthogonality: an inference failure is never converted into a task-execution retry.
 */

import { SuperAgentRole } from "./super-agent.js";

// ============================================================================
// 1. Capability gates
// ============================================================================

export type ModelCapabilityGateId =
  | "G1_STRUCTURED_JSON"
  | "G2_REPO_NAVIGATION"
  | "G3_CODE_UNDERSTANDING"
  | "G4_SINGLE_FILE_REPAIR"
  | "G5_MULTI_FILE_REPAIR"
  | "G6_REGRESSION_AWARENESS"
  | "G7_BEHAVIORAL_CONSISTENCY"
  | "G8_CONTEXT_RETENTION"
  | "G9_FAILURE_RECOVERY"
  | "G10_COMPLETION_SIGNAL";

export const MODEL_CAPABILITY_GATE_IDS: readonly ModelCapabilityGateId[] = Object.freeze([
  "G1_STRUCTURED_JSON",
  "G2_REPO_NAVIGATION",
  "G3_CODE_UNDERSTANDING",
  "G4_SINGLE_FILE_REPAIR",
  "G5_MULTI_FILE_REPAIR",
  "G6_REGRESSION_AWARENESS",
  "G7_BEHAVIORAL_CONSISTENCY",
  "G8_CONTEXT_RETENTION",
  "G9_FAILURE_RECOVERY",
  "G10_COMPLETION_SIGNAL",
]);

/** What a gate means and what it takes to pass it. These are policy definitions, not results. */
export interface CapabilityGateDefinition {
  readonly gateId: ModelCapabilityGateId;
  readonly meaning: string;
  readonly requiredEvidence: string;
  readonly testMethod: string;
  readonly passCriteria: string;
  /** Evidence older than this many days must be re-collected before it can authorize routing. */
  readonly revalidationDays: number;
}

const gate = (
  gateId: ModelCapabilityGateId,
  meaning: string,
  requiredEvidence: string,
  testMethod: string,
  passCriteria: string
): CapabilityGateDefinition => Object.freeze({ gateId, meaning, requiredEvidence, testMethod, passCriteria, revalidationDays: 90 });

export const CAPABILITY_GATE_DEFINITIONS: Readonly<Record<ModelCapabilityGateId, CapabilityGateDefinition>> = Object.freeze({
  G1_STRUCTURED_JSON: gate(
    "G1_STRUCTURED_JSON",
    "Returns a schema-valid action proposal for every request under the production structured-output schema.",
    "Durable inference telemetry for governed runs with the production schema.",
    "Governed live run; count requests whose outcome is SUCCESS versus INVALID_RESPONSE.",
    "At least 10 requests and zero INVALID_RESPONSE outcomes."
  ),
  G2_REPO_NAVIGATION: gate(
    "G2_REPO_NAVIGATION",
    "Locates the relevant files in an unfamiliar repository using read and search tools.",
    "Governed runs on a repository-navigation task set with independently checked target files.",
    "Evaluation harness task set; compare files read against the labelled target files.",
    "Target file reached within the step budget on at least 80% of tasks."
  ),
  G3_CODE_UNDERSTANDING: gate(
    "G3_CODE_UNDERSTANDING",
    "Identifies the cause of a failing behaviour from source and test output.",
    "Governed runs on a diagnosis task set with labelled root causes.",
    "Evaluation harness task set; the proposed edit must touch the labelled defect location.",
    "Correct defect location on at least 70% of tasks."
  ),
  G4_SINGLE_FILE_REPAIR: gate(
    "G4_SINGLE_FILE_REPAIR",
    "Produces a single-file change that makes an independently executed verification command pass.",
    "Governed runs ending COMPLETED with system-owned verification evidence.",
    "Evaluation harness single-file repair set with clean-room verification.",
    "Verified completion on at least 70% of tasks."
  ),
  G5_MULTI_FILE_REPAIR: gate(
    "G5_MULTI_FILE_REPAIR",
    "Produces a coordinated change across several files that passes independent verification.",
    "Governed runs ending COMPLETED on multi-file tasks with system-owned verification evidence.",
    "Evaluation harness multi-file repair set with clean-room verification.",
    "Verified completion on at least 60% of tasks."
  ),
  G6_REGRESSION_AWARENESS: gate(
    "G6_REGRESSION_AWARENESS",
    "Does not break previously passing tests while repairing a failing one.",
    "Pass-to-pass verification results from governed repair runs.",
    "Evaluation harness with fail-to-pass and pass-to-pass suites.",
    "Zero pass-to-pass regressions on at least 90% of completed tasks."
  ),
  G7_BEHAVIORAL_CONSISTENCY: gate(
    "G7_BEHAVIORAL_CONSISTENCY",
    "Gives the same proposal for the same context at temperature 0.",
    "Repeated governed requests with identical context snapshots.",
    "Replay each context at least 3 times and compare proposal hashes.",
    "Identical proposals on at least 95% of contexts."
  ),
  G8_CONTEXT_RETENTION: gate(
    "G8_CONTEXT_RETENTION",
    "Keeps the task objective and prior results over a multi-step run without undoing its own work.",
    "Governed multi-step runs with action history.",
    "Inspect durable action history for reverted or degraded prior successful work.",
    "No self-reverting action on at least 90% of runs of 4 or more steps."
  ),
  G9_FAILURE_RECOVERY: gate(
    "G9_FAILURE_RECOVERY",
    "Changes approach after a tool failure or rejection instead of repeating the failed action.",
    "Governed runs containing at least one failed action or rejected proposal.",
    "Inspect the action following each failure in durable history.",
    "A materially different next action on at least 80% of failures."
  ),
  G10_COMPLETION_SIGNAL: gate(
    "G10_COMPLETION_SIGNAL",
    "Signals completion when, and only when, the objective is satisfied.",
    "Governed runs with system-owned verification at the point of the completion claim.",
    "Compare each completion claim, and each absence of one, with the verification outcome.",
    "Completion claimed and verified on at least 80% of solvable tasks, with no unverified claim."
  ),
});

export type CapabilityGateOutcome = "PASSED" | "FAILED" | "INSUFFICIENT_EVIDENCE";

export type CapabilityCertificationStatus =
  | "UNVERIFIED"
  | "INSUFFICIENT_EVIDENCE"
  | "PASSED"
  | "FAILED"
  | "EXPIRED"
  | "INVALIDATED";

/** One evidence record for one gate, bound to an exact model identity. */
export interface CapabilityGateEvidence {
  readonly gateId: ModelCapabilityGateId;
  readonly outcome: CapabilityGateOutcome;
  readonly modelId: string;
  /** Digest of the model the evidence was collected against. */
  readonly modelDigest: string;
  readonly evaluationVersion: string;
  /** Where the evidence can be inspected (durable run identifiers, report path). */
  readonly evidenceRef: string;
  readonly summary: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly evaluationMode?: "FIXTURE_VALIDATION" | "LIVE_MODEL_EVALUATION";
}

// ============================================================================
// 2. Model profile
// ============================================================================

export interface ModelContextLimits {
  /** Context window the production provider is configured with (tokens). */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextWindowBytes: number;
}

export interface ObservedLatency {
  readonly sampleCount: number;
  readonly minMs: number;
  readonly medianMs: number;
  /** Nearest-rank 90th percentile; null when fewer than 10 samples exist. */
  readonly p90Ms: number | null;
  readonly maxMs: number;
  readonly measuredAt: string;
  readonly source: string;
}

export interface ModelLatencyProfile {
  /** Design estimate before measurement; null when no estimate is claimed. */
  readonly expectedStepLatencyMs: number | null;
  /** Measured on this host; null when the model has never been measured here. */
  readonly observed: ObservedLatency | null;
  /** Per-request inference timeout used when the observations were made, or the configured default. */
  readonly timeoutThresholdMs: number;
}

export interface ModelHardwareRequirements {
  readonly residentMemoryMb: number;
  /** True when residentMemoryMb was read from the provider at load time rather than estimated. */
  readonly residentMemoryMeasured: boolean;
  readonly quantization: string;
  readonly accelerator: "CPU" | "GPU" | "AUTO";
}

export interface OpenWeightModelProfile {
  readonly modelId: string;
  readonly modelTag: string;
  /** Provider digest; null when it has not been verified against an installed copy. */
  readonly modelDigest: string | null;
  readonly digestVerified: boolean;
  readonly parameterCount: string;
  readonly openSourceLicense: string;
  readonly isProprietaryHosted: false;
  /** What the model card claims. Never used for routing. */
  readonly declaredCapabilities: readonly string[];
  readonly gateEvidence: readonly CapabilityGateEvidence[];
  readonly contextLimits: ModelContextLimits;
  readonly latencyProfile: ModelLatencyProfile;
  readonly hardwareRequirements: ModelHardwareRequirements;
}

/**
 * Evaluates the authoritative capability certification status for a model and gate.
 * Strictly verifies unexpired PASSED evidence bound to the exact verified model digest.
 */
export function getGateCertificationStatus(
  profile: OpenWeightModelProfile,
  gateId: ModelCapabilityGateId,
  now: Date,
  expectedDigest?: string | null
): CapabilityCertificationStatus {
  if (!profile.digestVerified || !profile.modelDigest) {
    return "UNVERIFIED";
  }
  const normalizedProfileDigest = profile.modelDigest.trim().toLowerCase().replace(/^sha256:/, "");
  if (expectedDigest) {
    const normalizedExpected = expectedDigest.trim().toLowerCase().replace(/^sha256:/, "");
    if (normalizedProfileDigest !== normalizedExpected) {
      return "INVALIDATED";
    }
  }

  const records = profile.gateEvidence
    .filter((e) => e.gateId === gateId && e.modelId === profile.modelId)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

  if (records.length === 0) {
    return "UNVERIFIED";
  }

  const latest = records[records.length - 1]!;
  const normalizedRecordDigest = latest.modelDigest.trim().toLowerCase().replace(/^sha256:/, "");
  if (normalizedRecordDigest !== normalizedProfileDigest) {
    return "INVALIDATED";
  }

  if (latest.evaluationMode === "FIXTURE_VALIDATION") {
    // Epistemic boundary: fixture validation proves harness behavior, never live model competence.
    return "UNVERIFIED";
  }

  if (latest.outcome === "INSUFFICIENT_EVIDENCE") {
    return "INSUFFICIENT_EVIDENCE";
  }

  if (new Date(latest.expiresAt).getTime() <= now.getTime()) {
    return "EXPIRED";
  }

  if (latest.outcome === "PASSED") {
    return "PASSED";
  }

  return "FAILED";
}

/** Gates with unexpired PASSED evidence for this exact digest, and no later FAILED evidence. */
export function getVerifiedGates(profile: OpenWeightModelProfile, now: Date): readonly ModelCapabilityGateId[] {
  if (!profile.digestVerified || !profile.modelDigest) return [];
  const verified: ModelCapabilityGateId[] = [];
  for (const gateId of MODEL_CAPABILITY_GATE_IDS) {
    if (getGateCertificationStatus(profile, gateId, now) === "PASSED") {
      verified.push(gateId);
    }
  }
  return verified;
}

// ============================================================================
// 3. Routing request, decision and durable assignment
// ============================================================================

export interface ModelRoutingRequest {
  readonly role: SuperAgentRole;
  readonly tenantId: string;
  readonly taskId: string;
  readonly contractId: string;
  readonly runId?: string;
  /** Remaining inference time for the task; 0 means not constrained by the caller. */
  readonly remainingBudgetMs: number;
  /** Per-request inference budget; 0 means not constrained by the caller. */
  readonly stepBudgetMs: number;
  readonly estimatedContextTokens: number;
  /** Memory the caller can give to a model (MB). Omitted: only the host ceiling applies. */
  readonly availableMemoryMb?: number;
  /** Gates required in addition to the role's defaults. They can only add requirements. */
  readonly requiredGates?: readonly ModelCapabilityGateId[];
}

export type ModelRejectionCode =
  | "INVENTORY_NOT_VERIFIED"
  | "NOT_INSTALLED"
  | "DIGEST_UNVERIFIED"
  | "DIGEST_MISMATCH"
  | "MISSING_GATE_EVIDENCE"
  | "CONTEXT_OVERFLOW"
  | "MEMORY_BUDGET_EXCEEDED"
  | "LATENCY_UNMEASURED"
  | "LATENCY_EXCEEDS_STEP_BUDGET"
  | "LATENCY_EXCEEDS_REMAINING_BUDGET"
  | "EXCLUDED_AFTER_FAILURE"
  | "CONCURRENCY_LIMIT";

export interface RejectedModelCandidate {
  readonly modelId: string;
  readonly reasons: readonly { readonly code: ModelRejectionCode; readonly detail: string }[];
}

export interface ModelRoutingDecision {
  readonly request: ModelRoutingRequest;
  readonly selectedModelId: string;
  readonly modelDigest: string;
  readonly modelProfile: OpenWeightModelProfile;
  readonly requiredGates: readonly ModelCapabilityGateId[];
  /** Evidence records that authorized the selection, one or more per required gate. */
  readonly evidenceRefs: readonly string[];
  readonly rejectedCandidates: readonly RejectedModelCandidate[];
  /** Other models that also qualified, in deterministic preference order. */
  readonly eligibleAlternates: readonly string[];
  readonly isFallback: boolean;
  /** Models that failed earlier for this request, oldest first. Empty for a first decision. */
  readonly fallbackChain: readonly { readonly modelId: string; readonly reason: string }[];
  readonly routingReason: string;
  readonly decidedAt: string;
  /** Hash over the decision content excluding decidedAt, so replays of the same inputs hash identically. */
  readonly decisionHash: string;
}

/** The durable, minimal record of a routing decision that travels with a child task. */
export interface ModelAssignment {
  readonly modelId: string;
  readonly modelDigest: string;
  readonly role: SuperAgentRole;
  readonly tenantId: string;
  readonly taskId: string;
  readonly contractId: string;
  readonly requiredGates: readonly ModelCapabilityGateId[];
  readonly evidenceRefs: readonly string[];
  readonly decisionHash: string;
  readonly decidedAt: string;
}

export function toModelAssignment(decision: ModelRoutingDecision): ModelAssignment {
  return Object.freeze({
    modelId: decision.selectedModelId,
    modelDigest: decision.modelDigest,
    role: decision.request.role,
    tenantId: decision.request.tenantId,
    taskId: decision.request.taskId,
    contractId: decision.request.contractId,
    requiredGates: Object.freeze([...decision.requiredGates]),
    evidenceRefs: Object.freeze([...decision.evidenceRefs]),
    decisionHash: decision.decisionHash,
    decidedAt: decision.decidedAt,
  });
}

// ============================================================================
// 4. Host and role policy
// ============================================================================

export const HOST_HARDWARE_LIMITS = Object.freeze({
  MAX_RESIDENT_MEMORY_MB: 7800, // physical memory of the reference host (~7.6 GiB)
  MAX_STEP_LATENCY_MS: 150_000, // production per-request inference timeout
  /** Only one model may be loaded for execution at a time on the reference host. */
  MAX_CONCURRENT_LOADED_MODELS: 1,
});

export const SUPER_AGENT_ROLES: readonly SuperAgentRole[] = Object.freeze(["RESEARCHER", "CODER", "TESTER", "REVIEWER"]);

export const ROLE_DEFAULT_GATE_REQUIREMENTS: Record<SuperAgentRole, readonly ModelCapabilityGateId[]> = {
  RESEARCHER: ["G1_STRUCTURED_JSON", "G2_REPO_NAVIGATION"] as const,
  CODER: ["G1_STRUCTURED_JSON", "G3_CODE_UNDERSTANDING", "G4_SINGLE_FILE_REPAIR"] as const,
  TESTER: ["G1_STRUCTURED_JSON", "G3_CODE_UNDERSTANDING"] as const,
  REVIEWER: ["G1_STRUCTURED_JSON", "G6_REGRESSION_AWARENESS"] as const,
};

// ============================================================================
// 5. Approved open-weight model registry
// ============================================================================

const QWEN_15B_DIGEST = "sha256:d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668";
const LIVE_EVAL_VERSION = "live-acceptance-2026-11-10";
const LIVE_RUNS =
  "durable runs 80063249-96a5-47d7-a6af-375fa9c308e0, 346fd586-6083-4c61-abb7-ab36868c071f, 879cc286-d23f-45f1-aec8-6269f422835b";

/** A registered model with no verified identity, no measurement and no capability evidence. */
const unverifiedProfile = (
  modelId: string,
  modelTag: string,
  parameterCount: string,
  openSourceLicense: string,
  declaredCapabilities: readonly string[],
  estimatedResidentMemoryMb: number
): OpenWeightModelProfile => ({
  modelId,
  modelTag,
  modelDigest: null,
  digestVerified: false,
  parameterCount,
  openSourceLicense,
  isProprietaryHosted: false,
  declaredCapabilities,
  gateEvidence: [],
  contextLimits: { maxInputTokens: 4096, maxOutputTokens: 2048, contextWindowBytes: 16384 },
  latencyProfile: { expectedStepLatencyMs: null, observed: null, timeoutThresholdMs: 150_000 },
  hardwareRequirements: {
    residentMemoryMb: estimatedResidentMemoryMb,
    residentMemoryMeasured: false,
    quantization: "Q4_K_M",
    accelerator: "CPU",
  },
});

export const APPROVED_OPEN_WEIGHT_MODELS: readonly OpenWeightModelProfile[] = [
  {
    modelId: "qwen2.5-coder:1.5b",
    modelTag: "qwen2.5-coder:1.5b-instruct-q4_K_M",
    modelDigest: QWEN_15B_DIGEST,
    digestVerified: true,
    parameterCount: "1.54B",
    openSourceLicense: "Apache-2.0",
    isProprietaryHosted: false,
    declaredCapabilities: ["code.generation", "code.repair", "workspace.query"],
    gateEvidence: [
      {
        gateId: "G1_STRUCTURED_JSON",
        outcome: "PASSED",
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: QWEN_15B_DIGEST,
        evaluationVersion: LIVE_EVAL_VERSION,
        evidenceRef: LIVE_RUNS,
        summary: "11 of 11 completed inference requests returned a schema-valid proposal; no INVALID_RESPONSE outcome.",
        observedAt: "2026-11-10T09:27:20.000Z",
        expiresAt: "2027-02-08T09:27:20.000Z",
      },
      {
        gateId: "G8_CONTEXT_RETENTION",
        outcome: "FAILED",
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: QWEN_15B_DIGEST,
        evaluationVersion: LIVE_EVAL_VERSION,
        evidenceRef: "durable run 879cc286-d23f-45f1-aec8-6269f422835b",
        summary: "After a correct first write the model overwrote its own file with invalid content three times.",
        observedAt: "2026-11-10T09:27:20.000Z",
        expiresAt: "2027-02-08T09:27:20.000Z",
      },
      {
        gateId: "G10_COMPLETION_SIGNAL",
        outcome: "FAILED",
        modelId: "qwen2.5-coder:1.5b",
        modelDigest: QWEN_15B_DIGEST,
        evaluationVersion: LIVE_EVAL_VERSION,
        evidenceRef:
          "durable runs 346fd586-6083-4c61-abb7-ab36868c071f, 879cc286-d23f-45f1-aec8-6269f422835b",
        summary:
          "One run claimed completion three times without verification evidence; one run never claimed completion after a correct result.",
        observedAt: "2026-11-10T09:27:20.000Z",
        expiresAt: "2027-02-08T09:27:20.000Z",
      },
    ],
    // The production worker runs this model with a 4,096-token runner context.
    contextLimits: { maxInputTokens: 4096, maxOutputTokens: 2048, contextWindowBytes: 16384 },
    latencyProfile: {
      expectedStepLatencyMs: null,
      observed: {
        sampleCount: 11,
        minMs: 52_099,
        medianMs: 59_128,
        p90Ms: 82_362,
        maxMs: 90_699,
        measuredAt: "2026-11-10T09:27:20.000Z",
        source: `wall-clock duration of completed inference requests in ${LIVE_RUNS} (Intel i3-N305, CPU only)`,
      },
      timeoutThresholdMs: 150_000,
    },
    hardwareRequirements: {
      // Provider-reported at load: 338 MiB model + 596 MiB repacked + 112 MiB KV cache + 72 MiB compute.
      residentMemoryMb: 1118,
      residentMemoryMeasured: true,
      quantization: "Q4_K_M",
      accelerator: "CPU",
    },
  },
  unverifiedProfile("deepseek-coder:1.3b", "deepseek-coder:1.3b-instruct-q4_K_M", "1.35B", "DeepSeek License", ["code.generation"], 950),
  unverifiedProfile("llama3.2:1b", "llama3.2:1b-instruct-q4_K_M", "1.23B", "Llama 3.2 Community License", ["text.generation"], 850),
  unverifiedProfile("qwen2.5-coder:7b", "qwen2.5-coder:7b-instruct-q4_K_M", "7.61B", "Apache-2.0", ["code.generation", "code.repair"], 5200),
];

// ============================================================================
// 6. Domain errors
// ============================================================================

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export class InfeasibleModelError extends ModelRoutingError {
  constructor(modelId: string, reason: string) {
    super(`Model '${modelId}' is environmentally infeasible: ${reason}`);
    this.name = "InfeasibleModelError";
  }
}

export class ProprietaryModelRejectedError extends ModelRoutingError {
  constructor(modelId: string) {
    super(`Proprietary or hosted model '${modelId}' is strictly prohibited by ₹0-cost open-weight governance policy`);
    this.name = "ProprietaryModelRejectedError";
  }
}

export class InsufficientCapabilityGateError extends ModelRoutingError {
  constructor(modelId: string, missingGates: readonly string[]) {
    super(`Model '${modelId}' lacks experimentally verified gates: [${missingGates.join(", ")}]`);
    this.name = "InsufficientCapabilityGateError";
  }
}

/** No registered model satisfies the request. Carries every candidate's rejection reasons for audit. */
export class NoQualifiedModelError extends ModelRoutingError {
  constructor(
    readonly role: string,
    readonly requiredGates: readonly ModelCapabilityGateId[],
    readonly rejectedCandidates: readonly RejectedModelCandidate[]
  ) {
    super(
      `No approved model qualifies for role '${role}' requiring [${requiredGates.join(", ")}]: ` +
        rejectedCandidates
          .map((c) => `${c.modelId} (${c.reasons.map((r) => r.code).join("+")})`)
          .join("; ")
    );
    this.name = "NoQualifiedModelError";
  }
}

/** A task's durable model assignment does not match the model this worker is authorized to run. */
export class ModelAssignmentViolationError extends ModelRoutingError {
  constructor(message: string) {
    super(message);
    this.name = "ModelAssignmentViolationError";
  }
}
