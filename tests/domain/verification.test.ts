import { describe, expect, it } from "vitest";
import { computeCanonicalHash } from "../../src/domain/canonical-hash.js";
import {
  createOutputPayloadEvidence,
  createProcessExitEvidence,
} from "../../src/domain/evidence.js";
import {
  createVerificationSpec,
  DeterministicVerifier,
} from "../../src/domain/verification.js";

describe("Deterministic Verifier & VerificationSpec", () => {
  describe("EXACT_OUTPUT_MATCH rule", () => {
    it("returns VERIFIED when observed output exactly matches expected value", () => {
      const evidence = createOutputPayloadEvidence("run-1", { sum: 5 });
      const spec = createVerificationSpec({
        specId: "spec-sum",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { sum: 5 },
      });

      const result = DeterministicVerifier.verify([evidence], spec);

      expect(result.status).toBe("VERIFIED");
      expect(result.verifierId).toBe(DeterministicVerifier.VERIFIER_ID);
      expect(result.specId).toBe("spec-sum");
      expect(result.evidenceIds).toContain(evidence.evidenceId);
      expect(result.reasonCode).toBeUndefined();
    });

    it("returns VERIFIED for wrapped scalar outputs", () => {
      const evidence = createOutputPayloadEvidence("run-scalar", 42);
      const spec = createVerificationSpec({
        specId: "spec-scalar",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: 42,
      });

      const result = DeterministicVerifier.verify([evidence], spec);

      expect(result.status).toBe("VERIFIED");
    });

    it("returns FAILED with ASSERTION_FAILED when observed output does not match expected value", () => {
      const evidence = createOutputPayloadEvidence("run-1", { sum: 4 }); // actual is 4
      const spec = createVerificationSpec({
        specId: "spec-sum",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { sum: 5 }, // expected is 5
      });

      const result = DeterministicVerifier.verify([evidence], spec);

      expect(result.status).toBe("FAILED");
      expect(result.reasonCode).toBe("ASSERTION_FAILED");
      expect(result.message).toContain("did not match expected value");
      expect(result.details).toBeDefined();
    });

    it("returns FAILED with MISSING_EVIDENCE when OUTPUT_PAYLOAD evidence is absent", () => {
      const exitEvidence = createProcessExitEvidence("run-1", { exitCode: 0 });
      const spec = createVerificationSpec({
        specId: "spec-sum",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { sum: 5 },
      });

      const result = DeterministicVerifier.verify([exitEvidence], spec);

      expect(result.status).toBe("FAILED");
      expect(result.reasonCode).toBe("MISSING_EVIDENCE");
    });
  });

  describe("OUTPUT_HASH_MATCH rule", () => {
    it("returns VERIFIED when evidence contentHash matches expectedHash", () => {
      const expectedPayload = { message: "verified content" };
      const { contentHash } = computeCanonicalHash(expectedPayload);
      const evidence = createOutputPayloadEvidence("run-hash", expectedPayload);

      const spec = createVerificationSpec({
        specId: "spec-hash",
        ruleKind: "OUTPUT_HASH_MATCH",
        expectedHash: contentHash,
      });

      const result = DeterministicVerifier.verify([evidence], spec);

      expect(result.status).toBe("VERIFIED");
    });

    it("returns FAILED with ASSERTION_FAILED when hash differs", () => {
      const evidence = createOutputPayloadEvidence("run-hash", { message: "tampered" });
      const spec = createVerificationSpec({
        specId: "spec-hash",
        ruleKind: "OUTPUT_HASH_MATCH",
        expectedHash: "0000000000000000000000000000000000000000000000000000000000000000",
      });

      const result = DeterministicVerifier.verify([evidence], spec);

      expect(result.status).toBe("FAILED");
      expect(result.reasonCode).toBe("ASSERTION_FAILED");
    });
  });

  describe("EXIT_CODE_ZERO rule", () => {
    it("returns VERIFIED when exitCode is 0", () => {
      const exitEvidence = createProcessExitEvidence("run-exit-0", { exitCode: 0 });
      const spec = createVerificationSpec({
        specId: "spec-exit",
        ruleKind: "EXIT_CODE_ZERO",
      });

      const result = DeterministicVerifier.verify([exitEvidence], spec);

      expect(result.status).toBe("VERIFIED");
    });

    it("returns FAILED with ASSERTION_FAILED when exitCode is non-zero", () => {
      const exitEvidence = createProcessExitEvidence("run-exit-1", { exitCode: 137 });
      const spec = createVerificationSpec({
        specId: "spec-exit",
        ruleKind: "EXIT_CODE_ZERO",
      });

      const result = DeterministicVerifier.verify([exitEvidence], spec);

      expect(result.status).toBe("FAILED");
      expect(result.reasonCode).toBe("ASSERTION_FAILED");
      expect(result.message).toContain("exit code was 137");
    });

    it("returns FAILED with MISSING_EVIDENCE when PROCESS_EXIT evidence is absent", () => {
      const payloadEvidence = createOutputPayloadEvidence("run-payload", { ok: true });
      const spec = createVerificationSpec({
        specId: "spec-exit",
        ruleKind: "EXIT_CODE_ZERO",
      });

      const result = DeterministicVerifier.verify([payloadEvidence], spec);

      expect(result.status).toBe("FAILED");
      expect(result.reasonCode).toBe("MISSING_EVIDENCE");
    });
  });

  describe("General Verifier Invariants", () => {
    it("returns identical result on repeated evaluations (pure determinism)", () => {
      const evidence = createOutputPayloadEvidence("run-det", { val: 1 });
      const spec = createVerificationSpec({
        specId: "spec-det",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: { val: 1 },
      });

      const r1 = DeterministicVerifier.verify([evidence], spec, "2026-01-01T00:00:00Z");
      const r2 = DeterministicVerifier.verify([evidence], spec, "2026-01-01T00:00:00Z");

      expect(r1).toEqual(r2);
    });

    it("returns FAILED when evidence list is empty", () => {
      const spec = createVerificationSpec({
        specId: "spec-empty",
        ruleKind: "EXACT_OUTPUT_MATCH",
        expectedValue: 1,
      });

      const result = DeterministicVerifier.verify([], spec);
      expect(result.status).toBe("FAILED");
      expect(result.reasonCode).toBe("MISSING_EVIDENCE");
    });

    it("cannot be forced by caller to return VERIFIED (status is derived)", () => {
      const evidence = createOutputPayloadEvidence("run-fake", { a: 1 });
      // Caller attempts to sneak a "verified: true" property inside spec
      const hostileSpec = {
        specId: "spec-hostile",
        ruleKind: "EXACT_OUTPUT_MATCH" as const,
        expectedValue: { a: 2 },
        status: "VERIFIED",
        verified: true,
      };

      const result = DeterministicVerifier.verify([evidence], hostileSpec);
      // Verifier strictly derives status; ignores attempted override
      expect(result.status).toBe("FAILED");
    });
  });
});
