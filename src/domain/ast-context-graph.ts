/**
 * Phase 90: AST Context Graph Domain Model
 *
 * Defines structural representations for code graphs:
 * - Graph Nodes (FILE, MODULE, CLASS, FUNCTION, METHOD, CONFIGURATION, TEST, INTERFACE)
 * - Graph Edges (IMPORT, CALL, INHERITANCE, TYPE_REFERENCE, TEST_TO_SOURCE, CONFIG_TO_SOURCE, CROSS_REPO_DEPENDENCY)
 * - Graph Edge Provenance and Canonical Cryptographic Digests
 *
 * Invariant: Unknown graph edges must never be silently inferred as authoritative dependencies.
 */

import { canonicalJsonStringify, sha256Hex } from "./canonical-hash.js";

export type ASTNodeType =
  | "FILE"
  | "MODULE"
  | "CLASS"
  | "FUNCTION"
  | "METHOD"
  | "CONFIGURATION"
  | "TEST"
  | "INTERFACE";

export type ASTEdgeType =
  | "IMPORT"
  | "CALL"
  | "INHERITANCE"
  | "TYPE_REFERENCE"
  | "TEST_TO_SOURCE"
  | "CONFIG_TO_SOURCE"
  | "CROSS_REPO_DEPENDENCY";

export interface GraphNode {
  readonly nodeId: string;
  readonly repositoryId: string;
  readonly filePath: string;
  readonly nodeType: ASTNodeType;
  readonly symbolName: string;
  readonly sourceDigest: string;
  readonly estimatedTokens: number;
  readonly estimatedBytes: number;
  readonly isTest: boolean;
  readonly isConfiguration: boolean;
  readonly isCritical: boolean; // e.g., low-centrality critical configuration/schema/mapper
  readonly tags: readonly string[];
}

export interface EdgeProvenance {
  readonly extractor: string;
  readonly sourceDigest: string;
  readonly edgeDigest: string;
  readonly isAuthoritativeDependency: boolean;
}

export interface GraphEdge {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: ASTEdgeType;
  readonly weight: number; // 0.0 to 1.0
  readonly provenance: EdgeProvenance;
}

export interface ASTContextGraph {
  readonly graphId: string;
  readonly repositoryIds: readonly string[];
  readonly nodes: Record<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly graphDigest: string;
  readonly provenanceRoot: string;
  readonly createdAt: string;
}

export function computeNodeDigest(node: Omit<GraphNode, "sourceDigest"> & { sourceDigest?: string }): string {
  return sha256Hex(
    canonicalJsonStringify({
      nodeId: node.nodeId,
      repositoryId: node.repositoryId,
      filePath: node.filePath,
      nodeType: node.nodeType,
      symbolName: node.symbolName,
      sourceDigest: node.sourceDigest || "unspecified",
      isTest: node.isTest,
      isConfiguration: node.isConfiguration,
      isCritical: node.isCritical,
      tags: [...node.tags].sort(),
    })
  );
}

export function computeEdgeDigest(edge: {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: ASTEdgeType;
  readonly weight: number;
  readonly extractor?: string;
  readonly sourceDigest?: string;
}): string {
  return sha256Hex(
    canonicalJsonStringify({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      edgeType: edge.edgeType,
      weight: edge.weight,
      extractor: edge.extractor || "ast-extractor",
      sourceDigest: edge.sourceDigest || "unspecified",
    })
  );
}

export function computeGraphDigest(
  nodes: Record<string, GraphNode>,
  edges: readonly GraphEdge[]
): string {
  const sortedNodeDigests = Object.keys(nodes)
    .sort()
    .map((k) => nodes[k]!.sourceDigest);
  const sortedEdgeDigests = [...edges].map((e) => e.provenance.edgeDigest).sort();

  return sha256Hex(
    canonicalJsonStringify({
      nodeCount: Object.keys(nodes).length,
      edgeCount: edges.length,
      nodesDigest: sha256Hex(canonicalJsonStringify(sortedNodeDigests)),
      edgesDigest: sha256Hex(canonicalJsonStringify(sortedEdgeDigests)),
    })
  );
}

export function computeGraphProvenanceRoot(
  graphDigest: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): string {
  const nodeRoots = nodes.map((n) => n.sourceDigest).sort();
  const edgeRoots = edges.map((e) => e.provenance.edgeDigest).sort();
  return sha256Hex(
    canonicalJsonStringify({
      graphDigest,
      nodeRootsDigest: sha256Hex(canonicalJsonStringify(nodeRoots)),
      edgeRootsDigest: sha256Hex(canonicalJsonStringify(edgeRoots)),
    })
  );
}
