/**
 * Durable Evaluation Evidence and Artifact Provenance Domain Model for Emerald Agent Fabric.
 *
 * Establishes an immutable, tamper-evident, bounded, and sanitized persistence format
 * for live and offline SWE evaluation trial evidence (transcript steps, ReflexEvidence,
 * metrics, outcomes, and task/trial identities).
 *
 * Architectural Invariants:
 * 1. Immutable Provenance:
 *    Every persisted trial artifact is bound to task identity, configuration fingerprint,
 *    rule hash, and an authoritative artifactHash computed over canonical JSON serialization.
 * 2. Security & Credential Boundary:
 *    Artifacts must NEVER contain credentials, private keys, bearer tokens, passwords,
 *    or sensitive key-values. Sanitization is deterministic and mandatory before persistence.
 * 3. Strict Size Bounds:
 *    Bounds are strictly enforced on transcript entry count, payload sizes, and serialized byte sizes.
 *    Any bound violation results in an explicit ARTIFACT_SERIALIZATION_FAILED failure.
 *    Zero silent truncation of action payloads or contexts required for replay.
 * 4. Epistemic Separation & Baseline Telemetry Isolation:
 *    Baseline trials MUST omit reflexEvidence (undefined).
 *    Reflex trials with zero interventions persist reflexEvidence: [].
 * 5. Deterministic Replayability:
 *    Persisted artifacts contain all information required to reconstruct ReflexEvidence
 *    and execute deterministic offline replay verification via replayReflexEvidence.
 */

import { z } from "zod";
import {
  canonicalJsonStringify,
  isSensitiveKey,
  sha256Hex,
} from "./canonical-hash.js";
import {
  ArtifactBoundsExceededError,
  ArtifactIntegrityError,
  ArtifactSecurityError,
} from "./errors.js";
import {
  computeEvaluationTrialIdentityHash,
  EVALUATION_EXECUTION_MODES,
  EVALUATION_STATUSES,
  type EvaluationConfigFingerprint,
  EvaluationConfigFingerprintSchema,
  type EvaluationExecutionMode,
  type EvaluationMetrics,
  EvaluationMetricsSchema,
  type EvaluationStatus,
} from "./evaluation.js";
import {
  type ReflexEvidence,
  ReflexEvidenceSchema,
} from "./reflex-evidence.js";
import { TOOL_NAMES, type ToolName } from "./tool.js";

// ============================================================================
// 1. Constants & Bounds
// ============================================================================

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = 1;

export const EVIDENCE_ARTIFACT_BOUNDS = Object.freeze({
  /** Maximum number of transcript steps in a single trial */
  maxTranscriptEntries: 50,
  /** Maximum size in bytes of the canonical serialized transcript */
  maxSerializedTranscriptBytes: 1024 * 1024, // 1 MB
  /** Maximum size in bytes of all serialized Reflex evidence records */
  maxReflexEvidenceBytes: 512 * 1024, // 512 KB
  /** Maximum size in bytes for an individual action input or output payload */
  maxPayloadBytes: 65536, // 64 KB (matches MAX_PROPOSAL_BYTES)
  /** Maximum total size in bytes of the complete serialized artifact */
  maxTotalArtifactBytes: 2 * 1024 * 1024, // 2 MB
});

