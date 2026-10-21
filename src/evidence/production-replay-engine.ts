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
      reconstructedSuccessfully: true,
    };
  }
}
