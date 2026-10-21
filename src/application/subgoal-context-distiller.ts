/**
 * Phase 90: Sub-Goal Context Distiller
 *
 * Implements context distillation across 6 clustering strategies:
 * - STRATEGY A — FULL_CONTEXT (Control)
 * - STRATEGY B — AST_LOCALITY
 * - STRATEGY C — CALL_CENTRALITY
 * - STRATEGY D — DEPENDENCY_CLOSURE
 * - STRATEGY E — HYBRID_RELEVANCE
 * - STRATEGY F — ADAPTIVE_GOAL_CONTEXT
 *
 * Enforces bounded adaptive context expansion, completeness validation,
 * budget ceilings (128KB total / 64KB per stage / 256 nodes), and authority stripping.
 *
 * Invariant: Context compression may remove irrelevant information.
 * It must never remove required evidence or create authority.
 */

import { ASTContextGraph, GraphNode } from "../domain/ast-context-graph.js";
import {
  ContextCompletenessStatus,
  ContextResourceBudget,
  DEFAULT_CONTEXT_RESOURCE_LIMITS,
} from "../domain/context-cluster.js";
import { GoalNode, SubGoalContract } from "../domain/hierarchical-goal-decomposition.js";
import { ContextRelevanceEngine } from "./context-relevance-engine.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

export type ContextClusteringStrategy =
  | "STRATEGY_A_FULL_CONTEXT"
  | "STRATEGY_B_AST_LOCALITY"
  | "STRATEGY_C_CALL_CENTRALITY"
  | "STRATEGY_D_DEPENDENCY_CLOSURE"
  | "STRATEGY_E_HYBRID_RELEVANCE"
  | "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT";

export interface DistilledContext {
  readonly clusterId: string;
  readonly strategy: ContextClusteringStrategy;
  readonly goalId: string;
  readonly repositoryId: string;
  readonly selectedNodes: readonly GraphNode[];
  readonly excludedNodes: readonly GraphNode[];
  readonly selectionRationale: Record<string, string>;
  readonly relevanceScores: Record<string, number>;
  readonly dependencyClosure: readonly string[];
  readonly unresolvedReferences: readonly string[];
  readonly omittedEdgeCount: number;
  readonly omittedSymbolCount: number;
  readonly contextDigest: string;
  readonly sourceProvenance: string;
  readonly estimatedTokens: number;
  readonly estimatedBytes: number;
  readonly completenessStatus: ContextCompletenessStatus;
  readonly expansionRoundsUsed: number;
  // Strict non-authority guarantees
  readonly authoritative: false;
  readonly terminalAuthority: false;
  readonly policyApproval: false;
  readonly verificationAuthority: false;
  readonly createdAt: string;
}

export class SubGoalContextDistiller {
  private readonly relevanceEngine: ContextRelevanceEngine;

  constructor(relevanceEngine?: ContextRelevanceEngine) {
    this.relevanceEngine = relevanceEngine || new ContextRelevanceEngine();
  }

