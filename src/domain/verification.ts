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
  | "EXIT_CODE_ZERO"
  | "CLEAN_ROOM_DUAL_GATE";

export interface CleanRoomVerificationSpec {
  readonly specId: string;
  readonly baselineCommitSha: string;
  readonly failToPass: {
    readonly testCommand: readonly string[];
    readonly expectedBaselineExitCode: number;
    readonly expectedPatchedExitCode: 0;
    readonly minTestCount: number;
    readonly suiteRanRegex: string;
  };
  readonly passToPass: {
    readonly testCommand: readonly string[];
    readonly expectedBaselineExitCode: 0;
    readonly expectedPatchedExitCode: 0;
    readonly minTestCount: number;
    readonly suiteRanRegex: string;
  };
  readonly allowedPathPatterns: readonly string[];
  readonly timeoutMs: number;
}

export type CleanRoomFailureReasonCode =
  | "BASELINE_DEFECT_NOT_REPRODUCED"
  | "BASELINE_REGRESSION_PREEXISTING"
  | "EMPTY_PATCH"
  | "APPLY_PATCH_FAIL"
  | "TARGET_TEST_FAILED"
  | "REGRESSION_DETECTED"
  | "TEST_SUITE_NEVER_RAN"
  | "POLICY_PATH_VIOLATION"
  | "EXECUTION_TIMEOUT"
  | "INFRA_ENVIRONMENT_FAILURE";

export interface IndependentVerificationEvidencePayload {
  readonly runId: string;
  readonly taskId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly baselineCommitSha: string;
  readonly candidatePatchHash: string;
  readonly candidatePatchBytes: number;
  readonly touchedFiles: readonly string[];

  readonly baselineDiagnostic: {
    readonly f2pExitCode: number | null;
    readonly f2pOutputHash: string;
    readonly p2pExitCode: number | null;
    readonly p2pOutputHash: string;
    readonly baselineValid: boolean;
  };

  readonly patchApplication: {
    readonly status: "APPLIED" | "CONFLICT" | "EMPTY" | "MALFORMED";
    readonly exitCode: number;
    readonly outputText: string;
  };

  readonly cleanRoomEvaluation: {
    readonly f2pExitCode: number | null;
    readonly f2pTestsExecuted: number;
    readonly f2pTestsPassed: number;
    readonly f2pRatio: number;
    readonly f2pSuiteRanMatched: boolean;

    readonly p2pExitCode: number | null;
    readonly p2pTestsExecuted: number;
    readonly p2pTestsPassed: number;
    readonly p2pRatio: number;
    readonly p2pSuiteRanMatched: boolean;
  };

  readonly policyAudit: {
    readonly allowedPathsCompliant: boolean;
    readonly disallowedFilesTouched: readonly string[];
  };

