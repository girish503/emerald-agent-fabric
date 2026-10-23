/**
 * Emerald Agent Fabric — Production Replay Engine
 *
 * Implements deterministic read-only replay and run reconstruction.
 *
 * Answers Section 19 required questions:
 * - What happened?
 * - Which model proposed it?
 * - Which policy allowed it?
 * - Which capability permitted it?
 * - Which tool executed?
 * - Which attempt executed?
 * - What changed?
 * - What failed?
 * - What verified the result?
 * - Why did Emerald stop?
 */

import { ProductionEvidenceBundle } from "../control-plane/evidence-control.js";

export interface ReplayReport {
  readonly runId: string;
  readonly missionId: string;
  readonly summary: string;
  readonly modelId: string;
  readonly contractId: string;
  readonly contractHash: string;
  readonly actionsSummary: readonly string[];
  readonly toolExecutions: readonly {
    readonly tool: string;
    readonly permittedByCapability: string;
    readonly allowedByPolicy: string;
  }[];
  readonly changes: {
    readonly diff: string;
  };
  readonly failures: readonly string[];
  readonly verification: {
    readonly verified: boolean;
    readonly verifier: string;
    readonly proofHash: string;
  };
  readonly finalDisposition: string;
  readonly stopReason: string;
  readonly reconstructedSuccessfully: boolean;
  readonly diagnosticObservations?: readonly {
    readonly sequence: number;
    readonly eventType: string;
    readonly status: string;
    readonly summary: string;
  }[];
  readonly evidenceSelectionObservations?: readonly {
    readonly sequence: number;
    readonly originalDigest: string;
    readonly selectedDigest: string;
    readonly originalEvidenceDigest?: string;
    readonly selectedEvidenceDigest?: string;
    readonly originalBytes: number;
    readonly selectedBytes: number;
    readonly omittedCount: number;
    readonly reductionPercent?: number;
    readonly summary: string;
  }[];
  readonly anchoredEditObservations?: readonly {
    readonly sequence: number;
    readonly eventType: string;
    readonly path: string;
    readonly originalDigest?: string;
    readonly resultingDigest?: string;
    readonly outcome: string;
    readonly summary: string;
  }[];
}

export class ProductionReplayEngine {
  /**
   * Reconstructs a historical run deterministically from its evidence bundle.
   */
  public reconstructRun(bundle: ProductionEvidenceBundle): ReplayReport {
    const actionsSummary = bundle.timeline.map(
      (t) => `[Seq ${t.sequence}] ${t.eventType} by ${t.actor}: ${t.description}`,
    );

    const toolEvents = bundle.timeline.filter((t) => t.eventType.startsWith("tool."));
    const toolExecutions = toolEvents.map((t) => ({
      tool: String(t.details["toolName"] ?? t.description),
      permittedByCapability: String(t.details["capability"] ?? "AUTHORIZED_IN_FENCE"),
      allowedByPolicy: "PolicyEvaluator + CapabilityFenceEnforcer",
    }));

    const failureEvents = bundle.timeline
      .filter((t) => t.eventType.includes("fail") || t.eventType.includes("deni") || t.eventType.includes("reject"))
      .map((t) => `${t.eventType}: ${t.description}`);

    const stopReason = bundle.disposition === "ACCEPTED"
      ? "Goal achieved and sovereign verification passed"
      : `Halted with disposition ${bundle.disposition}`;

    const diagnosticEvents = bundle.timeline.filter((t) => t.eventType.startsWith("diagnostic."));
    const diagnosticObservations = diagnosticEvents.map((t) => ({
      sequence: t.sequence,
      eventType: t.eventType,
      status: String(t.details["status"] ?? "OBSERVED"),
      summary: t.description,
    }));

    const selectionEvents = bundle.timeline.filter((t) => t.eventType === "repair.minimal_evidence_selected");
    const evidenceSelectionObservations = selectionEvents.map((t) => ({
      sequence: t.sequence,
      originalDigest: String(t.details["originalEvidenceDigest"] ?? t.details["originalDigest"] ?? ""),
      selectedDigest: String(t.details["selectedEvidenceDigest"] ?? t.details["selectedDigest"] ?? ""),
      originalEvidenceDigest: String(t.details["originalEvidenceDigest"] ?? t.details["originalDigest"] ?? ""),
      selectedEvidenceDigest: String(t.details["selectedEvidenceDigest"] ?? t.details["selectedDigest"] ?? ""),
      originalBytes: Number(t.details["originalBytes"] ?? 0),
      selectedBytes: Number(t.details["selectedBytes"] ?? 0),
      omittedCount: Number(t.details["omittedCount"] ?? 0),
      reductionPercent: Number(t.details["reductionPercent"] ?? 0),
      summary: t.description,
    }));

    const editEvents = bundle.timeline.filter((t) => t.eventType.startsWith("repair.file_anchored_edit"));
    const anchoredEditObservations = editEvents.map((t) => ({
      sequence: t.sequence,
      eventType: t.eventType,
      path: String(t.details["filePath"] ?? ""),
      originalDigest: t.details["originalDigest"] ? String(t.details["originalDigest"]) : undefined,
      resultingDigest: t.details["resultingDigest"] ? String(t.details["resultingDigest"]) : undefined,
      outcome: String(t.details["outcome"] ?? "UNKNOWN"),
      summary: t.description,
    }));

    return {
      runId: bundle.runId,
      missionId: bundle.missionId,
      summary: `Run ${bundle.runId} completed with disposition ${bundle.disposition}. Verified: ${bundle.verificationResult.verified}.`,
      modelId: bundle.modelId,
      contractId: bundle.contractId,
      contractHash: bundle.contractHash,
      actionsSummary,
      toolExecutions,
      changes: {
        diff: bundle.gitDiff,
      },
      failures: failureEvents,
      verification: {
        verified: bundle.verificationResult.verified,
        verifier: bundle.verificationResult.sovereignVerifier,
        proofHash: bundle.verificationResult.proofHash,
      },
      finalDisposition: bundle.disposition,
      stopReason,
      diagnosticObservations,
      evidenceSelectionObservations,
      anchoredEditObservations,
      reconstructedSuccessfully: true,
    };
  }
}
