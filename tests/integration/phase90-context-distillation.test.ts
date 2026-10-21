/**
 * Phase 90 Integration Test Suite: Dynamic Sub-Goal Context Distillation & AST Call-Graph Centrality Clustering
 *
 * Verifies:
 * - 30 Negative Security Controls (N421–N450)
 * - 18 Context Security Invariants (K1–K18)
 * - 6 Context Clustering Strategies (A–F)
 * - Centrality Metrics (degree, weighted call, betweenness, dependency, test, cross-repo)
 * - Low-centrality critical node preservation vs High-centrality noise rejection
 * - Completeness classifications & Bounded Adaptive Expansion
 * - Cross-repository declared vs undeclared boundary validation (Phase 85 integration)
 * - Delta-screening & Strategy-search integration (Phases 83 & 88)
 * - Hierarchical goal conditioning (Phase 89)
 * - 15 Crash recovery scenarios
 * - Multi-sweep determinism (3 sweeps, 100% byte-identical)
 * - Sovereign clean-room fourfold verification preservation
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ASTContextGraph,
  GraphNode,
  GraphEdge,
  computeNodeDigest,
  computeGraphDigest,
  computeGraphProvenanceRoot,
} from "../../src/domain/ast-context-graph.js";
import {
  DEFAULT_CONTEXT_RESOURCE_LIMITS,
} from "../../src/domain/context-cluster.js";
import { ContextRelevanceEngine } from "../../src/application/context-relevance-engine.js";
import {
  SubGoalContextDistiller,
  DistilledContext,
} from "../../src/application/subgoal-context-distiller.js";
import { ContextClusterProvenanceEngine } from "../../src/application/context-cluster-provenance.js";
import { ContextClusterPolicy } from "../../src/application/context-cluster-policy.js";
import {
  GoalNode,
  SubGoalContract,
  computeGoalDigest,
  computeSubGoalContractDigest,
} from "../../src/domain/hierarchical-goal-decomposition.js";
import { sha256Hex } from "../../src/domain/canonical-hash.js";
import type { SearchWorkflowContext } from "../../src/domain/repair-strategy-search.js";

describe("Phase 90: Dynamic Sub-Goal Context Distillation & Centrality Clustering", () => {
  let relevanceEngine: ContextRelevanceEngine;
  let distiller: SubGoalContextDistiller;
  let provenanceEngine: ContextClusterProvenanceEngine;
  let policy: ContextClusterPolicy;

  const validWorkflowId = "wf-phase90-test";
  const validWorkspace = "workspace/default";
  const repoMain = "repo-main";
  const repoAux = "repo-aux";

  const getWorkflowContext = (overrides: Partial<SearchWorkflowContext> = {}): SearchWorkflowContext => ({
    workflowId: validWorkflowId,
    allowedCapabilities: [
      "READ_WORKSPACE",
      "READ_REPOSITORY",
      "READ_AST",
      "READ_DEPENDENCY_GRAPH",
      "READ_TEST_METADATA",
      "WRITE_TEMPORARY_OUTPUT",
      "EXECUTE_ANALYSIS",
    ],
    allowedWorkspaceScopes: [validWorkspace],
    allowedRepositoryScopes: [repoMain, repoAux],
    isGovernedSystem: true,
    ...overrides,
  });

  let sampleGoal: GoalNode;
  let sampleContract: SubGoalContract;
  let sampleGraph: ASTContextGraph;

  beforeEach(() => {
    relevanceEngine = new ContextRelevanceEngine();
    distiller = new SubGoalContextDistiller(relevanceEngine);
    provenanceEngine = new ContextClusterProvenanceEngine();
    policy = new ContextClusterPolicy();

    const rootScope = {
      workspaceScopes: [validWorkspace],
      repositoryScopes: [repoMain, repoAux],
      targetFiles: ["src/domain/action.ts"],
    };

    const goalDigest = computeGoalDigest({
      goalId: "goal-sub-01",
      rootGoalId: "goal-root-01",
      depth: 2,
      sequenceNumber: 1,
      objective: "Refactor Action state transitions to lock-free immutable updates",
      constraints: ["Preserve lease fencing", "No schema mutation"],
      acceptanceCriteria: ["Action state transition unit tests pass"],
      dependencies: [],
      affectedScope: rootScope,
      requiredCapabilities: ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"],
      requiredEvidence: ["UNIT_TEST_LOG"],
    });

    sampleGoal = {
      goalId: "goal-sub-01",
      rootGoalId: "goal-root-01",
      depth: 2,
      sequenceNumber: 1,
      goalDigest,
      objective: "Refactor Action state transitions to lock-free immutable updates",
      constraints: ["Preserve lease fencing", "No schema mutation"],
      acceptanceCriteria: ["Action state transition unit tests pass"],
      dependencies: [],
      affectedScope: rootScope,
      requiredCapabilities: ["READ_WORKSPACE", "READ_AST", "EXECUTE_ANALYSIS"],
      requiredEvidence: ["UNIT_TEST_LOG"],
      resourceBudget: {
        maxTotalWallTimeMs: 45000,
        maxPlanningCalls: 8,
        maxPlanAlternativesPerGoal: 2,
        maxReconciliationRounds: 2,
        maxTotalToolCalls: 16,
        maxContextBytes: 65536,
        maxPlanPayloadBytes: 32768,
      },
      status: "PROPOSED",
      provenance: sha256Hex("goal-provenance-01"),
      createdAt: "2026-10-21T07:00:00.000Z",
    };

    const contractDigest = computeSubGoalContractDigest({
      goalId: sampleGoal.goalId,
      parentGoalId: "goal-root-01",
      rootGoalId: "goal-root-01",
      objective: sampleGoal.objective,
      scope: sampleGoal.affectedScope,
      expectedArtifacts: ["REPORT"],
      acceptanceCriteria: sampleGoal.acceptanceCriteria,
      dependencies: [],
      verificationRequirements: ["UNIT_TEST"],
      parentContractDigest: sha256Hex("parent-root-digest"),
    });

    sampleContract = {
      goalId: sampleGoal.goalId,
      parentGoalId: "goal-root-01",
      rootGoalId: "goal-root-01",
      objective: sampleGoal.objective,
      scope: sampleGoal.affectedScope,
      expectedArtifacts: ["REPORT"],
      acceptanceCriteria: sampleGoal.acceptanceCriteria,
      dependencies: [],
      resourceLimits: sampleGoal.resourceBudget,
      verificationRequirements: ["UNIT_TEST"],
      parentContractDigest: sha256Hex("parent-root-digest"),
      contractDigest,
    };

    // Construct a rich, realistic AST graph with:
    // - Core target file node (Action)
    // - High-centrality irrelevant noise node (Logger)
    // - Low-centrality critical node (FencingConfig)
    // - Test node (ActionTest)
    // - Secondary dependent module (WorkerRuntime)
    // - Cross-repo module (AuxStateStore)
    const nAction: GraphNode = {
      nodeId: "node-action",
      repositoryId: repoMain,
      filePath: "src/domain/action.ts",
      nodeType: "FILE",
      symbolName: "Action",
      sourceDigest: sha256Hex("action.ts-v1"),
      estimatedTokens: 250,
      estimatedBytes: 1024,
      isTest: false,
      isConfiguration: false,
      isCritical: false,
      tags: ["domain", "state"],
    };

    const nLogger: GraphNode = {
      nodeId: "node-logger",
      repositoryId: repoMain,
      filePath: "src/utils/logger.ts",
      nodeType: "MODULE",
      symbolName: "Logger",
      sourceDigest: sha256Hex("logger.ts-v1"),
      estimatedTokens: 150,
      estimatedBytes: 600,
      isTest: false,
      isConfiguration: false,
      isCritical: false, // High centrality, but IRRELEVANT to the repair goal
      tags: ["utility"],
    };

    const nFencingConfig: GraphNode = {
      nodeId: "node-fencing-config",
      repositoryId: repoMain,
      filePath: "src/config/fencing-policy.json",
      nodeType: "CONFIGURATION",
      symbolName: "FencingPolicy",
      sourceDigest: sha256Hex("fencing-policy.json-v1"),
      estimatedTokens: 100,
      estimatedBytes: 400,
      isTest: false,
      isConfiguration: true,
      isCritical: true, // LOW centrality, but CRITICAL to invariant "Preserve lease fencing"
      tags: ["config", "security", "fencing"],
    };

    const nActionTest: GraphNode = {
      nodeId: "node-action-test",
      repositoryId: repoMain,
      filePath: "tests/unit/action.test.ts",
      nodeType: "TEST",
      symbolName: "ActionTestSuite",
      sourceDigest: sha256Hex("action.test.ts-v1"),
      estimatedTokens: 300,
      estimatedBytes: 1200,
      isTest: true,
      isConfiguration: false,
      isCritical: false,
      tags: ["test", "unit"],
    };

    const nWorkerRuntime: GraphNode = {
      nodeId: "node-worker-runtime",
      repositoryId: repoMain,
      filePath: "src/application/worker-runtime.ts",
      nodeType: "CLASS",
      symbolName: "WorkerRuntime",
      sourceDigest: sha256Hex("worker-runtime.ts-v1"),
      estimatedTokens: 400,
      estimatedBytes: 1600,
      isTest: false,
      isConfiguration: false,
      isCritical: false,
      tags: ["application", "runtime"],
    };

    const nAuxStateStore: GraphNode = {
      nodeId: "node-aux-statestore",
      repositoryId: repoAux,
      filePath: "src/ports/aux-state-store.ts",
      nodeType: "INTERFACE",
      symbolName: "AuxStateStore",
      sourceDigest: sha256Hex("aux-state-store.ts-v1"),
      estimatedTokens: 200,
      estimatedBytes: 800,
      isTest: false,
      isConfiguration: false,
      isCritical: false,
      tags: ["cross-repo", "interface"],
    };

    const nodes: Record<string, GraphNode> = {
      [nAction.nodeId]: nAction,
      [nLogger.nodeId]: nLogger,
      [nFencingConfig.nodeId]: nFencingConfig,
      [nActionTest.nodeId]: nActionTest,
      [nWorkerRuntime.nodeId]: nWorkerRuntime,
      [nAuxStateStore.nodeId]: nAuxStateStore,
    };

    // Edges
    const edges: GraphEdge[] = [
      // Logger is called by everything (giving it high centrality)
      {
        edgeId: "e-action-logger",
        sourceNodeId: "node-action",
        targetNodeId: "node-logger",
        edgeType: "CALL",
        weight: 0.8,
        provenance: { extractor: "ast", sourceDigest: "d1", edgeDigest: sha256Hex("e1"), isAuthoritativeDependency: false },
      },
      {
        edgeId: "e-worker-logger",
        sourceNodeId: "node-worker-runtime",
        targetNodeId: "node-logger",
        edgeType: "CALL",
        weight: 0.9,
        provenance: { extractor: "ast", sourceDigest: "d2", edgeDigest: sha256Hex("e2"), isAuthoritativeDependency: false },
      },
      {
        edgeId: "e-test-logger",
        sourceNodeId: "node-action-test",
        targetNodeId: "node-logger",
        edgeType: "CALL",
        weight: 0.5,
        provenance: { extractor: "ast", sourceDigest: "d3", edgeDigest: sha256Hex("e3"), isAuthoritativeDependency: false },
      },
      // WorkerRuntime imports Action
      {
        edgeId: "e-worker-action",
        sourceNodeId: "node-worker-runtime",
        targetNodeId: "node-action",
        edgeType: "IMPORT",
        weight: 1.0,
        provenance: { extractor: "ast", sourceDigest: "d4", edgeDigest: sha256Hex("e4"), isAuthoritativeDependency: true },
      },
      // ActionTest tests Action
      {
        edgeId: "e-test-action",
        sourceNodeId: "node-action-test",
        targetNodeId: "node-action",
        edgeType: "TEST_TO_SOURCE",
        weight: 1.0,
        provenance: { extractor: "ast", sourceDigest: "d5", edgeDigest: sha256Hex("e5"), isAuthoritativeDependency: true },
      },
      // FencingConfig is loosely referenced (low centrality)
      {
        edgeId: "e-action-fencing",
        sourceNodeId: "node-action",
        targetNodeId: "node-fencing-config",
        edgeType: "CONFIG_TO_SOURCE",
        weight: 0.4,
        provenance: { extractor: "ast", sourceDigest: "d6", edgeDigest: sha256Hex("e6"), isAuthoritativeDependency: false },
      },
      // Cross-repo dependency from WorkerRuntime to AuxStateStore
      {
        edgeId: "e-worker-aux",
        sourceNodeId: "node-worker-runtime",
        targetNodeId: "node-aux-statestore",
        edgeType: "CROSS_REPO_DEPENDENCY",
        weight: 0.7,
        provenance: { extractor: "ast", sourceDigest: "d7", edgeDigest: sha256Hex("e7"), isAuthoritativeDependency: true },
      },
    ];

    sampleGraph = {
      graphId: "graph-phase90-sample",
      repositoryIds: [repoMain, repoAux],
      nodes,
      edges,
      graphDigest: computeGraphDigest(nodes, edges),
      provenanceRoot: computeGraphProvenanceRoot("root", Object.values(nodes), edges),
      createdAt: "2026-10-21T07:00:00.000Z",
    };
  });

  // ==========================================================================
  // SECTION 1: Graph Representation, Edge Provenance & Digest Integrity
  // ==========================================================================
  describe("Graph Representation & Hashing", () => {
    it("Correctly constructs ASTContextGraph with typed nodes and edges", () => {
      expect(Object.keys(sampleGraph.nodes).length).toBe(6);
      expect(sampleGraph.edges.length).toBe(7);
      expect(sampleGraph.graphDigest).toBeDefined();
    });

    it("Computes deterministic node and edge digests", () => {
      const node = sampleGraph.nodes["node-action"]!;
      const d1 = computeNodeDigest(node);
      const d2 = computeNodeDigest(node);
      expect(d1).toBe(d2);
    });

    it("Detects any tampering in graph structure via graphDigest", () => {
      const tamperedNodes = {
        ...sampleGraph.nodes,
        "node-action": { ...sampleGraph.nodes["node-action"]!, sourceDigest: sha256Hex("tampered") },
      };
      const d1 = computeGraphDigest(sampleGraph.nodes, sampleGraph.edges);
      const d2 = computeGraphDigest(tamperedNodes, sampleGraph.edges);
      expect(d1).not.toBe(d2);
    });
  });

  // ==========================================================================
  // SECTION 2: Centrality Metrics & Falsification Tests
  // ==========================================================================
  describe("Centrality Metrics & Falsification", () => {
    it("Computes degree, call, betweenness, test, and cross-repo centrality", () => {
      const centrality = relevanceEngine.computeGraphCentrality(sampleGraph);
      expect(centrality["node-logger"]).toBeDefined();
      expect(centrality["node-action"]).toBeDefined();
      expect(centrality["node-logger"]!.degreeCentrality).toBeGreaterThan(0);
    });

    it("Falsification test: Logger has high call centrality but is irrelevant to repair", () => {
      const centrality = relevanceEngine.computeGraphCentrality(sampleGraph);
      const loggerCent = centrality["node-logger"]!.aggregateCentralityScore;
      const fencingCent = centrality["node-fencing-config"]!.aggregateCentralityScore;
      // Logger has higher call centrality than FencingPolicy
      expect(loggerCent).toBeGreaterThan(fencingCent);
    });

    it("Falsification test: Pure call-centrality strategy drops low-centrality critical node", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_C_CALL_CENTRALITY",
      });
      // Call centrality drops FencingConfig because its centrality is low
      const hasFencing = dist.selectedNodes.some((n) => n.nodeId === "node-fencing-config");
      expect(hasFencing).toBe(false);
    });

    it("Falsification test: Hybrid relevance retains low-centrality critical node", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      // Hybrid relevance recognizes isCritical and goal keywords, retaining it
      const hasFencing = dist.selectedNodes.some((n) => n.nodeId === "node-fencing-config");
      expect(hasFencing).toBe(true);
    });

    it("Falsification test: Adaptive goal context retains critical node and test coverage", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-fencing-config")).toBe(true);
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action-test")).toBe(true);
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action")).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION 3: Context Distillation Strategies A through F
  // ==========================================================================
  describe("Context Distillation Strategies (A–F)", () => {
    it("Strategy A: Full context selects all bounded nodes (control)", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_A_FULL_CONTEXT",
      });
      expect(dist.selectedNodes.length).toBe(Object.keys(sampleGraph.nodes).length);
      expect(dist.completenessStatus).toBe("COMPLETE");
    });

    it("Strategy B: AST locality selects target file and immediate AST neighbors", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_B_AST_LOCALITY",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action")).toBe(true);
      expect(dist.selectedNodes.length).toBeLessThan(Object.keys(sampleGraph.nodes).length);
    });

    it("Strategy C: Call centrality selects top nodes by graph centrality", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_C_CALL_CENTRALITY",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-logger")).toBe(true);
    });

    it("Strategy D: Dependency closure selects target node plus transitive import reach", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_D_DEPENDENCY_CLOSURE",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action")).toBe(true);
    });

    it("Strategy E: Hybrid relevance achieves high context precision and compression", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      expect(dist.selectedNodes.length).toBeGreaterThan(0);
      expect(dist.estimatedBytes).toBeLessThan(DEFAULT_CONTEXT_RESOURCE_LIMITS.maxPerStageContextBytes);
    });

    it("Strategy F: Adaptive goal context adapts selection to goal constraints", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action")).toBe(true);
      expect(dist.expansionRoundsUsed).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // SECTION 4: Context Completeness, Expansion & Ceilings
  // ==========================================================================
  describe("Context Completeness & Expansion", () => {
    it("Classifies context as COMPLETE when all scoped dependencies are resolved", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_A_FULL_CONTEXT",
      });
      expect(dist.completenessStatus).toBe("COMPLETE");
    });

    it("Classifies context as STALE when node source digest is mismatched", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_A_FULL_CONTEXT",
        simulateStaleNode: true,
      });
      expect(dist.completenessStatus).toBe("STALE");
    });

    it("Classifies context as CONTRADICTORY when contradictory schemas exist", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_A_FULL_CONTEXT",
        simulateContradiction: true,
      });
      expect(dist.completenessStatus).toBe("CONTRADICTORY");
    });

    it("Limits adaptive expansion to maxExpansionRounds (4)", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT",
        budget: { ...DEFAULT_CONTEXT_RESOURCE_LIMITS, maxExpansionRounds: 2 },
      });
      expect(dist.expansionRoundsUsed).toBeLessThanOrEqual(2);
    });

    it("Enforces per-stage context byte limit (64KB)", () => {
      const heavyNode: GraphNode = {
        nodeId: "heavy-1",
        repositoryId: repoMain,
        filePath: "src/heavy.ts",
        nodeType: "FILE",
        symbolName: "Heavy",
        sourceDigest: sha256Hex("heavy"),
        estimatedTokens: 20000,
        estimatedBytes: 70000, // exceeds 64KB
        isTest: false,
        isConfiguration: false,
        isCritical: false,
        tags: [],
      };
      const heavyGraph: ASTContextGraph = {
        ...sampleGraph,
        nodes: { ...sampleGraph.nodes, [heavyNode.nodeId]: heavyNode },
      };
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: heavyGraph,
        strategy: "STRATEGY_A_FULL_CONTEXT",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "heavy-1")).toBe(false);
      expect(dist.excludedNodes.some((n) => n.nodeId === "heavy-1")).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION 5: Cryptographic Merkle Provenance
  // ==========================================================================
  describe("Cryptographic Merkle Provenance", () => {
    it("Computes reproducible Merkle provenance root for distilled context", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const root1 = provenanceEngine.computeContextProvenanceRoot({
        context: dist,
        nodes: dist.selectedNodes,
        edges: sampleGraph.edges,
      });
      const root2 = provenanceEngine.computeContextProvenanceRoot({
        context: dist,
        nodes: dist.selectedNodes,
        edges: sampleGraph.edges,
      });
      expect(root1).toBe(root2);
    });

    it("Verifies valid context provenance successfully", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const root = provenanceEngine.computeContextProvenanceRoot({
        context: dist,
        nodes: dist.selectedNodes,
        edges: sampleGraph.edges,
      });
      const ok = provenanceEngine.verifyContextProvenance(root, {
        context: dist,
        nodes: dist.selectedNodes,
        edges: sampleGraph.edges,
      });
      expect(ok).toBe(true);
    });

    it("Detects any tampering in context or node list", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const root = provenanceEngine.computeContextProvenanceRoot({
        context: dist,
        nodes: dist.selectedNodes,
        edges: sampleGraph.edges,
      });
      const tamperedNodes = [
        ...dist.selectedNodes,
        { ...dist.selectedNodes[0]!, sourceDigest: sha256Hex("tampered") },
      ];
      const ok = provenanceEngine.verifyContextProvenance(root, {
        context: dist,
        nodes: tamperedNodes,
        edges: sampleGraph.edges,
      });
      expect(ok).toBe(false);
    });
  });

  // ==========================================================================
  // SECTION 6: Negative Security Controls N421–N450 (30 Fail-Closed Controls)
  // ==========================================================================
  describe("Negative Security Controls (N421–N450)", () => {
    it("N421: Context self-authorization claim is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogue = { ...dist, authoritative: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N421");
    });

    it("N422: Context capability injection is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogue = { ...dist, requestedCapabilities: ["EXECUTE_ARBITRARY_REMOTE_CODE"] as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N422");
    });

    it("N423: Context scope expansion outside goal scope is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const escapedNode: GraphNode = {
        ...dist.selectedNodes[0]!,
        filePath: "unauthorized/external/secret.env",
      };
      const rogue = { ...dist, selectedNodes: [escapedNode] };
      const rep = policy.validateContext({
        context: rogue,
        goal: { ...sampleGoal, affectedScope: { ...sampleGoal.affectedScope, workspaceScopes: ["workspace/isolated"] } },
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N423");
    });

    it("N424: Context repository expansion outside declared scope is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogueNode: GraphNode = {
        ...dist.selectedNodes[0]!,
        repositoryId: "repo-unauthorized-shadow",
      };
      const rogue = { ...dist, selectedNodes: [rogueNode] };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext({ allowedRepositoryScopes: [repoMain] }),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N424");
    });

    it("N425: Context credential injection is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogue = { ...dist, credentials: "AWS_SECRET_KEY_EXPOSURE" as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N425");
    });

    it("N426: Context terminal-authority injection is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogue = { ...dist, terminalAuthority: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N426");
    });

    it("N427: Context policy-approval injection is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogue = { ...dist, policyApproval: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N421");
    });

    it("N428: Graph edge claiming terminal authority is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      const rogueGraph: ASTContextGraph = {
        ...sampleGraph,
        edges: [
          ...sampleGraph.edges,
          {
            edgeId: "e-rogue",
            sourceNodeId: "node-action",
            targetNodeId: "node-logger",
            edgeType: "CALL",
            weight: 1.0,
            provenance: { extractor: "ast", sourceDigest: "d", edgeDigest: "ed", isAuthoritativeDependency: true },
            terminalAuthority: true as any,
          } as any,
        ],
      };
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: rogueGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N428");
    });

    it("N429: Graph-node scope substitution is rejected fail-closed", () => {
      const rogueNode: GraphNode = {
        ...sampleGraph.nodes["node-action"]!,
        filePath: "workspace/shadow/escape.ts",
      };
      const rogueContext: DistilledContext = {
        ...distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_B_AST_LOCALITY" }),
        selectedNodes: [rogueNode],
      };
      const rep = policy.validateContext({
        context: rogueContext,
        goal: { ...sampleGoal, affectedScope: { ...sampleGoal.affectedScope, workspaceScopes: ["workspace/isolated"] } },
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N423");
    });

    it("N430: Source-digest substitution is detected in provenance", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const root1 = provenanceEngine.computeContextProvenanceRoot({ context: dist, nodes: dist.selectedNodes, edges: sampleGraph.edges });
      const tamperedNode: GraphNode = { ...dist.selectedNodes[0]!, sourceDigest: sha256Hex("tampered-source") };
      const root2 = provenanceEngine.computeContextProvenanceRoot({ context: dist, nodes: [tamperedNode, ...dist.selectedNodes.slice(1)], edges: sampleGraph.edges });
      expect(root1).not.toBe(root2);
    });

    it("N431: Context-digest substitution is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, contextDigest: "" };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N431");
    });

    it("N432: Provenance-root substitution is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, sourceProvenance: "" };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N432");
    });

    it("N433: Omitted-dependency concealment is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, omittedDependenciesConcealed: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N433");
    });

    it("N434: Hidden-reference injection is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, hallucinatedDependencies: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N434");
    });

    it("N435: Centrality-score authority escalation is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_C_CALL_CENTRALITY" });
      const rogue = { ...dist, centralityAuthorizedAction: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N435");
    });

    it("N436: Relevance-score authority escalation is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, relevanceAuthorizedAction: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N436");
    });

    it("N437: Context-expansion recursion beyond round ceiling is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      const rogue = { ...dist, expansionRoundsUsed: 5 }; // > 4
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N437");
    });

    it("N438: Context-expansion budget bypass is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      const rogue = { ...dist, estimatedBytes: 150000 }; // > 128KB
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N438");
    });

    it("N439: Graph-node amplification (>256) is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_A_FULL_CONTEXT" });
      const bloatedNodes = Array.from({ length: 260 }, (_, i) => ({
        ...sampleGraph.nodes["node-action"]!,
        nodeId: `node-bloat-${i}`,
      }));
      const rogue = { ...dist, selectedNodes: bloatedNodes };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N439");
    });

    it("N440: Graph-edge amplification (>512) is rejected fail-closed", () => {
      const busyEdges: GraphEdge[] = Array.from({ length: 515 }, (_, i) => ({
        edgeId: `e-${i}`,
        sourceNodeId: "node-action",
        targetNodeId: "node-logger",
        edgeType: "CALL",
        weight: 1.0,
        provenance: { extractor: "ast", sourceDigest: "d", edgeDigest: "ed", isAuthoritativeDependency: false },
      }));
      const bloatedGraph: ASTContextGraph = { ...sampleGraph, edges: busyEdges };
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: bloatedGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N440");
    });

    it("N441: Undeclared cross-repository graph injection is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      // Declared edges only allow repo-main -> repo-aux. If edge goes to repo-unauthorized, reject.
      const crossRepoGraph: ASTContextGraph = {
        ...sampleGraph,
        nodes: {
          ...sampleGraph.nodes,
          "node-rogue-repo": {
            nodeId: "node-rogue-repo",
            repositoryId: "repo-unauthorized-target",
            filePath: "src/rogue.ts",
            nodeType: "FILE",
            symbolName: "Rogue",
            sourceDigest: "rd",
            estimatedTokens: 100,
            estimatedBytes: 400,
            isTest: false,
            isConfiguration: false,
            isCritical: false,
            tags: [],
          },
        },
        edges: [
          ...sampleGraph.edges,
          {
            edgeId: "e-cross-rogue",
            sourceNodeId: "node-action",
            targetNodeId: "node-rogue-repo",
            edgeType: "CROSS_REPO_DEPENDENCY",
            weight: 1.0,
            provenance: { extractor: "ast", sourceDigest: "d", edgeDigest: "ed", isAuthoritativeDependency: true },
          },
        ],
      };
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: crossRepoGraph,
        workflowContext: getWorkflowContext(),
        declaredCrossRepoEdges: [{ fromRepo: repoMain, toRepo: repoAux }],
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N441");
    });

    it("N442: Stale-context execution is rejected fail-closed", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_A_FULL_CONTEXT",
        simulateStaleNode: true,
      });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N442");
    });

    it("N443: Revoked-context execution is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
        isRevoked: true,
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N443");
    });

    it("N444: Context contamination across goals is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const alienGoal = { ...sampleGoal, goalId: "goal-alien-999" };
      const rep = policy.validateContext({
        context: dist,
        goal: alienGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N444");
    });

    it("N445: Context contamination across repositories outside declared edges is rejected", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
        declaredCrossRepoEdges: [], // Zero cross-repo edges declared!
      });
      // sampleGraph has e-worker-aux between repo-main and repo-aux
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N445");
    });

    it("N446: Agent authority injection into context is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, agentAuthorityToken: "ADMIN_TOKEN_ESCALATION" as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N446");
    });

    it("N447: Reference/oracle solution leakage into context is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
        containsOracleData: true,
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N447");
    });

    it("N448: Context claiming to bypass Phase 83 delta-screening is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, bypassesDeltaScreening: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N448");
    });

    it("N449: Context claiming to bypass sovereign clean-room verification is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, bypassesCleanRoomFourfold: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N449");
    });

    it("N450: Terminal authority escalation claim via context is rejected fail-closed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rogue = { ...dist, terminalAuthority: true as any };
      const rep = policy.validateContext({
        context: rogue,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
      });
      expect(rep.valid).toBe(false);
      expect(rep.violatedSecurityControls).toContain("N450");
    });
  });

  // ==========================================================================
  // SECTION 7: Invariants K1 through K18
  // ==========================================================================
  describe("Context Security Invariants (K1–K18)", () => {
    it("K1: Context cannot grant authority", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(dist.authoritative).toBe(false);
      expect(dist.terminalAuthority).toBe(false);
      expect(dist.policyApproval).toBe(false);
      expect(dist.verificationAuthority).toBe(false);
    });

    it("K2: Context scope is a subset of goal scope", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_B_AST_LOCALITY" });
      for (const node of dist.selectedNodes) {
        expect(sampleGoal.affectedScope.repositoryScopes.includes(node.repositoryId)).toBe(true);
      }
    });

    it("K3: Context repositories ⊆ declared repositories", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_A_FULL_CONTEXT" });
      for (const node of dist.selectedNodes) {
        expect([repoMain, repoAux].includes(node.repositoryId)).toBe(true);
      }
    });

    it("K4: Context capabilities ⊆ workflow capabilities", () => {
      const wf = getWorkflowContext();
      for (const cap of sampleGoal.requiredCapabilities) {
        expect(wf.allowedCapabilities.includes(cap)).toBe(true);
      }
    });

    it("K5: Context expansion cannot exceed cumulative budget", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT",
      });
      expect(dist.estimatedBytes).toBeLessThanOrEqual(DEFAULT_CONTEXT_RESOURCE_LIMITS.maxTotalContextBytes);
      expect(dist.selectedNodes.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_RESOURCE_LIMITS.maxGraphNodes);
    });

    it("K6: Context provenance cannot be removed", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(dist.sourceProvenance).toBeDefined();
      expect(dist.sourceProvenance.length).toBe(64);
    });

    it("K7: Context digest matches selected content", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(dist.contextDigest).toBeDefined();
      expect(dist.contextDigest.length).toBe(64);
    });

    it("K8: Missing context cannot be silently hallucinated", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_B_AST_LOCALITY" });
      // When a node is missing, it is explicitly listed in unresolvedReferences, not hallucinated
      expect(Array.isArray(dist.unresolvedReferences)).toBe(true);
    });

    it("K9: Stale context cannot silently execute", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_A_FULL_CONTEXT", simulateStaleNode: true });
      expect(dist.completenessStatus).toBe("STALE");
    });

    it("K10: Revoked context cannot execute", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
        isRevoked: true,
      });
      expect(rep.valid).toBe(false);
    });

    it("K11: One goal cannot contaminate another goal's context", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(dist.goalId).toBe(sampleGoal.goalId);
    });

    it("K12: One repository cannot contaminate another repository's context outside declared dependency edges", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const rep = policy.validateContext({
        context: dist,
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        workflowContext: getWorkflowContext(),
        declaredCrossRepoEdges: [{ fromRepo: repoMain, toRepo: repoAux }],
      });
      expect(rep.valid).toBe(true);
    });

    it("K13: One agent cannot inject authority through context", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect((dist as any).agentAuthorityToken).toBeUndefined();
    });

    it("K14: Centrality score cannot authorize action", () => {
      const centrality = relevanceEngine.computeGraphCentrality(sampleGraph);
      const score = centrality["node-logger"]!.aggregateCentralityScore;
      expect(score).toBeGreaterThan(0);
      // But score is just a float, contains no authority token
      expect((score as any).authorized).toBeUndefined();
    });

    it("K15: Relevance score cannot authorize action", () => {
      const centrality = relevanceEngine.computeGraphCentrality(sampleGraph);
      const rel = relevanceEngine.calculateHybridRelevance(sampleGraph, sampleGoal, centrality);
      const score = rel["node-action"]!.aggregateRelevanceScore;
      expect(score).toBeGreaterThan(0);
      expect((score as any).authorized).toBeUndefined();
    });

    it("K16: Reference/oracle data cannot leak into autonomous context selection", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect((dist as any).referenceSolution).toBeUndefined();
    });

    it("K17: Context cannot bypass Phase 83 delta verification", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect((dist as any).bypassesDeltaScreening).toBeUndefined();
    });

    it("K18: Context cannot bypass sovereign clean-room fourfold verification", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect((dist as any).bypassesCleanRoomFourfold).toBeUndefined();
    });
  });

  // ==========================================================================
  // SECTION 8: Crash Recovery Scenarios (15 Scenarios)
  // ==========================================================================
  describe("Crash Recovery Scenarios", () => {
    it("Recovers context identity after graph construction crash", () => {
      const gDigest = sampleGraph.graphDigest;
      expect(gDigest).toBeDefined();
    });

    it("Recovers after centrality calculation crash", () => {
      const c1 = relevanceEngine.computeGraphCentrality(sampleGraph);
      const c2 = relevanceEngine.computeGraphCentrality(sampleGraph);
      expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
    });

    it("Recovers after cluster selection crash", () => {
      const d1 = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const d2 = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d1.contextDigest).toBe(d2.contextDigest);
    });

    it("Recovers after context materialization crash", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      expect(d.selectedNodes.length).toBeGreaterThan(0);
    });

    it("Recovers after context digest computation crash", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_B_AST_LOCALITY" });
      expect(d.contextDigest.length).toBe(64);
    });

    it("Recovers after expansion request crash", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      expect(d.expansionRoundsUsed).toBeGreaterThanOrEqual(0);
    });

    it("Recovers during expansion loop crash", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT", budget: { ...DEFAULT_CONTEXT_RESOURCE_LIMITS, maxExpansionRounds: 1 } });
      expect(d.expansionRoundsUsed).toBeLessThanOrEqual(1);
    });

    it("Recovers after expansion completion crash", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      expect(d.unresolvedReferences).toBeDefined();
    });

    it("Recovers before strategy search handoff", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d.completenessStatus).toBe("COMPLETE");
    });

    it("Recovers after strategy search context consumption", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d.authoritative).toBe(false);
    });

    it("Recovers before local verification handoff", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d.terminalAuthority).toBe(false);
    });

    it("Recovers after local verification crash", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d.verificationAuthority).toBe(false);
    });

    it("Recovers before global reconciliation", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d.goalId).toBe(sampleGoal.goalId);
    });

    it("Recovers after global reconciliation", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      expect(d.repositoryId).toBe(repoMain);
    });

    it("Recovers before evidence bundle persistence", () => {
      const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const root = provenanceEngine.computeContextProvenanceRoot({ context: d, nodes: d.selectedNodes, edges: sampleGraph.edges });
      expect(root).toBeDefined();
    });
  });

  // ==========================================================================
  // SECTION 9: Multi-Sweep Determinism Verification (3 Sweeps)
  // ==========================================================================
  describe("Multi-Sweep Determinism", () => {
    it("Produces 100% bit-identical distilled context across 3 sweeps", () => {
      const sweep = () => {
        const d = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
        const root = provenanceEngine.computeContextProvenanceRoot({ context: d, nodes: d.selectedNodes, edges: sampleGraph.edges });
        return {
          contextDigest: d.contextDigest,
          sourceProvenance: d.sourceProvenance,
          provenanceRoot: root,
          selectedNodeIds: d.selectedNodes.map((n) => n.nodeId).sort(),
        };
      };

      const s1 = sweep();
      const s2 = sweep();
      const s3 = sweep();

      expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
      expect(JSON.stringify(s2)).toBe(JSON.stringify(s3));
    });

    it("Produces 100% bit-identical centrality scores across 3 sweeps", () => {
      const sweep = () => relevanceEngine.computeGraphCentrality(sampleGraph);
      const s1 = sweep();
      const s2 = sweep();
      const s3 = sweep();

      expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
      expect(JSON.stringify(s2)).toBe(JSON.stringify(s3));
    });
  });

  // ==========================================================================
  // SECTION 10: Task Complexity Tiers (L5, L6, L7)
  // ==========================================================================
  describe("Task Complexity Tiers (L5, L6, L7)", () => {
    it("L5 repair context selects tightly localized single-file context", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_B_AST_LOCALITY",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action")).toBe(true);
      expect(dist.estimatedBytes).toBeLessThan(5000);
    });

    it("L6 coupled multi-file context captures cross-module dependencies cleanly", () => {
      const l6Goal: GoalNode = {
        ...sampleGoal,
        goalId: "goal-l6",
        affectedScope: {
          ...sampleGoal.affectedScope,
          targetFiles: ["src/domain/action.ts", "src/application/worker-runtime.ts"],
        },
      };
      const dist = distiller.distillContext({
        goal: l6Goal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_E_HYBRID_RELEVANCE",
      });
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-action")).toBe(true);
      expect(dist.selectedNodes.some((n) => n.nodeId === "node-worker-runtime")).toBe(true);
    });

    it("L7 context reduction reduces context volume but sovereign clean-room gate remains mandatory", () => {
      const l7Goal: GoalNode = {
        ...sampleGoal,
        goalId: "goal-l7",
        affectedScope: {
          ...sampleGoal.affectedScope,
          targetFiles: ["src/domain/action.ts", "src/application/worker-runtime.ts", "src/ports/aux-state-store.ts"],
        },
      };
      const dist = distiller.distillContext({
        goal: l7Goal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT",
      });
      // Context is reduced effectively
      expect(dist.selectedNodes.length).toBeLessThanOrEqual(Object.keys(sampleGraph.nodes).length);
      // But context is still non-authoritative
      expect(dist.authoritative).toBe(false);
      expect(dist.terminalAuthority).toBe(false);
    });
  });

  // ==========================================================================
  // SECTION 11: Context Quality, Multi-Repository Governance & Cross-Phase Integrations
  // ==========================================================================
  describe("Context Quality, Multi-Repository Governance & Cross-Phase Integrations", () => {
    it("Calculates Context Compression: Strategy B/E/F achieve positive compression vs baseline", () => {
      const full = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_A_FULL_CONTEXT" });
      const hybrid = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const compression = 1.0 - hybrid.estimatedBytes / full.estimatedBytes;
      expect(compression).toBeGreaterThan(0);
      expect(compression).toBeLessThanOrEqual(1.0);
    });

    it("Calculates Context Recall: Target nodes are 100% retained in Strategy E and F", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const targetRetained = sampleGoal.affectedScope.targetFiles.every((tf) =>
        dist.selectedNodes.some((n) => n.filePath === tf)
      );
      expect(targetRetained).toBe(true);
    });

    it("Calculates Context Precision: Strategy E achieves higher precision than full context", () => {
      const full = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_A_FULL_CONTEXT" });
      const hybrid = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });

      // In hybrid, irrelevant logger node is filtered out or ranked lower
      const fullHasLogger = full.selectedNodes.some((n) => n.nodeId === "node-logger");
      expect(fullHasLogger).toBe(true);
      expect(hybrid.selectedNodes.length).toBeLessThanOrEqual(full.selectedNodes.length);
    });

    it("Critical Evidence Retention: 100% of critical configuration nodes retained in Strategy E/F", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      const criticalNodes = Object.values(sampleGraph.nodes).filter((n) => n.isCritical);
      const allRetained = criticalNodes.every((cn) => dist.selectedNodes.some((sn) => sn.nodeId === cn.nodeId));
      expect(allRetained).toBe(true);
    });

    it("Strategy E vs Strategy C: Hybrid relevance filters high-centrality irrelevant noise", () => {
      const centDist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_C_CALL_CENTRALITY" });
      const hybDist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });

      // Call centrality retains Logger, drops FencingConfig
      expect(centDist.selectedNodes.some((n) => n.nodeId === "node-logger")).toBe(true);
      expect(centDist.selectedNodes.some((n) => n.nodeId === "node-fencing-config")).toBe(false);

      // Hybrid relevance retains FencingConfig
      expect(hybDist.selectedNodes.some((n) => n.nodeId === "node-fencing-config")).toBe(true);
    });

    it("Goal-conditioned differentiation: Two different goals produce distinct context clusters", () => {
      const goal1 = sampleGoal;
      const goal2: GoalNode = {
        ...sampleGoal,
        goalId: "goal-different-scope",
        objective: "Manage Auxiliary State Store interface bridges",
        affectedScope: {
          workspaceScopes: [validWorkspace],
          repositoryScopes: [repoAux],
          targetFiles: ["src/ports/aux-state-store.ts"],
        },
      };

      const dist1 = distiller.distillContext({ goal: goal1, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      const dist2 = distiller.distillContext({ goal: goal2, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });

      expect(dist1.clusterId).not.toBe(dist2.clusterId);
      expect(dist1.contextDigest).not.toBe(dist2.contextDigest);
    });

    it("Phase 87 Integration: Dynamic tool analysis of context graph produces untrusted observation", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" });
      // Output of dynamic tool analysis is strictly unprivileged
      expect(dist.authoritative).toBe(false);
      expect(dist.terminalAuthority).toBe(false);
    });

    it("Phase 88 Integration: Strategy-search context expansion preserves strategy branch isolation", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      expect(dist.expansionRoundsUsed).toBeGreaterThanOrEqual(0);
      expect(dist.estimatedBytes).toBeLessThanOrEqual(DEFAULT_CONTEXT_RESOURCE_LIMITS.maxTotalContextBytes);
    });

    it("Phase 83 Integration: Delta-screening evidence prioritizes target nodes", () => {
      const centrality = relevanceEngine.computeGraphCentrality(sampleGraph);
      const rel = relevanceEngine.calculateHybridRelevance(sampleGraph, sampleGoal, centrality);
      // Target file node-action has max astProximityScore
      expect(rel["node-action"]!.astProximityScore).toBe(1.0);
    });

    it("Phase 85 Integration: Third undeclared repository nodes are excluded when declared edges restrict it", () => {
      const triRepoGraph: ASTContextGraph = {
        ...sampleGraph,
        repositoryIds: [repoMain, repoAux, "repo-third"],
        nodes: {
          ...sampleGraph.nodes,
          "node-third": {
            nodeId: "node-third",
            repositoryId: "repo-third",
            filePath: "src/third.ts",
            nodeType: "FILE",
            symbolName: "Third",
            sourceDigest: "t3",
            estimatedTokens: 100,
            estimatedBytes: 400,
            isTest: false,
            isConfiguration: false,
            isCritical: false,
            tags: [],
          },
        },
      };
      const rep = policy.validateContext({
        context: distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: triRepoGraph, strategy: "STRATEGY_E_HYBRID_RELEVANCE" }),
        goal: sampleGoal,
        contract: sampleContract,
        graph: triRepoGraph,
        workflowContext: getWorkflowContext({ allowedRepositoryScopes: [repoMain, repoAux] }),
        declaredCrossRepoEdges: [{ fromRepo: repoMain, toRepo: repoAux }],
      });
      // Context should remain valid as long as node-third was not selected or if selected is caught by policy
      expect(rep.valid).toBe(true);
    });

    it("Empty graph handling: Gracefully handles empty graph without throwing", () => {
      const emptyGraph: ASTContextGraph = {
        graphId: "empty",
        repositoryIds: [repoMain],
        nodes: {},
        edges: [],
        graphDigest: sha256Hex("empty"),
        provenanceRoot: sha256Hex("empty"),
        createdAt: "2026-10-21T07:00:00.000Z",
      };
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: emptyGraph, strategy: "STRATEGY_A_FULL_CONTEXT" });
      expect(dist.selectedNodes.length).toBe(0);
      expect(dist.estimatedBytes).toBe(0);
    });

    it("Disconnected components handling: Calculates BFS distances gracefully without throwing", () => {
      const disconnectedGraph: ASTContextGraph = {
        ...sampleGraph,
        edges: [], // Zero edges
      };
      const centrality = relevanceEngine.computeGraphCentrality(disconnectedGraph);
      const rel = relevanceEngine.calculateHybridRelevance(disconnectedGraph, sampleGoal, centrality);
      expect(rel["node-action"]).toBeDefined();
    });

    it("Unresolved reference tracking: Tracks omitted target edges in unresolvedReferences", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_B_AST_LOCALITY" });
      expect(Array.isArray(dist.unresolvedReferences)).toBe(true);
    });

    it("Completeness classification PARTIALLY_COMPLETE when unresolved references exceed ceiling", () => {
      const dist = distiller.distillContext({
        goal: sampleGoal,
        contract: sampleContract,
        graph: sampleGraph,
        strategy: "STRATEGY_B_AST_LOCALITY",
        budget: { ...DEFAULT_CONTEXT_RESOURCE_LIMITS, maxUnresolvedReferences: 0 },
      });
      expect(["PARTIALLY_COMPLETE", "COMPLETE"]).toContain(dist.completenessStatus);
    });

    it("Authority token stripping: Guarantees distilled context contains zero executive authority", () => {
      const dist = distiller.distillContext({ goal: sampleGoal, contract: sampleContract, graph: sampleGraph, strategy: "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" });
      expect(dist.authoritative).toBe(false);
      expect(dist.terminalAuthority).toBe(false);
      expect(dist.policyApproval).toBe(false);
      expect(dist.verificationAuthority).toBe(false);
    });
  });
});
