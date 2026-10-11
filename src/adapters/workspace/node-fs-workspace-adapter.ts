/**
 * Local Filesystem Workspace Adapter (NodeFsWorkspaceAdapter).
 *
 * Implements WorkspacePort using Node.js fs/promises and strict realpath canonicalization.
 * Enforces dual-boundary path security:
 * 1. Lexical sanitization (pure in-memory validation via sanitizeWorkspacePath).
 * 2. Filesystem canonicalization (fs.realpath verification asserting containment inside workspace root).
 *
 * ============================================================================
 * SECURITY INVARIANTS & CONSTRAINTS
 * ============================================================================
 * 1. STRICT PATH CONTAINMENT:
 *    Every resolved host filesystem path MUST be verified using path-aware relative
 *    subpath checking (path.relative). Naive string prefix (startsWith) checks are
 *    strictly prohibited to prevent false containment on sibling directories (e.g. ws-1 vs ws-10).
 *
 * 2. SYMLINK ESCAPE DEFENSE:
 *    All existing targets and parent directory chains are canonicalized via fs.realpath.
 *    Any symlink pointing outside the workspace boundary (e.g. to /etc/passwd or a sibling workspace)
 *    is rejected with WorkspacePathOutsideBoundaryError.
 *
 * 3. NONEXISTENT WRITE TARGET SAFETY:
 *    For files that do not exist yet (e.g. future write_file targets), the deepest existing
 *    ancestor directory on disk is resolved via fs.realpath and verified for workspace containment.
 *    This completely neutralizes parent-directory symlink redirection attacks (e.g. ws/src -> /outside).
 *
 * 4. TOCTOU & RACE ASSUMPTIONS:
 *    On standard OS filesystems without kernel-level path pinning (e.g. openat2/RESOLVE_BENEATH),
 *    a race condition can theoretically exist if a concurrent process mutates intermediate directory
 *    symlinks between resolvePath() and an external tool opening the file.
 *    Mitigations:
 *    - Workspaces are owned by exclusive worker leases (single active writer).
 *    - Host workspace directory permissions are restricted to 0700.
 *    - Container sandbox mounts isolate user processes to container mount namespaces.
 *
 * ============================================================================
 */

import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  InvalidWorkspaceError,
  InvalidWorkspacePathError,
  WorkspacePathOutsideBoundaryError,
  WorkspaceStateError,
} from "../../domain/errors.js";
import { sanitizeWorkspacePath } from "../../domain/workspace-path.js";
import {
  getWorkspaceSpecViolations,
  WorkspaceSpec,
} from "../../domain/workspace.js";
import {
  WorkspaceHandle,
  WorkspacePort,
} from "../../ports/workspace.port.js";

/**
 * Configuration options for NodeFsWorkspaceAdapter.
 */
export interface NodeFsWorkspaceConfig {
  /**
   * Absolute directory path on the host under which isolated workspace subdirectories are created.
   * MUST NOT be the user home directory or current repository root.
   */
  readonly workspaceRoot: string;

  /**
   * Default disk byte quota per workspace (default: 500 MB).
   */
  readonly defaultMaxWorkspaceBytes?: number;

  /**
   * Default max file size in bytes (default: 10 MB).
   */
  readonly defaultMaxFileSizeBytes?: number;
}

interface ActiveWorkspaceRecord {
  readonly spec: WorkspaceSpec;
  readonly handle: WorkspaceHandle;
  readonly canonicalHostPath: string;
}

export class NodeFsWorkspaceAdapter implements WorkspacePort {
  private readonly workspaceRoot: string;
  private canonicalWorkspaceRoot: string | null = null;
  private readonly workspaces = new Map<string, ActiveWorkspaceRecord>();

  constructor(config: NodeFsWorkspaceConfig) {
    if (!config || typeof config.workspaceRoot !== "string") {
      throw new InvalidWorkspacePathError(
        String(config?.workspaceRoot),
        "workspaceRoot must be a non-empty string"
      );
    }

    const trimmedRoot = config.workspaceRoot.trim();
    if (trimmedRoot.length === 0) {
      throw new InvalidWorkspacePathError(
        config.workspaceRoot,
        "workspaceRoot cannot be empty"
      );
    }

    if (!path.isAbsolute(trimmedRoot)) {
      throw new InvalidWorkspacePathError(
        trimmedRoot,
        "workspaceRoot must be an absolute filesystem path"
      );
    }

    // Guard: never use user home directory as workspace root
    const homeDir = os.homedir();
    if (path.resolve(trimmedRoot) === path.resolve(homeDir)) {
      throw new InvalidWorkspacePathError(
        trimmedRoot,
        "workspaceRoot cannot be the user home directory"
      );
    }

    // Guard: never use repository root / cwd as workspace root
    const cwd = process.cwd();
    if (path.resolve(trimmedRoot) === path.resolve(cwd)) {
      throw new InvalidWorkspacePathError(
        trimmedRoot,
        "workspaceRoot cannot be the current repository root"
      );
    }

    this.workspaceRoot = path.resolve(trimmedRoot);
  }

