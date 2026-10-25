import crypto from "node:crypto";
import {
  AuthorityRole,
  createSigningPayload,
  EvidenceBundle,
  EvidenceSignature,
  IngestionReasonCode,
  KeyAuthorityStatus,
  SignatureVerificationResult,
  ThresholdEvaluationResult,
  ThresholdPolicy,
  ThresholdStatus,
} from "../domain/evidence-bundle.js";
import {
  canonicalJsonStringify,
  sha256Hex,
} from "../domain/canonical-hash.js";

/**
 * Computes deterministic public key fingerprint (SHA-256 of standard SPKI DER bytes).
 */
export function computePublicKeyFingerprint(key: crypto.KeyObject | string | Buffer): string {
  let keyObj: crypto.KeyObject;
  if (typeof key === "string" || Buffer.isBuffer(key)) {
    keyObj = crypto.createPublicKey(key);
  } else {
    keyObj = key;
  }
  const der = keyObj.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

export interface TrustedKeyRecord {
  readonly keyId: string;
  readonly publicKey: crypto.KeyObject;
  readonly publicKeyPem: string;
  readonly publicKeyFingerprint: string;
  status: KeyAuthorityStatus;
  readonly authorityId?: string; // Phase 37: authority identifier (e.g. WORKER_PRODUCER, SUPERVISOR, INDEPENDENT_VERIFIER)
  readonly role?: AuthorityRole; // Phase 37: authority role
}

/**
 * Minimal offline trusted key registry for Emerald Agent Fabric.
 */
export class TrustedKeyring {
  private readonly keys = new Map<string, TrustedKeyRecord>();

  registerKey(params: {
    keyId: string;
    publicKey: crypto.KeyObject | string;
    status?: KeyAuthorityStatus;
    authorityId?: string;
    role?: AuthorityRole;
  }): TrustedKeyRecord {
    if (!params.keyId || typeof params.keyId !== "string" || params.keyId.trim() === "") {
      throw new Error("Invalid keyId: must be a non-empty string");
    }

    let keyObj: crypto.KeyObject;
    try {
      if (typeof params.publicKey === "string") {
        keyObj = crypto.createPublicKey(params.publicKey);
      } else {
        keyObj = params.publicKey;
      }
    } catch (err: any) {
      throw new Error(`Failed to parse public key for keyId '${params.keyId}': ${err?.message ?? "unknown error"}`);
    }

    if (keyObj.asymmetricKeyType !== "ed25519") {
      throw new Error(
        `Unsupported key algorithm for keyId '${params.keyId}': expected 'ed25519', got '${keyObj.asymmetricKeyType}'`
      );
    }

    const publicKeyPem = keyObj.export({ type: "spki", format: "pem" }) as string;
    const publicKeyFingerprint = computePublicKeyFingerprint(keyObj);

    const record: TrustedKeyRecord = {
      keyId: params.keyId,
      publicKey: keyObj,
      publicKeyPem,
      publicKeyFingerprint,
      status: params.status ?? "TRUSTED",
      authorityId: params.authorityId,
      role: params.role,
    };

    this.keys.set(params.keyId, record);
    return record;
  }

  getKey(keyId: string): TrustedKeyRecord | undefined {
    return this.keys.get(keyId);
  }

  getKeyByAuthorityId(authorityId: string): TrustedKeyRecord | undefined {
    for (const record of this.keys.values()) {
      if (record.authorityId === authorityId) {
        return record;
      }
    }
    return undefined;
  }

  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  revokeKey(keyId: string): void {
    const rec = this.keys.get(keyId);
    if (rec) {
      rec.status = "REVOKED";
    }
  }

  getFingerprint(keyId: string): string | undefined {
    return this.keys.get(keyId)?.publicKeyFingerprint;
  }
}

/**
 * Signs EvidenceBundles using Ed25519.
 */
export class EvidenceSigner {
  /**
   * Generates a new in-memory ephemeral Ed25519 keypair.
   * Useful for tests and local key provisioning.
   */
  static generateKeyPair(): {
    publicKey: crypto.KeyObject;
    privateKey: crypto.KeyObject;
    publicKeyPem: string;
    privateKeyPem: string;
    fingerprint: string;
  } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const fingerprint = computePublicKeyFingerprint(publicKey);
    return { publicKey, privateKey, publicKeyPem, privateKeyPem, fingerprint };
  }

  /**
   * Signs an EvidenceBundle with an Ed25519 private key.
   * Does NOT alter bundleId or provenanceRoot.
   */
  static sign(
    bundle: EvidenceBundle,
    privateKey: crypto.KeyObject | string,
    keyId: string,
    options?: {
      publicKeyFingerprint?: string;
      publicKey?: crypto.KeyObject | string;
      authorityId?: string;
      attachToSignatures?: boolean;
    }
  ): EvidenceBundle {
    let privateKeyObj: crypto.KeyObject;
    if (typeof privateKey === "string") {
      privateKeyObj = crypto.createPrivateKey(privateKey);
    } else {
      privateKeyObj = privateKey;
    }

    if (privateKeyObj.asymmetricKeyType !== "ed25519") {
      throw new Error(
        `Unsupported private key algorithm: expected 'ed25519', got '${privateKeyObj.asymmetricKeyType}'`
      );
    }

    let fingerprint = options?.publicKeyFingerprint;
    if (!fingerprint) {
      const pubKey = options?.publicKey ?? crypto.createPublicKey(privateKeyObj);
      fingerprint = computePublicKeyFingerprint(pubKey);
    }

    const signingPayload = createSigningPayload(bundle);
    const canonicalString = canonicalJsonStringify(signingPayload);
    const signedContentDigest = sha256Hex(canonicalString);

    const signatureBuffer = crypto.sign(null, Buffer.from(canonicalString, "utf8"), privateKeyObj);
    const signatureHex = signatureBuffer.toString("hex");

    const signature: EvidenceSignature = {
      algorithm: "Ed25519",
      keyId,
      publicKeyFingerprint: fingerprint,
      signature: signatureHex,
      signedContentDigest,
      ...(options?.authorityId ? { authorityId: options.authorityId } : {}),
    };

    const attachMulti = options?.attachToSignatures ?? (options?.authorityId !== undefined || bundle.signatures !== undefined);

    return Object.freeze({
      ...bundle,
      signature,
      ...(attachMulti
        ? {
            signatures: Object.freeze(
              bundle.signatures
                ? [...bundle.signatures, signature]
                : [signature]
            ),
          }
        : {}),
    });
  }

  /**
   * Adds an additional authority signature to an EvidenceBundle (Phase 37).
   */
  static addSignature(
    bundle: EvidenceBundle,
    privateKey: crypto.KeyObject | string,
    keyId: string,
    options?: {
      publicKeyFingerprint?: string;
      publicKey?: crypto.KeyObject | string;
      authorityId?: string;
    }
  ): EvidenceBundle {
    let privateKeyObj: crypto.KeyObject;
    if (typeof privateKey === "string") {
      privateKeyObj = crypto.createPrivateKey(privateKey);
    } else {
      privateKeyObj = privateKey;
    }

    let fingerprint = options?.publicKeyFingerprint;
    if (!fingerprint) {
      const pubKey = options?.publicKey ?? crypto.createPublicKey(privateKeyObj);
      fingerprint = computePublicKeyFingerprint(pubKey);
    }

    const signingPayload = createSigningPayload(bundle);
    const canonicalString = canonicalJsonStringify(signingPayload);
    const signedContentDigest = sha256Hex(canonicalString);

    const signatureBuffer = crypto.sign(null, Buffer.from(canonicalString, "utf8"), privateKeyObj);
    const signatureHex = signatureBuffer.toString("hex");

    const newSignature: EvidenceSignature = {
      algorithm: "Ed25519",
      keyId,
      publicKeyFingerprint: fingerprint,
      signature: signatureHex,
      signedContentDigest,
      ...(options?.authorityId ? { authorityId: options.authorityId } : {}),
    };

    const existingSignatures = bundle.signatures
      ? [...bundle.signatures]
      : bundle.signature
      ? [bundle.signature]
      : [];

    const updatedSignatures = [...existingSignatures, newSignature];

    return Object.freeze({
      ...bundle,
      signature: bundle.signature ?? newSignature,
      signatures: Object.freeze(updatedSignatures),
    });
  }
}

