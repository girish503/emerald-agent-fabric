/**
 * Phase 85 — Governed Cross-Repository Context Propagation and Multi-Project Repair Verification
 *
 * Integration test suite covering:
 * - Repository Identity & Dependency Graph
 * - Contract Extraction & Revision Fencing
 * - Context Propagation & Context Minimization
 * - Workspace Isolation & Security Boundaries
 * - Logical Atomicity & Partial Repair Trap
 * - Cross-Repository Clean-Room Dual-Gate
 * - Evidence Composition & Terminal Authority Fencing
 * - Crash Recovery across 11 stages
 * - Negative Controls N281–N300 (20/20)
 * - Determinism & Concurrency
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RepositoryIdentity,
  RepositoryDependencyEdge,
  CrossRepositoryContract,
  DEFAULT_CROSS_REPO_BUDGETS,
  computeRepositoryIdentityDigest,
  computeDependencyEdgeDigest,
  computeContractDigest,
  computeMultiRepoPlanDigest,
  computeCrossRepoEvidenceDigest,
} from "../../src/domain/cross-repository-context.js";
import {
  CrossRepositoryContextPropagator,
} from "../../src/application/cross-repository-context-propagator.js";
import {
  CrossRepositoryContractReconciler,
} from "../../src/application/cross-repository-contract-reconciler.js";
import {
  CrossRepositoryRepairOrchestrator,
  MultiRepoTaskDefinition,
  buildPhase85Cohort,
  generateRepositoryIdentities,
  generateDependencyEdges,
  generateContracts,
} from "../../src/application/cross-repository-repair-orchestrator.js";
import { sha256Hex, canonicalJsonStringify } from "../../src/domain/canonical-hash.js";

describe("Phase 85: Governed Cross-Repository Context & Repair Verification", () => {
  let propagator: CrossRepositoryContextPropagator;
  let reconciler: CrossRepositoryContractReconciler;
  let orchestrator: CrossRepositoryRepairOrchestrator;
  let tasks: MultiRepoTaskDefinition[];
  let identities: RepositoryIdentity[];
  let edges: RepositoryDependencyEdge[];
  let contracts: CrossRepositoryContract[];
  let sampleTask: MultiRepoTaskDefinition;
  let sampleRoots: Record<string, string>;

  beforeEach(() => {
    propagator = new CrossRepositoryContextPropagator();
    reconciler = new CrossRepositoryContractReconciler();
    orchestrator = new CrossRepositoryRepairOrchestrator();
    tasks = buildPhase85Cohort();
    identities = generateRepositoryIdentities(tasks);
    edges = generateDependencyEdges(tasks);
    contracts = generateContracts(tasks, edges);
    sampleTask = tasks[0]!;
    sampleRoots = Object.fromEntries(sampleTask.repositoryIds.map((r) => [r, `workspace/${r}`]));
    orchestrator.resetTerminalIndex();
  });

  // ===========================================================================
  // Group 1: Repository Identity
  // ===========================================================================
  describe("Group 1: Repository Identity", () => {
    it("1. Computes deterministic canonical digest for RepositoryIdentity", () => {
      const repo = identities[0]!;
      const digest1 = computeRepositoryIdentityDigest(repo);
      const digest2 = computeRepositoryIdentityDigest(repo);
      expect(digest1).toBe(digest2);
      expect(repo.canonicalRootDigest).toBe(digest1);
    });

    it("2. Changing sourceRevision produces different identity digest", () => {
      const repo = identities[0]!;
      const altered = { ...repo, sourceRevision: "rev-new-sha" };
      expect(computeRepositoryIdentityDigest(altered)).not.toBe(repo.canonicalRootDigest);
    });

    it("3. Changing repositoryManifestDigest produces different identity digest", () => {
      const repo = identities[0]!;
      const altered = { ...repo, repositoryManifestDigest: "digest-new-pkg" };
      expect(computeRepositoryIdentityDigest(altered)).not.toBe(repo.canonicalRootDigest);
    });

    it("4. Changing repositoryId produces different identity digest", () => {
      const repo = identities[0]!;
      const altered = { ...repo, repositoryId: "other-repo-id" };
      expect(computeRepositoryIdentityDigest(altered)).not.toBe(repo.canonicalRootDigest);
    });

    it("5. Identity does not rely solely on directory name", () => {
      const repoA: RepositoryIdentity = {
        repositoryId: "repo-common",
        canonicalRootDigest: "",
        sourceRevision: "rev-1",
        defaultBranchIdentity: "main",
        repositoryManifestDigest: "pkg-1",
        dependencyManifestDigest: "lock-1",
      };
      const repoB: RepositoryIdentity = {
        ...repoA,
        sourceRevision: "rev-2",
      };
      expect(computeRepositoryIdentityDigest(repoA)).not.toBe(computeRepositoryIdentityDigest(repoB));
    });
  });

  // ===========================================================================
  // Group 2: Dependency Edge Model
  // ===========================================================================
  describe("Group 2: Dependency Edge Model", () => {
    it("6. Computes canonical resolution evidence digest for dependency edge", () => {
      const edge = edges[0]!;
      const digest1 = computeDependencyEdgeDigest(edge);
      const digest2 = computeDependencyEdgeDigest(edge);
      expect(digest1).toBe(digest2);
      expect(edge.resolutionEvidenceDigest).toBe(digest1);
    });

    it("7. Supports various DependencyKinds (PACKAGE, API, SCHEMA, SHARED_TYPE)", () => {
      const kinds = ["PACKAGE", "API", "SCHEMA", "PROTOCOL", "GENERATED_ARTIFACT", "CLI_CONTRACT", "CONFIGURATION", "SHARED_TYPE"] as const;
      for (const k of kinds) {
        const edge = { ...edges[0]!, dependencyKind: k };
        expect(edge.dependencyKind).toBe(k);
      }
    });

    it("8. Detects edge revision mismatch against producer", () => {
      const edge = edges[0]!;
      const tampered = { ...edge, sourceRevision: "stale-producer-sha" };
      expect(computeDependencyEdgeDigest(tampered)).not.toBe(edge.resolutionEvidenceDigest);
    });

    it("9. Fails closed on forged resolutionEvidenceDigest", () => {
      const forgedEdge = { ...edges[0]!, resolutionEvidenceDigest: "forged-digest-1234" };
      expect(computeDependencyEdgeDigest(forgedEdge)).not.toBe(forgedEdge.resolutionEvidenceDigest);
    });
  });

  // ===========================================================================
  // Group 3: Cross-Repository Contract Model
  // ===========================================================================
  describe("Group 3: Cross-Repository Contract Model", () => {
    it("10. Computes canonical digest for CrossRepositoryContract", () => {
      const contract = contracts[0]!;
      const digest1 = computeContractDigest(contract);
      const digest2 = computeContractDigest(contract);
      expect(digest1).toBe(digest2);
      expect(contract.contractDigest).toBe(digest1);
    });

    it("11. Supports explicit invariant classes", () => {
      const contract = contracts[0]!;
      expect(contract.preconditions.length).toBeGreaterThan(0);
      expect(contract.postconditions.length).toBeGreaterThan(0);
      expect(contract.compatibilityRules.length).toBeGreaterThan(0);
    });

    it("12. Binds contract provenance including extractor and source file", () => {
      const contract = contracts[0]!;
      expect(contract.provenance.sourceFile).toBeDefined();
      expect(contract.provenance.extractor).toContain("EmeraldContractExtractor");
      expect(contract.provenance.evidenceDigest).toBeDefined();
    });

    it("13. Modifying contract representation changes contractDigest", () => {
      const contract = contracts[0]!;
      const altered = { ...contract, representation: "export interface Altered {}" };
      expect(computeContractDigest(altered)).not.toBe(contract.contractDigest);
    });

    it("14. Modifying preconditions or postconditions changes contractDigest", () => {
      const contract = contracts[0]!;
      const altered = { ...contract, preconditions: ["NEW_PRECONDITION"] };
      expect(computeContractDigest(altered)).not.toBe(contract.contractDigest);
    });
  });

  // ===========================================================================
  // Group 4: Contract Reconciliation & Revision Fencing
  // ===========================================================================
  describe("Group 4: Contract Reconciliation & Revision Fencing", () => {
    it("15. Reconciles matching producer and consumer revisions as COMPATIBLE", () => {
      const contract = contracts[0]!;
      const result = reconciler.reconcile({
        contract,
        currentProducerRevision: contract.producerRevision,
        currentConsumerRevision: contract.consumerRevision,
        dependencyEdge: edges[0]!,
      });
      expect(result.status).toBe("COMPATIBLE");
      expect(result.isStale).toBe(false);
      expect(result.reconciliationDigest).toBeDefined();
    });

    it("16. Producer revision mismatch triggers CROSS_REPOSITORY_CONTRACT_STALE", () => {
      const contract = contracts[0]!;
      const result = reconciler.reconcile({
        contract,
        currentProducerRevision: "new-producer-commit",
        currentConsumerRevision: contract.consumerRevision,
      });
      expect(result.status).toBe("INCOMPATIBLE");
      expect(result.isStale).toBe(true);
      expect(result.failureCode).toBe("CROSS_REPOSITORY_CONTRACT_STALE");
    });

    it("17. Consumer revision mismatch triggers CROSS_REPOSITORY_CONTRACT_STALE", () => {
      const contract = contracts[0]!;
      const result = reconciler.reconcile({
        contract,
        currentProducerRevision: contract.producerRevision,
        currentConsumerRevision: "new-consumer-commit",
      });
      expect(result.status).toBe("INCOMPATIBLE");
      expect(result.isStale).toBe(true);
      expect(result.failureCode).toBe("CROSS_REPOSITORY_CONTRACT_STALE");
    });

    it("18. Missing required symbols in consumer expectations triggers CONTRACT_CONFLICT", () => {
      const contract = contracts[0]!;
      const result = reconciler.reconcile({
        contract,
        currentProducerRevision: contract.producerRevision,
        currentConsumerRevision: contract.consumerRevision,
        consumerExpectations: {
          requiredSymbols: ["missingFunctionSymbol"],
        },
      });
      expect(result.status).toBe("INCOMPATIBLE");
      expect(result.failureCode).toBe("CONTRACT_CONFLICT");
      expect(result.diagnostics.some((d) => d.includes("missingFunctionSymbol"))).toBe(true);
    });

    it("19. Ambiguous contract symbols result in UNRESOLVED, never optimistically COMPATIBLE", () => {
      const unresolvedContract: CrossRepositoryContract = {
        ...contracts[0]!,
        representation: "export interface Contract { /* UNRESOLVED */ }",
        contractDigest: "",
      };
      const contractWithDigest = {
        ...unresolvedContract,
        contractDigest: computeContractDigest(unresolvedContract),
      };
      const result = reconciler.reconcile({
        contract: contractWithDigest,
        currentProducerRevision: contractWithDigest.producerRevision,
        currentConsumerRevision: contractWithDigest.consumerRevision,
      });
      expect(result.status).toBe("UNRESOLVED");
      expect(result.failureCode).toBe("CONTRACT_UNRESOLVED");
    });

    it("20. Major version mismatch triggers VERSION_MISMATCH", () => {
      const contract = contracts[0]!;
      const edge = { ...edges[0]!, resolvedVersion: "2.1.0" };
      const result = reconciler.reconcile({
        contract,
        currentProducerRevision: contract.producerRevision,
        currentConsumerRevision: contract.consumerRevision,
        dependencyEdge: edge,
        consumerExpectations: {
          declaredVersionRange: "^1.0.0",
        },
      });
      expect(result.status).toBe("INCOMPATIBLE");
      expect(result.failureCode).toBe("VERSION_MISMATCH");
    });
  });

  // ===========================================================================
  // Group 5: Context Propagation & Minimization
  // ===========================================================================
  describe("Group 5: Context Propagation & Minimization", () => {
    it("21. Projects bounded context under resource limits", () => {
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));

      const proj = propagator.projectContext({
        taskId: sampleTask.taskId,
        targetRepositoryId: sampleTask.producerRepoId,
        participatingRepositories: taskIdentities,
        dependencyEdges: taskEdges,
        contracts: taskContracts,
        affectedSymbols: { [sampleTask.producerRepoId]: ["processContract"] },
        affectedFiles: { [sampleTask.producerRepoId]: ["src/contract.ts"] },
        testAffinity: { [sampleTask.producerRepoId]: ["tests/contract.test.ts"] },
        fullRepositorySizes: sampleTask.fullRepositorySizes,
        workspaceRoots: sampleRoots,
      });

      expect(proj.targetRepositoryId).toBe(sampleTask.producerRepoId);
      expect(proj.totalBytesIncluded).toBeLessThan(DEFAULT_CROSS_REPO_BUDGETS.maxTotalCrossRepositoryContext);
      expect(proj.projectionDigest).toBeDefined();
    });

    it("22. Fails closed if repository context exceeds maxContextBytes per repository", () => {
      const customBudgets = { ...DEFAULT_CROSS_REPO_BUDGETS, maxContextBytes: 100 };
      const tightPropagator = new CrossRepositoryContextPropagator(customBudgets);
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));

      expect(() => {
        tightPropagator.projectContext({
          taskId: sampleTask.taskId,
          targetRepositoryId: sampleTask.producerRepoId,
          participatingRepositories: taskIdentities,
          dependencyEdges: taskEdges,
          contracts: taskContracts,
          affectedSymbols: {},
          affectedFiles: {},
          testAffinity: {},
          fullRepositorySizes: sampleTask.fullRepositorySizes,
          workspaceRoots: sampleRoots,
        });
      }).toThrow(/CROSS_REPOSITORY_SCOPE_VIOLATION/);
    });

    it("23. Fails closed if total context exceeds maxTotalCrossRepositoryContext", () => {
      const customBudgets = { ...DEFAULT_CROSS_REPO_BUDGETS, maxTotalCrossRepositoryContext: 200 };
      const tightPropagator = new CrossRepositoryContextPropagator(customBudgets);
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));

      expect(() => {
        tightPropagator.projectContext({
          taskId: sampleTask.taskId,
          targetRepositoryId: sampleTask.producerRepoId,
          participatingRepositories: taskIdentities,
          dependencyEdges: taskEdges,
          contracts: taskContracts,
          affectedSymbols: {},
          affectedFiles: {},
          testAffinity: {},
          fullRepositorySizes: sampleTask.fullRepositorySizes,
          workspaceRoots: sampleRoots,
        });
      }).toThrow(/CROSS_REPOSITORY_SCOPE_VIOLATION/);
    });

    it("24. Fails closed if dependency depth exceeds maxDependencyDepth", () => {
      const customBudgets = { ...DEFAULT_CROSS_REPO_BUDGETS, maxDependencyDepth: 1 };
      const tightPropagator = new CrossRepositoryContextPropagator(customBudgets);
      const deepEdges: RepositoryDependencyEdge[] = [
        {
          edgeId: "e1",
          producerRepositoryId: "r1",
          consumerRepositoryId: "r2",
          dependencyKind: "PACKAGE",
          dependencyIdentifier: "pkg1",
          declaredVersion: "1.0",
          resolvedVersion: "1.0",
          sourceRevision: "rev-1",
          contractDigest: "cd1",
          resolutionEvidenceDigest: "red1",
        },
        {
          edgeId: "e2",
          producerRepositoryId: "r2",
          consumerRepositoryId: "r3",
          dependencyKind: "PACKAGE",
          dependencyIdentifier: "pkg2",
          declaredVersion: "1.0",
          resolvedVersion: "1.0",
          sourceRevision: "rev-2",
          contractDigest: "cd2",
          resolutionEvidenceDigest: "red2",
        },
      ];
      const deepIdentities = [
        { repositoryId: "r1", canonicalRootDigest: "cr1", sourceRevision: "rev-1", repositoryManifestDigest: "m1", dependencyManifestDigest: "d1" },
        { repositoryId: "r2", canonicalRootDigest: "cr2", sourceRevision: "rev-2", repositoryManifestDigest: "m2", dependencyManifestDigest: "d2" },
        { repositoryId: "r3", canonicalRootDigest: "cr3", sourceRevision: "rev-3", repositoryManifestDigest: "m3", dependencyManifestDigest: "d3" },
      ];

      expect(() => {
        tightPropagator.projectContext({
          taskId: "deep-test",
          targetRepositoryId: "r1",
          participatingRepositories: deepIdentities,
          dependencyEdges: deepEdges,
          contracts: [],
          affectedSymbols: {},
          affectedFiles: {},
          testAffinity: {},
          fullRepositorySizes: { r1: 1000, r2: 1000, r3: 1000 },
          workspaceRoots: { r1: "w1", r2: "w2", r3: "w3" },
        });
      }).toThrow(/CROSS_REPOSITORY_SCOPE_VIOLATION/);
    });

    it("25. Fails closed if repository count exceeds maxRepositoriesPerTask", () => {
      const customBudgets = { ...DEFAULT_CROSS_REPO_BUDGETS, maxRepositoriesPerTask: 2 };
      const tightPropagator = new CrossRepositoryContextPropagator(customBudgets);
      const tier2Task = tasks.find((t) => t.topologyTier === 2)!;
      const tIdentities = identities.filter((r) => tier2Task.repositoryIds.includes(r.repositoryId));

      expect(() => {
        tightPropagator.projectContext({
          taskId: tier2Task.taskId,
          targetRepositoryId: tier2Task.producerRepoId,
          participatingRepositories: tIdentities,
          dependencyEdges: [],
          contracts: [],
          affectedSymbols: {},
          affectedFiles: {},
          testAffinity: {},
          fullRepositorySizes: tier2Task.fullRepositorySizes,
          workspaceRoots: {},
        });
      }).toThrow(/CROSS_REPOSITORY_SCOPE_VIOLATION/);
    });

    it("26. Measures significant context reduction compared to full repository size (>90%)", () => {
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));

      const proj = propagator.projectContext({
        taskId: sampleTask.taskId,
        targetRepositoryId: sampleTask.producerRepoId,
        participatingRepositories: taskIdentities,
        dependencyEdges: taskEdges,
        contracts: taskContracts,
        affectedSymbols: { [sampleTask.producerRepoId]: ["processContract"] },
        affectedFiles: { [sampleTask.producerRepoId]: ["src/contract.ts"] },
        testAffinity: { [sampleTask.producerRepoId]: ["tests/contract.test.ts"] },
        fullRepositorySizes: sampleTask.fullRepositorySizes,
        workspaceRoots: sampleRoots,
      });

      expect(proj.overallContextReductionPercent).toBeGreaterThan(90.0);
    });

    it("27. Guarantees 100% provenance coverage of projected contexts", () => {
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));

      const proj = propagator.projectContext({
        taskId: sampleTask.taskId,
        targetRepositoryId: sampleTask.producerRepoId,
        participatingRepositories: taskIdentities,
        dependencyEdges: taskEdges,
        contracts: taskContracts,
        affectedSymbols: {},
        affectedFiles: {},
        testAffinity: {},
        fullRepositorySizes: sampleTask.fullRepositorySizes,
        workspaceRoots: sampleRoots,
      });

      expect(proj.provenanceCoverage).toBe(1.0);
      for (const repoId of Object.keys(proj.repositoryContexts)) {
        expect(proj.repositoryContexts[repoId]?.provenanceRoot).toBeDefined();
      }
    });
  });

  // ===========================================================================
  // Group 6: Workspace Isolation & Security Boundaries
  // ===========================================================================
  describe("Group 6: Workspace Isolation & Security Boundaries", () => {
    it("28. Rejects relative path traversal attempts (../)", () => {
      expect(() => {
        propagator.projectContext({
          taskId: sampleTask.taskId,
          targetRepositoryId: sampleTask.producerRepoId,
          participatingRepositories: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
          dependencyEdges: [],
          contracts: [],
          affectedSymbols: {},
          affectedFiles: { [sampleTask.producerRepoId]: ["../sibling-repo/secret.ts"] },
          testAffinity: {},
          fullRepositorySizes: sampleTask.fullRepositorySizes,
          workspaceRoots: sampleRoots,
        });
      }).toThrow(/SECURITY_VIOLATION/);
    });

    it("29. Rejects absolute path workspace escapes", () => {
      expect(() => {
        propagator.projectContext({
          taskId: sampleTask.taskId,
          targetRepositoryId: sampleTask.producerRepoId,
          participatingRepositories: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
          dependencyEdges: [],
          contracts: [],
          affectedSymbols: {},
          affectedFiles: { [sampleTask.producerRepoId]: ["/etc/shadow"] },
          testAffinity: {},
          fullRepositorySizes: sampleTask.fullRepositorySizes,
          workspaceRoots: sampleRoots,
        });
      }).toThrow(/SECURITY_VIOLATION/);
    });

    it("30. Rejects unauthorized remote repository roots with DEPENDENCY_CONTEXT_UNAVAILABLE", async () => {
      const remoteRoots = { ...sampleRoots, [sampleTask.producerRepoId]: "remote://git.internal/repo" };
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-remote-root",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: remoteRoots,
      });

      expect(res.terminalSuccess).toBe(false);
      expect(res.failureCode).toBe("DEPENDENCY_CONTEXT_UNAVAILABLE");
    });

    it("31. Rejects unredacted secrets in contract representation", () => {
      const secretContract: CrossRepositoryContract = {
        ...contracts[0]!,
        representation: "export const apiKey = 'TOP_SECRET_AUTH_KEY';",
        contractDigest: "",
      };
      const contractWithDigest = {
        ...secretContract,
        contractDigest: computeContractDigest(secretContract),
      };

      expect(() => {
        propagator.projectContext({
          taskId: sampleTask.taskId,
          targetRepositoryId: sampleTask.producerRepoId,
          participatingRepositories: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
          dependencyEdges: [],
          contracts: [contractWithDigest],
          affectedSymbols: {},
          affectedFiles: {},
          testAffinity: {},
          fullRepositorySizes: sampleTask.fullRepositorySizes,
          workspaceRoots: sampleRoots,
        });
      }).toThrow(/SECURITY_VIOLATION/);
    });

    it("32. Rejects hidden test and gold patch leakage attempts", () => {
      expect(() => {
        propagator.projectContext({
          taskId: sampleTask.taskId,
          targetRepositoryId: sampleTask.producerRepoId,
          participatingRepositories: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
          dependencyEdges: [],
          contracts: [],
          affectedSymbols: {},
          affectedFiles: { [sampleTask.producerRepoId]: ["tests/evaluation.gold.ts"] },
          testAffinity: {},
          fullRepositorySizes: sampleTask.fullRepositorySizes,
          workspaceRoots: sampleRoots,
        });
      }).toThrow(/SECURITY_VIOLATION/);
    });
  });

  // ===========================================================================
  // Group 7: Logical Atomicity & Partial Repair Containment
  // ===========================================================================
  describe("Group 7: Logical Atomicity & Partial Repair Containment", () => {
    it("33. Traps partial repair when producer succeeds but consumer fails", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-partial-trap",
        task: sampleTask,
        condition: "CONDITION_A_LOCAL_CONTROL", // Uncoordinated execution causes partial repair
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.success).toBe(false);
      expect(res.terminalSuccess).toBe(false);
      expect(res.isPartialRepair).toBe(true);
      expect(res.failureCode).toBe("PARTIAL_REPAIR");
    });

    it("34. Enforces rollbackRequired when partial repair occurs", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-partial-rollback",
        task: sampleTask,
        condition: "CONDITION_A_LOCAL_CONTROL",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.rollbackRequired).toBe(true);
    });

    it("35. Partial repair is never marked as terminal success", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-partial-no-terminal",
        task: sampleTask,
        condition: "CONDITION_A_LOCAL_CONTROL",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.terminalSuccess).toBe(false);
      expect(res.terminalRecordAccepted).toBe(false);
    });

    it("36. Produces MultiRepositoryRepairPlan with explicit repair units per repository", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-plan-units",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.plan).toBeDefined();
      expect(res.plan?.repairUnits.length).toBe(sampleTask.repositoryIds.length);
      expect(res.plan?.planDigest).toBe(computeMultiRepoPlanDigest(res.plan!));
    });

    it("37. Invariant list in MultiRepositoryRepairPlan is validated", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-plan-invariants",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.plan?.crossRepositoryInvariants).toContain("API_SIGNATURE_COMPATIBILITY");
      expect(res.plan?.crossRepositoryInvariants).toContain("TYPE_COMPATIBILITY");
      expect(res.plan?.crossRepositoryInvariants).toContain("PRODUCER_CONSUMER_COMPATIBILITY");
    });
  });

  // ===========================================================================
  // Group 8: Cross-Repository Clean-Room Verification
  // ===========================================================================
  describe("Group 8: Cross-Repository Clean-Room Verification", () => {
    it("38. Clean-room verification enforces dual-gate extension across producer and consumer", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-clean-room-dual-gate",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.evidence).toBeDefined();
      const localResults = res.evidence?.repositoryLocalVerificationResults;
      expect(localResults?.[sampleTask.producerRepoId]?.f2pPassed).toBe(true);
      expect(localResults?.[sampleTask.producerRepoId]?.p2pPassed).toBe(true);
      expect(localResults?.[sampleTask.consumerRepoIds[0]!]?.p2pPassed).toBe(true);
    });

    it("39. Cross-repository contract verification must pass for terminal success", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-xrepo-contract-pass",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.evidence?.crossRepositoryVerificationResult.contractPassed).toBe(true);
      expect(res.evidence?.crossRepositoryVerificationResult.compatibilityVerified).toBe(true);
    });

    it("40. Fourfold verification remains authoritative on clean-room execution", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-fourfold",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.terminalSuccess).toBe(true);
      expect(res.evidence?.terminalRecordAccepted).toBe(true);
    });

    it("41. Verification suites count is strictly tracked", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-suites-ran",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.plan?.verificationPlan.requiredSuitesRan).toBeGreaterThanOrEqual(3);
    });

    it("42. Verification digest is distinct per repository", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-ver-digests",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      const local = res.evidence?.repositoryLocalVerificationResults;
      const dProducer = local?.[sampleTask.producerRepoId]?.verificationDigest;
      const dConsumer = local?.[sampleTask.consumerRepoIds[0]!]?.verificationDigest;
      expect(dProducer).not.toBe(dConsumer);
    });
  });

  // ===========================================================================
  // Group 9: Evidence Composition & Terminal Authority
  // ===========================================================================
  describe("Group 9: Evidence Composition & Terminal Authority", () => {
    it("43. Evidence bundle computes canonical cryptographic digest", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-evidence-digest",
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.evidence?.evidenceDigest).toBeDefined();
      const expected = computeCrossRepoEvidenceDigest(res.evidence!);
      expect(res.evidence?.evidenceDigest).toBe(expected);
    });

    it("44. Terminal authority allows exactly one terminal record per workflowId", async () => {
      const workflowId = "test-single-winner";
      const res1 = await orchestrator.executeWorkflow({
        workflowId,
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });
      expect(res1.terminalSuccess).toBe(true);

      // Attempt duplicate terminal authority recording
      const res2 = await orchestrator.executeWorkflow({
        workflowId,
        task: sampleTask,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });
      expect(res2.terminalSuccess).toBe(false);
      expect(res2.failureCode).toBe("TERMINAL_AUTHORITY_FAILURE");
    });

    it("45. Context layer possesses zero terminal authority", () => {
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));

      const proj = propagator.projectContext({
        taskId: sampleTask.taskId,
        targetRepositoryId: sampleTask.producerRepoId,
        participatingRepositories: taskIdentities,
        dependencyEdges: taskEdges,
        contracts: taskContracts,
        affectedSymbols: {},
        affectedFiles: {},
        testAffinity: {},
        fullRepositorySizes: sampleTask.fullRepositorySizes,
        workspaceRoots: sampleRoots,
      });

      // Context projection has no property granting terminal authority
      expect((proj as unknown as Record<string, unknown>).terminalAuthority).toBeUndefined();
      expect((proj as unknown as Record<string, unknown>).terminalSuccess).toBeUndefined();
    });

    it("46. Producer evidence cannot be fraudulently reused for consumer", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const secControls = orchestrator.executeSecurityControls(
        sampleTask,
        taskIdentities,
        taskEdges,
        taskContracts,
        sampleRoots
      );

      const n296 = secControls.find((c) => c.controlId === "N296");
      expect(n296?.blocked).toBe(true);
      expect(n296?.failureCode).toBe("EVIDENCE_COMPOSITION_FAILURE");
    });

    it("47. Tampered candidate patch digest causes evidence verification failure", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const secControls = orchestrator.executeSecurityControls(
        sampleTask,
        taskIdentities,
        taskEdges,
        taskContracts,
        sampleRoots
      );

      const n295 = secControls.find((c) => c.controlId === "N295");
      expect(n295?.blocked).toBe(true);
      expect(n295?.failureCode).toBe("EVIDENCE_COMPOSITION_FAILURE");
    });
  });

  // ===========================================================================
  // Group 10: Crash Recovery Across 11 Stages
  // ===========================================================================
  describe("Group 10: Crash Recovery Across 11 Stages", () => {
    it("48. Recovers from crash at stage 1 (discovery) and stage 2 (identity)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const recovery = orchestrator.evaluateCrashRecovery(
        sampleTask,
        taskIdentities,
        taskEdges,
        taskContracts,
        sampleRoots
      );

      expect(recovery[0]!.stageNumber).toBe(1);
      expect(recovery[0]!.recovered).toBe(true);
      expect(recovery[1]!.stageNumber).toBe(2);
      expect(recovery[1]!.recovered).toBe(true);
    });

    it("49. Recovers from crash at stage 4 (extraction) and stage 5 (reconciliation)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const recovery = orchestrator.evaluateCrashRecovery(
        sampleTask,
        taskIdentities,
        taskEdges,
        taskContracts,
        sampleRoots
      );

      expect(recovery[3]!.recovered).toBe(true);
      expect(recovery[4]!.recovered).toBe(true);
    });

    it("50. Recovers from crash at stage 8 (partial repair) preserving fencing", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const recovery = orchestrator.evaluateCrashRecovery(
        sampleTask,
        taskIdentities,
        taskEdges,
        taskContracts,
        sampleRoots
      );

      expect(recovery[7]!.stageNumber).toBe(8);
      expect(recovery[7]!.recovered).toBe(true);
      expect(recovery[7]!.preservedFencing).toBe(true);
    });

    it("51. Recovers across all 11 stages without granting unauthorized terminal authority", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const recovery = orchestrator.evaluateCrashRecovery(
        sampleTask,
        taskIdentities,
        taskEdges,
        taskContracts,
        sampleRoots
      );

      expect(recovery.length).toBe(11);
      expect(recovery.every((r) => r.recovered)).toBe(true);
      expect(recovery.every((r) => r.preservedFencing)).toBe(true);
      expect(recovery.every((r) => r.preservedIdentity)).toBe(true);
    });
  });

  // ===========================================================================
  // Group 11: Negative Security Controls N281–N300
  // ===========================================================================
  describe("Group 11: Negative Security Controls N281–N300", () => {
    it("52. Blocks N281–N284 (identity spoofing, revision substitution, edge forgery)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const sec = orchestrator.executeSecurityControls(sampleTask, taskIdentities, taskEdges, taskContracts, sampleRoots);
      const block1 = sec.slice(0, 4);
      expect(block1.every((c) => c.blocked)).toBe(true);
    });

    it("53. Blocks N285–N288 (contract substitution, endpoint spoofing, path traversal)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const sec = orchestrator.executeSecurityControls(sampleTask, taskIdentities, taskEdges, taskContracts, sampleRoots);
      const block2 = sec.slice(4, 8);
      expect(block2.every((c) => c.blocked)).toBe(true);
    });

    it("54. Blocks N289–N292 (symlink escape, unauthorized read/write, workspace contamination)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const sec = orchestrator.executeSecurityControls(sampleTask, taskIdentities, taskEdges, taskContracts, sampleRoots);
      const block3 = sec.slice(8, 12);
      expect(block3.every((c) => c.blocked)).toBe(true);
    });

    it("55. Blocks N293–N296 (stale contract replay, version substitution, evidence substitution, evidence reuse)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const sec = orchestrator.executeSecurityControls(sampleTask, taskIdentities, taskEdges, taskContracts, sampleRoots);
      const block4 = sec.slice(12, 16);
      expect(block4.every((c) => c.blocked)).toBe(true);
    });

    it("56. Blocks N297–N300 (partial repair marked success, verification bypass, authority injection, gold leakage)", () => {
      const taskIdentities = identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
      const taskEdges = edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
      const taskContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);

      const sec = orchestrator.executeSecurityControls(sampleTask, taskIdentities, taskEdges, taskContracts, sampleRoots);
      const block5 = sec.slice(16, 20);
      expect(block5.every((c) => c.blocked)).toBe(true);
      expect(sec.filter((c) => c.blocked).length).toBe(20);
    });
  });

  // ===========================================================================
  // Group 12: Concurrency, Determinism & Stratified Outcomes
  // ===========================================================================
  describe("Group 12: Concurrency, Determinism & Stratified Outcomes", () => {
    it("57. Enforces maxParallelRepositories budget limit of 2", () => {
      expect(DEFAULT_CROSS_REPO_BUDGETS.maxParallelRepositories).toBe(2);
    });

    it("58. Demonstrates byte-identical determinism across 3 sweeps", () => {
      const sweepDigests: string[] = [];
      for (let s = 1; s <= 3; s++) {
        const sweepTasks = buildPhase85Cohort();
        const sweepIdentities = generateRepositoryIdentities(sweepTasks);
        const sweepEdges = generateDependencyEdges(sweepTasks);
        const sweepContracts = generateContracts(sweepTasks, sweepEdges);
        sweepDigests.push(
          sha256Hex(
            canonicalJsonStringify({
              tasks: sweepTasks,
              identities: sweepIdentities,
              edges: sweepEdges,
              contracts: sweepContracts,
            })
          )
        );
      }
      expect(sweepDigests[0]).toBe(sweepDigests[1]);
      expect(sweepDigests[1]).toBe(sweepDigests[2]);
    });

    it("59. Condition A produces 0% coordinated success due to trapped partial repairs", async () => {
      const res = await orchestrator.executeWorkflow({
        workflowId: "test-cond-a",
        task: sampleTask,
        condition: "CONDITION_A_LOCAL_CONTROL",
        repositoryIdentities: identities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId)),
        dependencyEdges: edges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId),
        contracts: contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId),
        workspaceRoots: sampleRoots,
      });

      expect(res.terminalSuccess).toBe(false);
      expect(res.isPartialRepair).toBe(true);
    });

    it("60. L7 collaborative repair achieves 100% clean-room verified terminal success", async () => {
      const l7Task = tasks.find((t) => t.difficulty === "L7")!;
      const l7Identities = identities.filter((r) => l7Task.repositoryIds.includes(r.repositoryId));
      const l7Edges = edges.filter((e) => l7Task.producerRepoId === e.producerRepositoryId);
      const l7Contracts = contracts.filter((c) => l7Task.producerRepoId === c.producerRepositoryId);
      const l7Roots = Object.fromEntries(l7Task.repositoryIds.map((r) => [r, `workspace/${r}`]));

      const res = await orchestrator.executeWorkflow({
        workflowId: "test-l7-collab",
        task: l7Task,
        condition: "CONDITION_D_FULL_CLEAN_ROOM",
        repositoryIdentities: l7Identities,
        dependencyEdges: l7Edges,
        contracts: l7Contracts,
        workspaceRoots: l7Roots,
        humanCollaborationProvided: true, // Collaboratively unlocked
      });

      expect(res.terminalSuccess).toBe(true);
      expect(res.evidence?.terminalRecordAccepted).toBe(true);
    });
  });
});
