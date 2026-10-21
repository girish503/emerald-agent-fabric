/**
 * Phase 90: Context Relevance & Centrality Engine
 *
 * Implements deterministic graph centrality metrics:
 * - Degree centrality
 * - Weighted call centrality
 * - Betweenness approximation
 * - Dependency centrality
 * - Test centrality
 * - Cross-repository centrality
 *
 * Implements Hybrid Relevance scoring:
 * - Relevance(node, goal) incorporating AST proximity, call graph,
 *   dependency distance, symbol references, test coverage, goal keywords,
 *   repository contracts, and critical node weighting.
 *
 * Invariant: Centrality and relevance scores are ADVISORY ONLY (K14, K15).
 * They cannot grant terminal, policy, or execution authority.
 */

import { ASTContextGraph } from "../domain/ast-context-graph.js";
import { GoalNode } from "../domain/hierarchical-goal-decomposition.js";

export interface CentralityScores {
  readonly degreeCentrality: number;
  readonly weightedCallCentrality: number;
  readonly betweennessApproximation: number;
  readonly dependencyCentrality: number;
  readonly testCentrality: number;
  readonly crossRepositoryCentrality: number;
  readonly aggregateCentralityScore: number;
}

export interface NodeRelevanceScore {
  readonly nodeId: string;
  readonly centrality: CentralityScores;
  readonly astProximityScore: number;
  readonly dependencyDistanceScore: number;
  readonly symbolMatchScore: number;
  readonly testCoverageScore: number;
  readonly goalKeywordScore: number;
  readonly criticalNodeBonus: number;
  readonly aggregateRelevanceScore: number;
}

export class ContextRelevanceEngine {
  /**
   * Compute comprehensive centrality metrics for every node in the graph.
   */
  public computeGraphCentrality(graph: ASTContextGraph): Record<string, CentralityScores> {
    const nodeIds = Object.keys(graph.nodes);
    const n = nodeIds.length;
    if (n === 0) return {};

    const inDegreeMap = new Map<string, number>();
    const outDegreeMap = new Map<string, number>();
    const callWeightMap = new Map<string, number>();
    const testEdgeMap = new Map<string, number>();
    const crossRepoEdgeMap = new Map<string, number>();
    const dependencyReachMap = new Map<string, Set<string>>();

    for (const id of nodeIds) {
      inDegreeMap.set(id, 0);
      outDegreeMap.set(id, 0);
      callWeightMap.set(id, 0);
      testEdgeMap.set(id, 0);
      crossRepoEdgeMap.set(id, 0);
      dependencyReachMap.set(id, new Set<string>());
    }

    // Accumulate degrees and edge weights
    for (const edge of graph.edges) {
      const src = edge.sourceNodeId;
      const tgt = edge.targetNodeId;

      if (outDegreeMap.has(src)) outDegreeMap.set(src, outDegreeMap.get(src)! + 1);
      if (inDegreeMap.has(tgt)) inDegreeMap.set(tgt, inDegreeMap.get(tgt)! + 1);

      if (edge.edgeType === "CALL") {
        if (callWeightMap.has(src)) callWeightMap.set(src, callWeightMap.get(src)! + edge.weight);
        if (callWeightMap.has(tgt)) callWeightMap.set(tgt, callWeightMap.get(tgt)! + edge.weight);
      }

      if (edge.edgeType === "TEST_TO_SOURCE") {
        if (testEdgeMap.has(tgt)) testEdgeMap.set(tgt, testEdgeMap.get(tgt)! + 1);
        if (testEdgeMap.has(src)) testEdgeMap.set(src, testEdgeMap.get(src)! + 1);
      }

      if (edge.edgeType === "CROSS_REPO_DEPENDENCY") {
        if (crossRepoEdgeMap.has(src)) crossRepoEdgeMap.set(src, crossRepoEdgeMap.get(src)! + 1);
        if (crossRepoEdgeMap.has(tgt)) crossRepoEdgeMap.set(tgt, crossRepoEdgeMap.get(tgt)! + 1);
      }

      if (edge.edgeType === "IMPORT" || edge.edgeType === "CROSS_REPO_DEPENDENCY") {
        if (dependencyReachMap.has(src)) {
          dependencyReachMap.get(src)!.add(tgt);
        }
      }
    }

    const divisor = n > 1 ? n - 1 : 1;
    const scores: Record<string, CentralityScores> = {};

    for (const id of nodeIds) {
      const inDeg = inDegreeMap.get(id) || 0;
      const outDeg = outDegreeMap.get(id) || 0;
      const totalDeg = inDeg + outDeg;

      const degreeCentrality = Math.min(1.0, totalDeg / divisor);
      const weightedCallCentrality = Math.min(1.0, (callWeightMap.get(id) || 0) / divisor);
      const testCentrality = Math.min(1.0, (testEdgeMap.get(id) || 0) / divisor);
      const crossRepositoryCentrality = Math.min(1.0, (crossRepoEdgeMap.get(id) || 0) / divisor);
      const dependencyCentrality = Math.min(1.0, (dependencyReachMap.get(id)?.size || 0) / divisor);

      // Deterministic betweenness approximation based on in/out degree product
      const betweennessApproximation = Math.min(1.0, (inDeg * outDeg) / (divisor * divisor));

      // Aggregate centrality score (0.0 to 1.0)
      const aggregateCentralityScore = Number(
        (
          degreeCentrality * 0.25 +
          weightedCallCentrality * 0.3 +
          betweennessApproximation * 0.2 +
          dependencyCentrality * 0.15 +
          testCentrality * 0.05 +
          crossRepositoryCentrality * 0.05
        ).toFixed(4)
      );

      scores[id] = {
        degreeCentrality,
        weightedCallCentrality,
        betweennessApproximation,
        dependencyCentrality,
        testCentrality,
        crossRepositoryCentrality,
        aggregateCentralityScore,
      };
    }

    return scores;
  }