/**
 * Value-level regex patterns for secret detection across persisted artifact strings.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /bearer\s+[a-z0-9_\-\.]{10,}/i,
  /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b/,
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\b(?:xoxb|xoxp|xapp)-[a-zA-Z0-9-]+\b/,
  /(?:api[_-]?key|password|secret|bearer)\s*[:=]\s*["']?[a-zA-Z0-9_\-\.]{12,}["']?/i,
]);

// ============================================================================
// 2. Durable Transcript Entry Contract
// ============================================================================

export interface DurableTranscriptEntry {
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
  readonly finishReason?: string;
  readonly proposalValid: boolean;
  readonly proposalRejectionReason?: string;
  readonly proposalRejectionMessage?: string;
  readonly reflexDecision?: string;
  readonly reflexReasonCode?: string;
  readonly reflexRationale?: string;
  readonly reflexEvidence?: ReflexEvidence;
  readonly reflexError?: string;
  readonly reflexDurationMs?: number;
  readonly actionId?: string;
  readonly actionStatus?: string;
  readonly actionOutput?: unknown;
  readonly actionError?: unknown;
  readonly durationMs: number;
  readonly timestamp: string;
}

export const DurableTranscriptEntrySchema = z
  .object({
    stepNumber: z.number().int().min(1),
    contextSnapshotId: z.string().min(1),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/i, "contextHash must be 64-char hex SHA-256"),
    contextEstimatedTokens: z.number().int().min(0),
    contextBytes: z.number().int().min(0),
    contextObservationsCount: z.number().int().min(0),
    proposalId: z.string().optional(),
    toolName: z.enum(TOOL_NAMES).optional(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/i, "inputHash must be 64-char hex SHA-256").optional(),
    inputPayload: z.unknown().optional(),
    rationale: z.string().optional(),
    finishReason: z.string().optional(),
    proposalValid: z.boolean(),
    proposalRejectionReason: z.string().optional(),
    proposalRejectionMessage: z.string().optional(),
    reflexDecision: z.string().optional(),
    reflexReasonCode: z.string().optional(),
    reflexRationale: z.string().optional(),
    reflexEvidence: ReflexEvidenceSchema.optional(),
    reflexError: z.string().optional(),
    reflexDurationMs: z.number().min(0).optional(),
    actionId: z.string().optional(),
    actionStatus: z.string().optional(),
    actionOutput: z.unknown().optional(),
    actionError: z.unknown().optional(),
    durationMs: z.number().min(0),
    timestamp: z.string(),
  })
  .strict();

// ============================================================================
// 3. Persisted Trial Evidence Contract
// ============================================================================

export interface PersistedTrialIdentity {
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly trialIdentityHash: string;
  readonly runtimeRunId: string;
}

export interface PersistedTaskIdentity {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly taskContentHash: string;
}

export interface PersistedConditionIdentity {
  readonly conditionId: string;
  readonly name?: string;
}

export interface PersistedTrialOutcome {
  readonly status: EvaluationStatus;
  readonly statusMessage: string;
  readonly verificationPassed: boolean;
  readonly agentClaimedGoal?: boolean;
  readonly errorDetails?: string;
}

export interface PersistedTrialEvidence {
  readonly schemaVersion: number;
  readonly trialIdentity: PersistedTrialIdentity;
  readonly taskIdentity: PersistedTaskIdentity;
  readonly condition: PersistedConditionIdentity;
  readonly executionMode: EvaluationExecutionMode;
  readonly model: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly ruleConfigurationHash?: string;
  readonly transcript: readonly DurableTranscriptEntry[];
  readonly reflexEvidence?: readonly ReflexEvidence[];
  readonly metrics: EvaluationMetrics;
  readonly outcome: PersistedTrialOutcome;
  readonly artifactHash: string;
  readonly persistedAt: string;
}

export type PersistedTrialEvidenceCore = Omit<PersistedTrialEvidence, "artifactHash">;

export const PersistedTrialEvidenceSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
    trialIdentity: z
      .object({
        trialId: z.string().min(1),
        trialOrdinal: z.number().int().min(1),
        trialIdentityHash: z.string().regex(/^[a-f0-9]{64}$/i),
        runtimeRunId: z.string().min(1),
      })
      .strict(),
    taskIdentity: z
      .object({
        taskId: z.string().min(1),
        taskVersion: z.number().int().min(1),
        taskContentHash: z.string().regex(/^[a-f0-9]{64}$/i),
      })
      .strict(),
    condition: z
      .object({
        conditionId: z.string().min(1),
        name: z.string().optional(),
      })
      .strict(),
    executionMode: z.enum(EVALUATION_EXECUTION_MODES),
    model: z.string().min(1),
    configFingerprint: EvaluationConfigFingerprintSchema,
    ruleConfigurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    transcript: z.array(DurableTranscriptEntrySchema),
    reflexEvidence: z.array(ReflexEvidenceSchema).optional(),
    metrics: EvaluationMetricsSchema,
    outcome: z
      .object({
        status: z.enum(EVALUATION_STATUSES),
        statusMessage: z.string(),
        verificationPassed: z.boolean(),
        agentClaimedGoal: z.boolean().optional(),
        errorDetails: z.string().optional(),
      })
      .strict(),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/i),
    persistedAt: z.string().datetime({ message: "persistedAt must be an ISO datetime" }),
  })
  .strict();

// ============================================================================
// 4. Checkpoint Record Schemas for Append-Only NDJSON
// ============================================================================

export interface PersistedTrialStartRecord {
  readonly recordType: "TRIAL_START";
  readonly trialKey: string;
  readonly taskId: string;
  readonly executionMode: EvaluationExecutionMode;
  readonly trialOrdinal: number;
  readonly timestamp: string;
}

export interface PersistedTrialCompleteRecord {
  readonly recordType: "TRIAL_COMPLETE";
  readonly trialKey: string;
  readonly evidence: PersistedTrialEvidence;
  readonly completedAt: string;
}

export interface PersistedTrialErrorRecord {
  readonly recordType: "TRIAL_ERROR";
  readonly trialKey: string;
  readonly errorReason: "ARTIFACT_SERIALIZATION_FAILED" | string;
  readonly errorMessage: string;
  readonly timestamp: string;
}

export type PersistedCheckpointRecord =
  | PersistedTrialStartRecord
  | PersistedTrialCompleteRecord
  | PersistedTrialErrorRecord;

// ============================================================================
// 5. Sanitization & Credential Boundary Functions
// ============================================================================

/**
 * Scans an arbitrary value for sensitive patterns in strings or sensitive keys.
 * Recursively sanitizes any sensitive properties.
 */