/**
 * Verifies Ed25519 evidence signatures against a TrustedKeyring.
 */
export class EvidenceSignatureVerifier {
  /**
   * Verifies an EvidenceBundle's signature.
   *
   * @param bundle The evidence bundle to verify.
   * @param keyring The local trusted keyring.
   * @param options Verification options:
   *   - allowRevokedForHistorical: if true, allows REVOKED keys to pass cryptographic check
   *     while reporting authorityStatus = "REVOKED". Default false (rejects revoked keys).
   */
  static verify(
    bundle: EvidenceBundle,
    keyring: TrustedKeyring,
    options?: { allowRevokedForHistorical?: boolean }
  ): SignatureVerificationResult {
    if (!bundle.signature) {
      return {
        valid: false,
        signatureStatus: "UNSIGNED_LEGACY",
        authorityStatus: "NOT_ESTABLISHED",
        failures: ["Bundle has no signature"],
      };
    }

    return EvidenceSignatureVerifier.verifySingleSignature(
      bundle.signature,
      bundle,
      keyring,
      options
    );
  }

  /**
   * Verifies an individual EvidenceSignature against a bundle and keyring (Phase 37).
   */
  static verifySingleSignature(
    sig: EvidenceSignature,
    bundle: EvidenceBundle,
    keyring: TrustedKeyring,
    options?: { allowRevokedForHistorical?: boolean }
  ): SignatureVerificationResult {
    const failures: string[] = [];

    // 1. Structure & Algorithm Check
    if (typeof sig !== "object" || sig === null) {
      failures.push("Malformed signature property: must be a non-null object");
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "UNKNOWN",
        failures,
        reasonCode: "INVALID_SIGNATURE_PAYLOAD",
      };
    }