  /**
   * Returns the canonical, symlink-resolved root directory path on disk.
   * Lazily ensures the directory exists with restricted permissions (0700).
   */
  async getCanonicalWorkspaceRoot(): Promise<string> {
    if (!this.canonicalWorkspaceRoot) {
      await fs.mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
      this.canonicalWorkspaceRoot = await fs.realpath(this.workspaceRoot);
    }
    return this.canonicalWorkspaceRoot;
  }

  /**
   * Provisions a dedicated isolated directory for a workspace and returns its handle.
   */
  async provisionWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const violations = getWorkspaceSpecViolations(spec);
    if (violations.length > 0) {
      throw new InvalidWorkspaceError(spec.workspaceId, violations);
    }

    // Identity validation: workspaceId must be a safe directory name
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(spec.workspaceId) || spec.workspaceId.includes("..")) {
      throw new InvalidWorkspaceError(spec.workspaceId, [
        "workspaceId contains invalid characters for directory naming",
      ]);
    }

    if (this.workspaces.has(spec.workspaceId)) {
      throw new WorkspaceStateError(
        spec.workspaceId,
        "ALREADY_PROVISIONED",
        "UNALLOCATED",
        "provisionWorkspace"
      );
    }

    const root = await this.getCanonicalWorkspaceRoot();
    const targetDir = path.join(root, spec.workspaceId);

    // Verify target path is strictly contained in root
    if (!this.isContainedInRoot(root, targetDir)) {
      throw new WorkspacePathOutsideBoundaryError(
        targetDir,
        "Constructed workspace directory path escapes workspace root"
      );
    }

    // Fail closed if directory or symlink already exists on disk
    try {
      await fs.lstat(targetDir);
      throw new WorkspaceStateError(
        spec.workspaceId,
        "DIRECTORY_ALREADY_EXISTS",
        "UNALLOCATED",
        "provisionWorkspace"
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    // Create the leaf workspace directory with restricted 0700 permissions
    await fs.mkdir(targetDir, { mode: 0o700 });

    // Canonicalize the newly created workspace directory
    const canonicalHostPath = await fs.realpath(targetDir);

    if (!this.isContainedInRoot(root, canonicalHostPath)) {
      // Defensive rollback if realpath somehow escaped
      await fs.rm(canonicalHostPath, { recursive: true, force: true }).catch(() => {});
      throw new WorkspacePathOutsideBoundaryError(
        canonicalHostPath,
        "Canonical workspace directory escapes root directory"
      );
    }

    const now = new Date().toISOString();
    const handle: WorkspaceHandle = Object.freeze({
      workspaceId: spec.workspaceId,
      runId: spec.runId,
      hostPath: canonicalHostPath,
      containerMountPath: "/workspace",
      createdAt: now,
      maxWorkspaceBytes: spec.maxWorkspaceBytes,
    });

    this.workspaces.set(spec.workspaceId, {
      spec: Object.freeze({ ...spec }),
      handle,
      canonicalHostPath,
    });

    return handle;
  }

  /**
   * Resolves a relative path within a workspace to its canonical, symlink-verified host path.
   * Guarantees that the final real path remains strictly inside the workspace directory.
   */
  async resolvePath(workspaceId: string, relativePath: string): Promise<string> {
    const record = this.workspaces.get(workspaceId);
    if (!record) {
      throw new WorkspaceStateError(
        workspaceId,
        "NOT_FOUND",
        "PROVISIONED",
        "resolvePath"
      );
    }

    // Layer 1: Pure lexical sanitization
    const sanitized = sanitizeWorkspacePath(relativePath, { allowRoot: true });

    // Root resolution
    if (sanitized.normalizedPath === ".") {
      return record.canonicalHostPath;
    }

    // Layer 2: Lexical candidate resolution
    const candidatePath = path.resolve(record.canonicalHostPath, sanitized.normalizedPath);

    if (!this.isContainedInRoot(record.canonicalHostPath, candidatePath)) {
      throw new WorkspacePathOutsideBoundaryError(
        relativePath,
        "Candidate path escapes workspace root lexically"
      );
    }

    // Layer 3: Filesystem canonicalization & Symlink verification
    try {
      const canonicalTarget = await fs.realpath(candidatePath);

      // Verify strict path containment on existing file/dir
      if (!this.isContainedInRoot(record.canonicalHostPath, canonicalTarget)) {
        throw new WorkspacePathOutsideBoundaryError(
          relativePath,
          "Resolved symlink target escapes workspace sandbox boundary"
        );
      }

      return canonicalTarget;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }

      // Nonexistent target: resolve deepest existing ancestor to guard against symlink parents
      return await this.resolveNonexistentPath(
        record.canonicalHostPath,
        candidatePath,
        relativePath
      );
    }
  }

  /**
   * Safely canonicalizes a nonexistent write target by walking up to the deepest
   * existing ancestor directory, ensuring that ancestor is inside the workspace,
   * and asserting that the reconstructed child path cannot escape.
   */
  private async resolveNonexistentPath(
    workspaceHostPath: string,
    candidatePath: string,
    rawRequestedPath: string
  ): Promise<string> {
    let current = candidatePath;
    const missingSegments: string[] = [];

    while (current !== workspaceHostPath) {
      const parent = path.dirname(current);
      const base = path.basename(current);
      missingSegments.unshift(base);
      current = parent;

      try {
        await fs.lstat(current);
        // Found deepest existing ancestor
        break;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw err;
      }
    }

    // Canonicalize the existing ancestor directory
    const canonicalAncestor = await fs.realpath(current);

    if (!this.isContainedInRoot(workspaceHostPath, canonicalAncestor)) {
      throw new WorkspacePathOutsideBoundaryError(
        rawRequestedPath,
        "Parent directory symlink escapes workspace sandbox boundary"
      );
    }

    // Reconstruct the intended final path under the canonical ancestor
    const finalPath = path.join(canonicalAncestor, ...missingSegments);

    if (!this.isContainedInRoot(workspaceHostPath, finalPath)) {
      throw new WorkspacePathOutsideBoundaryError(
        rawRequestedPath,
        "Reconstructed write path escapes workspace sandbox boundary"
      );
    }

    return finalPath;
  }

  /**
   * Disposes of an allocated workspace, recursively deleting host files and freeing storage.
   * Defends against symlink substitution attacks on the workspace directory itself.
   */
  async disposeWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      throw new InvalidWorkspaceError(String(workspaceId), [
        "workspaceId must be a non-empty string",
      ]);
    }

    if (!/^[a-zA-Z0-9_\-\.]+$/.test(workspaceId) || workspaceId.includes("..")) {
      throw new InvalidWorkspaceError(workspaceId, [
        "workspaceId contains invalid characters for directory naming",
      ]);
    }

    const root = await this.getCanonicalWorkspaceRoot();
    const targetDir = path.join(root, workspaceId);

    // Verify target path cannot escape workspace root
    if (!this.isContainedInRoot(root, targetDir)) {
      throw new WorkspacePathOutsideBoundaryError(
        targetDir,
        "Target workspace directory escapes workspace root"
      );
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(targetDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Idempotent: already deleted
        this.workspaces.delete(workspaceId);
        return;
      }
      throw err;
    }

    // Symlink substitution defense: if the workspace dir was replaced by a symlink,
    // unlink ONLY the symlink without recursively following it!
    if (stat.isSymbolicLink()) {
      await fs.unlink(targetDir);
      this.workspaces.delete(workspaceId);
      return;
    }

    // Canonicalize and assert containment before recursive deletion
    const canonicalTarget = await fs.realpath(targetDir);

    if (!this.isContainedInRoot(root, canonicalTarget) || canonicalTarget === root) {
      throw new WorkspacePathOutsideBoundaryError(
        canonicalTarget,
        "Refusing to delete directory outside workspace root or workspace root itself"
      );
    }

    // Recursively adjust permissions for read-only files generated by builds
    await this.ensureWritableRecursive(canonicalTarget).catch(() => {});

    // Recursive removal
    await fs.rm(canonicalTarget, { recursive: true, force: true });
    this.workspaces.delete(workspaceId);
  }

  /**
   * Synchronously disposes of an allocated workspace for synchronous recovery paths.
   */
  disposeWorkspaceSync(workspaceId: string): void {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      throw new InvalidWorkspaceError(String(workspaceId), [
        "workspaceId must be a non-empty string",
      ]);
    }

    if (!/^[a-zA-Z0-9_\-\.]+$/.test(workspaceId) || workspaceId.includes("..")) {
      throw new InvalidWorkspaceError(workspaceId, [
        "workspaceId contains invalid characters for directory naming",
      ]);
    }

    if (!this.canonicalWorkspaceRoot) {
      syncFs.mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
      this.canonicalWorkspaceRoot = syncFs.realpathSync(this.workspaceRoot);
    }
    const root = this.canonicalWorkspaceRoot;
    const targetDir = path.join(root, workspaceId);

    if (!this.isContainedInRoot(root, targetDir)) {
      throw new WorkspacePathOutsideBoundaryError(
        targetDir,
        "Target workspace directory escapes workspace root"
      );
    }

    let stat: syncFs.Stats;
    try {
      stat = syncFs.lstatSync(targetDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.workspaces.delete(workspaceId);
        return;
      }
      throw err;
    }

    if (stat.isSymbolicLink()) {
      syncFs.unlinkSync(targetDir);
      this.workspaces.delete(workspaceId);
      return;
    }

    const canonicalTarget = syncFs.realpathSync(targetDir);
    if (!this.isContainedInRoot(root, canonicalTarget) || canonicalTarget === root) {
      throw new WorkspacePathOutsideBoundaryError(
        canonicalTarget,
        "Refusing to delete directory outside workspace root or workspace root itself"
      );
    }

    this.ensureWritableRecursiveSync(canonicalTarget);
    syncFs.rmSync(canonicalTarget, { recursive: true, force: true });
    this.workspaces.delete(workspaceId);
  }

  private ensureWritableRecursiveSync(targetDir: string): void {
    try {
      syncFs.chmodSync(targetDir, 0o700);
    } catch {}

    let entries: syncFs.Dirent[] = [];
    try {
      entries = syncFs.readdirSync(targetDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(targetDir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        this.ensureWritableRecursiveSync(fullPath);
      } else {
        try {
          syncFs.chmodSync(fullPath, 0o600);
        } catch {}
      }
    }
  }

  /**
   * Scans the workspace root and cleans up orphaned workspace directories
   * whose leases are no longer active in persistence.
   */
  async cleanupOrphanedWorkspaces(
    activeWorkspaceIds: ReadonlySet<string>
  ): Promise<readonly string[]> {
    const root = await this.getCanonicalWorkspaceRoot();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const reclaimed: string[] = [];

    for (const entry of entries) {
      // Only process directories or symlinks
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const dirName = entry.name;

      // Skip active workspaces
      if (activeWorkspaceIds.has(dirName)) {
        continue;
      }

      // Skip invalid or hidden directory names (e.g. .git, .tmp)
      if (!/^[a-zA-Z0-9_\-\.]+$/.test(dirName) || dirName.startsWith(".")) {
        continue;
      }

      try {
        await this.disposeWorkspace(dirName);
        reclaimed.push(dirName);
      } catch {
        // Continue cleaning other orphans if one fails
      }
    }

    return Object.freeze(reclaimed);
  }

  /**
   * Helper to retrieve a provisioned workspace handle (or null if not found).
   */
  getWorkspaceHandle(workspaceId: string): WorkspaceHandle | null {
    return this.workspaces.get(workspaceId)?.handle ?? null;
  }

  /**
   * Returns true if the workspace is currently active in this adapter.
   */
  isWorkspaceActive(workspaceId: string): boolean {
    return this.workspaces.has(workspaceId);
  }

  /**
   * Strict path containment check.
   * Asserts that candidatePath is equal to or a subpath of root, using path-aware
   * relative logic to avoid false positives (e.g. ws-1 vs ws-10).
   */
  private isContainedInRoot(canonicalRoot: string, candidatePath: string): boolean {
    const rel = path.relative(canonicalRoot, candidatePath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * Recursively ensures write permissions on directory contents so that read-only
   * artifacts created by build tools can be deleted without EACCES / EPERM errors.
   */
  private async ensureWritableRecursive(targetDir: string): Promise<void> {
    try {
      await fs.chmod(targetDir, 0o700);
    } catch {
      // Continue on platform mismatch (e.g. Windows)
    }

    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(targetDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(targetDir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await this.ensureWritableRecursive(fullPath);
      } else {
        try {
          await fs.chmod(fullPath, 0o600);
        } catch {
          // Ignore platform errors
        }
      }
    }
  }
}