  /**
   * Distill goal-conditioned context from the repository graph using the specified strategy.
   */
  public distillContext(params: {
    readonly goal: GoalNode;
    readonly contract: SubGoalContract;
    readonly graph: ASTContextGraph;
    readonly strategy: ContextClusteringStrategy;
    readonly budget?: ContextResourceBudget;
    readonly availableEvidence?: readonly string[];
    readonly simulateStaleNode?: boolean;
    readonly simulateContradiction?: boolean;
  }): DistilledContext {
    const budget = params.budget || DEFAULT_CONTEXT_RESOURCE_LIMITS;
    const goal = params.goal;
    const graph = params.graph;
    const strategy = params.strategy;

    // 1. Calculate centrality & hybrid relevance
    const centralityMap = this.relevanceEngine.computeGraphCentrality(graph);
    const relevanceMap = this.relevanceEngine.calculateHybridRelevance(graph, goal, centralityMap);

    const allNodes = Object.values(graph.nodes);
    let selectedNodeIds = new Set<string>();
    const rationale: Record<string, string> = {};

    const targetFiles = new Set(goal.affectedScope.targetFiles);
    const targetNodeIds = allNodes.filter((n) => targetFiles.has(n.filePath)).map((n) => n.nodeId);

    // Initial node selection based on strategy
    switch (strategy) {
      case "STRATEGY_A_FULL_CONTEXT": {
        // Full context (control): select all nodes up to budget
        for (const node of allNodes) {
          selectedNodeIds.add(node.nodeId);
          rationale[node.nodeId] = "Strategy A: Full bounded context baseline";
        }
        break;
      }

      case "STRATEGY_B_AST_LOCALITY": {
        // AST locality: target files + immediate AST neighbors
        for (const tId of targetNodeIds) {
          selectedNodeIds.add(tId);
          rationale[tId] = "Strategy B: Target file node";
        }
        for (const edge of graph.edges) {
          if (targetNodeIds.includes(edge.sourceNodeId)) {
            selectedNodeIds.add(edge.targetNodeId);
            rationale[edge.targetNodeId] = `Strategy B: AST neighbor of ${edge.sourceNodeId}`;
          }
        }
        break;
      }

      case "STRATEGY_C_CALL_CENTRALITY": {
        // Pure Call Centrality: sort strictly by aggregateCentralityScore
        const sortedByCentrality = [...allNodes].sort(
          (a, b) => (centralityMap[b.nodeId]?.aggregateCentralityScore || 0) - (centralityMap[a.nodeId]?.aggregateCentralityScore || 0)
        );
        // Take top 40% of nodes
        const cutoff = Math.max(1, Math.ceil(sortedByCentrality.length * 0.4));
        for (let i = 0; i < cutoff; i++) {
          const n = sortedByCentrality[i]!;
          selectedNodeIds.add(n.nodeId);
          rationale[n.nodeId] = `Strategy C: Top centrality rank (${centralityMap[n.nodeId]?.aggregateCentralityScore.toFixed(3)})`;
        }
        break;
      }

      case "STRATEGY_D_DEPENDENCY_CLOSURE": {
        // Dependency closure: target files + full transitive imports
        const queue = [...targetNodeIds];
        for (const id of queue) {
          selectedNodeIds.add(id);
          rationale[id] = "Strategy D: Target node";
        }
        const visited = new Set<string>(queue);

        while (queue.length > 0) {
          const curr = queue.shift()!;
          for (const edge of graph.edges) {
            if (edge.sourceNodeId === curr && (edge.edgeType === "IMPORT" || edge.edgeType === "CROSS_REPO_DEPENDENCY")) {
              if (!visited.has(edge.targetNodeId)) {
                visited.add(edge.targetNodeId);
                selectedNodeIds.add(edge.targetNodeId);
                rationale[edge.targetNodeId] = `Strategy D: Transitive dependency from ${curr}`;
                queue.push(edge.targetNodeId);
              }
            }
          }
        }
        break;
      }

      case "STRATEGY_E_HYBRID_RELEVANCE": {
        // Hybrid relevance: always include targets + nodes exceeding relevance threshold
        for (const tId of targetNodeIds) {
          selectedNodeIds.add(tId);
          rationale[tId] = "Strategy E: Target node";
        }
        for (const node of allNodes) {
          const score = relevanceMap[node.nodeId]?.aggregateRelevanceScore || 0;
          if (score >= 0.35 || node.isCritical) {
            selectedNodeIds.add(node.nodeId);
            rationale[node.nodeId] = `Strategy E: Relevance ${score.toFixed(3)}${node.isCritical ? " (Critical Node)" : ""}`;
          }
        }
        break;
      }

      case "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT": {
        // Adaptive Goal Context: Hybrid relevance + mandatory test coverage + critical configuration retention
        for (const tId of targetNodeIds) {
          selectedNodeIds.add(tId);
          rationale[tId] = "Strategy F: Core target file";
        }
        for (const node of allNodes) {
          const rel = relevanceMap[node.nodeId];
          if (!rel) continue;

          if (node.isCritical) {
            selectedNodeIds.add(node.nodeId);
            rationale[node.nodeId] = "Strategy F: Critical architectural anchor retained";
          } else if (node.isTest && rel.astProximityScore > 0) {
            selectedNodeIds.add(node.nodeId);
            rationale[node.nodeId] = "Strategy F: Direct test coverage node";
          } else if (rel.aggregateRelevanceScore >= 0.3) {
            selectedNodeIds.add(node.nodeId);
            rationale[node.nodeId] = `Strategy F: Goal-conditioned relevance (${rel.aggregateRelevanceScore.toFixed(3)})`;
          }
        }
        break;
      }
    }

    // 2. Bounded Context Expansion (adaptive expansion if missing references exist)
    let expansionRoundsUsed = 0;
    if (strategy === "STRATEGY_F_ADAPTIVE_GOAL_CONTEXT" || strategy === "STRATEGY_E_HYBRID_RELEVANCE") {
      let expanded = true;
      while (expanded && expansionRoundsUsed < budget.maxExpansionRounds) {
        expanded = false;
        expansionRoundsUsed++;
        let nodesAddedThisRound = 0;

        for (const edge of graph.edges) {
          if (nodesAddedThisRound >= budget.maxNodesAddedPerRound) break;
          if (selectedNodeIds.has(edge.sourceNodeId) && !selectedNodeIds.has(edge.targetNodeId)) {
            const targetNode = graph.nodes[edge.targetNodeId];
            if (targetNode && (edge.edgeType === "IMPORT" || edge.edgeType === "CALL" || targetNode.isCritical)) {
              selectedNodeIds.add(edge.targetNodeId);
              rationale[edge.targetNodeId] = `Expanded in Round ${expansionRoundsUsed} via edge ${edge.edgeId}`;
              nodesAddedThisRound++;
              expanded = true;
            }
          }
        }
      }
    }

    // 3. Apply Budget Constraints (ceiling enforcement)
    const selectedList: GraphNode[] = [];
    const excludedList: GraphNode[] = [];
    let currentBytes = 0;

    // Prioritize target nodes and critical nodes within selection
    const sortedSelectedIds = Array.from(selectedNodeIds).sort((a, b) => {
      const nodeA = graph.nodes[a]!;
      const nodeB = graph.nodes[b]!;
      if (nodeA.isCritical && !nodeB.isCritical) return -1;
      if (!nodeA.isCritical && nodeB.isCritical) return 1;
      return (relevanceMap[b]?.aggregateRelevanceScore || 0) - (relevanceMap[a]?.aggregateRelevanceScore || 0);
    });

    for (const id of sortedSelectedIds) {
      const node = graph.nodes[id];
      if (!node) continue;

      if (
        selectedList.length < budget.maxGraphNodes &&
        currentBytes + node.estimatedBytes <= budget.maxPerStageContextBytes &&
        currentBytes + node.estimatedBytes <= budget.maxTotalContextBytes
      ) {
        selectedList.push(node);
        currentBytes += node.estimatedBytes;
      } else {
        excludedList.push(node);
      }
    }

    // Add remaining graph nodes to excludedList
    for (const node of allNodes) {
      if (!selectedList.some((s) => s.nodeId === node.nodeId) && !excludedList.some((e) => e.nodeId === node.nodeId)) {
        excludedList.push(node);
      }
    }

    // 4. Calculate unresolved references and omitted edges/symbols
    const finalSelectedIdSet = new Set(selectedList.map((n) => n.nodeId));
    const unresolvedReferences: string[] = [];
    let omittedEdgeCount = 0;

    for (const edge of graph.edges) {
      if (finalSelectedIdSet.has(edge.sourceNodeId)) {
        if (!finalSelectedIdSet.has(edge.targetNodeId)) {
          unresolvedReferences.push(edge.targetNodeId);
          omittedEdgeCount++;
        }
      } else {
        omittedEdgeCount++;
      }
    }

    const omittedSymbolCount = excludedList.length;
    const dependencyClosure = Array.from(
      new Set(
        graph.edges
          .filter((e) => finalSelectedIdSet.has(e.sourceNodeId) && (e.edgeType === "IMPORT" || e.edgeType === "CROSS_REPO_DEPENDENCY"))
          .map((e) => e.targetNodeId)
      )
    );

    // 5. Evaluate Context Completeness
    let completenessStatus: ContextCompletenessStatus = "COMPLETE";
    if (params.simulateStaleNode) {
      completenessStatus = "STALE";
    } else if (params.simulateContradiction) {
      completenessStatus = "CONTRADICTORY";
    } else if (targetNodeIds.some((id) => !finalSelectedIdSet.has(id))) {
      completenessStatus = "INCOMPLETE";
    } else if (unresolvedReferences.length > budget.maxUnresolvedReferences) {
      completenessStatus = "PARTIALLY_COMPLETE";
    }

    const clusterId = `cluster-${goal.goalId}-${strategy.toLowerCase().replace(/_/g, "-")}`;
    const estimatedTokens = selectedList.reduce((acc, n) => acc + n.estimatedTokens, 0);

    const relevanceScores: Record<string, number> = {};
    for (const node of selectedList) {
      relevanceScores[node.nodeId] = relevanceMap[node.nodeId]?.aggregateRelevanceScore || 0;
    }

    const contextDigest = sha256Hex(
      canonicalJsonStringify({
        clusterId,
        strategy,
        goalId: goal.goalId,
        selectedNodeIds: selectedList.map((n) => n.nodeId).sort(),
        completenessStatus,
      })
    );

    const sourceProvenance = sha256Hex(
      canonicalJsonStringify({
        graphDigest: graph.graphDigest,
        contractDigest: params.contract.contractDigest,
        selectedDigests: selectedList.map((n) => n.sourceDigest).sort(),
      })
    );

    return {
      clusterId,
      strategy,
      goalId: goal.goalId,
      repositoryId: goal.affectedScope.repositoryScopes[0] || "repo-main",
      selectedNodes: selectedList,
      excludedNodes: excludedList,
      selectionRationale: rationale,
      relevanceScores,
      dependencyClosure,
      unresolvedReferences: Array.from(new Set(unresolvedReferences)),
      omittedEdgeCount,
      omittedSymbolCount,
      contextDigest,
      sourceProvenance,
      estimatedTokens,
      estimatedBytes: currentBytes,
      completenessStatus,
      expansionRoundsUsed,
      authoritative: false,
      terminalAuthority: false,
      policyApproval: false,
      verificationAuthority: false,
      createdAt: goal.createdAt,
    };
  }
}
