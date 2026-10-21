/**
 * Phase 87 — Dynamic Tool Provenance Engine
 *
 * Cryptographic provenance tracking, stage evidence hashing,
 * and immutable chain verification for multi-tool compositions.
 *
 * INVARIANTS:
 * - Removing, inserting, or reordering a stage invalidates the provenance root.
 * - Stage evidence binds tool identity, inputs, outputs, and execution duration.
 * - Tool data transfers record schema digest and untrusted observation trust level.
 */

import { canonicalJsonStringify, sha256Hex } from "../domain/canonical-hash.js";
import {
  StageExecutionRecord,
  ToolDataTransfer,
  computeCompositionProvenanceRoot,
} from "../domain/dynamic-tool-composition.js";

export class DynamicToolProvenanceEngine {
  /**
   * Computes a deterministic SHA-256 evidence digest for a single completed stage.
   */
  public computeStageEvidenceDigest(record: Omit<StageExecutionRecord, "stageEvidenceDigest">): string {
    const payload = {
      stageId: record.stageId,
      sequenceNumber: record.sequenceNumber,
      toolId: record.toolId,
      toolIdentity: record.toolIdentity,
      status: record.status,
      durationMs: record.durationMs,
      inputDigest: record.inputDigest,
      outputDigest: record.outputDigest,
      error: record.error,
    };
    return sha256Hex(canonicalJsonStringify(payload));
  }

  /**
   * Constructs a cryptographic provenance root binding the sequence of all executed stages.
   */
  public computeProvenanceRoot(records: readonly StageExecutionRecord[]): string {
    const digests = records.map((r) => r.stageEvidenceDigest);
    return computeCompositionProvenanceRoot(digests);
  }

  /**
   * Verifies whether a given provenance root matches the chain of stage records.
   */
  public verifyProvenanceChain(records: readonly StageExecutionRecord[], expectedRoot: string): boolean {
    if (!expectedRoot || records.length === 0) {
      return false;
    }

    // Verify each stage digest independently
    for (const r of records) {
      const computed = this.computeStageEvidenceDigest(r);
      if (computed !== r.stageEvidenceDigest) {
        return false;
      }
    }

    const recomputedRoot = this.computeProvenanceRoot(records);
    return recomputedRoot === expectedRoot;
  }

  /**
   * Constructs an audited ToolDataTransfer record between two stages.
   */
  public createDataTransfer(
    compositionId: string,
    sourceToolId: string,
    destinationToolId: string,
    sourceOutput: unknown,
    destinationInput: unknown,
    schema?: Record<string, unknown>
  ): ToolDataTransfer {
    const sourceOutputDigest = sha256Hex(canonicalJsonStringify(sourceOutput));
    const destinationInputDigest = sha256Hex(canonicalJsonStringify(destinationInput));
    const schemaDigest = sha256Hex(canonicalJsonStringify(schema || {}));

    const transferPayload = {
      compositionId,
      sourceToolId,
      destinationToolId,
      sourceOutputDigest,
      destinationInputDigest,
      schemaDigest,
    };
    const provenanceDigest = sha256Hex(canonicalJsonStringify(transferPayload));

    return {
      compositionId,
      sourceToolId,
      destinationToolId,
      sourceOutputDigest,
      destinationInputDigest,
      schemaDigest,
      provenanceDigest,
      trustLevel: "UNTRUSTED_OBSERVATION",
    };
  }
}