export function sanitizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;

  if (typeof val === "string") {
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(val)) {
        return "[REDACTED_SECRET]";
      }
    }
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item));
  }

  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = sanitizeValue(v);
      }
    }
    return result;
  }

  return val;
}

/**
 * Asserts that a value contains zero unredacted sensitive keys or string secrets.
 * Throws ArtifactSecurityError if any violations exist.
 */
export function assertCredentialBoundary(val: unknown, path = "root"): void {
  if (val === null || val === undefined) return;

  if (typeof val === "string") {
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(val)) {
        throw new ArtifactSecurityError(
          `Credential boundary violation: sensitive string pattern detected at '${path}'`
        );
      }
    }
    return;
  }

  if (Array.isArray(val)) {
    val.forEach((item, idx) => assertCredentialBoundary(item, `${path}[${idx}]`));
    return;
  }

  if (typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (isSensitiveKey(k) && v !== "[REDACTED]") {
        throw new ArtifactSecurityError(
          `Credential boundary violation: sensitive property key '${k}' detected at '${path}.${k}'`
        );
      }
      assertCredentialBoundary(v, `${path}.${k}`);
    }
  }
}

// ============================================================================
// 6. Bounds Enforcement
// ============================================================================

/**
 * Enforces explicit boundaries on the evidence artifact.
 * Throws ArtifactBoundsExceededError with code ARTIFACT_SERIALIZATION_FAILED if violated.
 */
export function assertArtifactBounds(
  transcript: readonly DurableTranscriptEntry[],
  reflexEvidence?: readonly ReflexEvidence[]
): void {
  if (transcript.length > EVIDENCE_ARTIFACT_BOUNDS.maxTranscriptEntries) {
    throw new ArtifactBoundsExceededError(
      `ARTIFACT_SERIALIZATION_FAILED: transcript entries (${transcript.length}) exceeds ceiling (${EVIDENCE_ARTIFACT_BOUNDS.maxTranscriptEntries})`
    );
  }

  // Check individual entry payload sizes
  for (const entry of transcript) {
    if (entry.inputPayload !== undefined) {
      const inputBytes = Buffer.byteLength(canonicalJsonStringify(entry.inputPayload), "utf8");
      if (inputBytes > EVIDENCE_ARTIFACT_BOUNDS.maxPayloadBytes) {
        throw new ArtifactBoundsExceededError(
          `ARTIFACT_SERIALIZATION_FAILED: action input payload (${inputBytes} bytes) exceeds ceiling (${EVIDENCE_ARTIFACT_BOUNDS.maxPayloadBytes} bytes) in step ${entry.stepNumber}`
        );
      }
    }
    if (entry.actionOutput !== undefined) {
      const outputBytes = Buffer.byteLength(canonicalJsonStringify(entry.actionOutput), "utf8");
      if (outputBytes > EVIDENCE_ARTIFACT_BOUNDS.maxPayloadBytes) {
        throw new ArtifactBoundsExceededError(
          `ARTIFACT_SERIALIZATION_FAILED: action output payload (${outputBytes} bytes) exceeds ceiling (${EVIDENCE_ARTIFACT_BOUNDS.maxPayloadBytes} bytes) in step ${entry.stepNumber}`
        );
      }
    }
  }

  const transcriptBytes = Buffer.byteLength(canonicalJsonStringify(transcript), "utf8");
  if (transcriptBytes > EVIDENCE_ARTIFACT_BOUNDS.maxSerializedTranscriptBytes) {
    throw new ArtifactBoundsExceededError(
      `ARTIFACT_SERIALIZATION_FAILED: serialized transcript (${transcriptBytes} bytes) exceeds ceiling (${EVIDENCE_ARTIFACT_BOUNDS.maxSerializedTranscriptBytes} bytes)`
    );
  }

  if (reflexEvidence && reflexEvidence.length > 0) {
    const reflexBytes = Buffer.byteLength(canonicalJsonStringify(reflexEvidence), "utf8");
    if (reflexBytes > EVIDENCE_ARTIFACT_BOUNDS.maxReflexEvidenceBytes) {
      throw new ArtifactBoundsExceededError(
        `ARTIFACT_SERIALIZATION_FAILED: serialized reflex evidence (${reflexBytes} bytes) exceeds ceiling (${EVIDENCE_ARTIFACT_BOUNDS.maxReflexEvidenceBytes} bytes)`
      );
    }
  }
}

