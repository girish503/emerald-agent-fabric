/**
 * Evidence Bundle & Provenance Model for Emerald Agent Fabric.
 *
 * Implements an immutable, content-hashed, offline-verifiable evidence artifact
 * representing the complete execution history of an agent mission.
 */

import { RunSnapshot } from "./invariants.js";
import { MissionContract } from "./mission-contract.js";
import {
  MissionCheckpoint,
  PersistedEvent,
  SupervisorLease,
} from "../ports/state-store.port.js";
import { ActionSnapshot } from "./action.js";
import { AttemptSnapshot } from "./attempt.js";
import { Evidence } from "./evidence.js";
import { VerificationResult } from "./verification.js";
import {
  canonicalJsonStringify,
  redactSensitiveData,
  sha256Hex,
} from "./canonical-hash.js";

export interface ChainedEvent<T = unknown> extends PersistedEvent<T> {
  readonly eventHash: string;
  readonly previousEventHash: string;
}

export interface BundledTerminalState {
  readonly status: RunSnapshot["status"];
  readonly resultPayload?: unknown;
  readonly errorPayload?: unknown;
  readonly completedAt?: string | null;
}

export interface BundledProvenance {
  readonly formatVersion: "emerald-evidence-bundle-v1";
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly exporterVersion: string;
  readonly hostRedacted: boolean;
  readonly sourceRunId: string;
}

export interface EvidenceBundleContent {
  readonly formatVersion: "emerald-evidence-bundle-v1";
  readonly schemaVersion: 1;
  readonly provenanceRoot: string;
  readonly run: RunSnapshot;
  readonly contract: MissionContract;
  readonly checkpoints: readonly MissionCheckpoint[];
  readonly events: readonly ChainedEvent[];
  readonly actions: readonly ActionSnapshot[];
  readonly attempts: readonly AttemptSnapshot[];
  readonly supervisorEvidence: readonly SupervisorLease[];
  readonly verificationEvidence: readonly Evidence[];
  readonly verificationResults: readonly VerificationResult[];
  readonly terminalState: BundledTerminalState;
  readonly provenance: BundledProvenance;
}

export interface EvidenceSigningPayload {
  readonly bundleId: string;
  readonly formatVersion: "emerald-evidence-bundle-v1";
  readonly provenanceRoot: string;
  readonly schemaVersion: 1;
}

// Phase 37: Authority roles for multi-authority threshold signing.
export type AuthorityRole = "WORKER_PRODUCER" | "SUPERVISOR" | "INDEPENDENT_VERIFIER";

export interface EvidenceSignature {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly publicKeyFingerprint: string;
  readonly signature: string; // 64-byte hex string (128 hex chars)
  readonly signedContentDigest: string; // 32-byte hex string (64 hex chars)
  readonly authorityId?: string; // Phase 37: distinct authority identifier for threshold deduplication
}

export interface EvidenceBundle extends EvidenceBundleContent {
  readonly bundleId: string;
  readonly signature?: EvidenceSignature; // Phase 35: single-authority legacy
  readonly signatures?: readonly EvidenceSignature[]; // Phase 37: multi-authority threshold
}

// Phase 37: Threshold policy for multi-authority evidence acceptance.
export interface ThresholdPolicy {
  readonly threshold: number; // e.g. 2 — minimum distinct trusted authorities required
  readonly totalAuthorities: number; // e.g. 3 — total authorities in the quorum
}

// Phase 37: Result of threshold evaluation over multiple signatures.
export type ThresholdStatus =
  | "THRESHOLD_SATISFIED"
  | "INSUFFICIENT_AUTHORITIES"
  | "DUPLICATE_AUTHORITY"
  | "REVOKED_AUTHORITY"
  | "UNKNOWN_AUTHORITY"
  | "INVALID_SIGNATURE"
  | "NO_VALID_SIGNATURES"
  | "THRESHOLD_NOT_CONFIGURED";

export interface ThresholdEvaluationResult {
  readonly status: ThresholdStatus;
  readonly distinctValidAuthorities: number;
  readonly validAuthorityIds: readonly string[];
  readonly rejectedAuthorityIds: readonly string[];
  readonly threshold: number;
  readonly totalAuthorities: number;
  readonly failures: readonly string[];
  readonly reasonCodes?: readonly IngestionReasonCode[];
  readonly signatureResults?: readonly SignatureVerificationResult[];
}

export interface FourfoldReplayOutcome {
  readonly taskSatisfied: boolean;
  readonly verificationPassed: boolean;
  readonly policySatisfied: boolean;
  readonly evidenceComplete: boolean;
}

export interface ReplayVerificationResult {
  readonly valid: boolean;
  readonly bundleId: string;
  readonly provenanceRoot: string;
  readonly bundleIntegrity: boolean;
  readonly contractIntegrity: boolean;
  readonly eventIntegrity: boolean;
  readonly checkpointIntegrity: boolean;
  readonly attemptIntegrity: boolean;
  readonly authorityIntegrity: boolean;
  readonly verificationIntegrity: boolean;
  readonly fourfoldOutcome: FourfoldReplayOutcome;
  readonly terminalOutcome: RunSnapshot["status"];
  readonly failures: readonly string[];
}

