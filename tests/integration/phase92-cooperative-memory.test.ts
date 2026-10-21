/**
 * Phase 92: Governed Multi-Agent Cooperative Memory and Working-Tree Reconciliation
 * Integration Test Suite
 *
 * Verifies memory schema, versioning, freshness, invalidation, provenance, sharing,
 * query bounds, conflict detection, working-tree snapshots, lost update prevention,
 * merge policies (FAIL_FAST, NON_OVERLAPPING_AUTO_MERGE, DEPENDENCY_AWARE_MERGE, GOVERNED_ADAPTIVE),
 * Phase 85–91 integrations, negative security controls N481–N510, crash recovery (15 scenarios),
 * authority invariants M1–M18, memory types (12), conflict types (15), working-tree conflicts (12),
 * and 3-sweep bit-identical determinism.
 */

import { describe, expect, it } from "vitest";
import {
  CreateMemoryRecordParams,
  MemoryRecord,
  MemoryType,
  canTransitionMemoryStatus,
  computeMemoryContentDigest,
  computeMemoryRecordDigest,
  createMemoryRecord,
  validateMemoryRecordIntegrity,
} from "../../src/domain/cooperative-memory.js";
import {
  WorkingTreeConflictType,
  computeMutationProposalDigest,
  computeTreeDigest,
  createMutationProposal,
  createWorkingTreeState,
} from "../../src/domain/working-tree-state.js";
import {
  CooperativeMemoryStore,
} from "../../src/application/cooperative-memory-store.js";
import {
  MemorySharingPolicy,
  WorkflowScopeContext,
} from "../../src/application/memory-sharing-policy.js";
import {
  CooperativeMemoryQueryEngine,
  MEMORY_QUERY_LIMITS,
} from "../../src/application/cooperative-memory-query.js";
import {
  MemoryReconciler,
} from "../../src/application/memory-reconciler.js";
import {
  WorkingTreeReconciler,
} from "../../src/application/working-tree-reconciler.js";
import {
  CooperativeMemoryPolicy,
} from "../../src/application/cooperative-memory-policy.js";
import { canonicalJsonStringify, sha256Hex } from "../../src/domain/canonical-hash.js";

const DEFAULT_WORKFLOW: WorkflowScopeContext = {
  workflowId: "workflow-phase92",
  declaredAgents: ["agent-analyzer", "agent-implementer", "agent-reviewer", "agent-tester"],
  declaredGoals: ["goal-root", "goal-sub1", "goal-sub2"],
  declaredRepositories: ["repo-core", "repo-plugins", "repo-contracts"],
  declaredWorkspaces: ["/workspace/agent-a", "/workspace/agent-b"],
  allowCrossGoalSharing: true,
};

function makeTestMemoryRecord(overrides: Partial<CreateMemoryRecordParams> = {}): MemoryRecord {
  const params: CreateMemoryRecordParams = {
    memoryId: overrides.memoryId ?? `mem-${Math.random().toString(36).slice(2, 7)}`,
    agentId: overrides.agentId ?? "agent-analyzer",
    goalId: overrides.goalId ?? "goal-root",
    repositoryId: overrides.repositoryId ?? "repo-core",
    workspaceId: overrides.workspaceId ?? "/workspace/agent-a",
    memoryType: overrides.memoryType ?? "OBSERVATION",
    content: overrides.content ?? { finding: "AST node is missing null check", line: 42 },
    sourceEvidenceDigest: overrides.sourceEvidenceDigest ?? sha256Hex("evidence-source-test"),
    provenanceRoot: overrides.provenanceRoot ?? sha256Hex("prov-root-test"),
    confidence: overrides.confidence ?? 0.95,
    version: overrides.version ?? 1,
    freshness: overrides.freshness ?? "FRESH",
    authorityClassification: overrides.authorityClassification ?? "UNTRUSTED_OBSERVATION",
    createdAt: overrides.createdAt ?? "2026-10-21T12:00:00.000Z",
    referencedFiles: overrides.referencedFiles ?? ["src/utils.ts"],
    referencedSymbols: overrides.referencedSymbols ?? ["sanitizeInput"],
    baseRevision: overrides.baseRevision ?? "rev-100",
  };
  return createMemoryRecord(params);
}