  /**
   * Calculate hybrid relevance of each graph node with respect to a specific GoalNode.
   */
  public calculateHybridRelevance(
    graph: ASTContextGraph,
    goal: GoalNode,
    centralityMap: Record<string, CentralityScores>
  ): Record<string, NodeRelevanceScore> {
    const results: Record<string, NodeRelevanceScore> = {};
    const targetFileSet = new Set(goal.affectedScope.targetFiles);
    const goalText = `${goal.objective} ${goal.constraints.join(" ")} ${goal.acceptanceCriteria.join(" ")}`.toLowerCase();
    const goalTokens = new Set(goalText.split(/[\s,._\-/:()]+/).filter((t) => t.length > 2));

    // Map each target file to its nodeIds in the graph
    const targetNodeIds = new Set<string>();
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      if (targetFileSet.has(node.filePath)) {
        targetNodeIds.add(nodeId);
      }
    }

    // Compute topological distances from target nodes
    const distanceMap = this.computeShortestDistances(graph, targetNodeIds);

    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      const centrality = centralityMap[nodeId] || {
        degreeCentrality: 0,
        weightedCallCentrality: 0,
        betweennessApproximation: 0,
        dependencyCentrality: 0,
        testCentrality: 0,
        crossRepositoryCentrality: 0,
        aggregateCentralityScore: 0,
      };

      // 1. AST Proximity Score: 1.0 for direct target, decayed by graph distance
      const dist = distanceMap.get(nodeId);
      let astProximityScore = 0;
      if (targetFileSet.has(node.filePath)) {
        astProximityScore = 1.0;
      } else if (dist !== undefined && dist > 0) {
        astProximityScore = Number(Math.max(0.1, 1.0 / (dist + 1)).toFixed(3));
      }

      // 2. Dependency Distance Score
      const dependencyDistanceScore = node.tags.includes("dependency") ? 0.8 : 0.4;

      // 3. Symbol Match Score
      let symbolMatchScore = 0;
      const symbolTokens = node.symbolName.toLowerCase().split(/[\s_.-]+/);
      let matches = 0;
      for (const st of symbolTokens) {
        if (goalTokens.has(st)) matches++;
      }
      if (symbolTokens.length > 0) {
        symbolMatchScore = Number(Math.min(1.0, matches / Math.min(3, symbolTokens.length)).toFixed(3));
      }

      // 4. Test Coverage Score
      const testCoverageScore = node.isTest ? (astProximityScore > 0 ? 0.9 : 0.3) : 0.1;

      // 5. Goal Keyword Score
      let goalKeywordScore = 0;
      const fileTokens = node.filePath.toLowerCase().split(/[\s/._-]+/);
      let fileMatches = 0;
      for (const ft of fileTokens) {
        if (goalTokens.has(ft)) fileMatches++;
      }
      goalKeywordScore = Number(Math.min(1.0, fileMatches * 0.25).toFixed(3));

      // 6. Critical Node Bonus: ensures low-centrality critical nodes (e.g. config/schema/error-mapper) are retained
      const criticalNodeBonus = node.isCritical ? 0.6 : 0.0;

      // Aggregate Hybrid Relevance Score (0.0 to 1.0)
      const rawAggregate =
        astProximityScore * 0.35 +
        centrality.aggregateCentralityScore * 0.2 +
        symbolMatchScore * 0.15 +
        goalKeywordScore * 0.1 +
        testCoverageScore * 0.1 +
        criticalNodeBonus * 0.1;

      const aggregateRelevanceScore = Number(Math.min(1.0, rawAggregate).toFixed(4));

      results[nodeId] = {
        nodeId,
        centrality,
        astProximityScore,
        dependencyDistanceScore,
        symbolMatchScore,
        testCoverageScore,
        goalKeywordScore,
        criticalNodeBonus,
        aggregateRelevanceScore,
      };
    }

    return results;
  }

  /**
   * Helper: compute shortest path distances from target node set via BFS.
   */
  private computeShortestDistances(
    graph: ASTContextGraph,
    startNodeIds: Set<string>
  ): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [];

    // Adjacency list (undirected for distance evaluation)
    const adj = new Map<string, string[]>();
    for (const id of Object.keys(graph.nodes)) {
      adj.set(id, []);
    }
    for (const edge of graph.edges) {
      adj.get(edge.sourceNodeId)?.push(edge.targetNodeId);
      adj.get(edge.targetNodeId)?.push(edge.sourceNodeId);
    }

    for (const id of startNodeIds) {
      distances.set(id, 0);
      queue.push(id);
    }

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const d = distances.get(curr)!;
      const neighbors = adj.get(curr) || [];
      for (const nbr of neighbors) {
        if (!distances.has(nbr)) {
          distances.set(nbr, d + 1);
          queue.push(nbr);
        }
      }
    }

    return distances;
  }
}
