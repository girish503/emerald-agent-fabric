/**
 * Emerald Agent Fabric — Production V1.6: Line-Anchored Editor
 *
 * Provides constrained, line-anchored search-and-replace file editing.
 * Replaces exact text spans without whole-file replacement.
 *
 * Core Invariants:
 * 1. Only workspace-contained files can be edited (strict path traversal checks).
 * 2. Anchors must match uniquely by default; ambiguous or zero matches fail closed.
 * 3. File content outside the anchor is preserved byte-for-byte.
 * 4. Stale edits with mismatched expected digests fail closed without modifying disk.
 * 5. Malformed inputs fail closed without modifying disk.
 * 6. Never silently fall back to whole-file replacement.
 * 7. Operations are non-authoritative (sovereign verifier remains sole authority).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface LineAnchoredEditInput {
  readonly path: string;
  readonly searchAnchor: string;
  readonly replacementText: string;
  readonly expectedDigest?: string;
  readonly allowMultipleMatches?: boolean;
}

export interface LineAnchoredEditResult {
  readonly success: boolean;
  readonly path: string;
  readonly originalDigest: string;
  readonly resultingDigest: string;
  readonly occurrences: number;
  readonly replacedCount: number;
  readonly bytesModified: number;
  readonly applied: boolean;
  readonly error?: string;
  readonly authoritative: false;
  readonly verificationAuthority: false;
  readonly terminalAuthority: false;
}

export class LineAnchoredEditor {
  /**
   * Resolves and verifies that a relative path stays within the workspace boundary.
   * Enforces both lexical containment and canonical filesystem (realpath) containment.
   * Throws on directory traversal, outside absolute paths, or symlink/junction escapes.
   */
  public resolveSafePath(filePath: string, workspacePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("File path must be a non-empty string");
    }

    // Security: reject Windows drive-relative paths (e.g., "C:foo", "D:bar/baz")
    if (/^[a-zA-Z]:(?![\/\\])/.test(filePath)) {
      throw new Error(`Path traversal denied outside workspace: ${filePath}`);
    }

    // 1. Lexical root-or-descendant boundary check
    const normalized = path.normalize(filePath);
    const resolved = path.resolve(workspacePath, normalized);
    const normResolved = resolved.split("\\").join("/").toLowerCase();
    const normBase = path.resolve(workspacePath).split("\\").join("/").toLowerCase();
    const normBaseWithSlash = normBase.endsWith("/") ? normBase : normBase + "/";

    // Security: ensure target is either the workspace root itself or a descendant separated by delimiter
    if (normResolved !== normBase && !normResolved.startsWith(normBaseWithSlash)) {
      throw new Error(`Path traversal denied outside workspace: ${filePath}`);
    }

    // 2. Canonical filesystem (realpath) containment check
    const canonicalRealpath = (p: string): string => {
      if (typeof fs.realpathSync.native === "function") {
        return fs.realpathSync.native(p);
      }
      return fs.realpathSync(p);
    };

    const normalizeCanonical = (p: string): string => {
      let s = p.split("\\").join("/");
      if (s.startsWith("//?/")) {
        s = s.slice(4);
      }
      return s.toLowerCase();
    };

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = canonicalRealpath(path.resolve(workspacePath));
    } catch {
      canonicalWorkspace = path.resolve(workspacePath);
    }
    const normCanonicalBase = normalizeCanonical(canonicalWorkspace);
    const normCanonicalBaseWithSlash = normCanonicalBase.endsWith("/") ? normCanonicalBase : normCanonicalBase + "/";

    // 3. For existing targets, validate canonical target
    if (fs.existsSync(resolved)) {
      let canonicalTarget: string;
      try {
        canonicalTarget = canonicalRealpath(resolved);
      } catch (err: any) {
        throw new Error(`Path traversal denied outside workspace (failed to canonicalize): ${filePath}`);
      }
      const normCanonicalTarget = normalizeCanonical(canonicalTarget);
      if (normCanonicalTarget !== normCanonicalBase && !normCanonicalTarget.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (canonical symlink escape): ${filePath}`);
      }
    } else {
      // 4. For non-existent targets, locate nearest existing ancestor and validate canonical path
      let curr = path.dirname(resolved);
      let existingAncestor: string | null = null;
      while (true) {
        if (fs.existsSync(curr)) {
          existingAncestor = curr;
          break;
        }
        const parent = path.dirname(curr);
        if (parent === curr) {
          break;
        }
        curr = parent;
      }

      if (!existingAncestor) {
        throw new Error(`Path traversal denied outside workspace (no valid existing ancestor): ${filePath}`);
      }

      let canonicalAncestor: string;
      try {
        canonicalAncestor = canonicalRealpath(existingAncestor);
      } catch (err: any) {
        throw new Error(`Path traversal denied outside workspace (failed to canonicalize ancestor): ${filePath}`);
      }

      const normCanonicalAncestor = normalizeCanonical(canonicalAncestor);
      if (normCanonicalAncestor !== normCanonicalBase && !normCanonicalAncestor.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (symlink ancestor escape): ${filePath}`);
      }

      const relFromAncestor = path.relative(existingAncestor, resolved);
      const canonicalTarget = path.resolve(canonicalAncestor, relFromAncestor);
      const normCanonicalTarget = normalizeCanonical(canonicalTarget);
      if (normCanonicalTarget !== normCanonicalBase && !normCanonicalTarget.startsWith(normCanonicalBaseWithSlash)) {
        throw new Error(`Path traversal denied outside workspace (canonical target escape): ${filePath}`);
      }
    }

    return resolved;
  }

  /**
   * Applies a constrained, line-anchored search-and-replace edit to an existing file.
   * Atomic, fail-closed, and non-destructive on errors.
   */
  public applyEdit(
    rawInput: Record<string, unknown>,
    workspacePath: string,
  ): LineAnchoredEditResult {
    // 1. Normalize and validate input fields
    const targetFile = String(rawInput["path"] || rawInput["filePath"] || "");
    const searchAnchor = typeof rawInput["searchAnchor"] === "string"
      ? rawInput["searchAnchor"]
      : (typeof rawInput["oldText"] === "string" ? rawInput["oldText"] : (typeof rawInput["anchor"] === "string" ? rawInput["anchor"] : undefined));
    const replacementText = typeof rawInput["replacementText"] === "string"
      ? rawInput["replacementText"]
      : (typeof rawInput["newText"] === "string" ? rawInput["newText"] : (typeof rawInput["replacement"] === "string" ? rawInput["replacement"] : undefined));
    const expectedDigest = typeof rawInput["expectedDigest"] === "string" ? rawInput["expectedDigest"].trim().toLowerCase() : undefined;
    const allowMultipleMatches = Boolean(rawInput["allowMultipleMatches"]);

    if (!targetFile) {
      throw new Error("Invalid edit request: 'path' must be specified");
    }
    if (searchAnchor === undefined) {
      throw new Error("Invalid edit request: 'searchAnchor' (or 'oldText') must be provided as a string");
    }
    if (replacementText === undefined) {
      throw new Error("Invalid edit request: 'replacementText' (or 'newText') must be provided as a string");
    }
    if (searchAnchor.trim().length === 0) {
      throw new Error("Invalid edit request: 'searchAnchor' cannot be empty or whitespace-only");
    }

    // 2. Resolve and verify safe containment in workspace
    const safePath = this.resolveSafePath(targetFile, workspacePath);

    // 3. Verify file exists (cannot create files via anchored edits)
    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found for line-anchored edit: ${targetFile}`);
    }

    const stat = fs.statSync(safePath);
    if (!stat.isFile()) {
      throw new Error(`Target path is not a regular file: ${targetFile}`);
    }

    // 4. Read current file content and compute SHA-256 digest
    const originalContent = fs.readFileSync(safePath, "utf8");
    const originalDigest = createHash("sha256").update(originalContent, "utf8").digest("hex");

    // 5. Optimistic concurrency check if expectedDigest provided
    if (expectedDigest && expectedDigest !== originalDigest) {
      throw new Error(
        `Stale edit precondition failed for ${targetFile}: expected digest '${expectedDigest}' but current digest is '${originalDigest}'`,
      );
    }

    // 6. Find occurrences of searchAnchor
    let occurrences = 0;
    let pos = 0;
    while ((pos = originalContent.indexOf(searchAnchor, pos)) !== -1) {
      occurrences++;
      pos += searchAnchor.length;
    }

    // Zero matches: fail closed without disk modification
    if (occurrences === 0) {
      throw new Error(
        `Search anchor not found in ${targetFile}: 0 occurrences matched '${searchAnchor.slice(0, 80)}${searchAnchor.length > 80 ? "..." : ""}'`,
      );
    }

    // Multiple matches when unique match is required: fail closed
    if (occurrences > 1 && !allowMultipleMatches) {
      throw new Error(
        `Ambiguous search anchor in ${targetFile}: ${occurrences} occurrences matched, but unique match is required. Provide more surrounding context lines.`,
      );
    }

    // 7. Perform replacement preserving surrounding bytes exactly
    let newContent: string;
    if (allowMultipleMatches) {
      newContent = originalContent.split(searchAnchor).join(replacementText);
    } else {
      const firstIdx = originalContent.indexOf(searchAnchor);
      const prefix = originalContent.slice(0, firstIdx);
      const suffix = originalContent.slice(firstIdx + searchAnchor.length);
      newContent = prefix + replacementText + suffix;
    }

    const resultingDigest = createHash("sha256").update(newContent, "utf8").digest("hex");

    // 8. Atomic file write via temporary file in same directory
    const tempFile = path.resolve(
      path.dirname(safePath),
      `.tmp.${path.basename(safePath)}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    );

    try {
      fs.writeFileSync(tempFile, newContent, "utf8");
      fs.renameSync(tempFile, safePath);
    } catch (writeErr) {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Ignore temp cleanup error
        }
      }
      throw new Error(`Failed to commit atomic edit to ${targetFile}: ${(writeErr as Error).message}`);
    }

    const replacedCount = allowMultipleMatches ? occurrences : 1;
    const bytesModified = Buffer.byteLength(replacementText, "utf8");

    return {
      success: true,
      path: path.relative(workspacePath, safePath).replace(/\\/g, "/"),
      originalDigest,
      resultingDigest,
      occurrences,
      replacedCount,
      bytesModified,
      applied: true,
      authoritative: false,
      verificationAuthority: false,
      terminalAuthority: false,
    };
  }
}
