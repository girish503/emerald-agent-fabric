/**
 * Emerald Agent Fabric — Artifact Visualization (Milestone 2.27 / Phase 4)
 *
 * Implements pure functional HTML rendering for:
 * - Authoritative run artifact metadata list
 * - MIME-type and path-based artifact categorization
 * - Human-readable file size formatting and cryptographic SHA-256 integrity display
 * - Clear disclosure that artifact content preview is unavailable over the frozen REST API
 * - Loading, empty, error (401, 403, 404, network), and populated states
 *
 * Security & Architectural Boundaries:
 * - Strictly read-only presentation of metadata from GET /api/v1/runs/:runId/artifacts.
 * - Does not invent an artifact-content or download endpoint.
 * - All dynamic server and task strings are escaped using escapeHtml().
 * - Never executes artifact content or renders raw HTML.
 * - Never treats artifact presence as proof of verification success.
 */

import type { ArtifactContentResponse, ArtifactRecord } from "../types/api.js";
import { escapeHtml } from "./dashboard-view.js";

export type ArtifactCategory =
  | "patch"
  | "code"
  | "config"
  | "log"
  | "document"
  | "binary"
  | "unknown";

export interface ArtifactCategoryInfo {
  readonly category: ArtifactCategory;
  readonly label: string;
  readonly badgeColor: string;
}

/**
 * Formats a raw byte count into human-readable binary units (B, KB, MB, GB).
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/**
 * Shortens a 64-character SHA-256 hash for compact presentation while keeping the full hash accessible.
 */
export function formatShortSha(sha256: string): string {
  if (!sha256 || typeof sha256 !== "string") return "unknown";
  if (sha256.length <= 16) return sha256;
  return `${sha256.slice(0, 8)}...${sha256.slice(-8)}`;
}

/**
 * Determines artifact category and badge styling based on MIME type and file extension.
 */
export function categorizeArtifact(contentType: string, relativePath: string): ArtifactCategoryInfo {
  const normType = (contentType || "").toLowerCase().trim();
  const normPath = (relativePath || "").toLowerCase().trim();

  // 1. Patches & Diffs
  if (
    normType === "text/x-diff" ||
    normType === "text/x-patch" ||
    normPath.endsWith(".diff") ||
    normPath.endsWith(".patch")
  ) {
    return { category: "patch", label: "Patch / Diff", badgeColor: "blue" };
  }

  // 2. Structured Configurations & JSON Data
  if (
    normType === "application/json" ||
    normType === "application/yaml" ||
    normType === "text/yaml" ||
    normType === "application/xml" ||
    normType === "text/xml" ||
    normPath.endsWith(".json") ||
    normPath.endsWith(".yaml") ||
    normPath.endsWith(".yml") ||
    normPath.endsWith(".toml")
  ) {
    return { category: "config", label: "Configuration / JSON", badgeColor: "purple" };
  }

  // 3. Source Code
  if (
    normType.startsWith("text/javascript") ||
    normType.startsWith("application/javascript") ||
    normType.startsWith("text/typescript") ||
    normType.startsWith("application/typescript") ||
    normType.startsWith("text/x-python") ||
    normType.startsWith("text/x-shellscript") ||
    normPath.endsWith(".ts") ||
    normPath.endsWith(".js") ||
    normPath.endsWith(".py") ||
    normPath.endsWith(".sh") ||
    normPath.endsWith(".go") ||
    normPath.endsWith(".rs") ||
    normPath.endsWith(".c") ||
    normPath.endsWith(".cpp")
  ) {
    return { category: "code", label: "Source Code", badgeColor: "green" };
  }

  // 4. Execution Logs & Test Reports
  if (
    normPath.endsWith(".log") ||
    normPath.endsWith(".report") ||
    normType === "text/x-log" ||
    normType.includes("ndjson")
  ) {
    return { category: "log", label: "Log / Report", badgeColor: "yellow" };
  }

  // 5. Documentation & Plain Text
  if (
    normType === "text/markdown" ||
    normType === "text/plain" ||
    normPath.endsWith(".md") ||
    normPath.endsWith(".txt")
  ) {
    return { category: "document", label: "Documentation / Text", badgeColor: "teal" };
  }

  // 6. Binary / Archive
  if (
    normType.startsWith("image/") ||
    normType === "application/octet-stream" ||
    normType === "application/zip" ||
    normType === "application/gzip" ||
    normType === "application/x-tar" ||
    normPath.endsWith(".zip") ||
    normPath.endsWith(".tar.gz") ||
    normPath.endsWith(".bin")
  ) {
    return { category: "binary", label: "Binary / Archive", badgeColor: "gray" };
  }

  // 7. Unknown / Fallback
  return { category: "unknown", label: "General Artifact", badgeColor: "gray" };
}