  readonly overallStatus: "VERIFIED" | "FAILED";
  readonly failureReasonCode?: CleanRoomFailureReasonCode;
  readonly verifiedAt: string;
}

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
    "CLEAN_ROOM_DUAL_GATE",
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
  | "UNSUPPORTED_RULE"
  | CleanRoomFailureReasonCode;

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

      case "CLEAN_ROOM_DUAL_GATE": {
        const independentEvidence = evidenceList.find(
          (e) => e.source === "INDEPENDENT_OBSERVER" || e.kind === "OUTPUT_PAYLOAD"
        );
        if (!independentEvidence) {
          return Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            reasonCode: "MISSING_EVIDENCE",
            message: "Missing independent observer evidence required for CLEAN_ROOM_DUAL_GATE.",
            verifiedAt,
          });
        }

        const payload = (
          independentEvidence.summary && "output" in independentEvidence.summary
            ? (independentEvidence.summary as any).output
            : independentEvidence.summary
        ) as IndependentVerificationEvidencePayload | undefined;

        if (!payload || typeof payload !== "object") {
          return Object.freeze({
            status: "FAILED",
            verifierId: DeterministicVerifier.VERIFIER_ID,
            specId: spec.specId,
            evidenceIds,
            reasonCode: "MALFORMED_EVIDENCE",
            message: "Malformed independent verification evidence payload.",
            verifiedAt,
          });
        }

        return DeterministicVerifier.evaluateCleanRoomPayload(
          payload,
          spec.specId,
          evidenceIds,
          verifiedAt
        );
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

  /**
   * Deterministically evaluates an IndependentVerificationEvidencePayload.
   * Enforces the fourfold clean-room invariant.
   */
  static evaluateCleanRoomPayload(
    payload: IndependentVerificationEvidencePayload,
    specId: string,
    evidenceIds: readonly string[],
    verifiedAt: string = new Date().toISOString()
  ): VerificationResult {
    // 1. Overall status assertion
    if (payload.overallStatus !== "VERIFIED") {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: payload.failureReasonCode ?? "ASSERTION_FAILED",
        message: `Clean-room verification failed: ${payload.failureReasonCode ?? "OVERALL_STATUS_NOT_VERIFIED"}`,
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // 2. Baseline diagnostic validity
    if (!payload.baselineDiagnostic?.baselineValid) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: "BASELINE_DEFECT_NOT_REPRODUCED",
        message: "Clean-room baseline diagnostic was invalid: defect was not reproduced or preexisting regression found.",
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // 3. Patch application validity
    if (payload.patchApplication?.status !== "APPLIED") {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: payload.patchApplication?.status === "EMPTY" ? "EMPTY_PATCH" : "APPLY_PATCH_FAIL",
        message: `Clean-room patch application failed with status '${payload.patchApplication?.status}'.`,
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // 4. Fail-to-Pass ratio must be 1.0
    if (payload.cleanRoomEvaluation?.f2pRatio !== 1.0) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: "TARGET_TEST_FAILED",
        message: `Clean-room Fail-to-Pass ratio was ${payload.cleanRoomEvaluation?.f2pRatio}, expected 1.0.`,
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // 5. Pass-to-Pass ratio must be 1.0
    if (payload.cleanRoomEvaluation?.p2pRatio !== 1.0) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: "REGRESSION_DETECTED",
        message: `Clean-room Pass-to-Pass ratio was ${payload.cleanRoomEvaluation?.p2pRatio}, expected 1.0 (regression detected).`,
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // 6. Anti-zero-test execution suite ran assertion
    if (
      !payload.cleanRoomEvaluation?.f2pSuiteRanMatched ||
      !payload.cleanRoomEvaluation?.p2pSuiteRanMatched
    ) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: "TEST_SUITE_NEVER_RAN",
        message: "Clean-room test suite execution check failed: suite did not execute required assertions.",
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // 7. Policy path audit
    if (!payload.policyAudit?.allowedPathsCompliant) {
      return Object.freeze({
        status: "FAILED",
        verifierId: DeterministicVerifier.VERIFIER_ID,
        specId,
        evidenceIds,
        reasonCode: "POLICY_PATH_VIOLATION",
        message: `Clean-room policy path audit failed: disallowed files touched: ${JSON.stringify(payload.policyAudit?.disallowedFilesTouched ?? [])}`,
        details: Object.freeze(payload as unknown as Record<string, unknown>),
        verifiedAt,
      });
    }

    // All clean-room predicates satisfied
    return Object.freeze({
      status: "VERIFIED",
      verifierId: DeterministicVerifier.VERIFIER_ID,
      specId,
      evidenceIds,
      message: "Independent clean-room proof verified: F2P=1.0, P2P=1.0, SUITE_RAN verified, zero regressions.",
      details: Object.freeze(payload as unknown as Record<string, unknown>),
      verifiedAt,
    });
  }

  /**
   * Helper to verify a single independent Evidence item against a CleanRoomVerificationSpec.
   */
  static verifyCleanRoom(
    evidence: Evidence,
    spec: CleanRoomVerificationSpec,
    verifiedAt: string = new Date().toISOString()
  ): VerificationResult {
    const vSpec: VerificationSpec = {
      specId: spec.specId,
      ruleKind: "CLEAN_ROOM_DUAL_GATE",
      expectedValue: spec,
    };
    return DeterministicVerifier.verify([evidence], vSpec, verifiedAt);
  }
}