    if (sig.algorithm !== "Ed25519") {
      failures.push(`Unsupported signature algorithm: '${sig.algorithm}'. Only 'Ed25519' is supported.`);
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "UNKNOWN",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "INVALID_SIGNATURE_PAYLOAD",
      };
    }

    // 2. KeyId Check
    if (typeof sig.keyId !== "string" || sig.keyId.trim() === "") {
      failures.push("Signature keyId must be a non-empty string");
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "UNKNOWN",
        failures,
        reasonCode: "INVALID_SIGNATURE_PAYLOAD",
      };
    }

    // 3. Keyring Lookup
    const trustedRecord = keyring.getKey(sig.keyId);
    if (!trustedRecord) {
      failures.push(`Signing key '${sig.keyId}' not found in trusted keyring`);
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "UNKNOWN",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "UNKNOWN_SIGNING_KEY",
      };
    }

    // Authority ID Check if present in signature and record
    if (sig.authorityId && trustedRecord.authorityId && sig.authorityId !== trustedRecord.authorityId) {
      failures.push(
        `Authority ID mismatch for key '${sig.keyId}': declared '${sig.authorityId}', expected '${trustedRecord.authorityId}'`
      );
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "UNKNOWN",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "INVALID_SIGNATURE",
      };
    }

    // 4. Revocation Check
    const isRevoked = trustedRecord.status === "REVOKED";
    if (isRevoked && !options?.allowRevokedForHistorical) {
      failures.push(`Signing key '${sig.keyId}' has been REVOKED`);
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "REVOKED",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "REVOKED_SIGNING_KEY",
      };
    }

    // 5. Fingerprint Match Check
    if (sig.publicKeyFingerprint !== trustedRecord.publicKeyFingerprint) {
      failures.push(
        `Public key fingerprint mismatch for key '${sig.keyId}': declared '${sig.publicKeyFingerprint}', expected '${trustedRecord.publicKeyFingerprint}'`
      );
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: "UNKNOWN",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "INVALID_PUBLIC_KEY",
      };
    }

    // 6. Signed Content Digest Check
    const signingPayload = createSigningPayload(bundle);
    const canonicalString = canonicalJsonStringify(signingPayload);
    const expectedDigest = sha256Hex(canonicalString);
    if (sig.signedContentDigest !== expectedDigest) {
      failures.push(
        `Signed content digest mismatch: declared '${sig.signedContentDigest}', recomputed '${expectedDigest}'`
      );
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: isRevoked ? "REVOKED" : "TRUSTED",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "INVALID_SIGNATURE",
      };
    }

    // 7. Signature Byte Length Check (Ed25519 signatures are 64 bytes = 128 hex characters)
    if (
      typeof sig.signature !== "string" ||
      !/^[0-9a-f]{128}$/i.test(sig.signature)
    ) {
      failures.push("Invalid Ed25519 signature format: must be 128 hex characters (64 bytes)");
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: isRevoked ? "REVOKED" : "TRUSTED",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "INVALID_SIGNATURE",
      };
    }

    // 8. Cryptographic Verification
    let cryptoValid = false;
    try {
      const sigBuffer = Buffer.from(sig.signature, "hex");
      const payloadBuffer = Buffer.from(canonicalString, "utf8");
      cryptoValid = crypto.verify(null, payloadBuffer, trustedRecord.publicKey, sigBuffer);
    } catch (err: any) {
      failures.push(`Cryptographic verification error: ${err?.message ?? "unknown error"}`);
    }

    if (!cryptoValid) {
      failures.push("Cryptographic signature verification failed: signature does not match payload and public key");
      return {
        valid: false,
        signatureStatus: "INVALID",
        authorityStatus: isRevoked ? "REVOKED" : "TRUSTED",
        keyId: sig.keyId,
        publicKeyFingerprint: sig.publicKeyFingerprint,
        signedContentDigest: sig.signedContentDigest,
        failures,
        reasonCode: "INVALID_SIGNATURE",
      };
    }

    return {
      valid: true,
      signatureStatus: "VALID",
      authorityStatus: isRevoked ? "REVOKED" : "TRUSTED",
      keyId: sig.keyId,
      publicKeyFingerprint: sig.publicKeyFingerprint,
      signedContentDigest: sig.signedContentDigest,
      failures: [],
    };
  }
}