export interface ArtifactViewerRenderOptions {
  readonly artifacts?: readonly ArtifactRecord[];
  readonly isLoading?: boolean;
  readonly error?: string;
  readonly selectedArtifactId?: string;
  readonly previewContent?: ArtifactContentResponse | null;
  readonly previewLoading?: boolean;
  readonly previewError?: string;
}

/**
 * Renders the artifact inspection card for the selected run.
 */
export function renderArtifactViewer(options: ArtifactViewerRenderOptions): string {
  const {
    artifacts = [],
    isLoading = false,
    error,
    selectedArtifactId,
    previewContent,
    previewLoading = false,
    previewError,
  } = options;

  // 1. Loading State
  if (isLoading) {
    return `
      <div class="artifact-viewer-card" id="artifact-viewer-card">
        <div class="artifact-card-header">
          <h4>Run Artifacts</h4>
          <span class="badge badge-gray">Loading...</span>
        </div>
        <div class="artifact-loading-state" id="artifact-loading-state">
          <span class="spinner"></span>
          <p>Querying registered artifacts for selected run...</p>
        </div>
      </div>
    `.trim();
  }

  // 2. Error State (e.g. 401, 403, 404, or network failure)
  if (error) {
    return `
      <div class="artifact-viewer-card" id="artifact-viewer-card">
        <div class="artifact-card-header">
          <h4>Run Artifacts</h4>
          <span class="badge badge-red">Unavailable</span>
        </div>
        <div class="artifact-error-state error-banner" id="artifact-error-state" role="alert">
          <strong>Failed to load artifact metadata:</strong>
          <span>${escapeHtml(error)}</span>
        </div>
      </div>
    `.trim();
  }

  // 3. Empty State (Run completed or running without producing registered artifacts)
  if (!artifacts || artifacts.length === 0) {
    return `
      <div class="artifact-viewer-card" id="artifact-viewer-card">
        <div class="artifact-card-header">
          <h4>Run Artifacts</h4>
          <span class="badge badge-gray">0 Artifacts</span>
        </div>
        <div class="artifact-empty-state" id="artifact-empty-state">
          <p>No artifacts registered for this run.</p>
          <span class="artifact-subtext">Runs produce export artifacts (such as patches and manifests) upon workspace cleanup or verification checkpoints.</span>
        </div>
      </div>
    `.trim();
  }

  // 4. Populated State: List of Artifacts
  const itemsHtml = artifacts
    .map((art) => {
      const isSelected = art.artifactId === selectedArtifactId;
      const catInfo = categorizeArtifact(art.contentType, art.relativePath);
      const shortSha = formatShortSha(art.sha256);
      const sizeStr = formatByteSize(art.byteSize);
      const selectedClass = isSelected ? "artifact-item-selected" : "";

      return `
        <li class="artifact-item ${selectedClass}" data-artifact-id="${escapeHtml(art.artifactId)}">
          <div class="artifact-item-header">
            <button
              type="button"
              class="artifact-select-trigger"
              data-action="select-artifact"
              data-artifact-id="${escapeHtml(art.artifactId)}"
              title="Inspect metadata for ${escapeHtml(art.relativePath)}"
            >
              <span class="artifact-path font-mono">${escapeHtml(art.relativePath)}</span>
            </button>
            <span class="badge badge-${catInfo.badgeColor}">${escapeHtml(catInfo.label)}</span>
          </div>
          <div class="artifact-item-meta">
            <span class="artifact-id font-mono" title="Artifact ID">ID: ${escapeHtml(art.artifactId)}</span>
            <span class="artifact-size">${escapeHtml(sizeStr)}</span>
            <span class="artifact-mime font-mono">${escapeHtml(art.contentType)}</span>
            <span class="artifact-sha font-mono" title="Full SHA-256: ${escapeHtml(art.sha256)}">SHA: ${escapeHtml(shortSha)}</span>
            <span class="artifact-created">${escapeHtml(art.createdAt)}</span>
          </div>
        </li>
      `.trim();
    })
    .join("\n");

  // Selected Artifact Details Box (Metadata only + explicit preview limitation notice)
  const selectedArtifact = selectedArtifactId
    ? artifacts.find((a) => a.artifactId === selectedArtifactId)
    : undefined;

  let selectedDetailsHtml = "";
  if (selectedArtifact) {
    const cat = categorizeArtifact(selectedArtifact.contentType, selectedArtifact.relativePath);
    selectedDetailsHtml = `
      <div class="artifact-selected-details" id="artifact-selected-details">
        <div class="selected-details-header">
          <h5>Selected Artifact: <code class="font-mono">${escapeHtml(selectedArtifact.relativePath)}</code></h5>
          <span class="badge badge-${cat.badgeColor}">${escapeHtml(cat.label)}</span>
        </div>
        <div class="selected-details-grid">
          <div class="detail-row">
            <span class="detail-label">Artifact ID:</span>
            <span class="detail-value font-mono">${escapeHtml(selectedArtifact.artifactId)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Relative Path:</span>
            <span class="detail-value font-mono">${escapeHtml(selectedArtifact.relativePath)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Content Type:</span>
            <span class="detail-value font-mono">${escapeHtml(selectedArtifact.contentType)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Size:</span>
            <span class="detail-value">${formatByteSize(selectedArtifact.byteSize)} (${selectedArtifact.byteSize.toLocaleString()} bytes)</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">SHA-256 Digest:</span>
            <span class="detail-value font-mono text-break" id="selected-artifact-sha">${escapeHtml(selectedArtifact.sha256)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Created At:</span>
            <span class="detail-value">${escapeHtml(selectedArtifact.createdAt)}</span>
          </div>
        </div>
        ${renderArtifactPreviewSection(selectedArtifact, { previewContent, previewLoading, previewError })}
      </div>
    `.trim();
  }

  return `
    <div class="artifact-viewer-card" id="artifact-viewer-card">
      <div class="artifact-card-header">
        <h4>Run Artifacts</h4>
        <span class="badge badge-blue">${artifacts.length} Artifact${artifacts.length === 1 ? "" : "s"}</span>
      </div>
      <div class="artifact-card-body">
        <ul class="artifact-list" id="artifact-list" role="list">
          ${itemsHtml}
        </ul>
        ${selectedDetailsHtml}
      </div>
    </div>
  `.trim();
}

