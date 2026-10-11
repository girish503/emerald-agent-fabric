/**
 * Pure Lexical Path Boundary Sanitizer for Emerald Workspace Sandbox.
 *
 * ============================================================================
 * SECURITY BOUNDARY NOTICE & INVARIANTS
 * ============================================================================
 *
 * 1. LEXICAL CONTAINMENT ONLY:
 *    This module performs strict, deterministic LEXICAL validation. It guarantees
 *    that an untrusted path string cannot lexically escape the workspace boundary
 *    via '.', '..', absolute paths, UNC network shares, Windows drive letters,
 *    null bytes, alternate data streams, or platform-specific control characters.
 *
 * 2. SYMLINK LIMITATION:
 *    Lexical validation CANNOT inspect the underlying filesystem. A path that is
 *    lexically contained (e.g. "links/external_secret") may still point to a symlink
 *    on disk that resolves outside the workspace sandbox (e.g. to /etc/passwd).
 *    Therefore, filesystem canonicalization (e.g. realpath) is STRICTLY REQUIRED
 *    at the infrastructure adapter layer (Task 3.2).
 *
 * 3. SECURITY INVARIANT:
 *    A path is executable, readable, or writable ONLY after the final resolved
 *    filesystem path is proven by the adapter to remain inside the assigned
 *    workspace root directory on disk.
 *
 * ============================================================================
 */

import {
  InvalidWorkspacePathError,
  WorkspacePathOutsideBoundaryError,
} from "./errors.js";

/**
 * Windows reserved device stems that must never be created or traversed.
 * Accessing these devices can trigger host hardware access or process hangs.
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Regex matching forbidden path characters:
 * - Null bytes (\0)
 * - Control characters (\x00-\x1F, \x7F)
 * - NTFS Alternate Data Stream separator (:)
 * - Shell and filesystem reserved characters (<, >, ", |, ?, *)
 */
const FORBIDDEN_CHARACTERS_REGEX = /[\x00-\x1F\x7F<>:"|?*]/;

/**
 * Options for workspace path sanitization.
 */
export interface SanitizeWorkspacePathOptions {
  /**
   * If true, resolving to the workspace root itself (e.g. "." or empty relative path)
   * is permitted. Defaults to false (requiring a child path).
   */
  readonly allowRoot?: boolean;
}

/**
 * Result of pure lexical path sanitization.
 */
export interface SanitizedPathResult {
  readonly rawPath: string;
  readonly normalizedPath: string; // POSIX-style relative path without leading slash
  readonly segments: readonly string[];
}

/**
 * Sanitizes and validates an untrusted path against workspace boundaries.
 * Pure function with zero host filesystem I/O.
 *
 * @throws {InvalidWorkspacePathError} if path contains null bytes, illegal characters, or is empty.
 * @throws {WorkspacePathOutsideBoundaryError} if path is absolute or attempts lexical escape.
 */
export function sanitizeWorkspacePath(
  untrustedPath: unknown,
  options: SanitizeWorkspacePathOptions = {}
): SanitizedPathResult {
  // 1. Type and non-empty check
  if (typeof untrustedPath !== "string") {
    throw new InvalidWorkspacePathError(
      String(untrustedPath),
      "Path must be a non-empty string"
    );
  }

  if (untrustedPath.trim().length === 0) {
    throw new InvalidWorkspacePathError(
      untrustedPath,
      "Path cannot be empty or whitespace only"
    );
  }

  if (untrustedPath !== untrustedPath.trim()) {
    throw new InvalidWorkspacePathError(
      untrustedPath,
      "Path cannot have leading or trailing whitespace"
    );
  }

  // 2. Null byte and control characters check
  if (untrustedPath.includes("\0") || untrustedPath.includes("%00")) {
    throw new InvalidWorkspacePathError(
      untrustedPath,
      "Path contains forbidden null byte sequence"
    );
  }

  // 3. Absolute path checks (POSIX leading slash, Windows leading backslash)
  if (untrustedPath.startsWith("/") || untrustedPath.startsWith("\\")) {
    throw new WorkspacePathOutsideBoundaryError(
      untrustedPath,
      "Absolute paths are not permitted in workspace sandbox"
    );
  }

  // 4. Windows drive letter check (e.g. C:, D:\, c:/)
  if (/^[a-zA-Z]:/.test(untrustedPath)) {
    throw new WorkspacePathOutsideBoundaryError(
      untrustedPath,
      "Windows drive letter paths are not permitted in workspace sandbox"
    );
  }

  // 5. UNC network paths check (//server or \\server)
  if (untrustedPath.startsWith("//") || untrustedPath.startsWith("\\\\")) {
    throw new WorkspacePathOutsideBoundaryError(
      untrustedPath,
      "UNC network paths are not permitted in workspace sandbox"
    );
  }

  // 6. Split into segments using both POSIX and Windows separators
  const rawSegments = untrustedPath.split(/[/\\]+/);
  const stack: string[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const segment = rawSegments[i]!;

    // Ignore empty segments or current directory '.'
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    // Traversal check: '..'
    if (segment === "..") {
      if (stack.length === 0) {
        throw new WorkspacePathOutsideBoundaryError(
          untrustedPath,
          "Path traverses above workspace root directory"
        );
      }
      stack.pop();
      continue;
    }

    // Check for illegal or dangerous characters in segment
    if (FORBIDDEN_CHARACTERS_REGEX.test(segment)) {
      throw new InvalidWorkspacePathError(
        untrustedPath,
        `Path segment '${segment}' contains forbidden characters`
      );
    }

    // Trailing dot or space check (Windows filesystem strips trailing dots/spaces)
    if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) {
      throw new InvalidWorkspacePathError(
        untrustedPath,
        `Path segment '${segment}' has dangerous trailing dot or whitespace`
      );
    }

    // Windows reserved device names check (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    const stem = segment.split(".")[0]!.toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      throw new InvalidWorkspacePathError(
        untrustedPath,
        `Path segment '${segment}' uses Windows reserved device name '${stem}'`
      );
    }

    stack.push(segment);
  }

  // 7. Root containment assertion
  if (stack.length === 0) {
    if (!options.allowRoot) {
      throw new InvalidWorkspacePathError(
        untrustedPath,
        "Path resolves to workspace root, but a relative file path is required"
      );
    }
    return Object.freeze({
      rawPath: untrustedPath,
      normalizedPath: ".",
      segments: Object.freeze([]) as readonly string[],
    });
  }

  const normalizedPath = stack.join("/");

  return Object.freeze({
    rawPath: untrustedPath,
    normalizedPath,
    segments: Object.freeze([...stack]) as readonly string[],
  });
}
