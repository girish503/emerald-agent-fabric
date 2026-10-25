/**
 * Evidence Ingestion Gateway for Emerald Agent Fabric.
 *
 * Implements an untrusted ingestion boundary that validates, replays, classifies,
 * verifies Ed25519 signatures, and immutably archives EvidenceBundles produced across host boundaries.
 */

import {
  canonicalJsonStringify,
  containsUnredactedSecrets,
  sha256Hex,
} from "../domain/canonical-hash.js";
import {
  ArchiveVerificationResult,
  AuthorityStatus,
  computeBundleId,
  createTerminalRecord,
  EvidenceBundle,
  IngestionReasonCode,
  IngestionResult,
  isTerminalStatus,
  SignatureStatus,
  SignatureVerificationResult,
  TerminalVerificationResult,
  AuthoritativeTerminalRecord,
  ThresholdEvaluationResult,
  ThresholdPolicy,
} from "../domain/evidence-bundle.js";
import { EvidenceArchivePort } from "../ports/evidence-archive.port.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { EvidenceReplayVerifier } from "./evidence-replay-verifier.js";
import {
  EvidenceSignatureVerifier,
  EvidenceThresholdVerifier,
  TrustedKeyring,
} from "./evidence-signer.js";

export interface EvidenceIngestionGatewayOptions {
  readonly archive: EvidenceArchivePort;
  readonly clock?: ClockPort;
  readonly maxBytes?: number;
  readonly keyring?: TrustedKeyring;
  readonly allowUnsignedLegacy?: boolean;
  readonly thresholdPolicy?: ThresholdPolicy; // Phase 37
  readonly enforceTerminalAuthority?: boolean; // Phase 40
}

export class EvidenceIngestionGateway {
  static readonly DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB boundary
  static readonly DEFAULT_THRESHOLD_POLICY = EvidenceThresholdVerifier.DEFAULT_THRESHOLD_POLICY;
  private readonly archive: EvidenceArchivePort;
  private readonly clock: ClockPort;
  private readonly maxBytes: number;
  private readonly keyring?: TrustedKeyring;
  private readonly allowUnsignedLegacy: boolean;
  private readonly thresholdPolicy?: ThresholdPolicy;
  private readonly enforceTerminalAuthority: boolean;

  constructor(options: EvidenceIngestionGatewayOptions) {
    this.archive = options.archive;
    this.clock = options.clock ?? new SystemClock();
    this.maxBytes = options.maxBytes ?? EvidenceIngestionGateway.DEFAULT_MAX_BYTES;
    this.keyring = options.keyring;
    this.allowUnsignedLegacy = options.allowUnsignedLegacy ?? true;
    this.thresholdPolicy = options.thresholdPolicy;
    this.enforceTerminalAuthority = options.enforceTerminalAuthority ?? false;
  }