function renderArtifactPreviewSection(
  artifact: ArtifactRecord,
  options: {
    readonly previewContent?: ArtifactContentResponse | null;
    readonly previewLoading?: boolean;
    readonly previewError?: string;
  }
): string {
  const { previewContent, previewLoading = false, previewError } = options;

  if (previewLoading) {
    return `
      <div class="artifact-preview-loading" id="artifact-preview-loading">
        <span class="spinner"></span>
        <p>Retrieving bounded content for <code>${escapeHtml(artifact.relativePath)}</code>...</p>
      </div>
    `.trim();
  }

  if (previewError) {
    return `
      <div class="artifact-preview-error error-banner" id="artifact-preview-error" role="alert">
        <strong>Content Preview Unavailable:</strong>
        <span>${escapeHtml(previewError)}</span>
      </div>
    `.trim();
  }

  if (previewContent && previewContent.artifactId === artifact.artifactId) {
    const isPatch =
      categorizeArtifact(previewContent.contentType, artifact.relativePath).category === "patch";
    const provenanceLabel = isPatch
      ? "Patch Diff Artifact (diff payload only)"
      : `Bounded Content (${escapeHtml(previewContent.contentType)})`;
    const shaNotice = previewContent.sha256
      ? `<span class="preview-sha font-mono">SHA-256: ${escapeHtml(previewContent.sha256)}</span>`
      : "";
    const truncatedNotice = previewContent.truncated
      ? `<span class="badge badge-yellow" id="artifact-preview-truncated">Truncated Preview (${previewContent.byteLength.toLocaleString()} bytes shown)</span>`
      : `<span class="preview-bytes">${previewContent.byteLength.toLocaleString()} bytes retrieved</span>`;

    return `
      <div class="artifact-content-preview" id="artifact-content-preview">
        <div class="artifact-preview-header">
          <strong>${provenanceLabel}</strong>
          <div class="artifact-preview-meta">
            ${truncatedNotice}
            ${shaNotice}
          </div>
        </div>
        <pre class="artifact-code-block ${isPatch ? "artifact-diff-block" : ""}"><code>${escapeHtml(previewContent.content)}</code></pre>
      </div>
    `.trim();
  }

  return `
    <div class="artifact-preview-notice" id="artifact-preview-notice">
      <span class="notice-icon">&#9432;</span>
      <div class="notice-body">
        <strong>Content Preview Unavailable:</strong>
        <p>The Emerald Agent Fabric backend exposes cryptographic metadata and integrity digests only. Direct content download is not exposed over the REST API and requires a separately authorized backend retrieval capability.</p>
      </div>
    </div>
  `.trim();
}
