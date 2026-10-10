import { describe, expect, it } from "vitest";
import {
  activateMissionContract,
  revokeMissionContract,
  createDefaultInProcessPolicy,
  createDefaultDockerPolicy,
  createExecutionPolicy,
  createMissionContract,
  createMissionContractSpec,
  createResourceLimits,
  createVerificationSpec,
  InvalidMissionContractError,
  reconstituteMissionContract,
  ResourceLimits,
} from "../../src/domain/index.js";

describe("MissionContract Domain Aggregate (Task 1.8A)", () => {
  const validLimits: ResourceLimits = {
    timeoutMs: 30000,
    maxAttempts: 3,
    maxOutputBytes: 1024 * 1024,
  };

  const defaultPolicy = createDefaultInProcessPolicy("policy-test-1");

  const defaultVerificationSpec = createVerificationSpec({
    specId: "vspec-test-1",
    ruleKind: "EXACT_OUTPUT_MATCH",
    expectedValue: { result: "ok" },
  });

  describe("ResourceLimits Construction & Validation", () => {
    it("creates valid ResourceLimits", () => {
      const limits = createResourceLimits({
        timeoutMs: 15000,
        maxAttempts: 5,
        maxOutputBytes: 65536,
      });

      expect(limits.timeoutMs).toBe(15000);
      expect(limits.maxAttempts).toBe(5);
      expect(limits.maxOutputBytes).toBe(65536);
      expect(Object.isFrozen(limits)).toBe(true);
    });

    it("rejects non-positive or non-integer timeoutMs", () => {
      expect(() =>
        createResourceLimits({ timeoutMs: 0, maxAttempts: 1, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: -500, maxAttempts: 1, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: 12.5, maxAttempts: 1, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: NaN, maxAttempts: 1, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);
    });

    it("rejects non-positive or non-integer maxAttempts", () => {
      expect(() =>
        createResourceLimits({ timeoutMs: 1000, maxAttempts: 0, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: 1000, maxAttempts: -2, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: 1000, maxAttempts: 1.5, maxOutputBytes: 100 })
      ).toThrow(InvalidMissionContractError);
    });

    it("rejects non-positive or non-integer maxOutputBytes", () => {
      expect(() =>
        createResourceLimits({ timeoutMs: 1000, maxAttempts: 1, maxOutputBytes: 0 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: 1000, maxAttempts: 1, maxOutputBytes: -100 })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createResourceLimits({ timeoutMs: 1000, maxAttempts: 1, maxOutputBytes: 100.2 })
      ).toThrow(InvalidMissionContractError);
    });
  });

  describe("MissionContractSpec Construction & Validation", () => {
    it("creates valid MissionContractSpec with deep freezing", () => {
      const spec = createMissionContractSpec({
        contractId: "contract-1",
        version: 1,
        taskId: "task-alpha",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:read", "artifact:read"],
      });

      expect(spec.contractId).toBe("contract-1");
      expect(spec.version).toBe(1);
      expect(spec.taskId).toBe("task-alpha");
      expect(spec.verificationSpecs).toHaveLength(1);
      expect(spec.credentialScopes).toEqual(["artifact:read", "github:repo:read"]);
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.verificationSpecs)).toBe(true);
      expect(Object.isFrozen(spec.credentialScopes)).toBe(true);
    });

    it("rejects empty or invalid contractId", () => {
      expect(() =>
        createMissionContractSpec({
          contractId: "",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
        })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createMissionContractSpec({
          contractId: "   ",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
        })
      ).toThrow(InvalidMissionContractError);
    });

    it("rejects empty or invalid taskId", () => {
      expect(() =>
        createMissionContractSpec({
          contractId: "contract-1",
          version: 1,
          taskId: "",
          policy: defaultPolicy,
          resourceLimits: validLimits,
        })
      ).toThrow(InvalidMissionContractError);
    });

    it("rejects version < 1", () => {
      expect(() =>
        createMissionContractSpec({
          contractId: "contract-1",
          version: 0,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
        })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createMissionContractSpec({
          contractId: "contract-1",
          version: -1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
        })
      ).toThrow(InvalidMissionContractError);
    });

    it("permits empty verificationSpecs array for unverified operations", () => {
      const spec = createMissionContractSpec({
        contractId: "contract-unverified",
        version: 1,
        taskId: "task-1",
        policy: defaultPolicy,
        verificationSpecs: [],
        resourceLimits: validLimits,
      });

      expect(spec.verificationSpecs).toEqual([]);
      expect(Object.isFrozen(spec.verificationSpecs)).toBe(true);
    });

    it("normalizes, deduplicates, and deterministically sorts credential scopes (Condition 2)", () => {
      const spec1 = createMissionContractSpec({
        contractId: "contract-scopes-1",
        version: 1,
        taskId: "task-1",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:read", "github:repo:write"],
      });

      const spec2 = createMissionContractSpec({
        contractId: "contract-scopes-1",
        version: 1,
        taskId: "task-1",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:write", "github:repo:read"],
      });

      const spec3 = createMissionContractSpec({
        contractId: "contract-scopes-1",
        version: 1,
        taskId: "task-1",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:read", "github:repo:write", "github:repo:read"],
      });

      expect(spec1.credentialScopes).toEqual(["github:repo:read", "github:repo:write"]);
      expect(spec2.credentialScopes).toEqual(["github:repo:read", "github:repo:write"]);
      expect(spec3.credentialScopes).toEqual(["github:repo:read", "github:repo:write"]);
    });

    it("rejects invalid credential scope strings or raw tokens (Condition 1)", () => {
      expect(() =>
        createMissionContractSpec({
          contractId: "contract-bad-scope",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
          credentialScopes: ["valid:scope", ""],
        })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createMissionContractSpec({
          contractId: "contract-bearer-token",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
          credentialScopes: ["Bearer eyJhbGciOi..."],
        })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createMissionContractSpec({
          contractId: "contract-ghp-token",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
          credentialScopes: ["ghp_1234567890abcdef1234567890abcdef"],
        })
      ).toThrow(InvalidMissionContractError);
    });

    it("rejects raw secret-bearing fields in verificationSpecs.expectedValue (Condition 1)", () => {
      expect(() =>
        createMissionContractSpec({
          contractId: "contract-secret-1",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
          verificationSpecs: [
            {
              specId: "v-secret-1",
              ruleKind: "EXACT_OUTPUT_MATCH",
              expectedValue: { token: "super-secret-token" },
            },
          ],
        })
      ).toThrow(InvalidMissionContractError);

      expect(() =>
        createMissionContractSpec({
          contractId: "contract-secret-2",
          version: 1,
          taskId: "task-1",
          policy: defaultPolicy,
          resourceLimits: validLimits,
          verificationSpecs: [
            {
              specId: "v-secret-2",
              ruleKind: "EXACT_OUTPUT_MATCH",
              expectedValue: { nested: { apiKey: "secret-key-123" } },
            },
          ],
        })
      ).toThrow(InvalidMissionContractError);
    });
  });

  describe("MissionContract Construction & Hashing Invariants", () => {
    it("creates a valid MissionContract with DRAFT status by default", () => {
      const contract = createMissionContract({
        contractId: "contract-abc",
        version: 1,
        taskId: "task-100",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
      });

      expect(contract.spec.contractId).toBe("contract-abc");
      expect(contract.lifecycle.status).toBe("DRAFT");
      expect(contract.lifecycle.activatedAt).toBeNull();
      expect(contract.lifecycle.revokedAt).toBeNull();
      expect(contract.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("generates deterministic contentHash for identical specifications", () => {
      const contract1 = createMissionContract({
        contractId: "contract-det",
        version: 1,
        taskId: "task-det",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
      });

      const contract2 = createMissionContract({
        contractId: "contract-det",
        version: 1,
        taskId: "task-det",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
      });

      expect(contract1.contentHash).toBe(contract2.contentHash);
    });

    it("guarantees contentHash is invariant across lifecycle status (DRAFT vs ACTIVE vs REVOKED)", () => {
      const now = new Date().toISOString();

      const draftContract = createMissionContract({
        contractId: "contract-lifecycle-hash",
        version: 1,
        taskId: "task-life",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        status: "DRAFT",
        createdAt: now,
      });

      const activeContract = createMissionContract({
        contractId: "contract-lifecycle-hash",
        version: 1,
        taskId: "task-life",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        status: "ACTIVE",
        createdAt: now,
        activatedAt: now,
      });

      const revokedContract = createMissionContract({
        contractId: "contract-lifecycle-hash",
        version: 1,
        taskId: "task-life",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        status: "REVOKED",
        createdAt: now,
        activatedAt: now,
        revokedAt: now,
        revocationReason: "Testing security deprecation",
      });

      // CORE INVARIANT: All three contracts have identical specs, so contentHash MUST be identical
      expect(draftContract.contentHash).toBe(activeContract.contentHash);
      expect(activeContract.contentHash).toBe(revokedContract.contentHash);
    });

    it("guarantees lifecycle timestamps and revocation reason do not alter contentHash", () => {
      const c1 = createMissionContract({
        contractId: "contract-ts",
        version: 1,
        taskId: "task-ts",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        status: "DRAFT",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const c2 = createMissionContract({
        contractId: "contract-ts",
        version: 1,
        taskId: "task-ts",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        status: "ACTIVE",
        createdAt: "2026-06-01T00:00:00.000Z",
        activatedAt: "2026-06-01T00:00:05.000Z",
      });

      const c3 = createMissionContract({
        contractId: "contract-ts",
        version: 1,
        taskId: "task-ts",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        status: "REVOKED",
        createdAt: "2026-10-01T00:00:00.000Z",
        activatedAt: "2026-10-01T00:00:05.000Z",
        revokedAt: "2026-10-02T12:00:00.000Z",
        revocationReason: "Key rotation emergency",
      });

      expect(c1.contentHash).toBe(c2.contentHash);
      expect(c2.contentHash).toBe(c3.contentHash);
    });

    it("changes contentHash when policy changes", () => {
      const baseContract = createMissionContract({
        contractId: "contract-change",
        version: 1,
        taskId: "task-c",
        policy: createDefaultInProcessPolicy("policy-1"),
        resourceLimits: validLimits,
      });

      const differentPolicyContract = createMissionContract({
        contractId: "contract-change",
        version: 1,
        taskId: "task-c",
        policy: createDefaultDockerPolicy("policy-2"),
        resourceLimits: validLimits,
      });

      expect(baseContract.contentHash).not.toBe(differentPolicyContract.contentHash);
    });

    it("changes contentHash when verificationSpecs change", () => {
      const c1 = createMissionContract({
        contractId: "contract-change",
        version: 1,
        taskId: "task-c",
        policy: defaultPolicy,
        verificationSpecs: [],
        resourceLimits: validLimits,
      });

      const c2 = createMissionContract({
        contractId: "contract-change",
        version: 1,
        taskId: "task-c",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
      });

      expect(c1.contentHash).not.toBe(c2.contentHash);
    });

    it("changes contentHash when resourceLimits change", () => {
      const c1 = createMissionContract({
        contractId: "contract-change",
        version: 1,
        taskId: "task-c",
        policy: defaultPolicy,
        resourceLimits: validLimits,
      });

      const c2 = createMissionContract({
        contractId: "contract-change",
        version: 1,
        taskId: "task-c",
        policy: defaultPolicy,
        resourceLimits: {
          ...validLimits,
          timeoutMs: 60000,
        },
      });

      expect(c1.contentHash).not.toBe(c2.contentHash);
    });

    it("changes contentHash when version or contractId changes", () => {
      const c1 = createMissionContract({
        contractId: "contract-v1",
        version: 1,
        taskId: "task-c",
        policy: defaultPolicy,
        resourceLimits: validLimits,
      });

      const c2 = createMissionContract({
        contractId: "contract-v1",
        version: 2,
        taskId: "task-c",
        policy: defaultPolicy,
        resourceLimits: validLimits,
      });

      const c3 = createMissionContract({
        contractId: "contract-v2",
        version: 1,
        taskId: "task-c",
        policy: defaultPolicy,
        resourceLimits: validLimits,
      });

      expect(c1.contentHash).not.toBe(c2.contentHash);
      expect(c1.contentHash).not.toBe(c3.contentHash);
    });

    it("produces identical contentHash for permuted and duplicate credentialScopes inputs (Condition 2)", () => {
      const contract1 = createMissionContract({
        contractId: "contract-perm",
        version: 1,
        taskId: "task-perm",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:read", "github:repo:write"],
      });

      const contract2 = createMissionContract({
        contractId: "contract-perm",
        version: 1,
        taskId: "task-perm",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:write", "github:repo:read"],
      });

      const contract3 = createMissionContract({
        contractId: "contract-perm",
        version: 1,
        taskId: "task-perm",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:read", "github:repo:write", "github:repo:read"],
      });

      expect(contract1.contentHash).toBe(contract2.contentHash);
      expect(contract2.contentHash).toBe(contract3.contentHash);
      expect(contract1.spec.credentialScopes).toEqual(["github:repo:read", "github:repo:write"]);
    });

    it("produces distinct contentHash for materially different credentialScopes (Condition 1)", () => {
      const contractA = createMissionContract({
        contractId: "contract-scopes-diff",
        version: 1,
        taskId: "task-diff",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:read"],
      });

      const contractB = createMissionContract({
        contractId: "contract-scopes-diff",
        version: 1,
        taskId: "task-diff",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        credentialScopes: ["github:repo:write"],
      });

      // Proof of Condition 1: distinct scopes produce distinct content hashes (no hash collision)
      expect(contractA.contentHash).not.toBe(contractB.contentHash);
    });
  });

  describe("Deep Immutability", () => {
    it("deeply freezes the MissionContract and all nested structures", () => {
      const contract = createMissionContract({
        contractId: "contract-freeze",
        version: 1,
        taskId: "task-freeze",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        credentialScopes: ["scope:read"],
      });

      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.spec)).toBe(true);
      expect(Object.isFrozen(contract.spec.policy)).toBe(true);
      expect(Object.isFrozen(contract.spec.policy.allowedCapabilities)).toBe(true);
      expect(Object.isFrozen(contract.spec.verificationSpecs)).toBe(true);
      expect(Object.isFrozen(contract.spec.resourceLimits)).toBe(true);
      expect(Object.isFrozen(contract.spec.credentialScopes)).toBe(true);
      expect(Object.isFrozen(contract.lifecycle)).toBe(true);

      // Attempted mutation throws in strict mode
      expect(() => {
        (contract as { contentHash: string }).contentHash = "tampered";
      }).toThrow();

      expect(() => {
        (contract.lifecycle as { status: string }).status = "ACTIVE";
      }).toThrow();

      expect(() => {
        (contract.spec.resourceLimits as { timeoutMs: number }).timeoutMs = 99999;
      }).toThrow();

      expect(() => {
        (contract.spec.policy.allowedCapabilities as string[]).push("execution.dangerous");
      }).toThrow();
    });
  });

  describe("Pure Lifecycle Transitions", () => {
    it("activates DRAFT contract and preserves identical spec and contentHash", () => {
      const draft = createMissionContract({
        contractId: "contract-act",
        version: 1,
        taskId: "task-act",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        status: "DRAFT",
      });

      const active = activateMissionContract(draft, "2026-10-10T12:00:00.000Z");

      expect(active.lifecycle.status).toBe("ACTIVE");
      expect(active.lifecycle.activatedAt).toBe("2026-10-10T12:00:00.000Z");
      expect(active.lifecycle.createdAt).toBe(draft.lifecycle.createdAt);
      expect(active.contentHash).toBe(draft.contentHash);
      expect(active.spec).toBe(draft.spec); // exact reference preserved
      expect(Object.isFrozen(active)).toBe(true);
    });

    it("revokes ACTIVE contract and preserves identical spec and contentHash", () => {
      const draft = createMissionContract({
        contractId: "contract-rev",
        version: 1,
        taskId: "task-rev",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        status: "DRAFT",
      });

      const active = activateMissionContract(draft, "2026-10-10T12:00:00.000Z");
      const revoked = revokeMissionContract(active, "Operator revocation test", "2026-10-10T13:00:00.000Z");

      expect(revoked.lifecycle.status).toBe("REVOKED");
      expect(revoked.lifecycle.revokedAt).toBe("2026-10-10T13:00:00.000Z");
      expect(revoked.lifecycle.revocationReason).toBe("Operator revocation test");
      expect(revoked.lifecycle.activatedAt).toBe("2026-10-10T12:00:00.000Z");
      expect(revoked.contentHash).toBe(draft.contentHash);
      expect(revoked.spec).toBe(draft.spec);
      expect(Object.isFrozen(revoked)).toBe(true);
    });

    it("rejects activating a non-DRAFT contract", () => {
      const draft = createMissionContract({
        taskId: "t-1",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        status: "DRAFT",
      });
      const active = activateMissionContract(draft);

      expect(() => activateMissionContract(active)).toThrow(InvalidMissionContractError);

      const revoked = revokeMissionContract(active);
      expect(() => activateMissionContract(revoked)).toThrow(InvalidMissionContractError);
    });

    it("rejects revoking a non-ACTIVE contract", () => {
      const draft = createMissionContract({
        taskId: "t-1",
        policy: defaultPolicy,
        resourceLimits: validLimits,
        status: "DRAFT",
      });

      // Cannot revoke DRAFT
      expect(() => revokeMissionContract(draft)).toThrow(InvalidMissionContractError);

      const active = activateMissionContract(draft);
      const revoked = revokeMissionContract(active);

      // Cannot revoke already REVOKED
      expect(() => revokeMissionContract(revoked)).toThrow(InvalidMissionContractError);
    });
  });

  describe("Reconstitution & Fail-Closed Integrity Verification", () => {
    it("reconstitutes contract when contentHash matches specification", () => {
      const original = createMissionContract({
        contractId: "contract-recon",
        version: 1,
        taskId: "task-recon",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
        status: "DRAFT",
      });

      const reconstituted = reconstituteMissionContract(
        original.spec,
        original.contentHash,
        original.lifecycle
      );

      expect(reconstituted.spec.contractId).toBe("contract-recon");
      expect(reconstituted.contentHash).toBe(original.contentHash);
      expect(reconstituted.lifecycle.status).toBe("DRAFT");
      expect(Object.isFrozen(reconstituted)).toBe(true);
    });

    it("fails closed when specification has been tampered with or expected hash diverges", () => {
      const original = createMissionContract({
        contractId: "contract-recon-tamper",
        version: 1,
        taskId: "task-recon",
        policy: defaultPolicy,
        verificationSpecs: [defaultVerificationSpec],
        resourceLimits: validLimits,
      });

      // Tampered spec (expanded capabilities)
      const tamperedSpec = {
        ...original.spec,
        policy: createExecutionPolicy({
          policyId: "tampered-policy",
          allowedCapabilities: ["execution.echo", "execution.dangerous_escalated"],
          isolationRequirement: "IN_PROCESS",
        }),
      };

      expect(() =>
        reconstituteMissionContract(tamperedSpec, original.contentHash, original.lifecycle)
      ).toThrow(InvalidMissionContractError);
    });
  });
});
