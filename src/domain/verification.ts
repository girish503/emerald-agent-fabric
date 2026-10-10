/**
 * Verification Model & Deterministic Verifier for Emerald Agent Fabric.
 *
 * Establishes the independent verification boundary answering:
 * "Does independently observable evidence support the claimed outcome?"
 *
 * Core Boundary Guarantees:
 * 1. Pure & Deterministic: No I/O, no network, no Docker, no SQLite, no randomness, no LLMs.
 * 2. Immutable Verdicts: VerificationResult reports VERIFIED or FAILED with structured audit data.
 * 3. Decoupled from Retry: The verifier reports semantic verdicts only;
 *    retry policy is owned separately by the application runtime.
 * 4. Tamper Detection: Detects discrepancies between provider-claimed outputs and expected specifications.
 */

import { computeCanonicalHash } from "./canonical-hash.js";
import { Evidence } from "./evidence.js";

export type VerificationRuleKind =
  | "EXACT_OUTPUT_MATCH"
  | "OUTPUT_HASH_MATCH"
  | "EXIT_CODE_ZERO";

export interface VerificationSpec {
  readonly specId: string;
  readonly ruleKind: VerificationRuleKind;
  readonly expectedValue?: unknown;
  readonly expectedHash?: string;
}

export function createVerificationSpec(spec: VerificationSpec): VerificationSpec {
  if (!spec || typeof spec !== "object") {
    throw new Error("VerificationSpec must be a valid object.");
  }
  if (!spec.specId || typeof spec.specId !== "string") {
    throw new Error("VerificationSpec requires a valid non-empty specId.");
  }

  const validKinds: readonly VerificationRuleKind[] = [
    "EXACT_OUTPUT_MATCH",
    "OUTPUT_HASH_MATCH",
    "EXIT_CODE_ZERO",
  ];
  if (!validKinds.includes(spec.ruleKind)) {
    throw new Error(`Invalid VerificationRuleKind: '${String(spec.ruleKind)}'.`);
  }

  return Object.freeze({
    specId: spec.specId,
    ruleKind: spec.ruleKind,
    expectedValue: spec.expectedValue !== undefined ? Object.freeze(spec.expectedValue) : undefined,
    expectedHash: spec.expectedHash,
  });
}

export type VerificationStatus = "VERIFIED" | "FAILED";

export type VerificationFailureReason =
  | "ASSERTION_FAILED"
  | "MISSING_EVIDENCE"
  | "MALFORMED_EVIDENCE"
  | "UNSUPPORTED_RULE";

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly verifierId: string;
  readonly specId: string;
  readonly evidenceIds: readonly string[];
  readonly reasonCode?: VerificationFailureReason;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly verifiedAt: string;
}

export class DeterministicVerifier {
  static readonly VERIFIER_ID = "deterministic-verifier-v1";