  private isEvidenceBundleStructure(val: unknown): val is EvidenceBundle {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      return false;
    }
    const obj = val as Record<string, unknown>;
    return (
      obj.formatVersion === "emerald-evidence-bundle-v1" &&
      obj.schemaVersion === 1 &&
      typeof obj.bundleId === "string" &&
      /^[0-9a-f]{64}$/.test(obj.bundleId) &&
      typeof obj.provenanceRoot === "string" &&
      /^[0-9a-f]{64}$/.test(obj.provenanceRoot) &&
      typeof obj.run === "object" &&
      obj.run !== null &&
      typeof obj.contract === "object" &&
      obj.contract !== null &&
      Array.isArray(obj.checkpoints) &&
      Array.isArray(obj.events) &&
      Array.isArray(obj.actions) &&
      Array.isArray(obj.attempts) &&
      Array.isArray(obj.supervisorEvidence) &&
      Array.isArray(obj.verificationEvidence) &&
      Array.isArray(obj.verificationResults) &&
      typeof obj.terminalState === "object" &&
      obj.terminalState !== null &&
      typeof obj.provenance === "object" &&
      obj.provenance !== null
    );
  }

  private validateSignatureStructure(sig: unknown): { valid: boolean; reasonCode?: IngestionReasonCode } {
    if (typeof sig !== "object" || sig === null) {
      return { valid: false, reasonCode: "INVALID_SIGNATURE_PAYLOAD" };
    }
    const s = sig as any;
    if (s.algorithm !== "Ed25519") {
      return { valid: false, reasonCode: "INVALID_SIGNATURE_PAYLOAD" };
    }
    if (typeof s.keyId !== "string" || s.keyId.trim() === "") {
      return { valid: false, reasonCode: "INVALID_SIGNATURE_PAYLOAD" };
    }
    if (typeof s.signature !== "string" || !/^[0-9a-f]{128}$/i.test(s.signature)) {
      return { valid: false, reasonCode: "INVALID_SIGNATURE" };
    }
    if (typeof s.publicKeyFingerprint !== "string" || !/^[0-9a-f]{64}$/i.test(s.publicKeyFingerprint)) {
      return { valid: false, reasonCode: "INVALID_PUBLIC_KEY" };
    }
    return { valid: true };
  }

  /**
   * Ingests an untrusted evidence bundle payload across the trust boundary.
   */
  ingest(untrustedInput: string | Buffer | object): IngestionResult {
    const ingestedAt = this.clock.nowIso();

    // 1. Raw Payload String and Size Validation
    let rawString: string;
    if (Buffer.isBuffer(untrustedInput)) {
      rawString = untrustedInput.toString("utf8");
    } else if (typeof untrustedInput === "string") {
      rawString = untrustedInput;
    } else if (typeof untrustedInput === "object" && untrustedInput !== null) {
      rawString = canonicalJsonStringify(untrustedInput);
    } else {
      rawString = String(untrustedInput);
    }

    const sizeBytes = Buffer.byteLength(rawString, "utf8");
    if (sizeBytes > this.maxBytes) {
      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: "BUNDLE_TOO_LARGE",
        rawPayload: rawString.slice(0, 1024), // store sample
      });
      return {
        status: "QUARANTINED",
        replayValid: false,
        reasonCodes: ["BUNDLE_TOO_LARGE"],
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    // 2. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawString);
    } catch {
      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: "INVALID_JSON",
        rawPayload: rawString,
      });
      return {
        status: "QUARANTINED",
        replayValid: false,
        reasonCodes: ["INVALID_JSON"],
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    // 3. Schema Structure Validation
    if (!this.isEvidenceBundleStructure(parsed)) {
      const declaredId =
        parsed && typeof parsed === "object" && "bundleId" in parsed && typeof (parsed as any).bundleId === "string"
          ? (parsed as any).bundleId
          : undefined;
      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: "UNSUPPORTED_SCHEMA",
        rawPayload: rawString,
        bundleId: declaredId,
      });
      return {
        status: "QUARANTINED",
        bundleId: declaredId,
        replayValid: false,
        reasonCodes: ["UNSUPPORTED_SCHEMA"],
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    const bundle: EvidenceBundle = parsed;

    // 4. Signature Structure Validation
    let signatureStatus: SignatureStatus = "UNSIGNED_LEGACY";
    let authorityStatus: AuthorityStatus = "NOT_ESTABLISHED";
    let signatureResult: SignatureVerificationResult | undefined = undefined;
    let thresholdResult: ThresholdEvaluationResult | undefined = undefined;

    const hasSignaturesArray = Array.isArray(bundle.signatures) && bundle.signatures.length > 0;
    const hasSingleSignature = bundle.signature !== undefined;

    if (hasSignaturesArray) {
      for (const sig of bundle.signatures!) {
        const check = this.validateSignatureStructure(sig);
        if (!check.valid) {
          const quarantineId = sha256Hex(rawString).slice(0, 32);
          this.archive.storeQuarantined({
            quarantineId,
            reasonCode: check.reasonCode!,
            rawPayload: rawString,
            bundleId: bundle.bundleId,
          });
          return {
            status: "QUARANTINED",
            bundleId: bundle.bundleId,
            replayValid: false,
            reasonCodes: [check.reasonCode!],
            sizeBytes,
            ingestedAt,
            quarantineReference: quarantineId,
          };
        }
      }
    } else if (hasSingleSignature) {
      const check = this.validateSignatureStructure(bundle.signature);
      if (!check.valid) {
        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode: check.reasonCode!,
          rawPayload: rawString,
          bundleId: bundle.bundleId,
        });
        return {
          status: "QUARANTINED",
          bundleId: bundle.bundleId,
          replayValid: false,
          reasonCodes: [check.reasonCode!],
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }
    } else {
      if (!this.allowUnsignedLegacy) {
        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode: "UNSIGNED_BUNDLE_REJECTED",
          rawPayload: rawString,
          bundleId: bundle.bundleId,
        });
        return {
          status: "QUARANTINED",
          bundleId: bundle.bundleId,
          replayValid: false,
          reasonCodes: ["UNSIGNED_BUNDLE_REJECTED"],
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }
    }

    // 5. Bundle ID Recalculation
    const { bundleId: declaredBundleId, ...content } = bundle;
    const recomputedBundleId = computeBundleId(content);
    if (recomputedBundleId !== declaredBundleId) {
      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: "INVALID_BUNDLE_ID",
        rawPayload: rawString,
        bundleId: declaredBundleId,
      });
      return {
        status: "QUARANTINED",
        bundleId: declaredBundleId,
        recomputedBundleId,
        replayValid: false,
        reasonCodes: ["INVALID_BUNDLE_ID", "BUNDLE_ID_MISMATCH"],
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    // 6. Trusted Key Lookup, Ed25519 Signature Verification & Threshold
    const evaluateThreshold =
      hasSignaturesArray ||
      (this.thresholdPolicy !== undefined && hasSingleSignature);

    if (evaluateThreshold) {
      if (!this.keyring) {
        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode: "UNKNOWN_SIGNING_KEY",
          rawPayload: rawString,
          bundleId: declaredBundleId,
        });
        return {
          status: "QUARANTINED",
          bundleId: declaredBundleId,
          recomputedBundleId,
          replayValid: false,
          reasonCodes: ["UNKNOWN_SIGNING_KEY", "UNKNOWN_AUTHORITY"],
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }

      const policy = this.thresholdPolicy ?? EvidenceThresholdVerifier.DEFAULT_THRESHOLD_POLICY;
      thresholdResult = EvidenceThresholdVerifier.verifyThreshold(bundle, this.keyring, policy);

      if (thresholdResult.status !== "THRESHOLD_SATISFIED") {
        let primaryReason: IngestionReasonCode = "INSUFFICIENT_AUTHORITIES";
        if (thresholdResult.status === "DUPLICATE_AUTHORITY") {
          primaryReason = "DUPLICATE_AUTHORITY";
        } else if (thresholdResult.status === "REVOKED_AUTHORITY") {
          primaryReason = "REVOKED_AUTHORITY";
        } else if (thresholdResult.status === "UNKNOWN_AUTHORITY") {
          primaryReason = "UNKNOWN_AUTHORITY";
        } else if (thresholdResult.status === "INVALID_SIGNATURE") {
          primaryReason = "INVALID_SIGNATURE";
        }

        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode: primaryReason,
          rawPayload: rawString,
          bundleId: declaredBundleId,
        });

        const reasonCodes: IngestionReasonCode[] =
          thresholdResult.reasonCodes && thresholdResult.reasonCodes.length > 0
            ? (thresholdResult.reasonCodes as IngestionReasonCode[])
            : [primaryReason];

        const allValidSigs = Boolean(
          thresholdResult.signatureResults &&
            thresholdResult.signatureResults.length > 0 &&
            thresholdResult.signatureResults.every((s: SignatureVerificationResult) => s.valid)
        );

        return {
          status: "QUARANTINED",
          bundleId: declaredBundleId,
          recomputedBundleId,
          replayValid: false,
          signatureStatus: allValidSigs ? "VALID" : "INVALID",
          authorityStatus: thresholdResult.status,
          thresholdResult,
          reasonCodes,
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }

      signatureStatus = "VALID";
      authorityStatus = "THRESHOLD_SATISFIED";
    } else if (hasSingleSignature) {
      if (!this.keyring) {
        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode: "UNKNOWN_SIGNING_KEY",
          rawPayload: rawString,
          bundleId: declaredBundleId,
        });
        return {
          status: "QUARANTINED",
          bundleId: declaredBundleId,
          recomputedBundleId,
          replayValid: false,
          reasonCodes: ["UNKNOWN_SIGNING_KEY"],
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }

      signatureResult = EvidenceSignatureVerifier.verify(bundle, this.keyring);
      if (!signatureResult.valid) {
        const reasonCode = signatureResult.reasonCode ?? "INVALID_SIGNATURE";
        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode,
          rawPayload: rawString,
          bundleId: declaredBundleId,
        });
        return {
          status: "QUARANTINED",
          bundleId: declaredBundleId,
          recomputedBundleId,
          replayValid: false,
          signatureStatus: signatureResult.signatureStatus,
          authorityStatus: signatureResult.authorityStatus,
          keyId: bundle.signature!.keyId,
          signatureResult,
          reasonCodes: [reasonCode],
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }

      signatureStatus = signatureResult.signatureStatus;
      authorityStatus = signatureResult.authorityStatus;
    }

    // 7. Phase 40: Terminal Authority Index Fencing
    const runId = bundle.run.runId;
    const isTerminal = isTerminalStatus(bundle.terminalState.status);

    if (this.enforceTerminalAuthority && this.archive.hasTerminalRecord(runId)) {
      const existingTerminal = this.archive.getTerminalRecord(runId);
      if (existingTerminal && existingTerminal.bundleId !== recomputedBundleId && isTerminal) {
        // Conflicting terminal evidence bundle for an already-finalized run!
        const quarantineId = sha256Hex(rawString).slice(0, 32);
        this.archive.storeQuarantined({
          quarantineId,
          reasonCode: "TERMINAL_CONFLICT",
          rawPayload: rawString,
          bundleId: declaredBundleId,
        });
        return {
          status: "QUARANTINED",
          bundleId: declaredBundleId,
          recomputedBundleId,
          replayValid: false,
          signatureStatus,
          authorityStatus,
          keyId: bundle.signature?.keyId,
          signatureResult,
          thresholdResult,
          reasonCodes: ["TERMINAL_CONFLICT"],
          sizeBytes,
          ingestedAt,
          quarantineReference: quarantineId,
        };
      }
    }

    // 8. Offline Replay Verification
    const replayResult = EvidenceReplayVerifier.verify(bundle);
    if (!replayResult.valid) {
      const reasonCodes: IngestionReasonCode[] = [];
      if (!replayResult.bundleIntegrity) {
        reasonCodes.push("INVALID_BUNDLE_ID");
        reasonCodes.push("BUNDLE_ID_MISMATCH");
      }
      if (!replayResult.contractIntegrity) reasonCodes.push("CONTRACT_INTEGRITY_FAILURE");
      if (!replayResult.eventIntegrity) reasonCodes.push("EVENT_INTEGRITY_FAILURE");
      if (!replayResult.checkpointIntegrity) reasonCodes.push("CHECKPOINT_INTEGRITY_FAILURE");
      if (!replayResult.attemptIntegrity) reasonCodes.push("ATTEMPT_INTEGRITY_FAILURE");
      if (!replayResult.authorityIntegrity) reasonCodes.push("AUTHORITY_INTEGRITY_FAILURE");
      if (!replayResult.verificationIntegrity) reasonCodes.push("VERIFICATION_INTEGRITY_FAILURE");
      if (replayResult.failures.some((f) => f.includes("Provenance root mismatch"))) {
        reasonCodes.push("INVALID_PROVENANCE_ROOT");
        reasonCodes.push("PROVENANCE_ROOT_MISMATCH");
      }
      if (!reasonCodes.includes("REPLAY_VERIFICATION_FAILURE")) {
        reasonCodes.push("REPLAY_VERIFICATION_FAILURE");
      }

      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: reasonCodes[0]!,
        rawPayload: rawString,
        bundleId: declaredBundleId,
      });

      return {
        status: "QUARANTINED",
        bundleId: declaredBundleId,
        recomputedBundleId,
        provenanceRoot: replayResult.provenanceRoot,
        replayValid: false,
        signatureStatus,
        authorityStatus,
        keyId: bundle.signature?.keyId,
        signatureResult,
        thresholdResult,
        reasonCodes,
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    // 8. Security Policy Validation (No unredacted secrets)
    if (containsUnredactedSecrets(bundle)) {
      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: "SECURITY_POLICY_FAILURE",
        rawPayload: rawString,
        bundleId: bundle.bundleId,
      });
      return {
        status: "QUARANTINED",
        bundleId: bundle.bundleId,
        recomputedBundleId,
        provenanceRoot: replayResult.provenanceRoot,
        replayValid: true,
        signatureStatus,
        authorityStatus,
        keyId: bundle.signature?.keyId,
        signatureResult,
        thresholdResult,
        reasonCodes: ["SECURITY_POLICY_FAILURE"],
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    // 10. Archive Identity & Duplicate Verification
    const canonicalBytes = canonicalJsonStringify(bundle);

    if (this.archive.hasAccepted(recomputedBundleId)) {
      const existingBytes = this.archive.getAcceptedBytes(recomputedBundleId);
      if (existingBytes === canonicalBytes) {
        // Idempotent duplicate submission
        if (this.enforceTerminalAuthority && isTerminal && !this.archive.hasTerminalRecord(runId)) {
          // Crash recovery: bundle was accepted previously, but terminal record was not written
          const terminalRecord = createTerminalRecord({
            runId,
            bundleId: recomputedBundleId,
            terminalOutcome: bundle.terminalState.status as any,
            nowIso: this.clock.nowIso(),
          });
          this.archive.establishAuthoritativeTerminal(terminalRecord);
        }
        return {
          status: "DUPLICATE",
          bundleId: recomputedBundleId,
          recomputedBundleId,
          provenanceRoot: replayResult.provenanceRoot,
          replayValid: true,
          signatureStatus,
          authorityStatus,
          keyId: bundle.signature?.keyId,
          signatureResult,
          thresholdResult,
          reasonCodes: [],
          archiveReference: recomputedBundleId,
          sizeBytes,
          ingestedAt,
        };
      }
      // Identity conflict: matching bundleId with different canonical bytes
      const quarantineId = sha256Hex(rawString).slice(0, 32);
      this.archive.storeQuarantined({
        quarantineId,
        reasonCode: "IDENTITY_CONFLICT",
        rawPayload: rawString,
        bundleId: declaredBundleId,
      });
      return {
        status: "QUARANTINED",
        bundleId: declaredBundleId,
        recomputedBundleId,
        provenanceRoot: replayResult.provenanceRoot,
        replayValid: true,
        signatureStatus,
        authorityStatus,
        keyId: bundle.signature?.keyId,
        signatureResult,
        thresholdResult,
        reasonCodes: ["IDENTITY_CONFLICT"],
        sizeBytes,
        ingestedAt,
        quarantineReference: quarantineId,
      };
    }

    // 10. Accept and Archive
    const record = this.archive.storeAccepted(bundle, canonicalBytes);

    if (this.enforceTerminalAuthority && isTerminal) {
      if (!this.archive.hasTerminalRecord(runId)) {
        const terminalRecord = createTerminalRecord({
          runId,
          bundleId: recomputedBundleId,
          terminalOutcome: bundle.terminalState.status as any,
          nowIso: this.clock.nowIso(),
        });
        this.archive.establishAuthoritativeTerminal(terminalRecord);
      }
    }

    return {
      status: "ACCEPTED",
      bundleId: recomputedBundleId,
      recomputedBundleId,
      provenanceRoot: replayResult.provenanceRoot,
      replayValid: true,
      signatureStatus,
      authorityStatus,
      keyId: bundle.signature?.keyId,
      signatureResult,
      thresholdResult,
      reasonCodes: [],
      archiveReference: record.archivePath,
      sizeBytes,
      ingestedAt,
    };
  }

  /**
   * Re-verifies an archived bundle from the content-addressed archive.
   */
  verifyArchivedBundle(bundleId: string): ArchiveVerificationResult {
    return this.archive.verifyArchivedBundle(bundleId, this.keyring);
  }

  /**
   * Retrieves the authoritative terminal record for a run, if established.
   */
  getTerminalRecord(runId: string): AuthoritativeTerminalRecord | null {
    return this.archive.getTerminalRecord(runId);
  }

  /**
   * Cryptographically verifies the authoritative terminal record for a run.
   */
  verifyTerminalRecord(runId: string): TerminalVerificationResult {
    return this.archive.verifyTerminalRecord(runId);
  }
}
