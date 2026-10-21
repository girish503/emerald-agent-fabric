/**
 * Emerald Agent Fabric — Production Control Plane: Evidence Control
 *
 * Provides inspectable timelines, provenance trees, and evidence bundles
 * for operators and auditors.
 *
 * Principle:
 * "The verifier decides. The evidence proves."
 */

import { computeCanonicalHash } from "../domain/canonical-hash.js";

export interface TimelineEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly eventType: string;
  readonly description: string;
  readonly actor: string;
  readonly details: Record<string, unknown>;
  readonly hash: string;
}

export interface ProductionEvidenceBundle {
  readonly runId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly contractHash: string;
  readonly workspacePath: string;
  readonly repositoryPath: string;
  readonly modelId: string;
  readonly contextDigest: string;
  readonly actionsCount: number;
  readonly attemptsCount: number;
  readonly gitDiff: string;
  readonly testResults: {
    readonly passed: boolean;
    readonly totalTests: number;
    readonly passedTests: number;
    readonly failedTests: number;
    readonly durationMs: number;
  };
  readonly verificationResult: {
    readonly verified: boolean;
    readonly sovereignVerifier: string;
    readonly proofHash: string;
  };
  readonly timeline: readonly TimelineEntry[];
  readonly disposition: "ACCEPTED" | "REJECTED" | "QUARANTINED";
  readonly completedAt: string;
  readonly bundleDigest: string;
}

export class EvidenceControl {
  private readonly timelines: Map<string, TimelineEntry[]> = new Map();
  private readonly evidenceBundles: Map<string, ProductionEvidenceBundle> = new Map();

  /**
   * Append an entry to a run's timeline.
   */
  public recordTimelineEntry(
    runId: string,
    eventType: string,
    description: string,
    actor: string,
    details: Record<string, unknown> = {},
  ): TimelineEntry {
    const list = this.timelines.get(runId) ?? [];
    const sequence = list.length + 1;
    const timestamp = new Date().toISOString();
    const raw = {
      sequence,
      timestamp,
      eventType,
      description,
      actor,
      details,
    };
    const entry: TimelineEntry = {
      ...raw,
      hash: computeCanonicalHash(raw).contentHash,
    };
    list.push(entry);
    this.timelines.set(runId, list);
    return entry;
  }

  public getTimeline(runId: string): readonly TimelineEntry[] {
    return this.timelines.get(runId) ?? [];
  }

  /**
   * Create and seal a production evidence bundle.
   */
  public sealEvidenceBundle(data: Omit<ProductionEvidenceBundle, "bundleDigest">): ProductionEvidenceBundle {
    const bundleDigest = computeCanonicalHash(data).contentHash;
    const bundle: ProductionEvidenceBundle = {
      ...data,
      bundleDigest,
    };
    this.evidenceBundles.set(data.runId, bundle);
    return bundle;
  }

  public getEvidenceBundle(runId: string): ProductionEvidenceBundle | undefined {
    return this.evidenceBundles.get(runId);
  }

  public listEvidenceBundles(): readonly ProductionEvidenceBundle[] {
    return Array.from(this.evidenceBundles.values());
  }
}
