/**
 * Emerald Agent Fabric — Durable Artifact Metadata Discovery (Milestone 2.28 / Phase 3)
 *
 * Implements read-only discovery of durable run artifacts from:
 *   <artifactRoot>/<runId>/attempt-<n>/manifest.json
 *
 * Security and Containment Guarantees:
 * - Strict canonical path containment (fs.realpathSync + boundary containment)
 * - Safe segment validation on runId (rejects .., ., slashes, drive paths, UNC)
 * - Symlink escape prevention for run dirs, attempt dirs, manifests, and patch files
 * - Fails closed on malformed JSON, corrupt attempt directories, or schema version mismatches
 * - Preserves public ArtifactResponse contracts without exposing host filesystem paths
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ArtifactResponseSchema,
  type ArtifactResponse,
  type ApiErrorCode,
} from "./api-contracts.js";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export class ArtifactDiscoveryError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = "ArtifactDiscoveryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Boundary-aware containment check: verifies targetCanonical resides strictly inside parentCanonical.
 * Prevents traversal, symlink escapes, drive changes, and UNC escapes.
 */
export function isWithinDirectory(parentCanonical: string, targetCanonical: string): boolean {
  const rel = path.relative(parentCanonical, targetCanonical);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface DiscoverRunArtifactsParams {
  readonly artifactRoot: string;
  readonly runId: string;
}

/**
 * Discovers and parses durable artifact metadata for a given run from on-disk manifests.
 */
export function discoverRunArtifacts(params: DiscoverRunArtifactsParams): readonly ArtifactResponse[] {
  const { artifactRoot, runId } = params;

  if (!runId || typeof runId !== "string" || !SAFE_SEGMENT.test(runId) || runId === "." || runId === "..") {
    throw new ArtifactDiscoveryError("BAD_REQUEST", 400, "Invalid run ID format");
  }

  if (!artifactRoot || typeof artifactRoot !== "string" || artifactRoot.trim().length === 0) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact storage root is not configured");
  }

  let canonicalRoot: string;
  try {
    if (!fs.existsSync(artifactRoot) || !fs.statSync(artifactRoot).isDirectory()) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact storage root directory is not accessible");
    }
    canonicalRoot = fs.realpathSync(artifactRoot);
  } catch (err: unknown) {
    if (err instanceof ArtifactDiscoveryError) throw err;
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact storage root directory is not accessible");
  }

  const runDir = path.join(canonicalRoot, runId);
  if (!fs.existsSync(runDir)) {
    // Valid run with no artifacts produced
    return [];
  }

  let canonicalRunDir: string;
  try {
    canonicalRunDir = fs.realpathSync(runDir);
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Failed to resolve run artifact directory");
  }

  if (!isWithinDirectory(canonicalRoot, canonicalRunDir)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Run artifact directory escapes artifact root");
  }

  try {
    if (!fs.statSync(canonicalRunDir).isDirectory()) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Run artifact path is not a directory");
    }
  } catch (err: unknown) {
    if (err instanceof ArtifactDiscoveryError) throw err;
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Failed to inspect run artifact directory");
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(canonicalRunDir, { withFileTypes: true });
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Failed to read run artifact directory");
  }

  const ATTEMPT_DIR_PATTERN = /^attempt-(\d+)$/;
  const attemptDirs: { name: string; attempt: number }[] = [];
  for (const entry of entries) {
    const match = ATTEMPT_DIR_PATTERN.exec(entry.name);
    if (match) {
      const attemptNum = Number(match[1]);
      if (Number.isInteger(attemptNum) && attemptNum >= 1) {
        attemptDirs.push({ name: entry.name, attempt: attemptNum });
      }
    }
  }

  if (attemptDirs.length === 0) {
    return [];
  }

  attemptDirs.sort((a, b) => a.attempt - b.attempt);

  const artifacts: ArtifactResponse[] = [];

  for (const { name, attempt } of attemptDirs) {
    const attemptPath = path.join(canonicalRunDir, name);
    let canonicalAttemptDir: string;
    try {
      canonicalAttemptDir = fs.realpathSync(attemptPath);
    } catch (err: unknown) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to resolve attempt directory ${name}`);
    }

    if (!isWithinDirectory(canonicalRoot, canonicalAttemptDir)) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Attempt directory escapes artifact root: ${name}`);
    }

    try {
      if (!fs.statSync(canonicalAttemptDir).isDirectory()) {
        throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Attempt path is not a directory: ${name}`);
      }
    } catch (err: unknown) {
      if (err instanceof ArtifactDiscoveryError) throw err;
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to inspect attempt directory: ${name}`);
    }

    const manifestPath = path.join(canonicalAttemptDir, "manifest.json");
    const patchFilePath = path.join(canonicalAttemptDir, "patch.diff");

    const manifestExists = fs.existsSync(manifestPath);
    const patchExists = fs.existsSync(patchFilePath);

    // Fail closed on partially corrupt attempt directories (e.g. patch exists without manifest)
    if (!manifestExists && patchExists) {
      throw new ArtifactDiscoveryError(
        "INTERNAL_ERROR",
        500,
        `Partially corrupt attempt directory: patch.diff exists without manifest.json in ${name}`
      );
    }

    if (!manifestExists) {
      // In-progress or baseline-only attempt without exported artifacts.
      continue;
    }

    let canonicalManifestPath: string;
    try {
      canonicalManifestPath = fs.realpathSync(manifestPath);
    } catch (err: unknown) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to resolve manifest in ${name}`);
    }

    if (!isWithinDirectory(canonicalRoot, canonicalManifestPath)) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Manifest escapes artifact root in ${name}`);
    }

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(canonicalManifestPath, "utf8");
    } catch (err: unknown) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to read manifest in ${name}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err: unknown) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Malformed manifest JSON in ${name}`);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Manifest must be a JSON object in ${name}`);
    }

    const manifest = parsed as Record<string, unknown>;

    if (manifest.schemaVersion !== 1) {
      throw new ArtifactDiscoveryError(
        "INTERNAL_ERROR",
        500,
        `Unsupported manifest schema version (${String(manifest.schemaVersion)}) in ${name}`
      );
    }

    if (manifest.runId !== runId) {
      throw new ArtifactDiscoveryError(
        "INTERNAL_ERROR",
        500,
        `Manifest runId mismatch in ${name}: expected ${runId}, got ${String(manifest.runId)}`
      );
    }

    if (manifest.attempt !== attempt) {
      throw new ArtifactDiscoveryError(
        "INTERNAL_ERROR",
        500,
        `Manifest attempt mismatch in ${name}: expected ${attempt}, got ${String(manifest.attempt)}`
      );
    }

    if (typeof manifest.createdAt !== "string" || isNaN(Date.parse(manifest.createdAt))) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Invalid createdAt timestamp in manifest in ${name}`);
    }

    if (typeof manifest.patch !== "object" || manifest.patch === null || Array.isArray(manifest.patch)) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Missing or invalid patch metadata in manifest in ${name}`);
    }

    const patch = manifest.patch as Record<string, unknown>;

    if (patch.file !== "patch.diff") {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Unexpected patch file name in manifest in ${name}`);
    }

    if (typeof patch.bytes !== "number" || !Number.isInteger(patch.bytes) || patch.bytes < 0) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Invalid patch byte size in manifest in ${name}`);
    }

    if (typeof patch.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(patch.sha256)) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Invalid patch SHA-256 digest in manifest in ${name}`);
    }

    if (!patchExists) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Referenced patch file missing in ${name}`);
    }

    let canonicalPatchPath: string;
    try {
      canonicalPatchPath = fs.realpathSync(patchFilePath);
    } catch (err: unknown) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to resolve patch file in ${name}`);
    }

    if (!isWithinDirectory(canonicalRoot, canonicalPatchPath)) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Patch file escapes artifact root in ${name}`);
    }

    const artifact: ArtifactResponse = {
      artifactId: `${manifest.runId}-attempt-${manifest.attempt}-patch`,
      runId: manifest.runId as string,
      relativePath: `attempt-${manifest.attempt}/patch.diff`,
      sha256: (patch.sha256 as string).toLowerCase(),
      byteSize: patch.bytes,
      contentType: "text/x-diff",
      createdAt: new Date(manifest.createdAt).toISOString(),
    };

    const validated = ArtifactResponseSchema.safeParse(artifact);
    if (!validated.success) {
      throw new ArtifactDiscoveryError(
        "INTERNAL_ERROR",
        500,
        `Mapped artifact record failed schema validation in ${name}: ${validated.error.message}`
      );
    }

    artifacts.push(validated.data);
  }

  return artifacts;
}