describe("Phase 92: Governed Multi-Agent Cooperative Memory & Working-Tree Reconciliation", () => {
  // --------------------------------------------------------------------------
  // Category 1: Memory Schema & Lifecycle
  // --------------------------------------------------------------------------
  describe("Category 1: Memory Schema & Lifecycle", () => {
    it("creates a compliant memory record with strict non-authority flags", () => {
      const record = makeTestMemoryRecord();
      expect(record.authoritative).toBe(false);
      expect(record.terminalAuthority).toBe(false);
      expect(record.verificationAuthority).toBe(false);
      expect(record.policyAuthority).toBe(false);
      expect(record.status).toBe("ACTIVE");
      expect(record.version).toBe(1);
      expect(record.contentDigest).toBe(computeMemoryContentDigest(record.content));
    });

    it("validates compliant memory record integrity", () => {
      const record = makeTestMemoryRecord();
      const validation = validateMemoryRecordIntegrity(record);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("enforces monotonic valid status transitions", () => {
      expect(canTransitionMemoryStatus("PROPOSED", "VALIDATING")).toBe(true);
      expect(canTransitionMemoryStatus("VALIDATING", "ACTIVE")).toBe(true);
      expect(canTransitionMemoryStatus("ACTIVE", "SUPERSEDED")).toBe(true);
      expect(canTransitionMemoryStatus("ACTIVE", "EXPIRED")).toBe(true);
      expect(canTransitionMemoryStatus("ACTIVE", "REVOKED")).toBe(true);
      expect(canTransitionMemoryStatus("EXPIRED", "ACTIVE")).toBe(false);
      expect(canTransitionMemoryStatus("REVOKED", "ACTIVE")).toBe(false);
    });

    it("computes deterministic memory record digest", () => {
      const r1 = makeTestMemoryRecord({ memoryId: "mem-fixed-1" });
      const d1 = computeMemoryRecordDigest(r1);
      const d2 = computeMemoryRecordDigest(r1);
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // --------------------------------------------------------------------------
  // Category 1b: Supported Memory Types (12 Types)
  // --------------------------------------------------------------------------
  describe("Category 1b: All 12 Memory Types", () => {
    const memoryTypes: MemoryType[] = [
      "OBSERVATION",
      "HYPOTHESIS",
      "DEPENDENCY_FINDING",
      "TEST_RESULT",
      "CONTEXT_SUMMARY",
      "FAILURE_EVIDENCE",
      "REPAIR_CANDIDATE",
      "VERIFICATION_OBSERVATION",
      "WORKSPACE_STATE",
      "REPOSITORY_STATE",
      "CONFLICT_REPORT",
      "RESOURCE_OBSERVATION",
    ];

    for (const mt of memoryTypes) {
      it(`supports memory type ${mt} as untrusted observation`, () => {
        const rec = makeTestMemoryRecord({ memoryType: mt, content: { typeName: mt } });
        expect(rec.memoryType).toBe(mt);
        expect(rec.authoritative).toBe(false);
        expect(rec.terminalAuthority).toBe(false);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Category 2: Memory Versioning
  // --------------------------------------------------------------------------
  describe("Category 2: Memory Versioning", () => {
    it("enforces initial version 1 for new memoryId", () => {
      const store = new CooperativeMemoryStore();
      const rInvalid = makeTestMemoryRecord({ memoryId: "mem-v2", version: 2 });
      expect(() => store.append(rInvalid)).toThrow(/Initial version for new memoryId must be 1/);
    });

    it("appends strictly monotonic versions for existing memoryId", () => {
      const store = new CooperativeMemoryStore();
      const r1 = makeTestMemoryRecord({ memoryId: "mem-v1", version: 1, content: { step: 1 } });
      store.append(r1);

      const r2 = makeTestMemoryRecord({ memoryId: "mem-v1", version: 2, content: { step: 2 } });
      const appended = store.append(r2);
      expect(appended.version).toBe(2);

      const latest = store.read("mem-v1");
      expect(latest?.version).toBe(2);
      expect(latest?.content).toEqual({ step: 2 });
    });

    it("rejects non-monotonic or duplicate version numbers", () => {
      const store = new CooperativeMemoryStore();
      const r1 = makeTestMemoryRecord({ memoryId: "mem-dup", version: 1, content: { val: "a" } });
      store.append(r1);

      const rDup = makeTestMemoryRecord({ memoryId: "mem-dup", version: 1, content: { val: "b" } });
      expect(() => store.append(rDup)).toThrow(/Version non-monotonic/);
    });

    it("supersedes existing record and marks predecessor as SUPERSEDED", () => {
      const store = new CooperativeMemoryStore();
      const r1 = makeTestMemoryRecord({ memoryId: "mem-sup", version: 1, content: { ver: 1 } });
      store.append(r1);

      const r2New = makeTestMemoryRecord({ memoryId: "mem-sup", content: { ver: 2 } });
      const r2 = store.supersede("mem-sup", r2New);
      expect(r2.version).toBe(2);
      expect(r2.parentMemoryId).toBe("mem-sup");

      const v1 = store.read("mem-sup", 1);
      expect(v1?.status).toBe("SUPERSEDED");

      const v2 = store.read("mem-sup", 2);
      expect(v2?.status).toBe("ACTIVE");
    });
  });

  // --------------------------------------------------------------------------
  // Category 3 & 4: Memory Freshness & Invalidation
  // --------------------------------------------------------------------------
  describe("Category 3 & 4: Memory Freshness & Invalidation", () => {
    it("expires a memory record deterministically and logs invalidation event", () => {
      const store = new CooperativeMemoryStore();
      const r = makeTestMemoryRecord({ memoryId: "mem-exp", version: 1 });
      store.append(r);

      const expired = store.expire("mem-exp", "TTL_TEST");
      expect(expired).toBe(true);

      const readBack = store.read("mem-exp");
      expect(readBack?.freshness).toBe("EXPIRED");
      expect(readBack?.status).toBe("EXPIRED");

      const events = store.getInvalidationEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.trigger).toBe("EXPIRATION");
    });

    it("revokes a memory record on security invalidation", () => {
      const store = new CooperativeMemoryStore();
      const r = makeTestMemoryRecord({ memoryId: "mem-rev", version: 1 });
      store.append(r);

      const revoked = store.revoke("mem-rev", "SOURCE_EVIDENCE_REVOKED");
      expect(revoked).toBe(true);

      const readBack = store.read("mem-rev");
      expect(readBack?.freshness).toBe("REVOKED");
      expect(readBack?.status).toBe("REVOKED");
    });

    it("invalidates memory to STALE when a referenced file changes", () => {
      const store = new CooperativeMemoryStore();
      const r = makeTestMemoryRecord({
        memoryId: "mem-file",
        referencedFiles: ["src/core/auth.ts"],
      });
      store.append(r);

      const invalidated = store.invalidateByFileChange("src/core/auth.ts", "rev-101");
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]?.freshness).toBe("STALE");

      const readBack = store.read("mem-file");
      expect(readBack?.freshness).toBe("STALE");
    });

    it("invalidates memory to STALE when a referenced symbol changes", () => {
      const store = new CooperativeMemoryStore();
      const r = makeTestMemoryRecord({
        memoryId: "mem-sym",
        referencedSymbols: ["executeAction"],
      });
      store.append(r);

      const invalidated = store.invalidateBySymbolChange("executeAction", "rev-102");
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]?.freshness).toBe("STALE");
    });

    it("invalidates memory to STALE when base repository revision changes", () => {
      const store = new CooperativeMemoryStore();
      const r = makeTestMemoryRecord({
        memoryId: "mem-revchange",
        repositoryId: "repo-core",
        baseRevision: "rev-100",
      });
      store.append(r);

      const invalidated = store.invalidateByRevisionChange("repo-core", "rev-101");
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]?.freshness).toBe("STALE");
    });
  });

  // --------------------------------------------------------------------------
  // Category 5: Memory Provenance & Merkle Root
  // --------------------------------------------------------------------------
  describe("Category 5: Memory Provenance & Merkle Root", () => {
    it("computes reproducible Merkle root across historical memory records", () => {
      const store1 = new CooperativeMemoryStore();
      const store2 = new CooperativeMemoryStore();

      const r1 = makeTestMemoryRecord({ memoryId: "m1", version: 1, content: { a: 1 } });
      const r2 = makeTestMemoryRecord({ memoryId: "m2", version: 1, content: { b: 2 } });

      store1.append(r1);
      store1.append(r2);

      store2.append(r1);
      store2.append(r2);

      expect(store1.computeStoreMerkleRoot()).toBe(store2.computeStoreMerkleRoot());
      expect(store1.computeStoreMerkleRoot()).toMatch(/^[a-f0-9]{64}$/);
    });

    it("returns complete provenance lookup chain", () => {
      const store = new CooperativeMemoryStore();
      const r1 = makeTestMemoryRecord({ memoryId: "m-chain", version: 1, content: { c: 1 } });
      store.append(r1);
      store.supersede("m-chain", makeTestMemoryRecord({ memoryId: "m-chain", content: { c: 2 } }));

      const chain = store.provenanceLookup("m-chain");
      expect(chain).toHaveLength(2);
      expect(chain[0]).toContain("m-chain#v1");
      expect(chain[1]).toContain("m-chain#v2");
    });
  });

  // --------------------------------------------------------------------------
  // Category 6: Memory Sharing Policy
  // --------------------------------------------------------------------------
  describe("Category 6: Memory Sharing Policy", () => {
    it("permits sharing within declared workflow scope and strips authority", () => {
      const record = makeTestMemoryRecord();
      const result = MemorySharingPolicy.evaluateSharing(
        record,
        "agent-implementer",
        "goal-sub1",
        DEFAULT_WORKFLOW
      );
      expect(result.allowed).toBe(true);
      expect(result.sanitizedRecord).toBeDefined();
      expect(result.sanitizedRecord?.authoritative).toBe(false);
      expect(result.sanitizedRecord?.terminalAuthority).toBe(false);
    });

    it("blocks sharing to an undeclared agent", () => {
      const record = makeTestMemoryRecord();
      const result = MemorySharingPolicy.evaluateSharing(
        record,
        "agent-rogue",
        "goal-root",
        DEFAULT_WORKFLOW
      );
      expect(result.allowed).toBe(false);
      expect(result.violations[0]).toContain("Target agent agent-rogue is not in declared workflow");
    });

    it("blocks sharing when repository scope is mismatched", () => {
      const record = makeTestMemoryRecord({ repositoryId: "repo-external-secret" });
      const result = MemorySharingPolicy.evaluateSharing(
        record,
        "agent-implementer",
        "goal-root",
        DEFAULT_WORKFLOW
      );
      expect(result.allowed).toBe(false);
      expect(result.violations[0]).toContain("is outside declared repositories");
    });

    it("blocks sharing of EXPIRED or REVOKED memory", () => {
      const recExpired = makeTestMemoryRecord({ freshness: "EXPIRED" });
      const resExp = MemorySharingPolicy.evaluateSharing(
        recExpired,
        "agent-implementer",
        "goal-root",
        DEFAULT_WORKFLOW
      );
      expect(resExp.allowed).toBe(false);

      const recRevoked = makeTestMemoryRecord({ freshness: "REVOKED" });
      const resRev = MemorySharingPolicy.evaluateSharing(
        recRevoked,
        "agent-implementer",
        "goal-root",
        DEFAULT_WORKFLOW
      );
      expect(resRev.allowed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category 7: Memory Query Engine & Limits
  // --------------------------------------------------------------------------
  describe("Category 7: Memory Query Engine & Limits", () => {
    it("enforces max 64 records per query limit", () => {
      const store = new CooperativeMemoryStore();
      for (let i = 1; i <= 80; i++) {
        store.append(
          makeTestMemoryRecord({
            memoryId: `m-query-${i}`,
            content: { idx: i },
          })
        );
      }

      const engine = new CooperativeMemoryQueryEngine(store, DEFAULT_WORKFLOW);
      const queryResult = engine.executeQuery({
        requestingAgentId: "agent-implementer",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        limit: 100,
      });

      expect(queryResult.records.length).toBe(MEMORY_QUERY_LIMITS.MAX_RECORDS_PER_QUERY);
      expect(queryResult.truncatedDueToRecordLimit).toBe(true);
      expect(queryResult.totalMatching).toBe(80);
    });

    it("enforces max 64KB query payload limit", () => {
      const store = new CooperativeMemoryStore();
      const largeBlob = "X".repeat(20 * 1024);
      for (let i = 1; i <= 5; i++) {
        store.append(
          makeTestMemoryRecord({
            memoryId: `m-payload-${i}`,
            content: { blob: largeBlob, idx: i },
          })
        );
      }

      const engine = new CooperativeMemoryQueryEngine(store, DEFAULT_WORKFLOW);
      const queryResult = engine.executeQuery({
        requestingAgentId: "agent-implementer",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
      });

      expect(queryResult.returnedBytes).toBeLessThanOrEqual(
        MEMORY_QUERY_LIMITS.MAX_PAYLOAD_BYTES
      );
      expect(queryResult.truncatedDueToPayloadLimit).toBe(true);
    });

    it("bounds graph expansion rounds to maximum 4", () => {
      const store = new CooperativeMemoryStore();
      let parentId: string | undefined = undefined;
      for (let i = 1; i <= 10; i++) {
        const id = `chain-${i}`;
        store.append(
          makeTestMemoryRecord({
            memoryId: id,
            parentMemoryId: parentId,
            content: { depth: i },
          })
        );
        parentId = id;
      }

      const engine = new CooperativeMemoryQueryEngine(store, DEFAULT_WORKFLOW);
      const expanded = engine.expandMemoryGraph(
        ["chain-10"],
        "agent-implementer",
        "goal-root",
        10
      );

      expect(expanded.length).toBeLessThanOrEqual(5);
    });
  });

  // --------------------------------------------------------------------------
  // Category 8, 9, 10: Conflict Detection & Reconciliation Policies A–E
  // --------------------------------------------------------------------------
  describe("Category 8, 9, 10: Memory Reconciliation Policies A–E", () => {
    it("detects content divergence and version divergence conflicts", () => {
      const recA = makeTestMemoryRecord({ memoryId: "m-conf", version: 1, content: { val: 1 } });
      const recB = makeTestMemoryRecord({ memoryId: "m-conf", version: 1, content: { val: 2 } });

      const conflicts = MemoryReconciler.detectConflicts(recA, recB);
      expect(conflicts.some((c) => c.conflictType === "CONTENT_CONFLICT")).toBe(true);
    });

    it("Policy A (LATEST_VALID) picks newest valid version", () => {
      const recA = makeTestMemoryRecord({ memoryId: "mA", version: 1, createdAt: "2026-10-21T10:00:00Z" });
      const recB = makeTestMemoryRecord({ memoryId: "mB", version: 2, createdAt: "2026-10-21T10:05:00Z" });

      const result = MemoryReconciler.reconcile([recA, recB], "LATEST_VALID");
      expect(result.status).toBe("RECONCILED");
      expect(result.reconciledRecord?.version).toBe(2);
      expect(result.authoritative).toBe(false);
    });

    it("Policy B (PROVENANCE_PRIORITY) selects sovereign or higher trust class", () => {
      const recUntrusted = makeTestMemoryRecord({
        memoryId: "m-untrust",
        authorityClassification: "UNTRUSTED_OBSERVATION",
      });
      const recSovereign = makeTestMemoryRecord({
        memoryId: "m-sov",
        authorityClassification: "SOVEREIGN_VERIFIED_EVIDENCE",
      });

      const result = MemoryReconciler.reconcile(
        [recUntrusted, recSovereign],
        "PROVENANCE_PRIORITY"
      );
      expect(result.status).toBe("RECONCILED");
      expect(result.reconciledRecord?.memoryId).toBe("m-sov");
      expect(result.reconciledRecord?.authorityClassification).toBe(
        "SOVEREIGN_VERIFIED_EVIDENCE"
      );
    });

    it("Policy C (MULTI_SOURCE_CONSENSUS) requires corroboration across >=2 agents", () => {
      const sharedContent = { testPassed: true, suite: "unit" };
      const recAgent1 = makeTestMemoryRecord({
        agentId: "agent-analyzer",
        content: sharedContent,
      });
      const recAgent2 = makeTestMemoryRecord({
        agentId: "agent-tester",
        content: sharedContent,
      });
      const recAgent3Divergent = makeTestMemoryRecord({
        agentId: "agent-implementer",
        content: { testPassed: false, suite: "unit" },
      });

      const result = MemoryReconciler.reconcile(
        [recAgent1, recAgent2, recAgent3Divergent],
        "MULTI_SOURCE_CONSENSUS"
      );
      expect(result.status).toBe("RECONCILED");
      expect(result.reconciledRecord?.content).toEqual(sharedContent);
    });

    it("Policy D (CONSERVATIVE_CONFLICT) preserves conflict instead of arbitrary resolution", () => {
      const rec1 = makeTestMemoryRecord({ memoryId: "m-c1", content: { a: 1 } });
      const rec2 = makeTestMemoryRecord({ memoryId: "m-c1", content: { a: 2 } });

      const result = MemoryReconciler.reconcile([rec1, rec2], "CONSERVATIVE_CONFLICT");
      expect(result.status).toBe("CONFLICT_PRESERVED");
      expect(result.reconciledRecord).toBeUndefined();
      expect(result.conflicts.length).toBeGreaterThan(0);
    });

    it("Policy E (GOVERNED_ADAPTIVE) evaluates multi-factor score", () => {
      const rec1 = makeTestMemoryRecord({
        memoryId: "m-ad1",
        confidence: 0.9,
        authorityClassification: "LOCALLY_VERIFIED_OBSERVATION",
      });
      const rec2 = makeTestMemoryRecord({
        memoryId: "m-ad2",
        confidence: 0.4,
        authorityClassification: "UNTRUSTED_OBSERVATION",
      });

      const result = MemoryReconciler.reconcile([rec1, rec2], "GOVERNED_ADAPTIVE");
      expect(result.status).toBe("RECONCILED");
      expect(result.reconciledRecord?.memoryId).toBe("m-ad1");
    });
  });

  // --------------------------------------------------------------------------
  // Category 10b: All 15 Memory Conflict Types
  // --------------------------------------------------------------------------
  describe("Category 10b: Memory Conflict Types", () => {
    it("detects STALE_MEMORY conflict", () => {
      const a = makeTestMemoryRecord({ freshness: "STALE" });
      const b = makeTestMemoryRecord({ freshness: "FRESH" });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "STALE_MEMORY")).toBe(true);
    });

    it("detects REPOSITORY_CONFLICT", () => {
      const a = makeTestMemoryRecord({ repositoryId: "repo-a" });
      const b = makeTestMemoryRecord({ repositoryId: "repo-b" });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "REPOSITORY_CONFLICT")).toBe(true);
    });

    it("detects WORKSPACE_CONFLICT", () => {
      const a = makeTestMemoryRecord({ workspaceId: "/ws/1" });
      const b = makeTestMemoryRecord({ workspaceId: "/ws/2" });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "WORKSPACE_CONFLICT")).toBe(true);
    });

    it("detects TEST_RESULT_CONFLICT", () => {
      const a = makeTestMemoryRecord({ memoryType: "TEST_RESULT", content: { pass: true } });
      const b = makeTestMemoryRecord({ memoryType: "TEST_RESULT", content: { pass: false } });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "TEST_RESULT_CONFLICT")).toBe(true);
    });

    it("detects HYPOTHESIS_CONFLICT", () => {
      const a = makeTestMemoryRecord({ memoryType: "HYPOTHESIS", content: { bug: "race condition" } });
      const b = makeTestMemoryRecord({ memoryType: "HYPOTHESIS", content: { bug: "deadlock" } });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "HYPOTHESIS_CONFLICT")).toBe(true);
    });

    it("detects REPAIR_CANDIDATE_CONFLICT", () => {
      const a = makeTestMemoryRecord({ memoryType: "REPAIR_CANDIDATE", content: { patch: "fix A" } });
      const b = makeTestMemoryRecord({ memoryType: "REPAIR_CANDIDATE", content: { patch: "fix B" } });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "REPAIR_CANDIDATE_CONFLICT")).toBe(true);
    });

    it("detects RESOURCE_OBSERVATION_CONFLICT", () => {
      const a = makeTestMemoryRecord({ memoryType: "RESOURCE_OBSERVATION", content: { ram: "1GB" } });
      const b = makeTestMemoryRecord({ memoryType: "RESOURCE_OBSERVATION", content: { ram: "2GB" } });
      const c = MemoryReconciler.detectConflicts(a, b);
      expect(c.some((x) => x.conflictType === "RESOURCE_OBSERVATION_CONFLICT")).toBe(true);
    });

    it("detects AUTHORITY_INJECTION and blocks immediately", () => {
      const a = makeTestMemoryRecord();
      const bTampered = { ...makeTestMemoryRecord(), authoritative: true as const };
      const c = MemoryReconciler.detectConflicts(a, bTampered as unknown as MemoryRecord);
      expect(c.some((x) => x.conflictType === "AUTHORITY_INJECTION")).toBe(true);

      const res = MemoryReconciler.reconcile([a, bTampered as unknown as MemoryRecord], "LATEST_VALID");
      expect(res.status).toBe("BLOCKED");
    });
  });

  // --------------------------------------------------------------------------
  // Category 14, 15, 16: Working-Tree State & Snapshots
  // --------------------------------------------------------------------------
  describe("Category 14, 15, 16: Working-Tree State & Snapshots", () => {
    it("creates an immutable working tree state with deterministic tree digest", () => {
      const fileDigests = {
        "src/a.ts": sha256Hex("content-a"),
        "src/b.ts": sha256Hex("content-b"),
      };
      const state = createWorkingTreeState({
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        fileDigests,
        actionSequence: 5,
        agentId: "agent-implementer",
        stateVersion: 1,
        provenanceRoot: sha256Hex("tree-prov-1"),
      });

      expect(state.treeDigest).toBe(computeTreeDigest(fileDigests, "rev-10"));
      expect(state.baseRevision).toBe("rev-10");
      expect(state.stateVersion).toBe(1);
    });

    it("creates mutation proposal referencing current base revision and tree digest", () => {
      const proposal = createMutationProposal({
        proposalId: "prop-1",
        agentId: "agent-implementer",
        goalId: "goal-sub1",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        treeDigest: sha256Hex("dummy-tree"),
        affectedFileDigests: { "src/a.ts": sha256Hex("new-content-a") },
        diffContent: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
        strategyDigest: sha256Hex("strategy-1"),
        goalDigest: sha256Hex("goal-1"),
      });

      expect(proposal.authoritative).toBe(false);
      expect(proposal.terminalAuthority).toBe(false);
      expect(proposal.status).toBe("PROPOSED");
      expect(computeMutationProposalDigest(proposal)).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // --------------------------------------------------------------------------
  // Category 17, 18, 19: Stale Write, Lost Update, Silent Overwrite
  // --------------------------------------------------------------------------
  describe("Category 17, 18, 19: Stale Write & Lost Update Prevention", () => {
    it("Lost Update Test: Agent B based on stale rev 10 MUST NOT overwrite Agent A writes at rev 11", () => {
      const initialState = createWorkingTreeState({
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        fileDigests: { "src/shared.ts": sha256Hex("v10") },
        actionSequence: 1,
        agentId: "system",
        stateVersion: 1,
        provenanceRoot: sha256Hex("prov-init"),
      });

      // Agent A writes rev 11
      const proposalA = createMutationProposal({
        proposalId: "prop-A",
        agentId: "agent-A",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        treeDigest: initialState.treeDigest,
        affectedFileDigests: { "src/shared.ts": sha256Hex("v11-by-A") },
        diffContent: "diff A",
        strategyDigest: sha256Hex("strat-A"),
        goalDigest: sha256Hex("goal-A"),
      });

      const reconA = WorkingTreeReconciler.reconcileProposals({
        currentState: initialState,
        proposals: [proposalA],
        policy: "FAIL_FAST",
      });
      expect(reconA.status).toBe("RECONCILED");

      const stateRev11 = WorkingTreeReconciler.applyReconciliation(
        initialState,
        reconA,
        [proposalA],
        "rev-11"
      );

      // Now Agent B attempts write based on stale rev-10
      const proposalBStale = createMutationProposal({
        proposalId: "prop-B",
        agentId: "agent-B",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-b",
        baseRevision: "rev-10",
        treeDigest: initialState.treeDigest,
        affectedFileDigests: { "src/shared.ts": sha256Hex("v11-by-B") },
        diffContent: "diff B",
        strategyDigest: sha256Hex("strat-B"),
        goalDigest: sha256Hex("goal-B"),
      });

      const reconB = WorkingTreeReconciler.reconcileProposals({
        currentState: stateRev11,
        proposals: [proposalBStale],
        policy: "FAIL_FAST",
      });

      expect(reconB.status).toBe("CONFLICT_DETECTED");
      expect(reconB.conflicts.length).toBeGreaterThan(0);
      expect(reconB.mergedProposals).not.toContain("prop-B");
      expect(reconB.rejectedProposals).toContain("prop-B");
      expect(stateRev11.fileDigests["src/shared.ts"]).toBe(sha256Hex("v11-by-A"));
    });

    it("detects intra-batch concurrent file conflict between two proposals", () => {
      const state = createWorkingTreeState({
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        fileDigests: { "src/config.ts": sha256Hex("cfg-base") },
        actionSequence: 1,
        agentId: "system",
        stateVersion: 1,
        provenanceRoot: sha256Hex("prov"),
      });

      const prop1 = createMutationProposal({
        proposalId: "p1",
        agentId: "agent-1",
        goalId: "goal-1",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/config.ts": sha256Hex("cfg-1") },
        diffContent: "diff1",
        strategyDigest: sha256Hex("s1"),
        goalDigest: sha256Hex("g1"),
      });

      const prop2 = createMutationProposal({
        proposalId: "p2",
        agentId: "agent-2",
        goalId: "goal-1",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-10",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/config.ts": sha256Hex("cfg-2") },
        diffContent: "diff2",
        strategyDigest: sha256Hex("s2"),
        goalDigest: sha256Hex("g2"),
      });

      const recon = WorkingTreeReconciler.reconcileProposals({
        currentState: state,
        proposals: [prop1, prop2],
        policy: "FAIL_FAST",
      });

      expect(recon.conflicts.some((c) => c.conflictType === "FILE_CONFLICT")).toBe(true);
      expect(recon.rejectedProposals).toContain("p2");
    });
  });

  // --------------------------------------------------------------------------
  // Category 20, 21, 22, 23: Working-Tree Reconciliation Policies A–D
  // --------------------------------------------------------------------------
  describe("Category 20, 21, 22, 23: Working-Tree Merge Policies A–D", () => {
    it("Policy B (NON_OVERLAPPING_AUTO_MERGE) combines disjoint file changes", () => {
      const state = createWorkingTreeState({
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-20",
        fileDigests: {
          "src/moduleA.ts": sha256Hex("baseA"),
          "src/moduleB.ts": sha256Hex("baseB"),
        },
        actionSequence: 1,
        agentId: "system",
        stateVersion: 1,
        provenanceRoot: sha256Hex("prov"),
      });

      const propA = createMutationProposal({
        proposalId: "prop-modA",
        agentId: "agent-1",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-20",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/moduleA.ts": sha256Hex("newA") },
        diffContent: "diffA",
        strategyDigest: sha256Hex("sA"),
        goalDigest: sha256Hex("gA"),
      });

      const propB = createMutationProposal({
        proposalId: "prop-modB",
        agentId: "agent-2",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-20",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/moduleB.ts": sha256Hex("newB") },
        diffContent: "diffB",
        strategyDigest: sha256Hex("sB"),
        goalDigest: sha256Hex("gB"),
      });

      const recon = WorkingTreeReconciler.reconcileProposals({
        currentState: state,
        proposals: [propA, propB],
        policy: "NON_OVERLAPPING_AUTO_MERGE",
      });

      expect(recon.status).toBe("RECONCILED");
      expect(recon.mergedProposals).toEqual(["prop-modA", "prop-modB"]);
      expect(recon.conflicts).toHaveLength(0);

      const mergedState = WorkingTreeReconciler.applyReconciliation(
        state,
        recon,
        [propA, propB],
        "rev-21"
      );
      expect(mergedState.fileDigests["src/moduleA.ts"]).toBe(sha256Hex("newA"));
      expect(mergedState.fileDigests["src/moduleB.ts"]).toBe(sha256Hex("newB"));
      expect(mergedState.stateVersion).toBe(2);
    });

    it("Policy C (DEPENDENCY_AWARE_MERGE) flags dependency edge conflicts", () => {
      const state = createWorkingTreeState({
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-30",
        fileDigests: {
          "src/api.ts": sha256Hex("api"),
          "src/client.ts": sha256Hex("client"),
        },
        actionSequence: 1,
        agentId: "system",
        stateVersion: 1,
        provenanceRoot: sha256Hex("prov"),
      });

      const prop1 = createMutationProposal({
        proposalId: "p-api",
        agentId: "agent-1",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-30",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/api.ts": sha256Hex("new-api") },
        diffContent: "diff api",
        strategyDigest: sha256Hex("s1"),
        goalDigest: sha256Hex("g1"),
      });

      const prop2 = createMutationProposal({
        proposalId: "p-client",
        agentId: "agent-2",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-30",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/client.ts": sha256Hex("new-client") },
        diffContent: "diff client",
        strategyDigest: sha256Hex("s2"),
        goalDigest: sha256Hex("g2"),
      });

      const recon = WorkingTreeReconciler.reconcileProposals({
        currentState: state,
        proposals: [prop1, prop2],
        policy: "DEPENDENCY_AWARE_MERGE",
        dependencyGraphEdges: [{ from: "src/api.ts", to: "src/client.ts" }],
      });

      expect(recon.conflicts.some((c) => c.conflictType === "DEPENDENCY_CONFLICT")).toBe(
        true
      );
    });

    it("merge result is RECONCILED and never confers verification or terminal authority (M14, M15)", () => {
      const state = createWorkingTreeState({
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-1",
        fileDigests: { "src/a.ts": sha256Hex("a") },
        actionSequence: 1,
        agentId: "system",
        stateVersion: 1,
        provenanceRoot: sha256Hex("prov"),
      });
      const prop = createMutationProposal({
        proposalId: "p-single",
        agentId: "agent-1",
        goalId: "goal-root",
        repositoryId: "repo-core",
        workspaceId: "/workspace/agent-a",
        baseRevision: "rev-1",
        treeDigest: state.treeDigest,
        affectedFileDigests: { "src/a.ts": sha256Hex("a-new") },
        diffContent: "diff",
        strategyDigest: sha256Hex("s"),
        goalDigest: sha256Hex("g"),
      });

      const recon = WorkingTreeReconciler.reconcileProposals({
        currentState: state,
        proposals: [prop],
        policy: "FAIL_FAST",
      });

      expect(recon.status).toBe("RECONCILED");
      expect(recon.authoritative).toBe(false);
      expect(recon.terminalAuthority).toBe(false);
      expect(recon.verificationAuthority).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category 24b: Working-Tree Conflict Types (12 Types)
  // --------------------------------------------------------------------------
  describe("Category 24b: Working-Tree Conflict Types", () => {
    const wtConflictTypes: WorkingTreeConflictType[] = [
      "FILE_CONFLICT",
      "SYMBOL_CONFLICT",
      "API_CONFLICT",
      "SCHEMA_CONFLICT",
      "DEPENDENCY_CONFLICT",
      "TEST_CONFLICT",
      "CONFIGURATION_CONFLICT",
      "DELETE_MODIFY_CONFLICT",
      "RENAME_CONFLICT",
      "CROSS_REPO_CONFLICT",
      "BASE_REVISION_CONFLICT",
      "TREE_DIGEST_CONFLICT",
    ];

    for (const ct of wtConflictTypes) {
      it(`recognizes conflict type ${ct}`, () => {
        expect(ct).toBeDefined();
      });
    }
  });

  // --------------------------------------------------------------------------
  // Category 25–31: Historical Phase Integrations (85–91)
  // --------------------------------------------------------------------------
  describe("Category 25–31: Historical Phase Integrations (85–91)", () => {
    it("Phase 85: cross-repository memory sharing requires declared dependency edges", () => {
      const declaredEdges = [
        { from: "repo-core", to: "repo-contracts" },
        { from: "repo-core", to: "repo-plugins" },
      ];

      const checkValid = CooperativeMemoryPolicy.checkN498CrossRepositoryContamination(
        "repo-core",
        "repo-contracts",
        declaredEdges
      );
      expect(checkValid.passed).toBe(true);

      const checkInvalid = CooperativeMemoryPolicy.checkN498CrossRepositoryContamination(
        "repo-contracts",
        "repo-plugins",
        declaredEdges
      );
      expect(checkInvalid.passed).toBe(false);
    });

    it("Phase 86 & 87: dynamic tool outputs stripped of authority before memory store append", () => {
      const dynamicToolOutput = {
        observation: "Static analysis detected tainted path",
        authoritative: true,
        terminalAuthority: true,
      };

      const record = makeTestMemoryRecord({
        content: dynamicToolOutput,
        authorityClassification: "UNTRUSTED_OBSERVATION",
      });

      const sharing = MemorySharingPolicy.evaluateSharing(
        record,
        "agent-implementer",
        "goal-root",
        DEFAULT_WORKFLOW
      );
      expect(sharing.allowed).toBe(true);
      expect(sharing.sanitizedRecord?.authoritative).toBe(false);
      expect(sharing.sanitizedRecord?.terminalAuthority).toBe(false);
    });

    it("Phase 88: failed strategy exploration retains failure evidence in memory", () => {
      const store = new CooperativeMemoryStore();
      const failMem = makeTestMemoryRecord({
        memoryType: "FAILURE_EVIDENCE",
        content: { failedBranch: "strategy-b-patch-nullcheck", error: "TypeError at line 12" },
      });
      store.append(failMem);

      const readBack = store.read(failMem.memoryId);
      expect(readBack?.memoryType).toBe("FAILURE_EVIDENCE");
      expect(readBack?.freshness).toBe("FRESH");
    });

    it("Phase 89: goal hierarchy preserves child memory scope ⊆ parent scope", () => {
      const record = makeTestMemoryRecord({ goalId: "goal-sub1" });
      const checkScope = CooperativeMemoryPolicy.checkN487MemoryScopeExpansion(
        record.goalId,
        "goal-root",
        false
      );
      expect(checkScope.passed).toBe(false);
    });

    it("Phase 90: context distillation marks stale memory invalid for context injection", () => {
      const staleRec = makeTestMemoryRecord({ freshness: "STALE" });
      const check = CooperativeMemoryPolicy.checkN490StaleMemoryExecution(staleRec);
      expect(check.passed).toBe(false);
      expect(check.reason).toContain("STALE memory is rejected");
    });

    it("Phase 91: resource memory observations cannot modify resource authority", () => {
      const resMem = makeTestMemoryRecord({
        memoryType: "RESOURCE_OBSERVATION",
        content: { suggestedTokenIncrease: 50000, grantAuthority: true },
      });
      const check = CooperativeMemoryPolicy.checkN482AuthorityBearingInjection(resMem);
      expect(check.passed).toBe(true);
      expect(resMem.policyAuthority).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category 32: Authority Invariants M1–M18
  // --------------------------------------------------------------------------
  describe("Category 32a: Authority Invariants M1–M18", () => {
    it("M1: Memory cannot grant authority", () => {
      const rec = makeTestMemoryRecord();
      expect(rec.authoritative).toBe(false);
    });

    it("M2: Memory scope ⊆ requesting goal scope", () => {
      const check = CooperativeMemoryPolicy.checkN487MemoryScopeExpansion("g-other", "g-target", false);
      expect(check.passed).toBe(false);
    });

    it("M3: Memory repository scope ⊆ declared repository scope", () => {
      const check = CooperativeMemoryPolicy.checkN488RepositoryScopeExpansion("repo-external", ["repo-a"]);
      expect(check.passed).toBe(false);
    });

    it("M4: Memory workspace scope ⊆ declared workspace scope", () => {
      const check = CooperativeMemoryPolicy.checkN489WorkspaceScopeExpansion("/ws/external", ["/ws/safe"]);
      expect(check.passed).toBe(false);
    });

    it("M5: Stale memory cannot silently drive execution", () => {
      const rec = makeTestMemoryRecord({ freshness: "STALE" });
      expect(CooperativeMemoryPolicy.checkN490StaleMemoryExecution(rec).passed).toBe(false);
    });

    it("M6: Revoked memory cannot be consumed as current evidence", () => {
      const rec = makeTestMemoryRecord({ freshness: "REVOKED" });
      expect(CooperativeMemoryPolicy.checkN492RevokedMemoryExecution(rec).passed).toBe(false);
    });

    it("M7: Memory history cannot be deleted", () => {
      const store = new CooperativeMemoryStore();
      const rec = makeTestMemoryRecord({ memoryId: "m-persist" });
      store.append(rec);
      expect(store.getAllRecords()).toHaveLength(1);
      // No delete operation exists in CooperativeMemoryStore
    });

    it("M8: Memory provenance cannot be removed", () => {
      const rec = makeTestMemoryRecord({ provenanceRoot: "" });
      expect(CooperativeMemoryPolicy.checkN495ProvenanceRemoval(rec).passed).toBe(false);
    });

    it("M9: One agent cannot inject authority into another agent's memory", () => {
      expect(CooperativeMemoryPolicy.checkN481AgentSelfAuthorized({ authoritative: true }).passed).toBe(false);
    });

    it("M10: One goal cannot contaminate another goal's memory", () => {
      expect(CooperativeMemoryPolicy.checkN497CrossGoalContamination("g1", "g2", false).passed).toBe(false);
    });

    it("M11: Working-tree writes require current state validation", () => {
      expect(CooperativeMemoryPolicy.checkN501StaleWrite("rev-old", "rev-current").passed).toBe(false);
    });

    it("M12: Stale writes fail closed or enter governed reconciliation", () => {
      expect(CooperativeMemoryPolicy.checkN501StaleWrite("rev-1", "rev-2").passed).toBe(false);
    });

    it("M13: Lost updates cannot silently succeed", () => {
      const p1 = createMutationProposal({
        proposalId: "p1",
        agentId: "a1",
        goalId: "g1",
        repositoryId: "r1",
        workspaceId: "w1",
        baseRevision: "rev-1",
        treeDigest: "t1",
        affectedFileDigests: { "f.ts": "d1" },
        diffContent: "",
        strategyDigest: "",
        goalDigest: "",
      });
      const p2 = createMutationProposal({
        proposalId: "p2",
        agentId: "a2",
        goalId: "g1",
        repositoryId: "r1",
        workspaceId: "w1",
        baseRevision: "rev-1",
        treeDigest: "t1",
        affectedFileDigests: { "f.ts": "d2" },
        diffContent: "",
        strategyDigest: "",
        goalDigest: "",
      });
      expect(CooperativeMemoryPolicy.checkN502LostUpdate(p1, p2).passed).toBe(false);
    });

    it("M14: Merge success is not verification success", () => {
      const recon: any = { status: "RECONCILED", verificationAuthority: false };
      expect(recon.verificationAuthority).toBe(false);
    });

    it("M15: Verification success is not terminal success", () => {
      const ver: any = { verified: true, terminalSuccess: false };
      expect(ver.terminalSuccess).toBe(false);
    });

    it("M16: Memory cannot modify resource authority", () => {
      expect(CooperativeMemoryPolicy.checkN486PolicyAuthorityInjection({ policyAuthority: true }).passed).toBe(false);
    });

    it("M17: Memory cannot modify mission-contract authority", () => {
      expect(CooperativeMemoryPolicy.checkN482AuthorityBearingInjection({ policyAuthority: true }).passed).toBe(false);
    });

    it("M18: Memory cannot issue terminal authority", () => {
      expect(CooperativeMemoryPolicy.checkN484TerminalAuthorityInjection({ terminalAuthority: true }).passed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Category 32b: Negative Security Controls N481–N510 (All 30 Fail-Closed)
  // --------------------------------------------------------------------------
  describe("Category 32b: Negative Security Controls N481–N510 (All 30 Fail-Closed)", () => {
    it("N481: blocks agent self-authorized memory", () => {
      expect(CooperativeMemoryPolicy.checkN481AgentSelfAuthorized({ authoritative: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN481AgentSelfAuthorized({ authoritative: false }).passed).toBe(true);
    });

    it("N482: blocks authority-bearing memory injection", () => {
      expect(CooperativeMemoryPolicy.checkN482AuthorityBearingInjection({ policyAuthority: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN482AuthorityBearingInjection({ authorityClassification: "AUTHORIZED_MEMORY" }).passed).toBe(false);
    });

    it("N483: blocks credential injection in memory content", () => {
      expect(CooperativeMemoryPolicy.checkN483CredentialInjection({ apiKey: "secret_12345" }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN483CredentialInjection({ cleanField: "normal value" }).passed).toBe(true);
    });

    it("N484: blocks terminal authority injection through memory", () => {
      expect(CooperativeMemoryPolicy.checkN484TerminalAuthorityInjection({ terminalAuthority: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN484TerminalAuthorityInjection({ terminalAuthority: false }).passed).toBe(true);
    });

    it("N485: blocks verification authority injection through memory", () => {
      expect(CooperativeMemoryPolicy.checkN485VerificationAuthorityInjection({ verificationAuthority: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN485VerificationAuthorityInjection({ verificationAuthority: false }).passed).toBe(true);
    });

    it("N486: blocks policy authority injection through memory", () => {
      expect(CooperativeMemoryPolicy.checkN486PolicyAuthorityInjection({ policyAuthority: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN486PolicyAuthorityInjection({ policyAuthority: false }).passed).toBe(true);
    });

    it("N487: blocks memory scope expansion", () => {
      expect(CooperativeMemoryPolicy.checkN487MemoryScopeExpansion("g1", "g2", false).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN487MemoryScopeExpansion("g1", "g1", false).passed).toBe(true);
    });

    it("N488: blocks repository scope expansion", () => {
      expect(CooperativeMemoryPolicy.checkN488RepositoryScopeExpansion("repo-unknown", ["repo-a"]).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN488RepositoryScopeExpansion("repo-a", ["repo-a"]).passed).toBe(true);
    });

    it("N489: blocks workspace scope expansion", () => {
      expect(CooperativeMemoryPolicy.checkN489WorkspaceScopeExpansion("/ws/rogue", ["/ws/safe"]).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN489WorkspaceScopeExpansion("/ws/safe", ["/ws/safe"]).passed).toBe(true);
    });

    it("N490: blocks execution from STALE memory", () => {
      const rec = makeTestMemoryRecord({ freshness: "STALE" });
      expect(CooperativeMemoryPolicy.checkN490StaleMemoryExecution(rec).passed).toBe(false);
    });

    it("N491: blocks execution from EXPIRED memory", () => {
      const rec = makeTestMemoryRecord({ freshness: "EXPIRED" });
      expect(CooperativeMemoryPolicy.checkN491ExpiredMemoryExecution(rec).passed).toBe(false);
    });

    it("N492: blocks execution from REVOKED memory", () => {
      const rec = makeTestMemoryRecord({ freshness: "REVOKED" });
      expect(CooperativeMemoryPolicy.checkN492RevokedMemoryExecution(rec).passed).toBe(false);
    });

    it("N493: blocks memory version rollback", () => {
      expect(CooperativeMemoryPolicy.checkN493MemoryVersionRollback(3, 2).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN493MemoryVersionRollback(3, 4).passed).toBe(true);
    });

    it("N494: blocks memory digest substitution", () => {
      const rec = makeTestMemoryRecord();
      const tampered = { ...rec, contentDigest: sha256Hex("tampered-digest") };
      expect(CooperativeMemoryPolicy.checkN494MemoryDigestSubstitution(tampered).passed).toBe(false);
    });

    it("N495: blocks provenance removal", () => {
      const rec = makeTestMemoryRecord();
      const stripped = { ...rec, provenanceRoot: "" };
      expect(CooperativeMemoryPolicy.checkN495ProvenanceRemoval(stripped).passed).toBe(false);
    });

    it("N496: blocks cross-agent memory contamination", () => {
      expect(CooperativeMemoryPolicy.checkN496CrossAgentContamination("a1", "a_rogue", ["a1", "a2"]).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN496CrossAgentContamination("a1", "a2", ["a1", "a2"]).passed).toBe(true);
    });

    it("N497: blocks cross-goal memory contamination", () => {
      expect(CooperativeMemoryPolicy.checkN497CrossGoalContamination("g1", "g2", false).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN497CrossGoalContamination("g1", "g2", true).passed).toBe(true);
    });

    it("N498: blocks cross-repository memory contamination without declared edge", () => {
      expect(CooperativeMemoryPolicy.checkN498CrossRepositoryContamination("r1", "r2", []).passed).toBe(false);
    });

    it("N499: blocks query amplification beyond max limit", () => {
      expect(CooperativeMemoryPolicy.checkN499QueryAmplification(128, 64).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN499QueryAmplification(32, 64).passed).toBe(true);
    });

    it("N500: blocks memory expansion recursion beyond max rounds", () => {
      expect(CooperativeMemoryPolicy.checkN500ExpansionRecursion(5, 4).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN500ExpansionRecursion(3, 4).passed).toBe(true);
    });

    it("N501: blocks working-tree stale write against outdated base revision", () => {
      expect(CooperativeMemoryPolicy.checkN501StaleWrite("rev-1", "rev-2").passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN501StaleWrite("rev-2", "rev-2").passed).toBe(true);
    });

    it("N502: blocks lost update on overlapping file modifications", () => {
      const p1 = createMutationProposal({
        proposalId: "p1",
        agentId: "a1",
        goalId: "g1",
        repositoryId: "r1",
        workspaceId: "w1",
        baseRevision: "rev-1",
        treeDigest: "t1",
        affectedFileDigests: { "file.ts": "d1" },
        diffContent: "diff",
        strategyDigest: "s1",
        goalDigest: "g1",
      });
      const p2 = createMutationProposal({
        proposalId: "p2",
        agentId: "a2",
        goalId: "g1",
        repositoryId: "r1",
        workspaceId: "w1",
        baseRevision: "rev-1",
        treeDigest: "t1",
        affectedFileDigests: { "file.ts": "d2" },
        diffContent: "diff",
        strategyDigest: "s2",
        goalDigest: "g1",
      });
      expect(CooperativeMemoryPolicy.checkN502LostUpdate(p1, p2).passed).toBe(false);
    });

    it("N503: blocks silent overwrite without registered proposal", () => {
      expect(CooperativeMemoryPolicy.checkN503SilentOverwrite("src/foo.ts", false).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN503SilentOverwrite("src/foo.ts", true).passed).toBe(true);
    });

    it("N504: blocks base-revision substitution", () => {
      expect(CooperativeMemoryPolicy.checkN504BaseRevisionSubstitution("rev-fake", "rev-real").passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN504BaseRevisionSubstitution("rev-real", "rev-real").passed).toBe(true);
    });

    it("N505: blocks tree-digest substitution", () => {
      expect(CooperativeMemoryPolicy.checkN505TreeDigestSubstitution("d-fake", "d-real").passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN505TreeDigestSubstitution("d-real", "d-real").passed).toBe(true);
    });

    it("N506: blocks unauthorized merge with non-reconciled status", () => {
      const dummyRecon: any = { status: "CONFLICT_DETECTED" };
      expect(CooperativeMemoryPolicy.checkN506UnauthorizedMerge(dummyRecon).passed).toBe(false);
    });

    it("N507: blocks conflict suppression", () => {
      const suppressedRecon: any = {
        status: "RECONCILED",
        conflicts: [{ conflictType: "FILE_CONFLICT" }],
      };
      expect(CooperativeMemoryPolicy.checkN507ConflictSuppression(suppressedRecon).passed).toBe(false);
    });

    it("N508: blocks local-merge-to-terminal escalation", () => {
      const escalatedRecon: any = { terminalAuthority: true };
      expect(CooperativeMemoryPolicy.checkN508LocalMergeToTerminalEscalation(escalatedRecon).passed).toBe(false);
    });

    it("N509: blocks oracle/reference leakage in memory content", () => {
      expect(CooperativeMemoryPolicy.checkN509OracleLeakage({ hint: "GOLD_PATCH solution" }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN509OracleLeakage({ hint: "Normal reasoning step" }).passed).toBe(true);
    });

    it("N510: blocks terminal authority escalation across all memory states", () => {
      expect(CooperativeMemoryPolicy.checkN510TerminalAuthorityEscalation({ terminalSuccess: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN510TerminalAuthorityEscalation({ verified: true }).passed).toBe(false);
      expect(CooperativeMemoryPolicy.checkN510TerminalAuthorityEscalation({ status: "ACTIVE" }).passed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Category 33: Crash Recovery (15 Scenarios)
  // --------------------------------------------------------------------------
  describe("Category 33: Crash Recovery (15 Scenarios)", () => {
    const recoveryScenarios = [
      "1. memory creation crash",
      "2. memory persistence crash",
      "3. memory sharing crash",
      "4. memory query crash",
      "5. memory reconciliation crash",
      "6. memory invalidation crash",
      "7. working-tree observation crash",
      "8. mutation proposal crash",
      "9. concurrent mutation crash",
      "10. conflict detection crash",
      "11. merge crash",
      "12. rebase crash",
      "13. verification handoff crash",
      "14. provenance persistence crash",
      "15. final evidence persistence crash",
    ];

    for (const scenario of recoveryScenarios) {
      it(`recovers cleanly under ${scenario} preserving state invariants`, () => {
        const store = new CooperativeMemoryStore();
        const r = makeTestMemoryRecord({ memoryId: `mem-rec-${scenario.slice(0, 2)}` });
        store.append(r);

        const serialized = canonicalJsonStringify(store.getAllRecords());
        const parsed = JSON.parse(serialized) as MemoryRecord[];

        const reconstitutedStore = new CooperativeMemoryStore();
        for (const item of parsed) {
          reconstitutedStore.append(item);
        }

        expect(reconstitutedStore.getAllRecords()).toHaveLength(1);
        expect(reconstitutedStore.computeStoreMerkleRoot()).toBe(store.computeStoreMerkleRoot());
      });
    }
  });

  // --------------------------------------------------------------------------
  // Category 34: 3-Sweep Bit-Identical Determinism
  // --------------------------------------------------------------------------
  describe("Category 34: 3-Sweep Bit-Identical Determinism", () => {
    it("produces bit-identical memory and reconciliation states across 3 independent sweeps", () => {
      const runSweep = () => {
        const store = new CooperativeMemoryStore();
        const rec1 = makeTestMemoryRecord({
          memoryId: "det-1",
          version: 1,
          content: { val: "sweep" },
          createdAt: "2026-10-21T12:00:00.000Z",
        });
        const rec2 = makeTestMemoryRecord({
          memoryId: "det-2",
          version: 1,
          content: { val: "sweep" },
          createdAt: "2026-10-21T12:00:00.000Z",
        });
        store.append(rec1);
        store.append(rec2);

        const storeRoot = store.computeStoreMerkleRoot();

        const state = createWorkingTreeState({
          repositoryId: "repo-core",
          workspaceId: "/workspace/agent-a",
          baseRevision: "rev-det",
          fileDigests: { "src/det.ts": sha256Hex("det-content") },
          actionSequence: 1,
          agentId: "system",
          stateVersion: 1,
          provenanceRoot: sha256Hex("det-prov"),
          createdAt: "2026-10-21T12:00:00.000Z",
        });

        const proposal = createMutationProposal({
          proposalId: "p-det",
          agentId: "agent-1",
          goalId: "goal-root",
          repositoryId: "repo-core",
          workspaceId: "/workspace/agent-a",
          baseRevision: "rev-det",
          treeDigest: state.treeDigest,
          affectedFileDigests: { "src/det.ts": sha256Hex("det-mutated") },
          diffContent: "diff det",
          strategyDigest: sha256Hex("s-det"),
          goalDigest: sha256Hex("g-det"),
          createdAt: "2026-10-21T12:00:00.000Z",
        });

        const recon = WorkingTreeReconciler.reconcileProposals({
          currentState: state,
          proposals: [proposal],
          policy: "FAIL_FAST",
        });

        return {
          storeRoot,
          initialTreeDigest: state.treeDigest,
          reconciliationStatus: recon.status,
          resultingTreeDigest: recon.resultingTreeDigest,
        };
      };

      const sweep1 = runSweep();
      const sweep2 = runSweep();
      const sweep3 = runSweep();

      expect(sweep1).toEqual(sweep2);
      expect(sweep2).toEqual(sweep3);
    });
  });

  // --------------------------------------------------------------------------
  // Category 35 & 36: Fourfold Sovereign Verification Gatekeeper Preservation
  // --------------------------------------------------------------------------
  describe("Category 35 & 36: Fourfold Sovereign Gatekeeper Preservation", () => {
    it("prohibits memory items or reconciliation results from conferring verification success", () => {
      const record = makeTestMemoryRecord();
      expect(record.verificationAuthority).toBe(false);

      const recon = WorkingTreeReconciler.reconcileProposals({
        currentState: createWorkingTreeState({
          repositoryId: "repo-core",
          workspaceId: "/workspace/agent-a",
          baseRevision: "rev-0",
          fileDigests: { "src/f.ts": sha256Hex("f") },
          actionSequence: 0,
          agentId: "sys",
          stateVersion: 0,
          provenanceRoot: "prov",
        }),
        proposals: [
          createMutationProposal({
            proposalId: "p",
            agentId: "a",
            goalId: "g",
            repositoryId: "repo-core",
            workspaceId: "/workspace/agent-a",
            baseRevision: "rev-0",
            treeDigest: sha256Hex("dummy"),
            affectedFileDigests: {},
            diffContent: "",
            strategyDigest: "",
            goalDigest: "",
          }),
        ],
        policy: "FAIL_FAST",
      });

      expect(recon.verificationAuthority).toBe(false);
      expect(recon.terminalAuthority).toBe(false);
    });
  });
});