  /**
   * Pure, deterministic verification evaluation function.
   * Compares evidence items against a VerificationSpec.
   */
  static verify(
    evidenceList: readonly Evidence[],
    spec: VerificationSpec,
    verifiedAt: string = new Date().toISOString()
  ): VerificationResult {
    // 1. Validate spec structure
    if (!spec || !spec.ruleKind) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId: spec?.specId ?? "unknown",
        evidenceIds: [],
        reasonCode: "UNSUPPORTED_RULE",
        message: "Invalid or undefined VerificationSpec.",
        verifiedAt,
      });
    }

    // 2. Validate evidence list
    if (!Array.isArray(evidenceList) || evidenceList.length === 0) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId: spec.specId,
        evidenceIds: [],
        reasonCode: "MISSING_EVIDENCE",
        message: "No evidence provided for verification evaluation.",
        verifiedAt,
      });
    }

    const evidenceIds = Object.freeze(evidenceList.map((e) => e.evidenceId));

    switch (spec.ruleKind) {
      case "EXACT_OUTPUT_MATCH": {
        const outputEvidence = evidenceList.find((e) => e.kind === "OUTPUT_PAYLOAD");
        if (!outputEvidence) {
          return Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            reasonCode: "MISSING_EVIDENCE",
            message: "Missing 'OUTPUT_PAYLOAD' evidence required for EXACT_OUTPUT_MATCH.",
            verifiedAt,
          });
        }

        // Compute expected hash and canonical JSON
        const { canonicalJson: expectedCanonical, contentHash: expectedHash } =
          computeCanonicalHash(spec.expectedValue);

        // Extract observed canonical value from evidence
        const observedPayload =
          outputEvidence.summary && "output" in outputEvidence.summary
            ? outputEvidence.summary.output
            : outputEvidence.summary;

        const { canonicalJson: observedCanonical, contentHash: observedHash } =
          computeCanonicalHash(observedPayload);

        // Verification check: hash equality on canonical redacted representations
        if (expectedHash === outputEvidence.contentHash || expectedHash === observedHash) {
          return Object.freeze({
            status: "VERIFIED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            message: `Output evidence '${outputEvidence.evidenceId}' verified against expected value.`,
            verifiedAt,
          });
        }

        return Object.freeze({
          status: "FAILED",
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: spec.specId,
          evidenceIds,
          reasonCode: "ASSERTION_FAILED",
          message: "Observed output did not match expected value.",
          details: Object.freeze({
            expectedHash,
            observedHash: outputEvidence.contentHash,
            expectedCanonical,
            observedCanonical,
          }),
          verifiedAt,
        });
      }

      case "OUTPUT_HASH_MATCH": {
        if (!spec.expectedHash || typeof spec.expectedHash !== "string") {
          return Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            reasonCode: "MALFORMED_EVIDENCE",
            message: "OUTPUT_HASH_MATCH rule requires a valid 'expectedHash'.",
            verifiedAt,
          });
        }

        const matchingEvidence = evidenceList.find(
          (e) => e.contentHash.toLowerCase() === spec.expectedHash?.toLowerCase()
        );

        if (matchingEvidence) {
          return Object.freeze({
            status: "VERIFIED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            message: `Evidence '${matchingEvidence.evidenceId}' content hash matches expected hash.`,
            verifiedAt,
          });
        }

        return Object.freeze({
          status: "FAILED",
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: spec.specId,
          evidenceIds,
          reasonCode: "ASSERTION_FAILED",
          message: "No evidence matched the expected content hash.",
          details: Object.freeze({
            expectedHash: spec.expectedHash,
            observedHashes: evidenceList.map((e) => e.contentHash),
          }),
          verifiedAt,
        });
      }

      case "EXIT_CODE_ZERO": {
        const exitEvidence = evidenceList.find((e) => e.kind === "PROCESS_EXIT");
        if (!exitEvidence) {
          return Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            reasonCode: "MISSING_EVIDENCE",
            message: "Missing 'PROCESS_EXIT' evidence required for EXIT_CODE_ZERO.",
            verifiedAt,
          });
        }

        const exitCode = exitEvidence.summary?.exitCode;
        if (exitCode === 0) {
          return Object.freeze({
            status: "VERIFIED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            message: `Process exit code is 0 (evidence '${exitEvidence.evidenceId}').`,
            verifiedAt,
          });
        }

        return Object.freeze({
          status: "FAILED",
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: spec.specId,
          evidenceIds,
          reasonCode: "ASSERTION_FAILED",
          message: `Process exit code was ${String(exitCode)}, expected 0.`,
          details: Object.freeze({ exitCode }),
          verifiedAt,
        });
      }

      default: {
        return Object.freeze({
          status: "FAILED",
          verifierId: DeterministicVerifier.VERIFIER_ID,
          specId: spec.specId,
          evidenceIds,
          reasonCode: "UNSUPPORTED_RULE",
          message: `Unsupported verification rule kind: '${String(spec.ruleKind)}'.`,
          verifiedAt,
        });
      }
    }
  }
}
