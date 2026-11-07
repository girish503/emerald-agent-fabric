/**
 * Outcome derivation must come only from durable verification evidence; it must never turn a claim,
 * an in-memory status or a generic terminal event into VERIFIED_SUCCESS.
 */
import { describe, expect, it } from "vitest";
import { deriveAuthoritativeOutcome, type DurableEventView } from "../../src/transport/http/run-outcome.js";

const verified = (seq: number, specId = "s1", status: "VERIFIED" | "FAILED" = "VERIFIED"): DurableEventView => ({
  sequence: seq, eventType: "verification.completed", payload: { specId, status },
});
const rejected = (seq: number, status = "COMPLETION_REJECTED"): DurableEventView => ({ sequence: seq, eventType: "verification.rejected", payload: { status } });
const generic = (seq: number, eventType: string): DurableEventView => ({ sequence: seq, eventType, payload: {} });

describe("deriveAuthoritativeOutcome", () => {
  it("is unknown (null) without a durable event source, whatever the status", () => {
    for (const status of ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "RUNNING"]) {
      expect(deriveAuthoritativeOutcome(status, undefined)).toBeNull();
    }
  });

  it("COMPLETED with VERIFIED evidence for every spec and no later rejection is VERIFIED_SUCCESS", () => {
    expect(deriveAuthoritativeOutcome("COMPLETED", [generic(1, "run.created"), verified(2, "a"), verified(3, "b"), generic(4, "run.completed")])).toBe("VERIFIED_SUCCESS");
  });

  it("a generic run.completed event or status alone never yields VERIFIED_SUCCESS", () => {
    expect(deriveAuthoritativeOutcome("COMPLETED", [generic(1, "run.created"), generic(2, "run.completed")])).toBe("COMPLETION_UNVERIFIABLE");
    expect(deriveAuthoritativeOutcome("COMPLETED", [])).toBe("COMPLETION_UNVERIFIABLE");
  });

  it("any FAILED latest verification result blocks success; a later VERIFIED result for the same spec may supersede it", () => {
    expect(deriveAuthoritativeOutcome("COMPLETED", [verified(1, "a"), verified(2, "b", "FAILED")])).not.toBe("VERIFIED_SUCCESS");
    expect(deriveAuthoritativeOutcome("COMPLETED", [verified(1, "a", "FAILED"), verified(2, "a")])).toBe("VERIFIED_SUCCESS");
  });

  it("a completion rejection after the last verification blocks success", () => {
    expect(deriveAuthoritativeOutcome("COMPLETED", [verified(1), rejected(2)])).toBe("COMPLETION_UNVERIFIABLE");
  });

  it("an operator-authorized unverified completion is never a verified success", () => {
    const events = [verified(1), generic(2, "verification.unverified_completion_authorized")];
    expect(deriveAuthoritativeOutcome("COMPLETED", events)).toBe("COMPLETION_UNVERIFIABLE");
  });

  it("FAILED maps to COMPLETION_UNVERIFIABLE only on a durable unverifiable rejection, otherwise EXECUTION_FAILURE", () => {
    expect(deriveAuthoritativeOutcome("FAILED", [rejected(1, "COMPLETION_UNVERIFIABLE")])).toBe("COMPLETION_UNVERIFIABLE");
    expect(deriveAuthoritativeOutcome("FAILED", [generic(1, "run.failed")])).toBe("EXECUTION_FAILURE");
  });

  it("TIMED_OUT and CANCELLED map to TIMEOUT and BLOCKED; non-terminal states have no outcome", () => {
    expect(deriveAuthoritativeOutcome("TIMED_OUT", [])).toBe("TIMEOUT");
    expect(deriveAuthoritativeOutcome("CANCELLED", [])).toBe("BLOCKED");
    expect(deriveAuthoritativeOutcome("RUNNING", [verified(1)])).toBeNull();
    expect(deriveAuthoritativeOutcome("QUEUED", [])).toBeNull();
  });

  describe("Multi-spec and authoritative specification set enforcement", () => {
    it("returns COMPLETION_UNVERIFIABLE if only a subset of required specs has evidence", () => {
      const events = [verified(1, "spec-1"), generic(2, "run.completed")];
      const outcome = deriveAuthoritativeOutcome("COMPLETED", events, {
        requiredSpecIds: ["spec-1", "spec-2"],
      });
      expect(outcome).toBe("COMPLETION_UNVERIFIABLE");
    });

    it("returns VERIFIED_SUCCESS when all required specs have VERIFIED evidence", () => {
      const events = [verified(1, "spec-1"), verified(2, "spec-2"), generic(3, "run.completed")];
      const outcome = deriveAuthoritativeOutcome("COMPLETED", events, {
        requiredSpecIds: ["spec-1", "spec-2"],
      });
      expect(outcome).toBe("VERIFIED_SUCCESS");
    });

    it("fails closed when any required spec failed even if other required specs passed", () => {
      const events = [verified(1, "spec-1"), verified(2, "spec-2", "FAILED"), generic(3, "run.completed")];
      const outcome = deriveAuthoritativeOutcome("COMPLETED", events, {
        requiredSpecIds: ["spec-1", "spec-2"],
      });
      expect(outcome).toBe("COMPLETION_UNVERIFIABLE");
    });

    it("an empty required spec set cannot claim VERIFIED_SUCCESS", () => {
      expect(deriveAuthoritativeOutcome("COMPLETED", [verified(1, "spec-1")], { requiredSpecIds: [] })).toBe("COMPLETION_UNVERIFIABLE");
      expect(deriveAuthoritativeOutcome("COMPLETED", [verified(1, "spec-1")], { requiredSpecIds: [], allowUnverifiedCompletion: true })).toBe("COMPLETION_UNVERIFIABLE");
    });

    it("contractLoaded === false immediately returns COMPLETION_UNVERIFIABLE", () => {
      const events = [verified(1, "spec-1"), generic(2, "run.completed")];
      expect(deriveAuthoritativeOutcome("COMPLETED", events, { contractLoaded: false })).toBe("COMPLETION_UNVERIFIABLE");
    });

    it("allowUnverifiedCompletion option forces outcome to COMPLETION_UNVERIFIABLE", () => {
      const events = [verified(1, "spec-1"), generic(2, "run.completed")];
      expect(deriveAuthoritativeOutcome("COMPLETED", events, { requiredSpecIds: ["spec-1"], allowUnverifiedCompletion: true })).toBe("COMPLETION_UNVERIFIABLE");
    });

    it("superseded failed result for a required spec is satisfied by later VERIFIED result", () => {
      const events = [
        verified(1, "spec-1", "FAILED"),
        verified(2, "spec-1", "VERIFIED"),
        verified(3, "spec-2", "VERIFIED"),
        generic(4, "run.completed"),
      ];
      expect(deriveAuthoritativeOutcome("COMPLETED", events, { requiredSpecIds: ["spec-1", "spec-2"] })).toBe("VERIFIED_SUCCESS");
    });
  });
});