/**
 * Evaluates multi-authority threshold verification over an EvidenceBundle (Phase 37).
 */
export class EvidenceThresholdVerifier {
  static readonly DEFAULT_THRESHOLD_POLICY: ThresholdPolicy = Object.freeze({
    threshold: 2,
    totalAuthorities: 3,
  });

  /**
   * Evaluates threshold authorization over an EvidenceBundle's signatures.
   */
  static verifyThreshold(
    bundle: EvidenceBundle,
    keyring: TrustedKeyring,
    policy: ThresholdPolicy = EvidenceThresholdVerifier.DEFAULT_THRESHOLD_POLICY,
    options?: { allowRevokedForHistorical?: boolean }
  ): ThresholdEvaluationResult & {
    readonly reasonCodes: readonly IngestionReasonCode[];
    readonly signatureResults: readonly SignatureVerificationResult[];
  } {
    const rawSignatures: readonly EvidenceSignature[] =
      bundle.signatures && bundle.signatures.length > 0
        ? bundle.signatures
        : bundle.signature
        ? [bundle.signature]
        : [];

    if (rawSignatures.length === 0) {
      return {
        status: "INSUFFICIENT_AUTHORITIES",
        distinctValidAuthorities: 0,
        validAuthorityIds: [],
        rejectedAuthorityIds: [],
        threshold: policy.threshold,
        totalAuthorities: policy.totalAuthorities,
        failures: ["Bundle has no signatures to evaluate threshold"],
        reasonCodes: ["INSUFFICIENT_AUTHORITIES"],
        signatureResults: [],
      };
    }

    const validAuthorityIds = new Set<string>();
    const rejectedAuthorityIds: string[] = [];
    const duplicateAuthorityIds: string[] = [];
    const failures: string[] = [];
    const reasonCodesSet = new Set<IngestionReasonCode>();
    const signatureResults: SignatureVerificationResult[] = [];

    for (const sig of rawSignatures) {
      const sigRes = EvidenceSignatureVerifier.verifySingleSignature(
        sig,
        bundle,
        keyring,
        options
      );
      signatureResults.push(sigRes);

      const trustedRecord = keyring.getKey(sig.keyId);
      const authorityId = sig.authorityId ?? trustedRecord?.authorityId ?? sig.keyId;

      if (!sigRes.valid) {
        rejectedAuthorityIds.push(authorityId);
        failures.push(...sigRes.failures);
        if (sigRes.reasonCode === "REVOKED_SIGNING_KEY") {
          reasonCodesSet.add("REVOKED_AUTHORITY");
        } else if (sigRes.reasonCode === "UNKNOWN_SIGNING_KEY") {
          reasonCodesSet.add("UNKNOWN_AUTHORITY");
        } else if (sigRes.reasonCode) {
          reasonCodesSet.add(sigRes.reasonCode);
        } else {
          reasonCodesSet.add("INVALID_SIGNATURE");
        }
      } else {
        // Valid signature cryptographically
        if (trustedRecord?.status === "REVOKED") {
          rejectedAuthorityIds.push(authorityId);
          failures.push(`Authority '${authorityId}' is REVOKED and cannot satisfy threshold`);
          reasonCodesSet.add("REVOKED_AUTHORITY");
        } else {
          // Check duplicate authority
          if (validAuthorityIds.has(authorityId)) {
            duplicateAuthorityIds.push(authorityId);
            failures.push(`Duplicate authority signature from '${authorityId}' cannot satisfy threshold`);
            reasonCodesSet.add("DUPLICATE_AUTHORITY");
          } else {
            validAuthorityIds.add(authorityId);
          }
        }
      }
    }

    const distinctValidCount = validAuthorityIds.size;
    const isSatisfied = distinctValidCount >= policy.threshold;

    if (isSatisfied) {
      return {
        status: "THRESHOLD_SATISFIED",
        distinctValidAuthorities: distinctValidCount,
        validAuthorityIds: Array.from(validAuthorityIds),
        rejectedAuthorityIds,
        threshold: policy.threshold,
        totalAuthorities: policy.totalAuthorities,
        failures: [],
        reasonCodes: [],
        signatureResults,
      };
    }

    // Threshold not satisfied
    let finalStatus: ThresholdStatus = "INSUFFICIENT_AUTHORITIES";
    if (duplicateAuthorityIds.length > 0 && distinctValidCount < policy.threshold) {
      finalStatus = "DUPLICATE_AUTHORITY";
    } else if (rejectedAuthorityIds.length > 0 && distinctValidCount === 0) {
      if (reasonCodesSet.has("REVOKED_AUTHORITY")) {
        finalStatus = "REVOKED_AUTHORITY";
      } else if (reasonCodesSet.has("UNKNOWN_AUTHORITY")) {
        finalStatus = "UNKNOWN_AUTHORITY";
      } else if (reasonCodesSet.has("INVALID_SIGNATURE")) {
        finalStatus = "INVALID_SIGNATURE";
      }
    }

    reasonCodesSet.add("INSUFFICIENT_AUTHORITIES");

    return {
      status: finalStatus,
      distinctValidAuthorities: distinctValidCount,
      validAuthorityIds: Array.from(validAuthorityIds),
      rejectedAuthorityIds,
      threshold: policy.threshold,
      totalAuthorities: policy.totalAuthorities,
      failures,
      reasonCodes: Array.from(reasonCodesSet),
      signatureResults,
    };
  }
}