// ============================================================================
// 7. Canonical Hash & Integrity Verification
// ============================================================================

/**
 * Computes the authoritative artifactHash across the canonical serialization
 * of all persisted evidence fields (excluding artifactHash itself).
 */
export function computeArtifactEvidenceHash(core: PersistedTrialEvidenceCore): string {
  const canonical = canonicalJsonStringify(core);
  return sha256Hex(canonical);
}

/**
 * Creates and validates a durable, sanitized, tamper-evident PersistedTrialEvidence artifact.
 */
export function createPersistedTrialEvidence(params: {
  readonly trialIdentity: PersistedTrialIdentity;
  readonly taskIdentity: PersistedTaskIdentity;
  readonly condition: PersistedConditionIdentity;
  readonly executionMode: EvaluationExecutionMode;
  readonly model: string;
  readonly configFingerprint: EvaluationConfigFingerprint;
  readonly ruleConfigurationHash?: string;
  readonly transcript: readonly DurableTranscriptEntry[];
  readonly reflexEvidence?: readonly ReflexEvidence[];
  readonly metrics: EvaluationMetrics;
  readonly outcome: PersistedTrialOutcome;
  readonly persistedAt?: string;
}): PersistedTrialEvidence {
  // 1. Enforce bounds before serialization
  assertArtifactBounds(params.transcript, params.reflexEvidence);

  // 2. Validate Baseline isolation invariant: Baseline MUST omit reflexEvidence
  let effectiveReflexEvidence: readonly ReflexEvidence[] | undefined = undefined;
  if (params.executionMode === "BASELINE") {
    if (params.reflexEvidence !== undefined) {
      throw new Error(
        "Invariant violation: Baseline trial cannot persist non-undefined reflexEvidence"
      );
    }
    effectiveReflexEvidence = undefined;
  } else {
    // For REFLEX: if zero evaluations occurred, persist empty array []
    effectiveReflexEvidence = params.reflexEvidence ? [...params.reflexEvidence] : [];
  }

  // 3. Sanitize transcript and evidence for credential boundary
  const sanitizedTranscript = sanitizeValue(params.transcript) as readonly DurableTranscriptEntry[];
  const sanitizedReflexEvidence = effectiveReflexEvidence
    ? (sanitizeValue(effectiveReflexEvidence) as readonly ReflexEvidence[])
    : undefined;
  const sanitizedOutcome = sanitizeValue(params.outcome) as PersistedTrialOutcome;

  // 4. Verify credential boundary
  assertCredentialBoundary(sanitizedTranscript, "transcript");
  if (sanitizedReflexEvidence) {
    assertCredentialBoundary(sanitizedReflexEvidence, "reflexEvidence");
  }

  const persistedAt = params.persistedAt ?? new Date().toISOString();

  // 5. Assemble core structure without artifactHash
  const core: PersistedTrialEvidenceCore = Object.freeze({
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    trialIdentity: Object.freeze({ ...params.trialIdentity }),
    taskIdentity: Object.freeze({ ...params.taskIdentity }),
    condition: Object.freeze({ ...params.condition }),
    executionMode: params.executionMode,
    model: params.model,
    configFingerprint: Object.freeze({ ...params.configFingerprint }),
    ruleConfigurationHash: params.ruleConfigurationHash,
    transcript: Object.freeze(sanitizedTranscript.map((e) => Object.freeze({ ...e }))),
    reflexEvidence: sanitizedReflexEvidence
      ? Object.freeze(sanitizedReflexEvidence.map((e) => Object.freeze({ ...e })))
      : undefined,
    metrics: Object.freeze({ ...params.metrics }),
    outcome: Object.freeze(sanitizedOutcome),
    persistedAt,
  });

  // 6. Compute authoritative artifactHash over canonical JSON
  const artifactHash = computeArtifactEvidenceHash(core);

  const fullArtifact: PersistedTrialEvidence = Object.freeze({
    ...core,
    artifactHash,
  });

  // 7. Total size ceiling check
  const totalBytes = Buffer.byteLength(canonicalJsonStringify(fullArtifact), "utf8");
  if (totalBytes > EVIDENCE_ARTIFACT_BOUNDS.maxTotalArtifactBytes) {
    throw new ArtifactBoundsExceededError(
      `ARTIFACT_SERIALIZATION_FAILED: total artifact (${totalBytes} bytes) exceeds ceiling (${EVIDENCE_ARTIFACT_BOUNDS.maxTotalArtifactBytes} bytes)`
    );
  }

  // 8. Schema validation
  PersistedTrialEvidenceSchema.parse(fullArtifact);

  return fullArtifact;
}

