/**
 * Phase 90: Context Cluster Provenance Engine
 *
 * Implements cryptographic Merkle tree provenance over context distillation outputs:
 * - Source file digests
 * - Graph edge digests
 * - Extraction methods
 * - Context cluster digests
 *
 * Guarantees reproducibility and tamper detection (Invariants K6, K7, N430–N432).
 */

import { DistilledContext } from "./subgoal-context-distiller.js";
import { GraphEdge, GraphNode } from "../domain/ast-context-graph.js";
import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";

export interface ContextProvenanceComponents {
  readonly context: DistilledContext;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export class ContextClusterProvenanceEngine {
  /**
   * Compute an immutable Merkle provenance root for a distilled context bundle.
   */
  public computeContextProvenanceRoot(components: ContextProvenanceComponents): string {
    const nodeDigests = components.nodes.map((n) => n.sourceDigest).sort();
    const edgeDigests = components.edges.map((e) => e.provenance.edgeDigest).sort();

    const nodesRoot = sha256Hex(canonicalJsonStringify(nodeDigests));
    const edgesRoot = sha256Hex(canonicalJsonStringify(edgeDigests));

    return sha256Hex(
      canonicalJsonStringify({
        clusterId: components.context.clusterId,
        strategy: components.context.strategy,
        goalId: components.context.goalId,
        contextDigest: components.context.contextDigest,
        sourceProvenance: components.context.sourceProvenance,
        nodesRoot,
        edgesRoot,
        completenessStatus: components.context.completenessStatus,
      })
    );
  }

  /**
   * Verify the cryptographic provenance root of a distilled context.
   */
  public verifyContextProvenance(
    expectedRoot: string,
    components: ContextProvenanceComponents
  ): boolean {
    const computed = this.computeContextProvenanceRoot(components);
    return computed === expectedRoot;
  }
}
