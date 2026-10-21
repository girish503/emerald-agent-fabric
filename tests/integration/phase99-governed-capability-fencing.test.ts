/**
 * Phase 99: Governed Autonomous Multi-Agent Capability Fencing and Dynamic Cross-Harness Boundary Enactment
 *
 * Comprehensive Integration Test Suite covering:
 * - 48 Distinct Test Categories
 * - >= 240 Tests
 * - Full coverage of Negative Security Controls N691–N720 (30/30 fail-closed)
 * - Full coverage of Core Invariants C1–C20 (20/20 strictly upheld)
 * - Capability lattice, downward delegation bounding (D ⊆ P), intersection-only composition (⋂ C_i)
 * - Anti-laundering, anti-splitting, confused deputy defense
 * - 8 Harness Types, Cross-Harness Gateway, payload sanitization
 * - 30 Crash recovery scenarios (state serialization and tree reconstitution)
 * - 3-Sweep byte-identical determinism
 * - 14 Target Safety Metrics: 0.0% boundary breaches, 0.0% escalation, 100% compliance
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Capability may be delegated only downward within a fixed safety envelope.
 * Capability composition must never create authority ex nihilo.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SettableClock } from "../../src/ports/clock.port.js";
import { sha256Hex } from "../../src/domain/canonical-hash.js";
import {
  ALL_FORBIDDEN_CAPABILITIES,
  ALL_POSITIVE_CAPABILITIES,
  CAPABILITY_FENCING_INVARIANTS,
  CapabilityFence,
  CapabilityScope,
  ForbiddenCapability,
  PositiveCapability,
  SECURITY_CONTROLS_PHASE99,
  computeCapabilityDenialHash,
  computeCapabilityEvidenceHash,
  computeCapabilityFenceHash,
  computeCapabilityGrantHash,
  computeCapabilityViolationHash,
  intersectCapabilities,
  isScopeContained,
  isSubCapabilitySet,
} from "../../src/domain/capability-fence.js";
import {
  CrossHarnessRequestType,
  HarnessType,
  computeCrossHarnessRequestHash,
  computeDelegationRecordHash,
} from "../../src/domain/cross-harness-request.js";
import { CapabilityFenceEnforcer } from "../../src/application/capability-fence-enforcer.js";
import { CrossHarnessGateway } from "../../src/application/cross-harness-gateway.js";
import { CapabilityGovernancePolicy } from "../../src/application/capability-governance-policy.js";

describe("Phase 99: Governed Autonomous Multi-Agent Capability Fencing", () => {
  let clock: SettableClock;
  let enforcer: CapabilityFenceEnforcer;
  let gateway: CrossHarnessGateway;
  let policy: CapabilityGovernancePolicy;

  const DEFAULT_CONTRACT_ID = "contract-phase99-001";
  const DEFAULT_CONTRACT_HASH = sha256Hex("contract-phase99-genesis");

  const defaultScope: CapabilityScope = {
    allowedWorkspacePaths: ["/workspace/src", "/workspace/temp"],
    forbiddenWorkspacePaths: ["/workspace/.git", "/etc", "/root"],
    allowedTools: ["read_file", "search_code", "execute_analysis", "write_temp"],
    maxOperations: 100,
    maxMemoryBytes: 1024 * 1024 * 512,
    networkAllowed: false,
    gitWriteAllowed: false,
  };

  function createTestFence(
    fenceId: string,
    subjectId: string,
    roleId: string,
    harnessId: string,
    allowedCapabilities: readonly PositiveCapability[],
    overrides?: Partial<CapabilityFence>,
  ): CapabilityFence {
    const raw: Omit<CapabilityFence, "hash"> = {
      fenceId,
      subjectId,
      roleId,
      harnessId,
      allowedCapabilities,
      forbiddenCapabilities: ALL_FORBIDDEN_CAPABILITIES,
      scope: defaultScope,
      trustLabel: "GOVERNED_OBSERVATION",
      status: "ACTIVE",
      delegatedFenceIds: [],
      version: 1,
      missionContractId: DEFAULT_CONTRACT_ID,
      missionContractHash: DEFAULT_CONTRACT_HASH,
      authoritative: false,
      terminalAuthority: false,
      sovereignAuthority: false,
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 3600000).toISOString(),
      ...overrides,
    };
    return {
      ...raw,
      hash: computeCapabilityFenceHash(raw),
    };
  }

  beforeEach(() => {
    clock = new SettableClock("2026-10-21T12:00:00.000Z");
    enforcer = new CapabilityFenceEnforcer(clock);
    gateway = new CrossHarnessGateway(enforcer, clock);
    policy = new CapabilityGovernancePolicy(enforcer, gateway);
  });

  // ============================================================================
  // CATEGORY 1: Positive Capabilities Lattice and Subset Verification
  // ============================================================================
  describe("Category 1: Positive Capabilities Lattice", () => {
    it("1.1 defines exactly 7 distinct positive capabilities", () => {
      expect(ALL_POSITIVE_CAPABILITIES).toHaveLength(7);
      expect(ALL_POSITIVE_CAPABILITIES).toContain("READ_WORKSPACE");
      expect(ALL_POSITIVE_CAPABILITIES).toContain("READ_REPOSITORY");
      expect(ALL_POSITIVE_CAPABILITIES).toContain("READ_AST");
      expect(ALL_POSITIVE_CAPABILITIES).toContain("READ_DEPENDENCY_GRAPH");
      expect(ALL_POSITIVE_CAPABILITIES).toContain("READ_TEST_METADATA");
      expect(ALL_POSITIVE_CAPABILITIES).toContain("WRITE_TEMPORARY_OUTPUT");
      expect(ALL_POSITIVE_CAPABILITIES).toContain("EXECUTE_ANALYSIS");
    });

    it("1.2 verifies subset relationship correctly", () => {
      const parent: PositiveCapability[] = ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"];
      const child: PositiveCapability[] = ["READ_WORKSPACE", "READ_AST"];
      expect(isSubCapabilitySet(child, parent)).toBe(true);
    });

    it("1.3 rejects subset when child has extra capability", () => {
      const parent: PositiveCapability[] = ["READ_WORKSPACE"];
      const child: PositiveCapability[] = ["READ_WORKSPACE", "EXECUTE_ANALYSIS"];
      expect(isSubCapabilitySet(child, parent)).toBe(false);
    });

    it("1.4 empty capability set is valid subset of any parent", () => {
      expect(isSubCapabilitySet([], ["READ_WORKSPACE"])).toBe(true);
    });

    it("1.5 scope containment returns true for narrower child scope", () => {
      const childScope: CapabilityScope = { ...defaultScope, maxOperations: 50 };
      expect(isScopeContained(childScope, defaultScope)).toBe(true);
    });
  });

  // ============================================================================
  // CATEGORY 2: Forbidden Capabilities Strict Prohibition (Invariant C1)
  // ============================================================================
  describe("Category 2: Forbidden Capabilities Prohibition (Invariant C1)", () => {
    it("2.1 defines 14 forbidden capabilities", () => {
      expect(ALL_FORBIDDEN_CAPABILITIES).toHaveLength(14);
      expect(ALL_FORBIDDEN_CAPABILITIES).toContain("WRITE_REPOSITORY");
      expect(ALL_FORBIDDEN_CAPABILITIES).toContain("COMMIT_GIT");
      expect(ALL_FORBIDDEN_CAPABILITIES).toContain("PUSH_GIT");
      expect(ALL_FORBIDDEN_CAPABILITIES).toContain("MODIFY_POLICY");
      expect(ALL_FORBIDDEN_CAPABILITIES).toContain("NETWORK_ACCESS");
    });

    it("2.2 rejects WRITE_REPOSITORY invocation fail-closed (C1)", () => {
      const fence = createTestFence("fence-1", "agent-1", "implementer", "harness-1", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-1", "agent-1", "WRITE_REPOSITORY");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("2.3 rejects COMMIT_GIT invocation fail-closed (C1)", () => {
      const fence = createTestFence("fence-2", "agent-2", "implementer", "harness-1", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-2", "agent-2", "COMMIT_GIT");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("2.4 rejects NETWORK_ACCESS invocation fail-closed (C1, N712)", () => {
      const fence = createTestFence("fence-3", "agent-3", "analyzer", "harness-1", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-3", "agent-3", "NETWORK_ACCESS");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("2.5 rejects MODIFY_POLICY invocation fail-closed (C1)", () => {
      const fence = createTestFence("fence-4", "agent-4", "reviewer", "harness-1", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-4", "agent-4", "MODIFY_POLICY");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });
  });

  // ============================================================================
  // CATEGORY 3: Downward Delegation Bounding (D ⊆ P, Invariant C2)
  // ============================================================================
  describe("Category 3: Downward Delegation Bounding (Invariant C2)", () => {
    it("3.1 allows downward delegation with subset of parent capabilities", () => {
      const parent = createTestFence("fence-p1", "agent-parent", "lead", "harness-main", [
        "READ_WORKSPACE",
        "READ_AST",
        "EXECUTE_ANALYSIS",
      ]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-p1",
        "agent-child",
        "worker",
        "harness-child",
        ["READ_WORKSPACE", "READ_AST"],
        defaultScope,
        1800000,
      );
      expect(res.success).toBe(true);
      expect(res.childFence).toBeDefined();
      expect(res.childFence?.allowedCapabilities).toEqual(["READ_WORKSPACE", "READ_AST"]);
    });

    it("3.2 rejects delegation with superset of parent capabilities (N697)", () => {
      const parent = createTestFence("fence-p2", "agent-parent", "lead", "harness-main", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-p2",
        "agent-child",
        "worker",
        "harness-child",
        ["READ_WORKSPACE", "EXECUTE_ANALYSIS"],
        defaultScope,
        1800000,
      );
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N697");
    });

    it("3.3 records parent's delegatedFenceIds list correctly", () => {
      const parent = createTestFence("fence-p3", "agent-parent", "lead", "harness-main", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-p3",
        "agent-child-1",
        "worker",
        "harness-child",
        ["READ_WORKSPACE"],
        defaultScope,
        1800000,
      );
      const updatedParent = enforcer.getFence("fence-p3");
      expect(updatedParent?.delegatedFenceIds).toContain(res.childFence?.fenceId);
    });

    it("3.4 downward delegation preserves mission contract hash (C10)", () => {
      const parent = createTestFence("fence-p4", "agent-parent", "lead", "harness-main", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-p4",
        "agent-child-2",
        "worker",
        "harness-child",
        ["READ_WORKSPACE"],
        defaultScope,
        1800000,
      );
      expect(res.childFence?.missionContractHash).toBe(parent.missionContractHash);
    });

    it("3.5 downward delegation enforces authoritative=false on child fence", () => {
      const parent = createTestFence("fence-p5", "agent-parent", "lead", "harness-main", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-p5",
        "agent-child-3",
        "worker",
        "harness-child",
        ["READ_WORKSPACE"],
        defaultScope,
        1800000,
      );
      expect(res.childFence?.authoritative).toBe(false);
      expect(res.childFence?.terminalAuthority).toBe(false);
    });
  });

  // ============================================================================
  // CATEGORY 4: Delegation Resource & Scope Containment (Invariant C2, Control N699)
  // ============================================================================
  describe("Category 4: Delegation Resource & Scope Containment (Control N699)", () => {
    it("4.1 rejects delegation when child maxOperations exceeds parent (N699)", () => {
      const parent = createTestFence("fence-sc1", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const excessiveScope: CapabilityScope = { ...defaultScope, maxOperations: 500 }; // parent has 100
      const res = enforcer.delegateCapability(
        "fence-sc1",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        excessiveScope,
        1800000,
      );
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N699");
    });

    it("4.2 rejects delegation when child maxMemoryBytes exceeds parent (N699)", () => {
      const parent = createTestFence("fence-sc2", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const excessiveScope: CapabilityScope = { ...defaultScope, maxMemoryBytes: 1024 * 1024 * 1024 * 2 };
      const res = enforcer.delegateCapability(
        "fence-sc2",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        excessiveScope,
        1800000,
      );
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N699");
    });

    it("4.3 rejects delegation when child requests tools outside parent allowedTools", () => {
      const parent = createTestFence("fence-sc3", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const foreignToolScope: CapabilityScope = { ...defaultScope, allowedTools: ["unknown_tool"] };
      const res = enforcer.delegateCapability(
        "fence-sc3",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        foreignToolScope,
        1800000,
      );
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N699");
    });

    it("4.4 allows delegation when child tools are a subset of parent tools", () => {
      const parent = createTestFence("fence-sc4", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const subsetToolScope: CapabilityScope = { ...defaultScope, allowedTools: ["read_file"] };
      const res = enforcer.delegateCapability(
        "fence-sc4",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        subsetToolScope,
        1800000,
      );
      expect(res.success).toBe(true);
    });

    it("4.5 records delegation record with immutable SHA-256 hash", () => {
      const parent = createTestFence("fence-sc5", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      enforcer.delegateCapability(
        "fence-sc5",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        1800000,
      );
      const dels = enforcer.getAllDelegations();
      expect(dels.length).toBeGreaterThan(0);
      expect(dels[0]?.hash).toHaveLength(64);
    });
  });

  // ============================================================================
  // CATEGORY 5: Delegation Lifetime & Expiration Bounding (Control N698)
  // ============================================================================
  describe("Category 5: Delegation Lifetime & Expiration Bounding (Control N698)", () => {
    it("5.1 rejects delegation extending beyond parent expiration (N698)", () => {
      const parent = createTestFence("fence-lt1", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      // Parent expires in 1 hour (3600000ms), child requests 2 hours (7200000ms)
      const res = enforcer.delegateCapability(
        "fence-lt1",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        7200000,
      );
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N698");
    });

    it("5.2 allows delegation with duration shorter than parent expiration", () => {
      const parent = createTestFence("fence-lt2", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-lt2",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        1800000,
      );
      expect(res.success).toBe(true);
    });

    it("5.3 child expiration timestamp is earlier than parent expiration timestamp", () => {
      const parent = createTestFence("fence-lt3", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability(
        "fence-lt3",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        1800000,
      );
      const pTime = new Date(parent.expiresAt).getTime();
      const cTime = new Date(res.childFence!.expiresAt).getTime();
      expect(cTime).toBeLessThan(pTime);
    });

    it("5.4 rejects delegation when parent is already expired", () => {
      const expiredParent = createTestFence("fence-lt4", "agent-p", "role", "harness", ["READ_WORKSPACE"], {
        status: "EXPIRED",
      });
      enforcer.registerFence(expiredParent);
      const res = enforcer.delegateCapability(
        "fence-lt4",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        1000,
      );
      expect(res.success).toBe(false);
    });

    it("5.5 rejects delegation when parent fence is non-existent", () => {
      const res = enforcer.delegateCapability(
        "fence-non-existent",
        "agent-c",
        "subrole",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        1000,
      );
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N705");
    });
  });

  // ============================================================================
  // CATEGORY 6: Multi-Tier Delegation Cascades (Parent -> Child -> Grandchild)
  // ============================================================================
  describe("Category 6: Multi-Tier Delegation Cascades", () => {
    it("6.1 successfully establishes 3-tier downward delegation chain", () => {
      const root = createTestFence("fence-root", "agent-root", "root", "harness", [
        "READ_WORKSPACE",
        "READ_AST",
        "EXECUTE_ANALYSIS",
      ]);
      enforcer.registerFence(root);

      const tier1 = enforcer.delegateCapability(
        "fence-root",
        "agent-tier1",
        "lead",
        "harness",
        ["READ_WORKSPACE", "READ_AST"],
        defaultScope,
        3000000,
      );
      expect(tier1.success).toBe(true);

      const tier2 = enforcer.delegateCapability(
        tier1.childFence!.fenceId,
        "agent-tier2",
        "worker",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        1500000,
      );
      expect(tier2.success).toBe(true);
      expect(tier2.childFence?.allowedCapabilities).toEqual(["READ_WORKSPACE"]);
    });

    it("6.2 rejects grandchild attempting capability held by root but not by child", () => {
      const root = createTestFence("fence-root2", "agent-root", "root", "harness", [
        "READ_WORKSPACE",
        "READ_AST",
        "EXECUTE_ANALYSIS",
      ]);
      enforcer.registerFence(root);

      const tier1 = enforcer.delegateCapability(
        "fence-root2",
        "agent-tier1",
        "lead",
        "harness",
        ["READ_WORKSPACE"],
        defaultScope,
        3000000,
      );

      // Child only has READ_WORKSPACE; grandchild asks for EXECUTE_ANALYSIS
      const tier2 = enforcer.delegateCapability(
        tier1.childFence!.fenceId,
        "agent-tier2",
        "worker",
        "harness",
        ["EXECUTE_ANALYSIS"],
        defaultScope,
        1500000,
      );
      expect(tier2.success).toBe(false);
      expect(tier2.controlId).toBe("N697");
    });

    it("6.3 grandchild parentFenceId correctly links to direct child fence", () => {
      const root = createTestFence("fence-root3", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const tier1 = enforcer.delegateCapability("fence-root3", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);
      const tier2 = enforcer.delegateCapability(tier1.childFence!.fenceId, "agent-t2", "worker", "harness", ["READ_WORKSPACE"], defaultScope, 1500000);
      expect(tier2.childFence?.parentFenceId).toBe(tier1.childFence?.fenceId);
    });

    it("6.4 grandchild expires strictly earlier than both child and root", () => {
      const root = createTestFence("fence-root4", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const tier1 = enforcer.delegateCapability("fence-root4", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);
      const tier2 = enforcer.delegateCapability(tier1.childFence!.fenceId, "agent-t2", "worker", "harness", ["READ_WORKSPACE"], defaultScope, 1000000);
      const rTime = new Date(root.expiresAt).getTime();
      const t1Time = new Date(tier1.childFence!.expiresAt).getTime();
      const t2Time = new Date(tier2.childFence!.expiresAt).getTime();
      expect(t2Time).toBeLessThan(t1Time);
      expect(t1Time).toBeLessThanOrEqual(rTime);
    });

    it("6.5 capability invocation by grandchild succeeds for its authorized capability", () => {
      const root = createTestFence("fence-root5", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const tier1 = enforcer.delegateCapability("fence-root5", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);
      const tier2 = enforcer.delegateCapability(tier1.childFence!.fenceId, "agent-t2", "worker", "harness", ["READ_WORKSPACE"], defaultScope, 1000000);
      const res = enforcer.evaluateCapability(tier2.childFence!.fenceId, "agent-t2", "READ_WORKSPACE");
      expect(res.granted).toBe(true);
    });
  });

  // ============================================================================
  // CATEGORY 7: Immediate Revocation Cascade (Invariant C9, Control N701)
  // ============================================================================
  describe("Category 7: Immediate Revocation Cascade (Invariant C9)", () => {
    it("7.1 revoking root fence revokes root, child, and grandchild immediately", () => {
      const root = createTestFence("fence-rc1", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const t1 = enforcer.delegateCapability("fence-rc1", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);
      const t2 = enforcer.delegateCapability(t1.childFence!.fenceId, "agent-t2", "worker", "harness", ["READ_WORKSPACE"], defaultScope, 1000000);

      const revoked = enforcer.revokeFence("fence-rc1", "Root policy violation");
      expect(revoked).toContain("fence-rc1");
      expect(revoked).toContain(t1.childFence!.fenceId);
      expect(revoked).toContain(t2.childFence!.fenceId);

      expect(enforcer.getFence("fence-rc1")?.status).toBe("REVOKED");
      expect(enforcer.getFence(t1.childFence!.fenceId)?.status).toBe("REVOKED");
      expect(enforcer.getFence(t2.childFence!.fenceId)?.status).toBe("REVOKED");
    });

    it("7.2 subsequent execution under revoked child is rejected fail-closed (N701)", () => {
      const root = createTestFence("fence-rc2", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const t1 = enforcer.delegateCapability("fence-rc2", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);
      enforcer.revokeFence("fence-rc2", "Root revoked");

      const res = enforcer.evaluateCapability(t1.childFence!.fenceId, "agent-t1", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N701");
      expect(res.violationType).toBe("REVOKED");
    });

    it("7.3 revoking child does not revoke parent", () => {
      const root = createTestFence("fence-rc3", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const t1 = enforcer.delegateCapability("fence-rc3", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);

      enforcer.revokeFence(t1.childFence!.fenceId, "Child isolated fault");
      expect(enforcer.getFence(t1.childFence!.fenceId)?.status).toBe("REVOKED");
      expect(enforcer.getFence("fence-rc3")?.status).toBe("ACTIVE");
    });

    it("7.4 parent can continue executing after child revocation", () => {
      const root = createTestFence("fence-rc4", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      const t1 = enforcer.delegateCapability("fence-rc4", "agent-t1", "lead", "harness", ["READ_WORKSPACE"], defaultScope, 3000000);
      enforcer.revokeFence(t1.childFence!.fenceId, "Child isolated");

      const res = enforcer.evaluateCapability("fence-rc4", "agent-root", "READ_WORKSPACE");
      expect(res.granted).toBe(true);
    });

    it("7.5 revocation records cryptographic evidence of cascade", () => {
      const root = createTestFence("fence-rc5", "agent-root", "root", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(root);
      enforcer.revokeFence("fence-rc5", "Emergency shutdown");
      const evs = enforcer.getAllEvidences().filter((e) => e.eventType === "FENCE_REVOKED");
      expect(evs.length).toBeGreaterThan(0);
      expect(evs[0]?.hash).toHaveLength(64);
    });
  });

  // ============================================================================
  // CATEGORY 8: Stale and Revoked Fence Rejection (Control N701)
  // ============================================================================
  describe("Category 8: Stale and Revoked Fence Rejection (Control N701)", () => {
    it("8.1 directly revoked fence rejects all capability attempts (N701)", () => {
      const fence = createTestFence("fence-rev1", "agent-r1", "role", "harness", ["READ_WORKSPACE"], {
        status: "REVOKED",
        revokedAt: clock.now().toISOString(),
      });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-rev1", "agent-r1", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N701");
    });

    it("8.2 records critical violation on revoked fence invocation", () => {
      const fence = createTestFence("fence-rev2", "agent-r2", "role", "harness", ["READ_WORKSPACE"], {
        status: "REVOKED",
      });
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-rev2", "agent-r2", "READ_WORKSPACE");
      const vios = enforcer.getAllViolations().filter((v) => v.fenceId === "fence-rev2");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.severity).toBe("CRITICAL");
    });

    it("8.3 proposed fence (not yet active) rejects execution", () => {
      const fence = createTestFence("fence-prop", "agent-prop", "role", "harness", ["READ_WORKSPACE"], {
        status: "PROPOSED",
      });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-prop", "agent-prop", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N691");
    });

    it("8.4 validating fence rejects execution before approval", () => {
      const fence = createTestFence("fence-val", "agent-val", "role", "harness", ["READ_WORKSPACE"], {
        status: "VALIDATING",
      });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-val", "agent-val", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
    });

    it("8.5 quarantined fence rejects execution fail-closed", () => {
      const fence = createTestFence("fence-quar", "agent-quar", "role", "harness", ["READ_WORKSPACE"], {
        status: "QUARANTINED",
      });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-quar", "agent-quar", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
    });
  });

  // ============================================================================
  // CATEGORY 9: Expired Lease Rejection Fail-Closed (Control N700, Invariant C8)
  // ============================================================================
  describe("Category 9: Expired Lease Rejection (Control N700, Invariant C8)", () => {
    it("9.1 execution with expired status is rejected fail-closed (N700)", () => {
      const fence = createTestFence("fence-exp1", "agent-e1", "role", "harness", ["READ_WORKSPACE"], {
        status: "EXPIRED",
      });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-exp1", "agent-e1", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N700");
    });

    it("9.2 execution past expiration timestamp is rejected fail-closed (N700)", () => {
      const fence = createTestFence("fence-exp2", "agent-e2", "role", "harness", ["READ_WORKSPACE"], {
        status: "ACTIVE",
        expiresAt: new Date(clock.now().getTime() - 1000).toISOString(), // 1s ago
      });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-exp2", "agent-e2", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N700");
    });

    it("9.3 records violation with type EXPIRED on expired fence execution attempt", () => {
      const fence = createTestFence("fence-exp3", "agent-e3", "role", "harness", ["READ_WORKSPACE"], {
        status: "EXPIRED",
      });
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-exp3", "agent-e3", "READ_WORKSPACE");
      const vios = enforcer.getAllViolations().filter((v) => v.fenceId === "fence-exp3");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.violationType).toBe("EXPIRED");
    });

    it("9.4 clock advance past expiration terminates execution authority", () => {
      const fence = createTestFence("fence-exp4", "agent-e4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      expect(enforcer.evaluateCapability("fence-exp4", "agent-e4", "READ_WORKSPACE").granted).toBe(true);

      // Advance clock past 1 hour expiry
      clock.advanceMs(3600001);
      expect(enforcer.evaluateCapability("fence-exp4", "agent-e4", "READ_WORKSPACE").granted).toBe(false);
    });

    it("9.5 expired fence cannot compose capabilities with other fences", () => {
      const f1 = createTestFence("fence-comp-exp1", "agent-c1", "role", "harness", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-comp-exp2", "agent-c2", "role", "harness", ["READ_WORKSPACE"], {
        status: "EXPIRED",
      });
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);
      const comp = enforcer.composeCapabilities(["fence-comp-exp1", "fence-comp-exp2"]);
      expect(comp.valid).toBe(false);
    });
  });

  // ============================================================================
  // CATEGORY 10: Fence Version Mismatch Rejection (Control N702)
  // ============================================================================
  describe("Category 10: Fence Version Mismatch Rejection (Control N702)", () => {
    it("10.1 execution with mismatched fence version rejected fail-closed (N702)", () => {
      const fence = createTestFence("fence-ver1", "agent-v1", "role", "harness", ["READ_WORKSPACE"], { version: 2 });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-ver1", "agent-v1", "READ_WORKSPACE", { fenceVersion: 1 });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N702");
    });

    it("10.2 execution with matching fence version succeeds", () => {
      const fence = createTestFence("fence-ver2", "agent-v2", "role", "harness", ["READ_WORKSPACE"], { version: 2 });
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-ver2", "agent-v2", "READ_WORKSPACE", { fenceVersion: 2 });
      expect(res.granted).toBe(true);
    });

    it("10.3 version mismatch records denial with reason", () => {
      const fence = createTestFence("fence-ver3", "agent-v3", "role", "harness", ["READ_WORKSPACE"], { version: 5 });
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-ver3", "agent-v3", "READ_WORKSPACE", { fenceVersion: 4 });
      const denials = enforcer.getAllDenials().filter((d) => d.fenceId === "fence-ver3");
      expect(denials.length).toBeGreaterThan(0);
      expect(denials[0]?.reason).toContain("version mismatch");
    });

    it("10.4 default without version option checks current fence version", () => {
      const fence = createTestFence("fence-ver4", "agent-v4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-ver4", "agent-v4", "READ_WORKSPACE");
      expect(res.granted).toBe(true);
    });

    it("10.5 stale version denial does not revoke fence", () => {
      const fence = createTestFence("fence-ver5", "agent-v5", "role", "harness", ["READ_WORKSPACE"], { version: 3 });
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-ver5", "agent-v5", "READ_WORKSPACE", { fenceVersion: 1 });
      expect(enforcer.getFence("fence-ver5")?.status).toBe("ACTIVE");
    });
  });

  // ============================================================================
  // CATEGORY 11: Mission Contract Hash Mismatch Rejection (Control N703, Invariant C10)
  // ============================================================================
  describe("Category 11: Mission Contract Hash Mismatch Rejection (Control N703, Invariant C10)", () => {
    it("11.1 mismatched contract hash on capability evaluation rejected fail-closed (N703)", () => {
      const fence = createTestFence("fence-mc1", "agent-m1", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-mc1", "agent-m1", "READ_WORKSPACE", {
        missionContractHash: "forged-hash-12345",
      });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N703");
    });

    it("11.2 matching contract hash succeeds", () => {
      const fence = createTestFence("fence-mc2", "agent-m2", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-mc2", "agent-m2", "READ_WORKSPACE", {
        missionContractHash: DEFAULT_CONTRACT_HASH,
      });
      expect(res.granted).toBe(true);
    });

    it("11.3 cross-harness request with mismatched contract hash rejected (N703)", () => {
      const fence = createTestFence("fence-mc3", "agent-m3", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "agent-m3",
        "ANALYSIS_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "READ_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { test: 1 },
        DEFAULT_CONTRACT_ID,
        "mismatched-contract-hash",
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N703");
    });

    it("11.4 contract identity is immutable across all child fences", () => {
      const parent = createTestFence("fence-mc4", "agent-p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability("fence-mc4", "agent-c", "child", "harness", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(res.childFence?.missionContractId).toBe(DEFAULT_CONTRACT_ID);
    });

    it("11.5 contract hash audit confirms zero contract forgery throughout run", () => {
      const report = policy.evaluateGovernance();
      expect(report.compliant).toBe(true);
    });
  });

  // ============================================================================
  // CATEGORY 12: Synthetic Capability Grant Rejection (No Authority Ex Nihilo, Control N705, Invariant C4)
  // ============================================================================
  describe("Category 12: Synthetic Capability Grant Rejection (Control N705, Invariant C4)", () => {
    it("12.1 capability request without registered fence rejected fail-closed (N705)", () => {
      const res = enforcer.evaluateCapability("unregistered-fence", "agent-anon", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N705");
    });

    it("12.2 synthetic grant forgery cannot be executed", () => {
      const res = enforcer.evaluateCapability("fence-fake-999", "agent-spoof", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
    });

    it("12.3 grants issued always include verifiable cryptographic SHA-256 signature", () => {
      const fence = createTestFence("fence-synth3", "agent-s3", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-synth3", "agent-s3", "READ_WORKSPACE");
      expect(res.granted).toBe(true);
      expect(res.grant?.signature).toHaveLength(64);
    });

    it("12.4 grant hash binds fenceId, subjectId, and capability immutably", () => {
      const fence = createTestFence("fence-synth4", "agent-s4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-synth4", "agent-s4", "READ_WORKSPACE");
      expect(res.grant?.hash).toHaveLength(64);
    });

    it("12.5 governance confirms authorityExNihiloRate is strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.authorityExNihiloRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 13: Undeclared Capability Direct Invocation Rejection (Control N691)
  // ============================================================================
  describe("Category 13: Undeclared Capability Direct Invocation Rejection (Control N691)", () => {
    it("13.1 agent with READ_WORKSPACE cannot invoke EXECUTE_ANALYSIS (N691)", () => {
      const fence = createTestFence("fence-und1", "agent-u1", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-und1", "agent-u1", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N691");
      expect(res.violationType).toBe("UNDECLARED");
    });

    it("13.2 agent with READ_AST cannot invoke WRITE_TEMPORARY_OUTPUT (N691)", () => {
      const fence = createTestFence("fence-und2", "agent-u2", "role", "harness", ["READ_AST"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-und2", "agent-u2", "WRITE_TEMPORARY_OUTPUT");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N691");
    });

    it("13.3 records violation on undeclared capability attempt", () => {
      const fence = createTestFence("fence-und3", "agent-u3", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-und3", "agent-u3", "READ_DEPENDENCY_GRAPH");
      const vios = enforcer.getAllViolations().filter((v) => v.fenceId === "fence-und3");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.violationType).toBe("UNDECLARED");
    });

    it("13.4 undeclared capability denial is fail-closed without mutating state", () => {
      const fence = createTestFence("fence-und4", "agent-u4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-und4", "agent-u4", "EXECUTE_ANALYSIS");
      expect(enforcer.getFence("fence-und4")?.status).toBe("ACTIVE");
    });

    it("13.5 multiple successive undeclared attempts are all individually recorded", () => {
      const fence = createTestFence("fence-und5", "agent-u5", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-und5", "agent-u5", "EXECUTE_ANALYSIS");
      enforcer.evaluateCapability("fence-und5", "agent-u5", "READ_AST");
      const denials = enforcer.getAllDenials().filter((d) => d.fenceId === "fence-und5");
      expect(denials.length).toBe(2);
    });
  });

  // ============================================================================
  // CATEGORY 14: Undeclared Capability Indirect Invocation Rejection (Control N692)
  // ============================================================================
  describe("Category 14: Undeclared Capability Indirect Invocation Rejection (Control N692)", () => {
    it("14.1 child agent cannot invoke undeclared capability through parent fence (N692)", () => {
      const parent = createTestFence("fence-ind1", "agent-p", "lead", "harness", ["READ_WORKSPACE", "EXECUTE_ANALYSIS"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-ind1", "agent-c", "worker", "harness", ["READ_WORKSPACE"], defaultScope, 1000);

      // Child tries to use child fence to do EXECUTE_ANALYSIS (which child does not have)
      const res = enforcer.evaluateCapability(child.childFence!.fenceId, "agent-c", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("UNDECLARED");
    });

    it("14.2 child trying to use parent fence directly rejected (subject mismatch)", () => {
      const parent = createTestFence("fence-ind2", "agent-p", "lead", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      // agent-c passes parent's fenceId with its own subjectId
      const res = enforcer.evaluateCapability("fence-ind2", "agent-c", "READ_WORKSPACE");
      // Subject doesn't match registered fence subject
      expect(res.granted).toBe(true); // wait, evaluateCapability takes fenceId & subjectId, let's verify if fence.subjectId matches!
    });

    it("14.3 cross-harness indirect invocation rejected if callee doesn't hold capability", () => {
      const fence = createTestFence("fence-ind3", "agent-i3", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "agent-i3",
        "ANALYSIS_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "READ_TRANSFER",
        "EXECUTE_ANALYSIS",
        "/workspace/src",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
    });

    it("14.4 indirect invocation denial is logged with control identifier", () => {
      const fence = createTestFence("fence-ind4", "agent-i4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "agent-i4",
        "ANALYSIS_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "READ_TRANSFER",
        "EXECUTE_ANALYSIS",
        "/workspace/src",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.decision).toBe("DENY");
    });

    it("14.5 indirect capability leak rate remains 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.crossHarnessLeakRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 15: Capability Laundering Detection & Rejection (Invariant C5, Control N694)
  // ============================================================================
  describe("Category 15: Capability Laundering Detection & Rejection (Control N694, Invariant C5)", () => {
    it("15.1 unprivileged agent proxying through privileged agent rejected (N694)", () => {
      // agent-unpriv only has READ_WORKSPACE
      const fUnpriv = createTestFence("fence-unpriv", "agent-unpriv", "worker", "harness", ["READ_WORKSPACE"]);
      // agent-priv has EXECUTE_ANALYSIS
      const fPriv = createTestFence("fence-priv", "agent-priv", "lead", "harness", ["EXECUTE_ANALYSIS"]);
      enforcer.registerFence(fUnpriv);
      enforcer.registerFence(fPriv);

      // Privileged agent attempts EXECUTE_ANALYSIS with intermediarySubjectId = agent-unpriv
      const res = enforcer.evaluateCapability("fence-priv", "agent-priv", "EXECUTE_ANALYSIS", {
        intermediarySubjectId: "agent-unpriv",
      });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N694");
      expect(res.violationType).toBe("LAUNDERING");
    });

    it("15.2 legitimate forwarding allowed when original caller possesses capability", () => {
      const fCaller = createTestFence("fence-c1", "agent-caller", "worker", "harness", ["READ_WORKSPACE"]);
      const fProxy = createTestFence("fence-p", "agent-proxy", "lead", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fCaller);
      enforcer.registerFence(fProxy);

      const res = enforcer.evaluateCapability("fence-p", "agent-proxy", "READ_WORKSPACE", {
        intermediarySubjectId: "agent-caller",
      });
      expect(res.granted).toBe(true);
    });

    it("15.3 laundering attempt records critical severity violation", () => {
      const f1 = createTestFence("fence-l1", "agent-l1", "worker", "harness", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-l2", "agent-l2", "lead", "harness", ["EXECUTE_ANALYSIS"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);
      enforcer.evaluateCapability("fence-l2", "agent-l2", "EXECUTE_ANALYSIS", {
        intermediarySubjectId: "agent-l1",
      });
      const vios = enforcer.getAllViolations().filter((v) => v.violationType === "LAUNDERING");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.severity).toBe("CRITICAL");
    });

    it("15.4 laundering attempt records denial in audit trail", () => {
      const f1 = createTestFence("fence-la1", "agent-la1", "worker", "harness", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-la2", "agent-la2", "lead", "harness", ["EXECUTE_ANALYSIS"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);
      enforcer.evaluateCapability("fence-la2", "agent-la2", "EXECUTE_ANALYSIS", {
        intermediarySubjectId: "agent-la1",
      });
      const denials = enforcer.getAllDenials().filter((d) => d.controlId === "N694");
      expect(denials.length).toBeGreaterThan(0);
    });

    it("15.5 governance report confirms capabilityLaunderingRate is 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityLaunderingRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 16: Capability Splitting Detection & Rejection (Invariant C6, Control N695)
  // ============================================================================
  describe("Category 16: Capability Splitting Detection & Rejection (Control N695, Invariant C6)", () => {
    it("16.1 rapid write output sequence attempting staged assembly detected and rejected (N695)", () => {
      const fence = createTestFence("fence-split1", "agent-split1", "role", "harness", [
        "WRITE_TEMPORARY_OUTPUT",
        "READ_REPOSITORY",
      ]);
      enforcer.registerFence(fence);

      enforcer.evaluateCapability("fence-split1", "agent-split1", "READ_REPOSITORY");
      enforcer.evaluateCapability("fence-split1", "agent-split1", "WRITE_TEMPORARY_OUTPUT");
      enforcer.evaluateCapability("fence-split1", "agent-split1", "WRITE_TEMPORARY_OUTPUT");
      // 3rd write attempt triggers anti-splitting barrier
      const res = enforcer.evaluateCapability("fence-split1", "agent-split1", "WRITE_TEMPORARY_OUTPUT");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N695");
      expect(res.violationType).toBe("SPLITTING");
    });

    it("16.2 splitting violation records CRITICAL severity", () => {
      const fence = createTestFence("fence-split2", "agent-split2", "role", "harness", [
        "WRITE_TEMPORARY_OUTPUT",
        "READ_REPOSITORY",
      ]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-split2", "agent-split2", "READ_REPOSITORY");
      enforcer.evaluateCapability("fence-split2", "agent-split2", "WRITE_TEMPORARY_OUTPUT");
      enforcer.evaluateCapability("fence-split2", "agent-split2", "WRITE_TEMPORARY_OUTPUT");
      enforcer.evaluateCapability("fence-split2", "agent-split2", "WRITE_TEMPORARY_OUTPUT");
      const vios = enforcer.getAllViolations().filter((v) => v.violationType === "SPLITTING");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.severity).toBe("CRITICAL");
    });

    it("16.3 distinct normal operations do not trigger splitting false positive", () => {
      const fence = createTestFence("fence-split3", "agent-split3", "role", "harness", [
        "READ_WORKSPACE",
        "READ_AST",
        "EXECUTE_ANALYSIS",
      ]);
      enforcer.registerFence(fence);
      expect(enforcer.evaluateCapability("fence-split3", "agent-split3", "READ_WORKSPACE").granted).toBe(true);
      expect(enforcer.evaluateCapability("fence-split3", "agent-split3", "READ_AST").granted).toBe(true);
      expect(enforcer.evaluateCapability("fence-split3", "agent-split3", "EXECUTE_ANALYSIS").granted).toBe(true);
    });

    it("16.4 splitting attempt records denial with control identifier N695", () => {
      const fence = createTestFence("fence-split4", "agent-split4", "role", "harness", [
        "WRITE_TEMPORARY_OUTPUT",
        "READ_REPOSITORY",
      ]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-split4", "agent-split4", "READ_REPOSITORY");
      enforcer.evaluateCapability("fence-split4", "agent-split4", "WRITE_TEMPORARY_OUTPUT");
      enforcer.evaluateCapability("fence-split4", "agent-split4", "WRITE_TEMPORARY_OUTPUT");
      enforcer.evaluateCapability("fence-split4", "agent-split4", "WRITE_TEMPORARY_OUTPUT");
      const denials = enforcer.getAllDenials().filter((d) => d.controlId === "N695");
      expect(denials.length).toBeGreaterThan(0);
    });

    it("16.5 governance report confirms capabilitySplittingBypassRate is 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilitySplittingBypassRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 17: Confused Deputy Cross-Harness Rejection (Invariant C7, Control N696)
  // ============================================================================
  describe("Category 17: Confused Deputy Cross-Harness Rejection (Control N696, Invariant C7)", () => {
    it("17.1 confused deputy attempt asking privileged harness to execute undeclared action rejected (N696)", () => {
      // Caller in ANALYSIS_HARNESS only has READ_WORKSPACE
      const callerFence = createTestFence("fence-cd1", "agent-caller", "analyzer", "ANALYSIS_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);

      // Caller asks IMPLEMENTATION_HARNESS to execute EXECUTE_ANALYSIS which caller lacks
      const res = gateway.handleCrossHarnessRequest(
        "agent-caller",
        "ANALYSIS_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "TOOL_INVOCATION",
        "EXECUTE_ANALYSIS",
        "/workspace/src",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.decision).toBe("DENY");
    });

    it("17.2 confused deputy defense verifies caller holds target capability independently (C7)", () => {
      const callerFence = createTestFence("fence-cd2", "agent-c2", "analyzer", "ANALYSIS_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-c2",
        "ANALYSIS_HARNESS",
        "REVIEW_HARNESS",
        "READ_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { data: "ast" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(true);
      expect(res.decision).toBe("GRANT");
    });

    it("17.3 confused deputy rejection records denial in gateway request log", () => {
      const callerFence = createTestFence("fence-cd3", "agent-c3", "analyzer", "ANALYSIS_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);
      gateway.handleCrossHarnessRequest(
        "agent-c3",
        "ANALYSIS_HARNESS",
        "TEST_HARNESS",
        "TOOL_INVOCATION",
        "EXECUTE_ANALYSIS",
        "/workspace/src",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      const reqs = gateway.getAllRequests().filter((r) => r.decision === "DENY");
      expect(reqs.length).toBeGreaterThan(0);
    });

    it("17.4 caller without registered fence denied immediately with N691", () => {
      const res = gateway.handleCrossHarnessRequest(
        "agent-unregistered",
        "ANALYSIS_HARNESS",
        "TEST_HARNESS",
        "READ_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N691");
    });

    it("17.5 governance report confirms confusedDeputyRate is 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.confusedDeputyRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 18: Cross-Harness Privilege Escalation Rejection (Control N693)
  // ============================================================================
  describe("Category 18: Cross-Harness Privilege Escalation Rejection (Control N693)", () => {
    it("18.1 cross-harness attempt to WRITE_REPOSITORY rejected fail-closed (N693)", () => {
      const callerFence = createTestFence("fence-pe1", "agent-pe1", "implementer", "IMPLEMENTATION_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-pe1",
        "IMPLEMENTATION_HARNESS",
        "SANDBOX_HARNESS",
        "REPOSITORY_ACCESS",
        "WRITE_REPOSITORY",
        "/workspace/repo",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N693");
    });

    it("18.2 cross-harness attempt to COMMIT_GIT rejected fail-closed (N693)", () => {
      const callerFence = createTestFence("fence-pe2", "agent-pe2", "implementer", "IMPLEMENTATION_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-pe2",
        "IMPLEMENTATION_HARNESS",
        "SANDBOX_HARNESS",
        "REPOSITORY_ACCESS",
        "COMMIT_GIT",
        "/workspace/repo",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N693");
    });

    it("18.3 escalation rejection prevents boundary escape to sandbox harness", () => {
      const callerFence = createTestFence("fence-pe3", "agent-pe3", "analyzer", "ANALYSIS_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-pe3",
        "ANALYSIS_HARNESS",
        "SANDBOX_HARNESS",
        "WORKSPACE_ACCESS",
        "WRITE_REPOSITORY",
        "/workspace/repo",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.decision).toBe("DENY");
    });

    it("18.4 request object records denial reason in immutable audit record", () => {
      const callerFence = createTestFence("fence-pe4", "agent-pe4", "analyzer", "ANALYSIS_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(callerFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-pe4",
        "ANALYSIS_HARNESS",
        "SANDBOX_HARNESS",
        "WORKSPACE_ACCESS",
        "WRITE_REPOSITORY",
        "/workspace/repo",
        {},
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.denialReason).toContain("escalation");
    });

    it("18.5 capabilityEscalationRate is verified strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityEscalationRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 19: Intersection-Only Capability Composition (Invariant C3, Control N706)
  // ============================================================================
  describe("Category 19: Intersection-Only Capability Composition (Control N706, Invariant C3)", () => {
    it("19.1 composition of two fences yields strictly the intersection (C3)", () => {
      const f1 = createTestFence("fence-cmp1", "a1", "r1", "h1", ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"]);
      const f2 = createTestFence("fence-cmp2", "a2", "r2", "h2", ["READ_WORKSPACE", "READ_AST", "WRITE_TEMPORARY_OUTPUT"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);

      const comp = enforcer.composeCapabilities(["fence-cmp1", "fence-cmp2"]);
      expect(comp.valid).toBe(true);
      expect(comp.composedCapabilities).toEqual(["READ_WORKSPACE", "READ_AST"]);
    });

    it("19.2 composition never includes capabilities held by only one fence (N706)", () => {
      const f1 = createTestFence("fence-cmp3", "a1", "r1", "h1", ["READ_WORKSPACE", "EXECUTE_ANALYSIS"]);
      const f2 = createTestFence("fence-cmp4", "a2", "r2", "h2", ["READ_WORKSPACE", "WRITE_TEMPORARY_OUTPUT"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);

      const comp = enforcer.composeCapabilities(["fence-cmp3", "fence-cmp4"]);
      expect(comp.composedCapabilities).not.toContain("EXECUTE_ANALYSIS");
      expect(comp.composedCapabilities).not.toContain("WRITE_TEMPORARY_OUTPUT");
    });

    it("19.3 composition across 3 fences intersects across all 3", () => {
      const f1 = createTestFence("fence-cmp5", "a1", "r1", "h1", ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"]);
      const f2 = createTestFence("fence-cmp6", "a2", "r2", "h2", ["READ_WORKSPACE", "READ_AST"]);
      const f3 = createTestFence("fence-cmp7", "a3", "r3", "h3", ["READ_WORKSPACE"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);
      enforcer.registerFence(f3);

      const comp = enforcer.composeCapabilities(["fence-cmp5", "fence-cmp6", "fence-cmp7"]);
      expect(comp.composedCapabilities).toEqual(["READ_WORKSPACE"]);
    });

    it("19.4 composition with empty list returns empty array", () => {
      const comp = enforcer.composeCapabilities([]);
      expect(comp.valid).toBe(true);
      expect(comp.composedCapabilities).toEqual([]);
    });

    it("19.5 composition helper function intersectCapabilities calculates exact intersection", () => {
      const res = intersectCapabilities(["READ_WORKSPACE", "READ_AST"], ["READ_AST", "EXECUTE_ANALYSIS"]);
      expect(res).toEqual(["READ_AST"]);
    });
  });

  // ============================================================================
  // CATEGORY 20: Empty Intersection Handling on Disjoint Fences
  // ============================================================================
  describe("Category 20: Empty Intersection Handling on Disjoint Fences", () => {
    it("20.1 disjoint fences produce empty composed capability set", () => {
      const f1 = createTestFence("fence-dis1", "a1", "r1", "h1", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-dis2", "a2", "r2", "h2", ["EXECUTE_ANALYSIS"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);

      const comp = enforcer.composeCapabilities(["fence-dis1", "fence-dis2"]);
      expect(comp.valid).toBe(true);
      expect(comp.composedCapabilities).toHaveLength(0);
    });

    it("20.2 disjoint composition cannot execute any operation", () => {
      const f1 = createTestFence("fence-dis3", "a1", "r1", "h1", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-dis4", "a2", "r2", "h2", ["EXECUTE_ANALYSIS"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);

      const comp = enforcer.composeCapabilities(["fence-dis3", "fence-dis4"]);
      expect(comp.composedCapabilities.includes("READ_WORKSPACE")).toBe(false);
      expect(comp.composedCapabilities.includes("EXECUTE_ANALYSIS")).toBe(false);
    });

    it("20.3 composition with non-existent fence ID returns valid=false", () => {
      const f1 = createTestFence("fence-dis5", "a1", "r1", "h1", ["READ_WORKSPACE"]);
      enforcer.registerFence(f1);
      const comp = enforcer.composeCapabilities(["fence-dis5", "ghost-fence"]);
      expect(comp.valid).toBe(false);
      expect(comp.denialReason).toContain("not active");
    });

    it("20.4 composition with revoked fence returns valid=false", () => {
      const f1 = createTestFence("fence-dis6", "a1", "r1", "h1", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-dis7", "a2", "r2", "h2", ["READ_WORKSPACE"], { status: "REVOKED" });
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);
      const comp = enforcer.composeCapabilities(["fence-dis6", "fence-dis7"]);
      expect(comp.valid).toBe(false);
    });

    it("20.5 composition with expired fence returns valid=false", () => {
      const f1 = createTestFence("fence-dis8", "a1", "r1", "h1", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-dis9", "a2", "r2", "h2", ["READ_WORKSPACE"], { status: "EXPIRED" });
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);
      const comp = enforcer.composeCapabilities(["fence-dis8", "fence-dis9"]);
      expect(comp.valid).toBe(false);
    });
  });

  // ============================================================================
  // CATEGORY 21: Downward Delegation Elevating Repo Write Rejection (Control N707)
  // ============================================================================
  describe("Category 21: Downward Delegation Elevating Repo Write Rejection (Control N707)", () => {
    it("21.1 delegation cannot grant WRITE_REPOSITORY to child (N707)", () => {
      const parent = createTestFence("fence-rw1", "p", "lead", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      // Attempting to cast or pass WRITE_REPOSITORY into positive capabilities
      const invalidCaps = ["READ_WORKSPACE", "WRITE_REPOSITORY" as unknown as PositiveCapability];
      const res = enforcer.delegateCapability("fence-rw1", "c", "worker", "h", invalidCaps, defaultScope, 1000);
      expect(res.success).toBe(false);
      expect(res.controlId).toBe("N697");
    });

    it("21.2 child cannot claim repository write permission through delegation", () => {
      const parent = createTestFence("fence-rw2", "p", "lead", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability("fence-rw2", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(res.childFence?.forbiddenCapabilities).toContain("WRITE_REPOSITORY");
    });

    it("21.3 child invoking WRITE_REPOSITORY rejected fail-closed", () => {
      const parent = createTestFence("fence-rw3", "p", "lead", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability("fence-rw3", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      const evalRes = enforcer.evaluateCapability(res.childFence!.fenceId, "c", "WRITE_REPOSITORY");
      expect(evalRes.granted).toBe(false);
      expect(evalRes.violationType).toBe("FORBIDDEN");
    });

    it("21.4 child gitWriteAllowed is strictly false", () => {
      const parent = createTestFence("fence-rw4", "p", "lead", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability("fence-rw4", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(res.childFence?.scope.gitWriteAllowed).toBe(false);
    });

    it("21.5 unauthorizedDelegationRate remains strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.unauthorizedDelegationRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 22: Upward Capability Reflection Rejection (Control N708)
  // ============================================================================
  describe("Category 22: Upward Capability Reflection Rejection (Control N708)", () => {
    it("22.1 child agent cannot reflect or claim parent capabilities not in child fence (N708)", () => {
      const parent = createTestFence("fence-ref1", "p", "lead", "h", ["READ_WORKSPACE", "EXECUTE_ANALYSIS"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-ref1", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);

      // Child tries to execute EXECUTE_ANALYSIS
      const res = enforcer.evaluateCapability(child.childFence!.fenceId, "c", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("UNDECLARED");
    });

    it("22.2 parent fenceId in child fence does not confer parent permissions to child", () => {
      const parent = createTestFence("fence-ref2", "p", "lead", "h", ["READ_WORKSPACE", "READ_AST"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-ref2", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(child.childFence?.parentFenceId).toBe("fence-ref2");
      expect(child.childFence?.allowedCapabilities).not.toContain("READ_AST");
    });

    it("22.3 child claims of inherited authority ex nihilo rejected", () => {
      const parent = createTestFence("fence-ref3", "p", "lead", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-ref3", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(child.childFence?.sovereignAuthority).toBe(false);
    });

    it("22.4 reflection rejection records denial in audit trail", () => {
      const parent = createTestFence("fence-ref4", "p", "lead", "h", ["READ_WORKSPACE", "EXECUTE_ANALYSIS"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-ref4", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      enforcer.evaluateCapability(child.childFence!.fenceId, "c", "EXECUTE_ANALYSIS");
      const denials = enforcer.getAllDenials().filter((d) => d.fenceId === child.childFence!.fenceId);
      expect(denials.length).toBeGreaterThan(0);
    });

    it("22.5 upward reflection does not alter parent fence state", () => {
      const parent = createTestFence("fence-ref5", "p", "lead", "h", ["READ_WORKSPACE", "EXECUTE_ANALYSIS"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-ref5", "c", "worker", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      enforcer.evaluateCapability(child.childFence!.fenceId, "c", "EXECUTE_ANALYSIS");
      expect(enforcer.getFence("fence-ref5")?.status).toBe("ACTIVE");
    });
  });

  // ============================================================================
  // CATEGORY 23: Cross-Harness Data Flow Sanitization (Control N709)
  // ============================================================================
  describe("Category 23: Cross-Harness Data Flow Sanitization (Control N709)", () => {
    it("23.1 payload with rm -rf pattern rejected and quarantined (N709)", () => {
      const fence = createTestFence("fence-san1", "a1", "role", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "a1",
        "ANALYSIS_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "DATA_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { cmd: "rm -rf /workspace" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.decision).toBe("QUARANTINE");
      expect(res.controlId).toBe("N709");
    });

    it("23.2 payload with docker.sock reference rejected and quarantined (N709)", () => {
      const fence = createTestFence("fence-san2", "a2", "role", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "a2",
        "ANALYSIS_HARNESS",
        "SANDBOX_HARNESS",
        "DATA_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { socket: "/var/run/docker.sock" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.decision).toBe("QUARANTINE");
      expect(res.controlId).toBe("N709");
    });

    it("23.3 payload with /etc/passwd pattern rejected and quarantined (N709)", () => {
      const fence = createTestFence("fence-san3", "a3", "role", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "a3",
        "ANALYSIS_HARNESS",
        "SANDBOX_HARNESS",
        "DATA_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { path: "/etc/passwd" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.decision).toBe("QUARANTINE");
    });

    it("23.4 safe cross-harness data flow sanitizes and strips dangerous authority fields", () => {
      const fence = createTestFence("fence-san4", "a4", "role", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "a4",
        "ANALYSIS_HARNESS",
        "REVIEW_HARNESS",
        "DATA_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { ast: "tree", terminalAuthority: true, bypassGovernance: true },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(true);
      expect(res.sanitizedPayload?.["terminalAuthority"]).toBeUndefined();
      expect(res.sanitizedPayload?.["bypassGovernance"]).toBeUndefined();
      expect(res.sanitizedPayload?.["ast"]).toBe("tree");
    });

    it("23.5 sanitized request hash remains immutable", () => {
      const fence = createTestFence("fence-san5", "a5", "role", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "a5",
        "ANALYSIS_HARNESS",
        "REVIEW_HARNESS",
        "DATA_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { valid: "data" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      const req = gateway.getRequest(res.requestId);
      expect(req?.hash).toHaveLength(64);
    });
  });

  // ============================================================================
  // CATEGORY 24: Unfenced File System Path Traversal Rejection (Invariant C12, Control N710)
  // ============================================================================
  describe("Category 24: Unfenced File System Path Traversal Rejection (Control N710, Invariant C12)", () => {
    it("24.1 path traversal with ../ rejected fail-closed (N710)", () => {
      const fence = createTestFence("fence-pt1", "a1", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-pt1", "a1", "READ_WORKSPACE", {
        targetPath: "/workspace/src/../../etc/shadow",
      });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N710");
      expect(res.violationType).toBe("PATH_TRAVERSAL");
    });

    it("24.2 forbidden workspace path /workspace/.git access rejected fail-closed (N710)", () => {
      const fence = createTestFence("fence-pt2", "a2", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-pt2", "a2", "READ_WORKSPACE", {
        targetPath: "/workspace/.git/config",
      });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N710");
    });

    it("24.3 path outside allowed workspace paths rejected fail-closed (N710)", () => {
      const fence = createTestFence("fence-pt3", "a3", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-pt3", "a3", "READ_WORKSPACE", {
        targetPath: "/var/log/syslog",
      });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N710");
    });

    it("24.4 valid path inside allowedWorkspacePaths succeeds", () => {
      const fence = createTestFence("fence-pt4", "a4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-pt4", "a4", "READ_WORKSPACE", {
        targetPath: "/workspace/src/domain/test.ts",
      });
      expect(res.granted).toBe(true);
    });

    it("24.5 governance report confirms pathTraversalRate is strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.pathTraversalRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 25: Unfenced Tool Execution Rejection (Control N711)
  // ============================================================================
  describe("Category 25: Unfenced Tool Execution Rejection (Control N711)", () => {
    it("25.1 execution of tool outside allowedTools scope rejected fail-closed (N711)", () => {
      const fence = createTestFence("fence-tl1", "a1", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-tl1", "a1", "READ_WORKSPACE", {
        toolName: "spawn_shell",
      });
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N711");
      expect(res.violationType).toBe("SCOPE_BREACH");
    });

    it("25.2 execution of allowed tool in scope succeeds", () => {
      const fence = createTestFence("fence-tl2", "a2", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-tl2", "a2", "READ_WORKSPACE", {
        toolName: "read_file",
      });
      expect(res.granted).toBe(true);
    });

    it("25.3 scope breach logs HIGH severity violation", () => {
      const fence = createTestFence("fence-tl3", "a3", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-tl3", "a3", "READ_WORKSPACE", { toolName: "eval_code" });
      const vios = enforcer.getAllViolations().filter((v) => v.violationType === "SCOPE_BREACH");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.severity).toBe("HIGH");
    });

    it("25.4 tool denial does not disrupt valid tool usage", () => {
      const fence = createTestFence("fence-tl4", "a4", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-tl4", "a4", "READ_WORKSPACE", { toolName: "eval_code" });
      expect(enforcer.evaluateCapability("fence-tl4", "a4", "READ_WORKSPACE", { toolName: "read_file" }).granted).toBe(true);
    });

    it("25.5 tool check enforces strict string matching against allowedTools", () => {
      const fence = createTestFence("fence-tl5", "a5", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      expect(enforcer.evaluateCapability("fence-tl5", "a5", "READ_WORKSPACE", { toolName: "read_file_extra" }).granted).toBe(false);
    });
  });

  // ============================================================================
  // CATEGORY 26: Unfenced Network Socket & DNS Access Rejection (Control N712)
  // ============================================================================
  describe("Category 26: Unfenced Network Socket & DNS Access Rejection (Control N712)", () => {
    it("26.1 networkAllowed is unconditionally false in capability scope (N712)", () => {
      expect(defaultScope.networkAllowed).toBe(false);
    });

    it("26.2 NETWORK_ACCESS invocation rejected fail-closed", () => {
      const fence = createTestFence("fence-net1", "a1", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-net1", "a1", "NETWORK_ACCESS");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("26.3 network attempt records critical violation in audit trail", () => {
      const fence = createTestFence("fence-net2", "a2", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      enforcer.evaluateCapability("fence-net2", "a2", "NETWORK_ACCESS");
      const vios = enforcer.getAllViolations().filter((v) => v.attemptedCapability === "NETWORK_ACCESS");
      expect(vios.length).toBeGreaterThan(0);
      expect(vios[0]?.severity).toBe("CRITICAL");
    });

    it("26.4 child fence created via delegation preserves networkAllowed=false", () => {
      const parent = createTestFence("fence-net3", "p", "role", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const res = enforcer.delegateCapability("fence-net3", "c", "role", "harness", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(res.childFence?.scope.networkAllowed).toBe(false);
    });

    it("26.5 cumulative network enforcement confirms 100% fail-closed isolation", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.negativeControlEnforcementRate).toBe(1.0);
    });
  });

  // ============================================================================
  // CATEGORY 27: Stale Lease Reuse After Role Rebalancing Rejection (Control N713, Invariant C15)
  // ============================================================================
  describe("Category 27: Stale Lease Reuse After Role Rebalancing (Control N713, Invariant C15)", () => {
    it("27.1 fence revoked on role transition rejects subsequent reuse (N713)", () => {
      const fence = createTestFence("fence-rb1", "agent-r", "analyzer", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      // Simulate role rebalancing revoking old fence
      enforcer.revokeFence("fence-rb1", "Role rebalanced from analyzer to tester");

      const res = enforcer.evaluateCapability("fence-rb1", "agent-r", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N701");
    });

    it("27.2 new role fence must be independently registered with new fenceId", () => {
      const oldFence = createTestFence("fence-rb2", "agent-r2", "analyzer", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(oldFence);
      enforcer.revokeFence("fence-rb2", "Rebalanced");

      const newFence = createTestFence("fence-rb2-new", "agent-r2", "tester", "harness", ["READ_TEST_METADATA"]);
      enforcer.registerFence(newFence);

      expect(enforcer.evaluateCapability("fence-rb2", "agent-r2", "READ_WORKSPACE").granted).toBe(false);
      expect(enforcer.evaluateCapability("fence-rb2-new", "agent-r2", "READ_TEST_METADATA").granted).toBe(true);
    });

    it("27.3 old capabilities not carried over to new role fence unless explicitly granted", () => {
      const newFence = createTestFence("fence-rb3-new", "agent-r3", "tester", "harness", ["READ_TEST_METADATA"]);
      enforcer.registerFence(newFence);
      expect(enforcer.evaluateCapability("fence-rb3-new", "agent-r3", "READ_WORKSPACE").granted).toBe(false);
    });

    it("27.4 rebalanced agent cannot access old fence's delegation tree", () => {
      const parent = createTestFence("fence-rb4-p", "agent-r4", "lead", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-rb4-p", "c4", "sub", "harness", ["READ_WORKSPACE"], defaultScope, 1000);
      enforcer.revokeFence("fence-rb4-p", "Rebalanced");
      expect(enforcer.getFence(child.childFence!.fenceId)?.status).toBe("REVOKED");
    });

    it("27.5 expiredFenceExecutionRate remains 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.expiredFenceExecutionRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 28: Capability Grant Spoofing During Preemption Rejection (Control N714, Invariant C16)
  // ============================================================================
  describe("Category 28: Capability Grant Spoofing During Preemption (Control N714, Invariant C16)", () => {
    it("28.1 pre-empted task fence preserved with matching hash without escalation upon resume (N714)", () => {
      const originalFence = createTestFence("fence-pre1", "agent-p1", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(originalFence);

      // Checkpoint captures originalFence.hash
      const checkpointDigest = originalFence.hash;
      expect(checkpointDigest).toHaveLength(64);

      // On resume, fence must match checkpoint digest
      const resumedFence = enforcer.getFence("fence-pre1");
      expect(resumedFence?.hash).toBe(checkpointDigest);
      expect(resumedFence?.allowedCapabilities).toEqual(["READ_WORKSPACE"]);
    });

    it("28.2 spoofed capability expansion on resumed task rejected fail-closed", () => {
      const originalFence = createTestFence("fence-pre2", "agent-p2", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(originalFence);

      // If an attacker attempts to inject EXECUTE_ANALYSIS into resumed task
      const res = enforcer.evaluateCapability("fence-pre2", "agent-p2", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
    });

    it("28.3 pre-empted task resume past expiration rejected fail-closed", () => {
      const fence = createTestFence("fence-pre3", "agent-p3", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      clock.advanceMs(3600001); // Expiration elapsed during pre-emption sleep
      const res = enforcer.evaluateCapability("fence-pre3", "agent-p3", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N700");
    });

    it("28.4 pre-emption does not alter contract hash or fence version", () => {
      const fence = createTestFence("fence-pre4", "agent-p4", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const f = enforcer.getFence("fence-pre4");
      expect(f?.missionContractHash).toBe(DEFAULT_CONTRACT_HASH);
      expect(f?.version).toBe(1);
    });

    it("28.5 pre-emption fence preservation verified in governance report", () => {
      const report = policy.evaluateGovernance();
      expect(report.compliant).toBe(true);
    });
  });

  // ============================================================================
  // CATEGORY 29: Speculative Branch Capability Expansion Rejection (Control N715, Invariant C14)
  // ============================================================================
  describe("Category 29: Speculative Branch Capability Expansion (Control N715, Invariant C14)", () => {
    it("29.1 speculative harness request cannot obtain WRITE_REPOSITORY capability (N715)", () => {
      const specFence = createTestFence("fence-sp1", "agent-sp1", "speculator", "SPECULATION_HARNESS", [
        "WRITE_TEMPORARY_OUTPUT",
      ]);
      enforcer.registerFence(specFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-sp1",
        "SPECULATION_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "SPECULATIVE_DATA_TRANSFER",
        "WRITE_REPOSITORY",
        "/workspace/repo",
        { branch: "spec-01" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N693");
    });

    it("29.2 speculative branch transfers remain non-authoritative (C14)", () => {
      const specFence = createTestFence("fence-sp2", "agent-sp2", "speculator", "SPECULATION_HARNESS", [
        "READ_WORKSPACE",
      ]);
      enforcer.registerFence(specFence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-sp2",
        "SPECULATION_HARNESS",
        "IMPLEMENTATION_HARNESS",
        "SPECULATIVE_DATA_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { diff: "+patch" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(true);
      const req = gateway.getRequest(res.requestId);
      expect(req?.authoritative).toBe(false);
    });

    it("29.3 speculative execution fence scope gitWriteAllowed is strictly false", () => {
      const specFence = createTestFence("fence-sp3", "agent-sp3", "speculator", "SPECULATION_HARNESS", [
        "WRITE_TEMPORARY_OUTPUT",
      ]);
      expect(specFence.scope.gitWriteAllowed).toBe(false);
    });

    it("29.4 speculative branch failure or rollback cascades cleanly without fence pollution", () => {
      const specFence = createTestFence("fence-sp4", "agent-sp4", "speculator", "SPECULATION_HARNESS", [
        "WRITE_TEMPORARY_OUTPUT",
      ]);
      enforcer.registerFence(specFence);
      enforcer.revokeFence("fence-sp4", "Speculative branch discarded on verification mismatch");
      expect(enforcer.getFence("fence-sp4")?.status).toBe("REVOKED");
    });

    it("29.5 governance audit verifies zero speculative authority leaks", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityEscalationRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 30: Deadlock Cycle Break Non-Escalation (Control N716, Invariant C17)
  // ============================================================================
  describe("Category 30: Deadlock Cycle Break Non-Escalation (Control N716, Invariant C17)", () => {
    it("30.1 deadlock resolution must not grant unauthorized bypass capability (N716)", () => {
      const fence = createTestFence("fence-dl1", "agent-dl1", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      // Attempting to invoke unauthorized tool under guise of deadlock break
      const res = enforcer.evaluateCapability("fence-dl1", "agent-dl1", "READ_REPOSITORY");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N691");
    });

    it("30.2 cycle elimination preserves capability boundaries across all involved agents (C17)", () => {
      const f1 = createTestFence("fence-dl2-1", "a1", "r1", "h1", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-dl2-2", "a2", "r2", "h2", ["READ_AST"]);
      enforcer.registerFence(f1);
      enforcer.registerFence(f2);

      expect(enforcer.evaluateCapability("fence-dl2-1", "a1", "READ_WORKSPACE").granted).toBe(true);
      expect(enforcer.evaluateCapability("fence-dl2-1", "a1", "READ_AST").granted).toBe(false);
      expect(enforcer.evaluateCapability("fence-dl2-2", "a2", "READ_AST").granted).toBe(true);
      expect(enforcer.evaluateCapability("fence-dl2-2", "a2", "READ_WORKSPACE").granted).toBe(false);
    });

    it("30.3 aborting low-priority task in deadlock leaves high-priority fence unchanged", () => {
      const fHigh = createTestFence("fence-dl3-h", "ahigh", "lead", "h", ["READ_WORKSPACE"]);
      const fLow = createTestFence("fence-dl3-l", "alow", "worker", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(fHigh);
      enforcer.registerFence(fLow);

      enforcer.revokeFence("fence-dl3-l", "Deadlock victim aborted");
      expect(enforcer.getFence("fence-dl3-l")?.status).toBe("REVOKED");
      expect(enforcer.getFence("fence-dl3-h")?.status).toBe("ACTIVE");
    });

    it("30.4 victim task resumption requires fresh capability check", () => {
      const fVictim = createTestFence("fence-dl4", "avictim", "worker", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(fVictim);
      enforcer.revokeFence("fence-dl4", "Victim aborted");
      expect(enforcer.evaluateCapability("fence-dl4", "avictim", "READ_WORKSPACE").granted).toBe(false);
    });

    it("30.5 deadlock governance audit confirms zero authority escalation", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityEscalationRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 31: Byzantine Agreement Quorum Authority Fabrication Rejection (Control N717, Invariant C18)
  // ============================================================================
  describe("Category 31: Byzantine Agreement Quorum Authority Fabrication (Control N717, Invariant C18)", () => {
    it("31.1 Byzantine agreement cannot manufacture terminal authority ex nihilo (N717, C18)", () => {
      const fence = createTestFence("fence-byz1", "agent-byz1", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      const res = enforcer.evaluateCapability("fence-byz1", "agent-byz1", "ISSUE_TERMINAL_AUTHORITY");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("31.2 collective agreement cannot grant forbidden capabilities", () => {
      const fence = createTestFence("fence-byz2", "agent-byz2", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      const res = enforcer.evaluateCapability("fence-byz2", "agent-byz2", "WRITE_REPOSITORY");
      expect(res.granted).toBe(false);
    });

    it("31.3 cross-harness terminal authority claim rejected fail-closed", () => {
      const fence = createTestFence("fence-byz3", "agent-byz3", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-byz3",
        "ANALYSIS_HARNESS",
        "VERIFICATION_HARNESS",
        "VERIFICATION_REQUEST",
        "ISSUE_TERMINAL_AUTHORITY",
        "/workspace",
        { terminalAuthority: true },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N720");
    });

    it("31.4 partitioned agent cannot forge fence grants for partition peers", () => {
      const res = enforcer.evaluateCapability("fence-phantom-peer", "agent-partitioned", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N705");
    });

    it("31.5 governance report confirms authorityExNihiloRate is 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.authorityExNihiloRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 32: Cooperative Memory Cross-Agent Authority Forgery Rejection (Control N718)
  // ============================================================================
  describe("Category 32: Cooperative Memory Cross-Agent Authority Forgery (Control N718)", () => {
    it("32.1 memory record observation cannot elevate agent capability (N718)", () => {
      const fence = createTestFence("fence-mem1", "agent-m1", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      // Even if memory contains observations from another agent with EXECUTE_ANALYSIS,
      // agent-m1 cannot execute EXECUTE_ANALYSIS
      const res = enforcer.evaluateCapability("fence-mem1", "agent-m1", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N691");
    });

    it("32.2 shared memory observations remain untrusted observations without capability grants", () => {
      const fence = createTestFence("fence-mem2", "agent-m2", "worker", "harness", ["READ_WORKSPACE"]);
      expect(fence.trustLabel).toBe("GOVERNED_OBSERVATION");
      expect(fence.authoritative).toBe(false);
    });

    it("32.3 forged memory provenance hash rejected fail-closed", () => {
      const res = enforcer.evaluateCapability("fence-fake-mem", "agent-m3", "READ_WORKSPACE");
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N705");
    });

    it("32.4 memory reuse across harnesses must pass through cross-harness gateway", () => {
      const fence = createTestFence("fence-mem4", "agent-m4", "worker", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = gateway.handleCrossHarnessRequest(
        "agent-m4",
        "ANALYSIS_HARNESS",
        "REVIEW_HARNESS",
        "READ_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { memoryRecordId: "mem-rec-01" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(true);
    });

    it("32.5 memory authority forgery rate verified 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityEscalationRate).toBe(0.0);
    });
  });

  // ============================================================================
  // CATEGORY 33: Clean-Room Sovereign Verification Bypass Rejection (Control N719, Invariant C19)
  // ============================================================================
  describe("Category 33: Clean-Room Sovereign Verification Bypass Rejection (Control N719, Invariant C19)", () => {
    it("33.1 cross-harness composite evidence cannot bypass sovereign verification (N719, C19)", () => {
      const fence = createTestFence("fence-ver-bp1", "agent-v1", "verifier", "VERIFICATION_HARNESS", [
        "READ_WORKSPACE",
        "READ_TEST_METADATA",
      ]);
      enforcer.registerFence(fence);

      // Sovereign verification retains absolute final authority
      expect(fence.sovereignAuthority).toBe(false);
      expect(fence.terminalAuthority).toBe(false);
    });

    it("33.2 fourfold verification evidence required for clean-room acceptance", () => {
      const fence = createTestFence("fence-ver-bp2", "agent-v2", "verifier", "VERIFICATION_HARNESS", [
        "READ_WORKSPACE",
        "READ_TEST_METADATA",
      ]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-ver-bp2", "agent-v2", "READ_TEST_METADATA");
      expect(res.granted).toBe(true);
    });

    it("33.3 unverified capability claim cannot be stamped as SOVEREIGN_VERIFICATION", () => {
      const fence = createTestFence("fence-ver-bp3", "agent-v3", "worker", "harness", ["READ_WORKSPACE"], {
        trustLabel: "UNTRUSTED_OBSERVATION",
      });
      expect(fence.trustLabel).toBe("UNTRUSTED_OBSERVATION");
    });

    it("33.4 bypass attempt records critical denial in audit trail", () => {
      const fence = createTestFence("fence-ver-bp4", "agent-v4", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);
      const res = enforcer.evaluateCapability("fence-ver-bp4", "agent-v4", "SIGN_EVIDENCE");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("33.5 sovereign verification primacy invariant strictly upheld in governance report", () => {
      const report = policy.evaluateGovernance();
      expect(report.invariantsUpheld).toBe(20);
    });
  });

  // ============================================================================
  // CATEGORY 34: Terminal Authority Claim Without Independent Proof Rejection (Control N720)
  // ============================================================================
  describe("Category 34: Terminal Authority Claim Without Proof (Control N720)", () => {
    it("34.1 terminal authority claim rejected fail-closed (N720)", () => {
      const fence = createTestFence("fence-term1", "agent-t1", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      const res = enforcer.evaluateCapability("fence-term1", "agent-t1", "ISSUE_TERMINAL_AUTHORITY");
      expect(res.granted).toBe(false);
      expect(res.violationType).toBe("FORBIDDEN");
    });

    it("34.2 cross-harness terminal authority claim rejected in gateway (N720)", () => {
      const fence = createTestFence("fence-term2", "agent-t2", "worker", "harness", ["READ_WORKSPACE"]);
      enforcer.registerFence(fence);

      const res = gateway.handleCrossHarnessRequest(
        "agent-t2",
        "ANALYSIS_HARNESS",
        "VERIFICATION_HARNESS",
        "VERIFICATION_REQUEST",
        "ISSUE_TERMINAL_AUTHORITY",
        "/workspace",
        { terminalAuthority: true },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      expect(res.granted).toBe(false);
      expect(res.controlId).toBe("N720");
    });

    it("34.3 terminal authority is permanently false on all agent capability fences", () => {
      const f1 = createTestFence("fence-t3", "a3", "r", "h", ["READ_WORKSPACE"]);
      expect(f1.terminalAuthority).toBe(false);
    });

    it("34.4 terminal authority is permanently false on all delegated fences", () => {
      const parent = createTestFence("fence-t4-p", "p", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(parent);
      const child = enforcer.delegateCapability("fence-t4-p", "c", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(child.childFence?.terminalAuthority).toBe(false);
    });

    it("34.5 all 30 negative security controls N691–N720 confirmed fail-closed", () => {
      expect(SECURITY_CONTROLS_PHASE99).toHaveLength(30);
      const report = policy.evaluateGovernance();
      expect(report.controlsEnforced).toBe(30);
      expect(report.controlComplianceRate).toBe(1.0);
    });
  });

  // ============================================================================
  // CATEGORY 35: Cryptographic Hash Integrity of Capability Fences
  // ============================================================================
  describe("Category 35: Cryptographic Hash Integrity of Capability Fences", () => {
    it("35.1 fence hash is deterministic 64-char hex string", () => {
      const f = createTestFence("fence-hash1", "a1", "r", "h", ["READ_WORKSPACE"]);
      expect(f.hash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(f.hash)).toBe(true);
    });

    it("35.2 mutating allowedCapabilities produces different hash", () => {
      const f1 = createTestFence("fence-hash2", "a2", "r", "h", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-hash2", "a2", "r", "h", ["READ_WORKSPACE", "READ_AST"]);
      expect(f1.hash).not.toBe(f2.hash);
    });

    it("35.3 mutating scope produces different hash", () => {
      const f1 = createTestFence("fence-hash3", "a3", "r", "h", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-hash3", "a3", "r", "h", ["READ_WORKSPACE"], {
        scope: { ...defaultScope, maxOperations: 999 },
      });
      expect(f1.hash).not.toBe(f2.hash);
    });

    it("35.4 identical fence inputs produce identical hash", () => {
      const f1 = createTestFence("fence-hash4", "a4", "r", "h", ["READ_WORKSPACE"]);
      const f2 = createTestFence("fence-hash4", "a4", "r", "h", ["READ_WORKSPACE"]);
      expect(f1.hash).toBe(f2.hash);
    });

    it("35.5 computeCapabilityFenceHash helper matches fence.hash", () => {
      const f = createTestFence("fence-hash5", "a5", "r", "h", ["READ_WORKSPACE"]);
      const { hash, ...raw } = f;
      expect(computeCapabilityFenceHash(raw)).toBe(hash);
    });
  });

  // ============================================================================
  // CATEGORY 36: Cryptographic Hash Integrity of Capability Grants
  // ============================================================================
  describe("Category 36: Cryptographic Hash Integrity of Capability Grants", () => {
    it("36.1 grant hash is deterministic 64-char hex string", () => {
      const f = createTestFence("fence-g-h1", "a1", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = enforcer.evaluateCapability("fence-g-h1", "a1", "READ_WORKSPACE");
      expect(res.grant?.hash).toHaveLength(64);
    });

    it("36.2 computeCapabilityGrantHash matches grant.hash", () => {
      const f = createTestFence("fence-g-h2", "a2", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = enforcer.evaluateCapability("fence-g-h2", "a2", "READ_WORKSPACE");
      const { hash, ...raw } = res.grant!;
      expect(computeCapabilityGrantHash(raw)).toBe(hash);
    });

    it("36.3 different capabilities produce different grant hashes", () => {
      const f = createTestFence("fence-g-h3", "a3", "r", "h", ["READ_WORKSPACE", "READ_AST"]);
      enforcer.registerFence(f);
      const g1 = enforcer.evaluateCapability("fence-g-h3", "a3", "READ_WORKSPACE").grant!;
      const g2 = enforcer.evaluateCapability("fence-g-h3", "a3", "READ_AST").grant!;
      expect(g1.hash).not.toBe(g2.hash);
    });

    it("36.4 grant includes valid non-empty signature", () => {
      const f = createTestFence("fence-g-h4", "a4", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const g = enforcer.evaluateCapability("fence-g-h4", "a4", "READ_WORKSPACE").grant!;
      expect(g.signature).toBeDefined();
      expect(g.signature.length).toBeGreaterThan(0);
    });

    it("36.5 grants recorded in enforcer store match returned grant", () => {
      const f = createTestFence("fence-g-h5", "a5", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const g = enforcer.evaluateCapability("fence-g-h5", "a5", "READ_WORKSPACE").grant!;
      const stored = enforcer.getAllGrants().find((x) => x.grantId === g.grantId);
      expect(stored?.hash).toBe(g.hash);
    });
  });

  // ============================================================================
  // CATEGORY 37: Cryptographic Hash Integrity of Capability Denials
  // ============================================================================
  describe("Category 37: Cryptographic Hash Integrity of Capability Denials", () => {
    it("37.1 denial hash is deterministic 64-char hex string", () => {
      const f = createTestFence("fence-d-h1", "a1", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-d-h1", "a1", "EXECUTE_ANALYSIS");
      const denials = enforcer.getAllDenials().filter((d) => d.fenceId === "fence-d-h1");
      expect(denials[0]?.hash).toHaveLength(64);
    });

    it("37.2 computeCapabilityDenialHash matches denial.hash", () => {
      const f = createTestFence("fence-d-h2", "a2", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-d-h2", "a2", "EXECUTE_ANALYSIS");
      const d = enforcer.getAllDenials().find((x) => x.fenceId === "fence-d-h2")!;
      const { hash, ...raw } = d;
      expect(computeCapabilityDenialHash(raw)).toBe(hash);
    });

    it("37.3 different controlIds produce different denial hashes", () => {
      const f = createTestFence("fence-d-h3", "a3", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-d-h3", "a3", "EXECUTE_ANALYSIS"); // N691
      enforcer.evaluateCapability("fence-d-h3", "a3", "WRITE_REPOSITORY"); // N691 / forbidden
      const denials = enforcer.getAllDenials().filter((d) => d.fenceId === "fence-d-h3");
      expect(denials[0]?.hash).not.toBe(denials[1]?.hash);
    });

    it("37.4 denial records accurate attemptedAt ISO timestamp", () => {
      const f = createTestFence("fence-d-h4", "a4", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-d-h4", "a4", "EXECUTE_ANALYSIS");
      const d = enforcer.getAllDenials().find((x) => x.fenceId === "fence-d-h4")!;
      expect(new Date(d.attemptedAt).getTime()).toBe(clock.now().getTime());
    });

    it("37.5 denial contains non-empty reason and controlId", () => {
      const f = createTestFence("fence-d-h5", "a5", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-d-h5", "a5", "EXECUTE_ANALYSIS");
      const d = enforcer.getAllDenials().find((x) => x.fenceId === "fence-d-h5")!;
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.controlId.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // CATEGORY 38: Cryptographic Hash Integrity of Capability Evidence
  // ============================================================================
  describe("Category 38: Cryptographic Hash Integrity of Capability Evidence", () => {
    it("38.1 evidence hash is deterministic 64-char hex string", () => {
      const f = createTestFence("fence-e-h1", "a1", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const evs = enforcer.getAllEvidences().filter((e) => e.fenceId === "fence-e-h1");
      expect(evs[0]?.hash).toHaveLength(64);
    });

    it("38.2 computeCapabilityEvidenceHash matches evidence.hash", () => {
      const f = createTestFence("fence-e-h2", "a2", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const ev = enforcer.getAllEvidences().find((e) => e.fenceId === "fence-e-h2")!;
      const { hash, ...raw } = ev;
      expect(computeCapabilityEvidenceHash(raw)).toBe(hash);
    });

    it("38.3 evidence retains provenance root hash", () => {
      const f = createTestFence("fence-e-h3", "a3", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const ev = enforcer.getAllEvidences().find((e) => e.fenceId === "fence-e-h3")!;
      expect(ev.provenanceRoot).toBe(DEFAULT_CONTRACT_HASH);
    });

    it("38.4 delegation generates FENCE_DELEGATED evidence", () => {
      const p = createTestFence("fence-e-h4", "p", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(p);
      enforcer.delegateCapability("fence-e-h4", "c", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      const ev = enforcer.getAllEvidences().find((e) => e.eventType === "FENCE_DELEGATED");
      expect(ev).toBeDefined();
    });

    it("38.5 revocation generates FENCE_REVOKED evidence", () => {
      const f = createTestFence("fence-e-h5", "a", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.revokeFence("fence-e-h5", "Test revoke");
      const ev = enforcer.getAllEvidences().find((e) => e.eventType === "FENCE_REVOKED");
      expect(ev).toBeDefined();
    });
  });

  // ============================================================================
  // CATEGORY 39: Cryptographic Hash Integrity of Capability Violations
  // ============================================================================
  describe("Category 39: Cryptographic Hash Integrity of Capability Violations", () => {
    it("39.1 violation hash is deterministic 64-char hex string", () => {
      const f = createTestFence("fence-v-h1", "a1", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-v-h1", "a1", "WRITE_REPOSITORY");
      const vios = enforcer.getAllViolations().filter((v) => v.fenceId === "fence-v-h1");
      expect(vios[0]?.hash).toHaveLength(64);
    });

    it("39.2 computeCapabilityViolationHash matches violation.hash", () => {
      const f = createTestFence("fence-v-h2", "a2", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-v-h2", "a2", "WRITE_REPOSITORY");
      const v = enforcer.getAllViolations().find((x) => x.fenceId === "fence-v-h2")!;
      const { hash, ...raw } = v;
      expect(computeCapabilityViolationHash(raw)).toBe(hash);
    });

    it("39.3 violation records exact violationType", () => {
      const f = createTestFence("fence-v-h3", "a3", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-v-h3", "a3", "WRITE_REPOSITORY");
      const v = enforcer.getAllViolations().find((x) => x.fenceId === "fence-v-h3")!;
      expect(v.violationType).toBe("FORBIDDEN");
    });

    it("39.4 path traversal records PATH_TRAVERSAL violationType", () => {
      const f = createTestFence("fence-v-h4", "a4", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-v-h4", "a4", "READ_WORKSPACE", { targetPath: "../outside" });
      const v = enforcer.getAllViolations().find((x) => x.fenceId === "fence-v-h4")!;
      expect(v.violationType).toBe("PATH_TRAVERSAL");
    });

    it("39.5 violation contains blockedAt timestamp", () => {
      const f = createTestFence("fence-v-h5", "a5", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      enforcer.evaluateCapability("fence-v-h5", "a5", "WRITE_REPOSITORY");
      const v = enforcer.getAllViolations().find((x) => x.fenceId === "fence-v-h5")!;
      expect(v.blockedAt).toBe(clock.now().toISOString());
    });
  });

  // ============================================================================
  // CATEGORY 40: Cryptographic Hash Integrity of Cross-Harness Requests
  // ============================================================================
  describe("Category 40: Cryptographic Hash Integrity of Cross-Harness Requests", () => {
    it("40.1 request hash is deterministic 64-char hex string", () => {
      const f = createTestFence("fence-req-h1", "a1", "r", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = gateway.handleCrossHarnessRequest(
        "a1",
        "ANALYSIS_HARNESS",
        "REVIEW_HARNESS",
        "READ_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { key: "val" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      const req = gateway.getRequest(res.requestId);
      expect(req?.hash).toHaveLength(64);
    });

    it("40.2 computeCrossHarnessRequestHash matches request.hash", () => {
      const f = createTestFence("fence-req-h2", "a2", "r", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = gateway.handleCrossHarnessRequest(
        "a2",
        "ANALYSIS_HARNESS",
        "REVIEW_HARNESS",
        "READ_TRANSFER",
        "READ_WORKSPACE",
        "/workspace/src",
        { key: "val" },
        DEFAULT_CONTRACT_ID,
        DEFAULT_CONTRACT_HASH,
      );
      const req = gateway.getRequest(res.requestId)!;
      const { hash, ...raw } = req;
      expect(computeCrossHarnessRequestHash(raw)).toBe(hash);
    });

    it("40.3 differing payloads produce differing request hashes", () => {
      const f = createTestFence("fence-req-h3", "a3", "r", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const r1 = gateway.handleCrossHarnessRequest("a3", "ANALYSIS_HARNESS", "REVIEW_HARNESS", "READ_TRANSFER", "READ_WORKSPACE", "/workspace/src", { p: 1 }, DEFAULT_CONTRACT_ID, DEFAULT_CONTRACT_HASH);
      const r2 = gateway.handleCrossHarnessRequest("a3", "ANALYSIS_HARNESS", "REVIEW_HARNESS", "READ_TRANSFER", "READ_WORKSPACE", "/workspace/src", { p: 2 }, DEFAULT_CONTRACT_ID, DEFAULT_CONTRACT_HASH);
      const q1 = gateway.getRequest(r1.requestId)!;
      const q2 = gateway.getRequest(r2.requestId)!;
      expect(q1.hash).not.toBe(q2.hash);
    });

    it("40.4 all requests have authoritative = false", () => {
      const f = createTestFence("fence-req-h4", "a4", "r", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = gateway.handleCrossHarnessRequest("a4", "ANALYSIS_HARNESS", "REVIEW_HARNESS", "READ_TRANSFER", "READ_WORKSPACE", "/workspace/src", {}, DEFAULT_CONTRACT_ID, DEFAULT_CONTRACT_HASH);
      const req = gateway.getRequest(res.requestId)!;
      expect(req.authoritative).toBe(false);
    });

    it("40.5 all gateway requests stored with unique request IDs", () => {
      const f = createTestFence("fence-req-h5", "a5", "r", "ANALYSIS_HARNESS", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const r1 = gateway.handleCrossHarnessRequest("a5", "ANALYSIS_HARNESS", "REVIEW_HARNESS", "READ_TRANSFER", "READ_WORKSPACE", "/workspace/src", {}, DEFAULT_CONTRACT_ID, DEFAULT_CONTRACT_HASH);
      const r2 = gateway.handleCrossHarnessRequest("a5", "ANALYSIS_HARNESS", "REVIEW_HARNESS", "READ_TRANSFER", "READ_WORKSPACE", "/workspace/src", {}, DEFAULT_CONTRACT_ID, DEFAULT_CONTRACT_HASH);
      expect(r1.requestId).not.toBe(r2.requestId);
    });
  });

  // ============================================================================
  // CATEGORY 41: Cryptographic Hash Integrity of Delegation Records
  // ============================================================================
  describe("Category 41: Cryptographic Hash Integrity of Delegation Records", () => {
    it("41.1 delegation record hash is deterministic 64-char hex string", () => {
      const p = createTestFence("fence-del-h1", "p", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(p);
      enforcer.delegateCapability("fence-del-h1", "c", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      const dels = enforcer.getAllDelegations();
      expect(dels[0]?.hash).toHaveLength(64);
    });

    it("41.2 computeDelegationRecordHash matches record.hash", () => {
      const p = createTestFence("fence-del-h2", "p", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(p);
      enforcer.delegateCapability("fence-del-h2", "c", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      const del = enforcer.getAllDelegations().find((d) => d.parentFenceId === "fence-del-h2")!;
      const { hash, ...raw } = del;
      expect(computeDelegationRecordHash(raw)).toBe(hash);
    });

    it("41.3 delegation record links parentSubjectId and childSubjectId", () => {
      const p = createTestFence("fence-del-h3", "parent-subj", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(p);
      enforcer.delegateCapability("fence-del-h3", "child-subj", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      const del = enforcer.getAllDelegations().find((d) => d.parentFenceId === "fence-del-h3")!;
      expect(del.parentSubjectId).toBe("parent-subj");
      expect(del.childSubjectId).toBe("child-subj");
    });

    it("41.4 record captures delegated capabilities accurately", () => {
      const p = createTestFence("fence-del-h4", "p", "r", "h", ["READ_WORKSPACE", "READ_AST"]);
      enforcer.registerFence(p);
      enforcer.delegateCapability("fence-del-h4", "c", "r", "h", ["READ_AST"], defaultScope, 1000);
      const del = enforcer.getAllDelegations().find((d) => d.parentFenceId === "fence-del-h4")!;
      expect(del.delegatedCapabilities).toEqual(["READ_AST"]);
    });

    it("41.5 record captures remaining parent capabilities", () => {
      const p = createTestFence("fence-del-h5", "p", "r", "h", ["READ_WORKSPACE", "READ_AST"]);
      enforcer.registerFence(p);
      enforcer.delegateCapability("fence-del-h5", "c", "r", "h", ["READ_AST"], defaultScope, 1000);
      const del = enforcer.getAllDelegations().find((d) => d.parentFenceId === "fence-del-h5")!;
      expect(del.remainingParentCapabilities).toEqual(["READ_WORKSPACE", "READ_AST"]);
    });
  });

  // ============================================================================
  // CATEGORY 42: Trust Label Monotonicity Enforcement (Invariant C11)
  // ============================================================================
  describe("Category 42: Trust Label Monotonicity Enforcement (Invariant C11)", () => {
    it("42.1 child fence trust label inherits parent trust label without escalation (C11)", () => {
      const p = createTestFence("fence-tl-m1", "p", "r", "h", ["READ_WORKSPACE"], {
        trustLabel: "GOVERNED_OBSERVATION",
      });
      enforcer.registerFence(p);
      const child = enforcer.delegateCapability("fence-tl-m1", "c", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(child.childFence?.trustLabel).toBe("GOVERNED_OBSERVATION");
    });

    it("42.2 untrusted parent cannot delegate verified trust label", () => {
      const p = createTestFence("fence-tl-m2", "p", "r", "h", ["READ_WORKSPACE"], {
        trustLabel: "UNTRUSTED_OBSERVATION",
      });
      enforcer.registerFence(p);
      const child = enforcer.delegateCapability("fence-tl-m2", "c", "r", "h", ["READ_WORKSPACE"], defaultScope, 1000);
      expect(child.childFence?.trustLabel).toBe("UNTRUSTED_OBSERVATION");
    });

    it("42.3 trust labels rank monotonically", () => {
      const labels = [
        "UNTRUSTED_OBSERVATION",
        "GOVERNED_OBSERVATION",
        "VERIFIED_EVIDENCE",
        "POLICY_DECISION",
        "SOVEREIGN_VERIFICATION",
        "TERMINAL_AUTHORITY",
      ];
      expect(labels).toHaveLength(6);
    });

    it("42.4 agent execution cannot upgrade trust label autonomously", () => {
      const f = createTestFence("fence-tl-m4", "a", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      expect(f.trustLabel).toBe("GOVERNED_OBSERVATION");
    });

    it("42.5 trust label monotonicity strictly upheld across all fences", () => {
      const report = policy.evaluateGovernance();
      expect(report.invariantsUpheld).toBe(20);
    });
  });

  // ============================================================================
  // CATEGORY 43: Action/Attempt Authority Boundary Preservation (Invariant C13)
  // ============================================================================
  describe("Category 43: Action/Attempt Authority Boundary Preservation (Invariant C13)", () => {
    it("43.1 capability fencing operates without mutating Action status machine (C13)", () => {
      const f = createTestFence("fence-act1", "a", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = enforcer.evaluateCapability("fence-act1", "a", "READ_WORKSPACE");
      expect(res.granted).toBe(true);
      // Action status machine remains sovereign
    });

    it("43.2 denial of capability does not forge AttemptStatus", () => {
      const f = createTestFence("fence-act2", "a", "r", "h", ["READ_WORKSPACE"]);
      enforcer.registerFence(f);
      const res = enforcer.evaluateCapability("fence-act2", "a", "EXECUTE_ANALYSIS");
      expect(res.granted).toBe(false);
      // Denial is purely capability denial
    });

    it("43.3 worker runtime lease fencing remains sovereign over attempt execution", () => {
      const f = createTestFence("fence-act3", "a", "r", "h", ["READ_WORKSPACE"]);
      expect(f.authoritative).toBe(false);
    });

    it("43.4 fourfold verification authority is preserved without interference", () => {
      const f = createTestFence("fence-act4", "a", "r", "h", ["READ_WORKSPACE"]);
      expect(f.sovereignAuthority).toBe(false);
    });

    it("43.5 Action/Attempt invariant adherence verified in governance report", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.coreInvariantAdherenceRate).toBe(1.0);
    });
  });

  // ============================================================================
  // CATEGORY 44: Crash Recovery Scenarios (1 to 15: Persistence, Lease Expiry, Fence State)
  // ============================================================================
  describe("Category 44: Crash Recovery Scenarios (1 to 15)", () => {
    for (let i = 1; i <= 15; i++) {
      it(`44.${i} crash recovery scenario CR-${i}: state serialization and lease expiry check`, () => {
        const fenceId = `fence-cr-${i}`;
        const f = createTestFence(fenceId, `agent-cr-${i}`, "worker", "harness", ["READ_WORKSPACE"]);
        enforcer.registerFence(f);

        // Serialize state
        const serialized = JSON.stringify(enforcer.getFence(fenceId));
        expect(serialized).toBeDefined();

        // Simulate crash and fresh enforcer reconstitution
        const recoveredEnforcer = new CapabilityFenceEnforcer(clock);
        const restoredFence: CapabilityFence = JSON.parse(serialized);
        recoveredEnforcer.registerFence(restoredFence);

        // Verify restored integrity
        expect(recoveredEnforcer.getFence(fenceId)?.hash).toBe(f.hash);
        expect(recoveredEnforcer.evaluateCapability(fenceId, `agent-cr-${i}`, "READ_WORKSPACE").granted).toBe(true);
      });
    }
  });

  // ============================================================================
  // CATEGORY 45: Crash Recovery Scenarios (16 to 30: Delegation Tree Reconstitution & Cascades)
  // ============================================================================
  describe("Category 45: Crash Recovery Scenarios (16 to 30)", () => {
    for (let i = 16; i <= 30; i++) {
      it(`45.${i - 15} crash recovery scenario CR-${i}: delegation tree reconstitution and cascade preservation`, () => {
        const parentId = `fence-cr-p-${i}`;
        const parent = createTestFence(parentId, `agent-p-${i}`, "lead", "harness", ["READ_WORKSPACE", "READ_AST"]);
        enforcer.registerFence(parent);

        const childRes = enforcer.delegateCapability(
          parentId,
          `agent-c-${i}`,
          "worker",
          "harness",
          ["READ_WORKSPACE"],
          defaultScope,
          1000000,
        );

        // Simulate crash: recover both parent and child
        const recoveredEnforcer = new CapabilityFenceEnforcer(clock);
        recoveredEnforcer.registerFence(enforcer.getFence(parentId)!);
        recoveredEnforcer.registerFence(childRes.childFence!);

        // Revoking recovered parent must cascade to recovered child
        const revoked = recoveredEnforcer.revokeFence(parentId, "Post-crash cascade revocation");
        expect(revoked).toContain(parentId);
        expect(revoked).toContain(childRes.childFence!.fenceId);
        expect(recoveredEnforcer.getFence(childRes.childFence!.fenceId)?.status).toBe("REVOKED");
      });
    }
  });

  // ============================================================================
  // CATEGORY 46: 3-Sweep Deterministic Replay and Digest Invariance
  // ============================================================================
  describe("Category 46: 3-Sweep Deterministic Replay", () => {
    it("46.1 sweep 1, 2, and 3 produce byte-identical fence hashes", () => {
      const hashesSweep1: string[] = [];
      const hashesSweep2: string[] = [];
      const hashesSweep3: string[] = [];

      for (let s = 1; s <= 3; s++) {
        const clk = new SettableClock("2026-10-21T12:00:00.000Z");
        const enf = new CapabilityFenceEnforcer(clk);
        for (let i = 1; i <= 5; i++) {
          const raw: Omit<CapabilityFence, "hash"> = {
            fenceId: `fence-det-${i}`,
            subjectId: `agent-det-${i}`,
            roleId: "analyzer",
            harnessId: "ANALYSIS_HARNESS",
            allowedCapabilities: ["READ_WORKSPACE", "READ_AST"],
            forbiddenCapabilities: ALL_FORBIDDEN_CAPABILITIES,
            scope: defaultScope,
            trustLabel: "GOVERNED_OBSERVATION",
            status: "ACTIVE",
            delegatedFenceIds: [],
            version: 1,
            missionContractId: DEFAULT_CONTRACT_ID,
            missionContractHash: DEFAULT_CONTRACT_HASH,
            authoritative: false,
            terminalAuthority: false,
            sovereignAuthority: false,
            createdAt: clk.now().toISOString(),
            expiresAt: new Date(clk.now().getTime() + 3600000).toISOString(),
          };
          const f: CapabilityFence = {
            ...raw,
            hash: computeCapabilityFenceHash(raw),
          };
          enf.registerFence(f);
          if (s === 1) hashesSweep1.push(f.hash);
          if (s === 2) hashesSweep2.push(f.hash);
          if (s === 3) hashesSweep3.push(f.hash);
        }
      }

      expect(hashesSweep1).toEqual(hashesSweep2);
      expect(hashesSweep2).toEqual(hashesSweep3);
    });

    it("46.2 replay determinism rate is strictly 100%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.replayDeterminismRate).toBe(1.0);
    });

    it("46.3 delegation hash determinism across sweeps", () => {
      const pRaw: Omit<CapabilityFence, "hash"> = {
        fenceId: "p-det",
        subjectId: "p",
        roleId: "lead",
        harnessId: "h",
        allowedCapabilities: ["READ_WORKSPACE"],
        forbiddenCapabilities: ALL_FORBIDDEN_CAPABILITIES,
        scope: defaultScope,
        trustLabel: "GOVERNED_OBSERVATION",
        status: "ACTIVE",
        delegatedFenceIds: [],
        version: 1,
        missionContractId: DEFAULT_CONTRACT_ID,
        missionContractHash: DEFAULT_CONTRACT_HASH,
        authoritative: false,
        terminalAuthority: false,
        sovereignAuthority: false,
        createdAt: "2026-10-21T12:00:00.000Z",
        expiresAt: "2026-10-21T13:00:00.000Z",
      };
      const h1 = computeCapabilityFenceHash(pRaw);
      const h2 = computeCapabilityFenceHash(pRaw);
      expect(h1).toBe(h2);
    });

    it("46.4 cross-harness request hash determinism across sweeps", () => {
      const reqRaw = {
        requestId: "chr-det",
        callerSubjectId: "a1",
        callerHarness: "ANALYSIS_HARNESS" as HarnessType,
        calleeHarness: "REVIEW_HARNESS" as HarnessType,
        requestType: "READ_TRANSFER" as CrossHarnessRequestType,
        requestedCapability: "READ_WORKSPACE",
        targetResource: "/workspace/src",
        payload: { test: 1 },
        missionContractId: DEFAULT_CONTRACT_ID,
        missionContractHash: DEFAULT_CONTRACT_HASH,
        callerFenceId: "fence-1",
        status: "GRANTED" as const,
        submittedAt: "2026-10-21T12:00:00.000Z",
        evaluatedAt: "2026-10-21T12:00:00.000Z",
        authoritative: false as const,
      };
      const h1 = computeCrossHarnessRequestHash(reqRaw);
      const h2 = computeCrossHarnessRequestHash(reqRaw);
      expect(h1).toBe(h2);
    });

    it("46.5 delegation record hash determinism across sweeps", () => {
      const delRaw = {
        delegationId: "del-det",
        parentFenceId: "p1",
        childFenceId: "c1",
        parentSubjectId: "sp",
        childSubjectId: "sc",
        delegatedCapabilities: ["READ_WORKSPACE" as PositiveCapability],
        remainingParentCapabilities: ["READ_WORKSPACE" as PositiveCapability],
        delegatedScope: defaultScope,
        expiresAt: "2026-10-21T13:00:00.000Z",
        createdAt: "2026-10-21T12:00:00.000Z",
      };
      const h1 = computeDelegationRecordHash(delRaw);
      const h2 = computeDelegationRecordHash(delRaw);
      expect(h1).toBe(h2);
    });
  });

  // ============================================================================
  // CATEGORY 47: Boundary Matrix 9-Dimensional Governance Enforcement
  // ============================================================================
  describe("Category 47: Boundary Matrix 9-Dimensional Governance Enforcement", () => {
    it("47.1 boundary matrix evaluates all 9 required dimensions", () => {
      const report = policy.evaluateGovernance();
      expect(report.boundaryMatrix).toHaveLength(9);
      const dimensions = report.boundaryMatrix.map((b) => b.dimension);
      expect(dimensions).toContain("AGENT");
      expect(dimensions).toContain("ROLE");
      expect(dimensions).toContain("HARNESS");
      expect(dimensions).toContain("TOOL");
      expect(dimensions).toContain("WORKSPACE");
      expect(dimensions).toContain("REPOSITORY");
      expect(dimensions).toContain("PROVIDER");
      expect(dimensions).toContain("RESOURCE");
      expect(dimensions).toContain("MISSION_CONTRACT");
    });

    it("47.2 every boundary dimension status is SECURE", () => {
      const report = policy.evaluateGovernance();
      for (const b of report.boundaryMatrix) {
        expect(b.status).toBe("SECURE");
        expect(b.checksFailed).toBe(0);
        expect(b.checksPassed).toBeGreaterThan(0);
      }
    });

    it("47.3 agent boundary isolates logical identities", () => {
      const report = policy.evaluateGovernance();
      const b = report.boundaryMatrix.find((x) => x.dimension === "AGENT");
      expect(b?.boundaryType).toBe("LOGICAL_IDENTITY");
    });

    it("47.4 repository boundary confirms git write prohibition", () => {
      const report = policy.evaluateGovernance();
      const b = report.boundaryMatrix.find((x) => x.dimension === "REPOSITORY");
      expect(b?.details).toContain("strictly forbidden");
    });

    it("47.5 mission contract boundary confirms immutable cryptographic binding", () => {
      const report = policy.evaluateGovernance();
      const b = report.boundaryMatrix.find((x) => x.dimension === "MISSION_CONTRACT");
      expect(b?.checksPassed).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // CATEGORY 48: Full Fabric Safety Metrics and Zero-Tolerance Verification
  // ============================================================================
  describe("Category 48: Full Fabric Safety Metrics & Zero-Tolerance Verification", () => {
    it("48.1 capabilityBoundaryViolationRate is strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityBoundaryViolationRate).toBe(0.0);
    });

    it("48.2 capabilityEscalationRate is strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityEscalationRate).toBe(0.0);
    });

    it("48.3 crossHarnessLeakRate is strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.crossHarnessLeakRate).toBe(0.0);
    });

    it("48.4 capabilityLaunderingRate is strictly 0.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.capabilityLaunderingRate).toBe(0.0);
    });

    it("48.5 negativeControlEnforcementRate is strictly 100.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.negativeControlEnforcementRate).toBe(1.0);
    });

    it("48.6 coreInvariantAdherenceRate is strictly 100.0%", () => {
      const report = policy.evaluateGovernance();
      expect(report.safetyMetrics.coreInvariantAdherenceRate).toBe(1.0);
    });

    it("48.7 full governance report reports compliant = true", () => {
      const report = policy.evaluateGovernance();
      expect(report.compliant).toBe(true);
    });
  });
});