/**
 * Computes genesis event hash for a given runId.
 */
export function computeGenesisEventHash(runId: string): string {
  return sha256Hex(`genesis:${runId}`);
}

/**
 * Computes the cryptographic hash for a single event linked to its predecessor.
 */
export function computeEventHash(
  event: PersistedEvent,
  previousEventHash: string
): string {
  const hashMaterial = {
    sequence: event.sequence,
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    producer: event.producer,
    payload: redactSensitiveData(event.payload),
    previousEventHash,
  };
  return sha256Hex(canonicalJsonStringify(hashMaterial));
}

/**
 * Chains an array of PersistedEvents into cryptographically linked ChainedEvents.
 */
export function buildEventHashChain(
  runId: string,
  events: readonly PersistedEvent[]
): readonly ChainedEvent[] {
  let prevHash = computeGenesisEventHash(runId);
  const chained: ChainedEvent[] = [];

  for (const event of events) {
    const hash = computeEventHash(event, prevHash);
    chained.push(
      Object.freeze({
        ...event,
        payload: redactSensitiveData(event.payload),
        previousEventHash: prevHash,
        eventHash: hash,
      })
    );
    prevHash = hash;
  }

  return Object.freeze(chained);
}

/**
 * Computes subsystem roots and the overall provenance root for an evidence bundle.
 */
export function computeProvenanceRoot(params: {
  contractHash: string;
  eventRoot: string;
  checkpointRoot: string;
  attemptRoot: string;
  verificationRoot: string;
}): string {
  const rootMaterial = {
    attemptRoot: params.attemptRoot,
    checkpointRoot: params.checkpointRoot,
    contractHash: params.contractHash,
    eventRoot: params.eventRoot,
    verificationRoot: params.verificationRoot,
  };
  return sha256Hex(canonicalJsonStringify(rootMaterial));
}

/**
 * Computes deterministic bundle ID over the canonical bundle content excluding bundleId and signature.
 */
export function computeBundleId(content: EvidenceBundleContent): string {
  const { bundleId, signature, signatures, ...rest } = content as any;
  return sha256Hex(canonicalJsonStringify(rest));
}

/**
 * Creates deterministic signing payload from an evidence bundle.
 */
export function createSigningPayload(bundle: {
  bundleId: string;
  formatVersion: "emerald-evidence-bundle-v1";
  provenanceRoot: string;
  schemaVersion: 1;
}): EvidenceSigningPayload {
  return Object.freeze({
    bundleId: bundle.bundleId,
    formatVersion: bundle.formatVersion,
    provenanceRoot: bundle.provenanceRoot,
    schemaVersion: bundle.schemaVersion,
  });
}

/**
 * Computes deterministic SHA-256 digest of canonical signing payload.
 */
export function computeSignedContentDigest(payload: EvidenceSigningPayload): string {
  return sha256Hex(canonicalJsonStringify(payload));
}

// -----------------------------------------------------------------------------
// Phase 34 & 35: Ingestion, Authority & Archival Types
// -----------------------------------------------------------------------------

export type IngestionStatus = "ACCEPTED" | "DUPLICATE" | "QUARANTINED";

export type IngestionReasonCode =
  | "BUNDLE_TOO_LARGE"
  | "INVALID_JSON"
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_BUNDLE_ID"
  | "BUNDLE_ID_MISMATCH"
  | "INVALID_PROVENANCE_ROOT"
  | "PROVENANCE_ROOT_MISMATCH"
  | "CONTRACT_INTEGRITY_FAILURE"
  | "EVENT_INTEGRITY_FAILURE"
  | "CHECKPOINT_INTEGRITY_FAILURE"
  | "ATTEMPT_INTEGRITY_FAILURE"
  | "AUTHORITY_INTEGRITY_FAILURE"
  | "VERIFICATION_INTEGRITY_FAILURE"
  | "REPLAY_VERIFICATION_FAILURE"
  | "IDENTITY_CONFLICT"
  | "SECURITY_POLICY_FAILURE"
  | "UNKNOWN_SIGNING_KEY"
  | "UNKNOWN_AUTHORITY"
  | "REVOKED_SIGNING_KEY"
  | "REVOKED_AUTHORITY"
  | "INVALID_SIGNATURE"
  | "INVALID_PUBLIC_KEY"
  | "INVALID_SIGNATURE_PAYLOAD"
  | "UNSIGNED_BUNDLE_REJECTED"
  | "INSUFFICIENT_AUTHORITIES"     // Phase 37: not enough distinct trusted authorities
  | "DUPLICATE_AUTHORITY"
  | "DUPLICATE_AUTHORITY_REJECTED" // Phase 37: duplicate authority signatures cannot satisfy threshold
  | "TERMINAL_CONFLICT"            // Phase 40: conflicting terminal submission for already terminated run
  | "TERMINAL_RECORD_MISMATCH"     // Phase 40: terminal record does not match referenced bundle
  | "INVALID_TERMINAL_RECORD"      // Phase 40: terminal record schema or hash integrity failure
  | "TERMINAL_BUNDLE_MISSING";     // Phase 40: authoritative bundle referenced by terminal record does not exist