export const DEFAULT_MAX_ARTIFACT_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ALLOWED_ARTIFACT_CONTENT_TYPES = ["text/x-diff", "text/plain", "application/json"] as const;

export interface RetrieveArtifactContentParams {
  readonly artifactRoot: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly maxBytes?: number;
}

export interface RetrievedArtifactContent {
  readonly artifact: ArtifactResponse;
  readonly content: Buffer;
  readonly contentType: string;
  readonly sha256: string;
  readonly fileName: string;
}

/**
 * Retrieves and cryptographically verifies the content of a specific run artifact from disk.
 *
 * Security & Integrity Guarantees:
 * - Bounded content reads (defaults to 10 MiB maximum).
 * - File-descriptor-based reads (fstat + read on open fd) to mitigate file swap TOCTOU.
 * - Detects in-flight file truncation or growth.
 * - Enforces full SHA-256 digest verification before returning content.
 * - Enforces canonical containment of run directory, attempt directory, manifest, and patch.
 * - Strict safe segment validation (rejects traversal, UNC, drive letters, and ADS).
 */
export function retrieveRunArtifactContent(params: RetrieveArtifactContentParams): RetrievedArtifactContent {
  const { artifactRoot, runId, artifactId, maxBytes = DEFAULT_MAX_ARTIFACT_CONTENT_BYTES } = params;

  if (!runId || typeof runId !== "string" || !SAFE_SEGMENT.test(runId) || runId === "." || runId === "..") {
    throw new ArtifactDiscoveryError("BAD_REQUEST", 400, "Invalid run ID format");
  }
  if (runId.includes(":") || runId.includes("\\") || runId.includes("/")) {
    throw new ArtifactDiscoveryError("BAD_REQUEST", 400, "Invalid run ID: path separators and streams forbidden");
  }

  if (!artifactId || typeof artifactId !== "string" || !SAFE_SEGMENT.test(artifactId) || artifactId === "." || artifactId === "..") {
    throw new ArtifactDiscoveryError("NOT_FOUND", 404, "Artifact not found");
  }
  if (artifactId.includes(":") || artifactId.includes("\\") || artifactId.includes("/")) {
    throw new ArtifactDiscoveryError("BAD_REQUEST", 400, "Invalid artifact ID: path separators and streams forbidden");
  }

  if (!artifactRoot || typeof artifactRoot !== "string" || artifactRoot.trim().length === 0) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact storage root is not configured");
  }

  let canonicalRoot: string;
  try {
    if (!fs.existsSync(artifactRoot) || !fs.statSync(artifactRoot).isDirectory()) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact storage root directory is not accessible");
    }
    canonicalRoot = fs.realpathSync(artifactRoot);
  } catch (err: unknown) {
    if (err instanceof ArtifactDiscoveryError) throw err;
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact storage root directory is not accessible");
  }

  const runDir = path.join(canonicalRoot, runId);
  if (!fs.existsSync(runDir)) {
    throw new ArtifactDiscoveryError("NOT_FOUND", 404, "Artifact not found");
  }

  let canonicalRunDir: string;
  try {
    canonicalRunDir = fs.realpathSync(runDir);
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Failed to resolve run artifact directory");
  }

  if (!isWithinDirectory(canonicalRoot, canonicalRunDir)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Run artifact directory escapes artifact root");
  }

  // Authoritative Emerald artifact ID structure: <runId>-attempt-<attemptNumber>-patch
  const match = /^([A-Za-z0-9._-]+)-attempt-(\d+)-patch$/.exec(artifactId);
  if (!match || match[1] !== runId) {
    throw new ArtifactDiscoveryError("NOT_FOUND", 404, "Artifact not found");
  }

  const attemptNum = Number(match[2]);
  if (!Number.isInteger(attemptNum) || attemptNum < 1) {
    throw new ArtifactDiscoveryError("NOT_FOUND", 404, "Artifact not found");
  }

  const attemptDirName = `attempt-${attemptNum}`;
  const attemptDir = path.join(canonicalRunDir, attemptDirName);
  if (!fs.existsSync(attemptDir)) {
    throw new ArtifactDiscoveryError("NOT_FOUND", 404, "Artifact not found");
  }

  let canonicalAttemptDir: string;
  try {
    canonicalAttemptDir = fs.realpathSync(attemptDir);
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to resolve attempt directory ${attemptDirName}`);
  }

  if (!isWithinDirectory(canonicalRoot, canonicalAttemptDir)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Attempt directory escapes artifact root: ${attemptDirName}`);
  }

  const manifestPath = path.join(canonicalAttemptDir, "manifest.json");
  const patchFilePath = path.join(canonicalAttemptDir, "patch.diff");

  const manifestExists = fs.existsSync(manifestPath);
  const patchExists = fs.existsSync(patchFilePath);

  if (!manifestExists && patchExists) {
    throw new ArtifactDiscoveryError(
      "INTERNAL_ERROR",
      500,
      `Partially corrupt attempt directory: patch.diff exists without manifest.json in ${attemptDirName}`
    );
  }

  if (!manifestExists) {
    throw new ArtifactDiscoveryError("NOT_FOUND", 404, "Artifact not found");
  }

  let canonicalManifestPath: string;
  try {
    canonicalManifestPath = fs.realpathSync(manifestPath);
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to resolve manifest in ${attemptDirName}`);
  }

  if (!isWithinDirectory(canonicalRoot, canonicalManifestPath)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Manifest escapes artifact root in ${attemptDirName}`);
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(canonicalManifestPath, "utf8");
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to read manifest in ${attemptDirName}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Malformed manifest JSON in ${attemptDirName}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Manifest must be a JSON object in ${attemptDirName}`);
  }

  const manifest = parsed as Record<string, unknown>;

  if (manifest.schemaVersion !== 1) {
    throw new ArtifactDiscoveryError(
      "INTERNAL_ERROR",
      500,
      `Unsupported manifest schema version (${String(manifest.schemaVersion)}) in ${attemptDirName}`
    );
  }

  if (manifest.runId !== runId) {
    throw new ArtifactDiscoveryError(
      "INTERNAL_ERROR",
      500,
      `Manifest runId mismatch in ${attemptDirName}: expected ${runId}, got ${String(manifest.runId)}`
    );
  }

  if (manifest.attempt !== attemptNum) {
    throw new ArtifactDiscoveryError(
      "INTERNAL_ERROR",
      500,
      `Manifest attempt mismatch in ${attemptDirName}: expected ${attemptNum}, got ${String(manifest.attempt)}`
    );
  }

  if (typeof manifest.createdAt !== "string" || isNaN(Date.parse(manifest.createdAt))) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Invalid createdAt timestamp in manifest in ${attemptDirName}`);
  }

  if (typeof manifest.patch !== "object" || manifest.patch === null || Array.isArray(manifest.patch)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Missing or invalid patch metadata in manifest in ${attemptDirName}`);
  }

  const patch = manifest.patch as Record<string, unknown>;

  if (patch.file !== "patch.diff") {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Unexpected patch file name in manifest in ${attemptDirName}`);
  }

  if (typeof patch.bytes !== "number" || !Number.isInteger(patch.bytes) || patch.bytes < 0) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Invalid patch byte size in manifest in ${attemptDirName}`);
  }

  if (patch.bytes > maxBytes) {
    throw new ArtifactDiscoveryError(
      "PAYLOAD_TOO_LARGE",
      413,
      `Artifact content size (${patch.bytes} bytes) exceeds limit (${maxBytes} bytes)`
    );
  }

  if (typeof patch.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(patch.sha256)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Invalid patch SHA-256 digest in manifest in ${attemptDirName}`);
  }

  if (!patchExists) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Referenced patch file missing in ${attemptDirName}`);
  }

  let canonicalPatchPath: string;
  try {
    canonicalPatchPath = fs.realpathSync(patchFilePath);
  } catch (err: unknown) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to resolve patch file in ${attemptDirName}`);
  }

  if (!isWithinDirectory(canonicalRoot, canonicalPatchPath) || !isWithinDirectory(canonicalAttemptDir, canonicalPatchPath)) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Patch file escapes artifact root in ${attemptDirName}`);
  }

  // Open file with O_RDONLY and O_NOFOLLOW (on platforms where supported)
  const openFlags = fs.constants.O_RDONLY | (process.platform !== "win32" && (fs.constants as any).O_NOFOLLOW ? (fs.constants as any).O_NOFOLLOW : 0);
  let fd: number | null = null;
  let buffer: Buffer;

  try {
    try {
      fd = fs.openSync(canonicalPatchPath, openFlags);
    } catch (openErr: any) {
      if (openErr && (openErr.code === "ENOENT" || openErr.code === "ELOOP")) {
        throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, `Failed to open artifact file: ${openErr.code}`);
      }
      if (openErr && openErr.code === "EACCES") {
        throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Permission denied opening artifact file");
      }
      throw openErr;
    }

    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact path is not a regular file");
    }

    if (stat.size > maxBytes) {
      throw new ArtifactDiscoveryError(
        "PAYLOAD_TOO_LARGE",
        413,
        `Artifact content size (${stat.size} bytes) exceeds limit (${maxBytes} bytes)`
      );
    }

    buffer = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      const chunk = fs.readSync(fd, buffer, bytesRead, stat.size - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }

    if (bytesRead !== stat.size) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact file size changed during read");
    }

    // Check if file grew during read
    const checkGrowth = Buffer.alloc(1);
    const extraRead = fs.readSync(fd, checkGrowth, 0, 1, stat.size);
    if (extraRead > 0) {
      throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact file grew during read");
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }

  const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
  const expectedSha256 = (patch.sha256 as string).toLowerCase();

  if (actualSha256 !== expectedSha256) {
    throw new ArtifactDiscoveryError("INTERNAL_ERROR", 500, "Artifact SHA-256 integrity verification failed");
  }

  const artifact: ArtifactResponse = {
    artifactId,
    runId,
    relativePath: `attempt-${manifest.attempt}/patch.diff`,
    sha256: actualSha256,
    byteSize: buffer.length,
    contentType: "text/x-diff",
    createdAt: new Date(manifest.createdAt as string).toISOString(),
  };

  return {
    artifact,
    content: buffer,
    contentType: "text/x-diff",
    sha256: actualSha256,
    fileName: "patch.diff",
  };
}