/**
 * Verifies the integrity of a PersistedTrialEvidence artifact.
 * Detects tampering with any evidence fields, trial identities, or hashes.
 */
export function verifyArtifactIntegrity(
  artifact: PersistedTrialEvidence,
  options?: { readonly expectedTaskContentHash?: string }
): { readonly valid: boolean; readonly reason?: string } {
  try {
    // 1. Zod schema validation
    PersistedTrialEvidenceSchema.parse(artifact);

    // 2. Artifact hash verification
    const { artifactHash, ...core } = artifact;
    const computedHash = computeArtifactEvidenceHash(core);
    if (artifactHash !== computedHash) {
      return {
        valid: false,
        reason: `Artifact hash mismatch: expected '${computedHash}', got '${artifactHash}' (content tampered)`,
      };
    }

    // 3. Trial identity hash verification
    const expectedTrialIdentityHash = computeEvaluationTrialIdentityHash({
      taskId: artifact.taskIdentity.taskId,
      taskVersion: artifact.taskIdentity.taskVersion,
      taskContentHash: artifact.taskIdentity.taskContentHash,
      configFingerprintHash: artifact.configFingerprint.fingerprintHash,
      trialOrdinal: artifact.trialIdentity.trialOrdinal,
      executionMode: artifact.executionMode,
      ruleConfigurationHash: artifact.ruleConfigurationHash,
    });
    if (artifact.trialIdentity.trialIdentityHash !== expectedTrialIdentityHash) {
      return {
        valid: false,
        reason: `Trial identity hash mismatch: expected '${expectedTrialIdentityHash}', got '${artifact.trialIdentity.trialIdentityHash}'`,
      };
    }

    // 4. Optional task content hash verification
    if (
      options?.expectedTaskContentHash &&
      artifact.taskIdentity.taskContentHash !== options.expectedTaskContentHash
    ) {
      return {
        valid: false,
        reason: `Task content hash mismatch: expected '${options.expectedTaskContentHash}', got '${artifact.taskIdentity.taskContentHash}'`,
      };
    }

    // 5. Bounds check
    assertArtifactBounds(artifact.transcript, artifact.reflexEvidence);

    // 6. Credential boundary check
    assertCredentialBoundary(artifact.transcript, "transcript");
    if (artifact.reflexEvidence) {
      assertCredentialBoundary(artifact.reflexEvidence, "reflexEvidence");
    }

    // 7. Baseline isolation check
    if (artifact.executionMode === "BASELINE" && artifact.reflexEvidence !== undefined) {
      return {
        valid: false,
        reason: "Baseline trial must not contain reflexEvidence",
      };
    }

    return { valid: true };
  } catch (err: unknown) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Asserts the integrity of a PersistedTrialEvidence artifact.
 * Throws ArtifactIntegrityError if the artifact has been tampered with or is invalid.
 */
export function assertArtifactIntegrity(
  artifact: PersistedTrialEvidence,
  options?: { readonly expectedTaskContentHash?: string }
): void {
  const result = verifyArtifactIntegrity(artifact, options);
  if (!result.valid) {
    throw new ArtifactIntegrityError(result.reason ?? "Artifact integrity check failed");
  }
}

/**
 * Serializes a PersistedTrialEvidence artifact to canonical JSON format.
 */
export function serializeTrialEvidence(evidence: PersistedTrialEvidence): string {
  const result = verifyArtifactIntegrity(evidence);
  if (!result.valid) {
    throw new ArtifactIntegrityError(
      `Cannot serialize invalid/tampered trial evidence: ${result.reason}`
    );
  }
  return canonicalJsonStringify(evidence);
}

/**
 * Deserializes and validates a PersistedTrialEvidence artifact from canonical JSON.
 */
export function deserializeTrialEvidence(jsonStr: string): PersistedTrialEvidence {
  const parsed = JSON.parse(jsonStr);
  const validated = PersistedTrialEvidenceSchema.parse(parsed) as PersistedTrialEvidence;
  const result = verifyArtifactIntegrity(validated);
  if (!result.valid) {
    throw new ArtifactIntegrityError(
      `Integrity check failed on deserialized trial evidence: ${result.reason}`
    );
  }
  return validated;
}