export type KeyAuthorityStatus = "TRUSTED" | "REVOKED";
export type SignatureStatus = "VALID" | "INVALID" | "UNSIGNED_LEGACY";
export type AuthorityStatus =
  | "TRUSTED"
  | "REVOKED"
  | "UNKNOWN"
  | "NOT_ESTABLISHED"
  | "INSUFFICIENT_AUTHORITIES"
  | "THRESHOLD_SATISFIED"
  | "UNKNOWN_AUTHORITY"
  | "REVOKED_AUTHORITY"
  | "INVALID_SIGNATURE"
  | "DUPLICATE_AUTHORITY"
  | "NO_VALID_SIGNATURES"
  | "THRESHOLD_NOT_CONFIGURED";

export interface SignatureVerificationResult {
  readonly valid: boolean;
  readonly signatureStatus: SignatureStatus;
  readonly authorityStatus: AuthorityStatus;
  readonly keyId?: string;
  readonly publicKeyFingerprint?: string;
  readonly signedContentDigest?: string;
  readonly failures: readonly string[];
  readonly reasonCode?: IngestionReasonCode;
}

export interface IngestionResult {
  readonly status: IngestionStatus;
  readonly bundleId?: string;
  readonly recomputedBundleId?: string;
  readonly provenanceRoot?: string;
  readonly replayValid: boolean;
  readonly reasonCodes: readonly IngestionReasonCode[];
  readonly archiveReference?: string;
  readonly quarantineReference?: string;
  readonly sizeBytes: number;
  readonly ingestedAt: string;
  readonly signatureStatus?: SignatureStatus;
  readonly authorityStatus?: AuthorityStatus;
  readonly keyId?: string;
  readonly signatureResult?: SignatureVerificationResult;
  readonly thresholdResult?: ThresholdEvaluationResult; // Phase 37
}

export interface ArchiveRecord {
  readonly bundleId: string;
  readonly provenanceRoot: string;
  readonly acceptedAt: string;
  readonly formatVersion: string;
  readonly schemaVersion: number;
  readonly sizeBytes: number;
  readonly status: "ACCEPTED";
  readonly archivePath: string;
}

export interface ArchiveVerificationResult {
  readonly valid: boolean;
  readonly bundleId: string;
  readonly status: "VERIFIED" | "ARCHIVE_INTEGRITY_FAILURE" | "NOT_FOUND";
  readonly replayResult?: ReplayVerificationResult;
  readonly signatureResult?: SignatureVerificationResult;
  readonly thresholdResult?: ThresholdEvaluationResult; // Phase 37
  readonly failures: readonly string[];
}

// -----------------------------------------------------------------------------
// Phase 40: Authoritative Terminal Record Types & Helpers
// -----------------------------------------------------------------------------

export type TerminalOutcomeStatus = "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";

export function isTerminalStatus(status: unknown): status is TerminalOutcomeStatus {
  return typeof status === "string" && ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
}

export interface AuthoritativeTerminalRecord {
  readonly formatVersion: "emerald-terminal-record-v1";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly bundleId: string;
  readonly terminalOutcome: TerminalOutcomeStatus;
  readonly recordedAt: string;
  readonly recordHash: string;
}

export function computeTerminalRecordHash(
  record: Omit<AuthoritativeTerminalRecord, "recordHash">
): string {
  return sha256Hex(canonicalJsonStringify(record));
}

export function createTerminalRecord(params: {
  runId: string;
  bundleId: string;
  terminalOutcome: TerminalOutcomeStatus;
  nowIso: string;
}): AuthoritativeTerminalRecord {
  const content = {
    formatVersion: "emerald-terminal-record-v1" as const,
    schemaVersion: 1 as const,
    runId: params.runId,
    bundleId: params.bundleId,
    terminalOutcome: params.terminalOutcome,
    recordedAt: params.nowIso,
  };
  const recordHash = computeTerminalRecordHash(content);
  return Object.freeze({
    ...content,
    recordHash,
  });
}

export interface TerminalVerificationResult {
  readonly valid: boolean;
  readonly runId: string;
  readonly terminalRecord?: AuthoritativeTerminalRecord;
  readonly bundleId?: string;
  readonly status: "VERIFIED" | "NOT_FOUND" | "INVALID_RECORD" | "BUNDLE_MISSING" | "RECORD_MISMATCH";
  readonly reasonCode?: IngestionReasonCode;
  readonly failures: readonly string[];
}


