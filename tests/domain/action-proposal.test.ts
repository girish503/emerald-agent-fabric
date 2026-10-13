import { describe, expect, it } from "vitest";
import {
  ActionProposal,
  ActionProposalSchema,
  findForbiddenAuthorityKeys,
  FORBIDDEN_AUTHORITY_KEYS,
  MAX_PROPOSAL_BYTES,
  MAX_RATIONALE_LENGTH,
} from "../../src/domain/action-proposal.js";

describe("ActionProposal Domain Model & Schema", () => {
  const validHex64 = "a".repeat(64);

  const baseProposal: ActionProposal = {
    proposalId: "prop-12345",
    toolName: "read_file",
    inputPayload: { path: "src/index.ts" },
    contextSnapshotHash: validHex64,
  };

  it("validates a minimal compliant proposal", () => {
    const result = ActionProposalSchema.safeParse(baseProposal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposalId).toBe("prop-12345");
      expect(result.data.toolName).toBe("read_file");
      expect(result.data.contextSnapshotHash).toBe(validHex64);
      expect(result.data.rationale).toBeUndefined();
      expect(result.data.sequenceHint).toBeUndefined();
    }
  });

  it("validates a proposal with valid rationale and sequenceHint", () => {
    const fullProposal: ActionProposal = {
      ...baseProposal,
      rationale: "Inspecting entrypoint to determine exports.",
      sequenceHint: 1,
    };
    const result = ActionProposalSchema.safeParse(fullProposal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rationale).toBe("Inspecting entrypoint to determine exports.");
      expect(result.data.sequenceHint).toBe(1);
    }
  });

  it("rejects missing proposalId", () => {
    const invalid = { ...baseProposal, proposalId: undefined };
    const result = ActionProposalSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects empty proposalId", () => {
    const invalid = { ...baseProposal, proposalId: "" };
    const result = ActionProposalSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects proposalId exceeding 256 characters", () => {
    const invalid = { ...baseProposal, proposalId: "x".repeat(257) };
    const result = ActionProposalSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects unauthorized tool name", () => {
    const invalid = { ...baseProposal, toolName: "format_disk" };
    const result = ActionProposalSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects non-object inputPayload", () => {
    const invalid = { ...baseProposal, inputPayload: "not-an-object" };
    const result = ActionProposalSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects contextSnapshotHash that is not a 64-character hex string", () => {
    expect(ActionProposalSchema.safeParse({ ...baseProposal, contextSnapshotHash: "abc" }).success).toBe(false);
    expect(ActionProposalSchema.safeParse({ ...baseProposal, contextSnapshotHash: "z".repeat(64) }).success).toBe(false);
    expect(ActionProposalSchema.safeParse({ ...baseProposal, contextSnapshotHash: "a".repeat(63) }).success).toBe(false);
    expect(ActionProposalSchema.safeParse({ ...baseProposal, contextSnapshotHash: "a".repeat(65) }).success).toBe(false);
  });

  it("rejects rationale exceeding MAX_RATIONALE_LENGTH", () => {
    const invalid = { ...baseProposal, rationale: "x".repeat(MAX_RATIONALE_LENGTH + 1) };
    const result = ActionProposalSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("accepts rationale exactly equal to MAX_RATIONALE_LENGTH", () => {
    const valid = { ...baseProposal, rationale: "x".repeat(MAX_RATIONALE_LENGTH) };
    const result = ActionProposalSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects non-positive or non-integer sequenceHint", () => {
    expect(ActionProposalSchema.safeParse({ ...baseProposal, sequenceHint: 0 }).success).toBe(false);
    expect(ActionProposalSchema.safeParse({ ...baseProposal, sequenceHint: -1 }).success).toBe(false);
    expect(ActionProposalSchema.safeParse({ ...baseProposal, sequenceHint: 1.5 }).success).toBe(false);
  });

  it("rejects unexpected fields at top level via strict schema", () => {
    const withExtra = {
      ...baseProposal,
      extraField: "should-fail",
    };
    const result = ActionProposalSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  describe("findForbiddenAuthorityKeys", () => {
    it("returns empty array for clean proposal", () => {
      const violations = findForbiddenAuthorityKeys(baseProposal);
      expect(violations).toEqual([]);
    });

    it("identifies all forbidden authority keys when injected", () => {
      for (const key of FORBIDDEN_AUTHORITY_KEYS) {
        const payload = { ...baseProposal, [key]: "malicious-value" };
        const violations = findForbiddenAuthorityKeys(payload);
        expect(violations).toContain(key);
      }
    });

    it("identifies multiple forbidden keys simultaneously", () => {
      const payload = {
        ...baseProposal,
        workerId: "rogue-worker",
        leaseId: "fake-lease",
        contractId: "bypass-contract",
        status: "SUCCEEDED",
      };
      const violations = findForbiddenAuthorityKeys(payload);
      expect(violations).toContain("workerId");
      expect(violations).toContain("leaseId");
      expect(violations).toContain("contractId");
      expect(violations).toContain("status");
    });
  });

  describe("Constants & Ceilings", () => {
    it("enforces MAX_PROPOSAL_BYTES of 64KB (65536 bytes)", () => {
      expect(MAX_PROPOSAL_BYTES).toBe(65536);
    });

    it("enforces MAX_RATIONALE_LENGTH of 4096 characters", () => {
      expect(MAX_RATIONALE_LENGTH).toBe(4096);
    });
  });
});
