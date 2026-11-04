/**
 * Artifact exporter port.
 *
 * Preserves what an agent changed in a run workspace before the workspace is destroyed. A baseline is
 * captured once, before the agent runs, in a location the agent cannot reach. Just before disposal the
 * exporter writes a patch (baseline to final) and a manifest of changed files.
 *
 * Contract:
 * - Neither operation may modify the workspace.
 * - Failures must throw ArtifactExportError; callers treat a failed export as a failed run and preserve
 *   the workspace instead of disposing it.
 */

import type { ArtifactExportSummary } from "../domain/events.js";

export type { ArtifactExportSummary } from "../domain/events.js";

export interface ArtifactScope {
  readonly runId: string;
  /** 1-based attempt number; each attempt gets its own artifact so a retry never overwrites an earlier one. */
  readonly attempt: number;
  readonly workspacePath: string;
}

export interface ArtifactExporterPort {
  /** Records the workspace content as the baseline. Called once per attempt, before the agent runs. */
  captureBaseline(scope: ArtifactScope): Promise<void>;
  /** Writes the patch and manifest for everything that differs from the baseline. */
  exportArtifact(scope: ArtifactScope & { readonly disposalReason?: string }): Promise<ArtifactExportSummary>;
}

export type ArtifactExportErrorCode = "ARTIFACT_BASELINE_FAILED" | "ARTIFACT_EXPORT_FAILED";

export class ArtifactExportError extends Error {
  constructor(
    readonly code: ArtifactExportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ArtifactExportError";
  }
}
