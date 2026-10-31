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
  WorkspaceOwnershipError,
  WorkspacePathOutsideBoundaryError,
  WorkspaceStateError,
} from "../../domain/errors.js";
import { sanitizeWorkspacePath } from "../../domain/workspace-path.js";
import {
  getWorkspaceSpecViolations,
  WorkspaceSpec,
} from "../../domain/workspace.js";
import {
  OrphanSweepOptions,
  WorkspaceActiveFilter,
  WorkspaceHandle,
  WorkspaceOwner,
  WorkspacePort,
} from "../../ports/workspace.port.js";
import { OWNER_MARKER, OwnerKeyError, clearOwnership, issueOwnership, readAuthenticatedOwner, type OwnerMarkerRead } from "./owner-marker.js";

/** Ownership marker written inside a workspace directory when it is provisioned for a specific attempt. */

/** "absent" = no marker file (ENOENT); "invalid" = present but unreadable/corrupt/symlinked/wrong shape: ownership is UNPROVABLE. */

/**
 * A workspace id becomes a directory name directly under the workspace root. It must not start with "." (that
 * namespace is reserved for the adapter's own `.disposing-*` / `.disposed-*` tombstones, which the orphan sweep
 * deletes without consulting the active set) and must be short enough that `.disposing-<id>-<uuid>` stays a
 * legal file name (255).
 */
const MAX_WORKSPACE_ID_LENGTH = 128;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
const isUnsafeWorkspaceId = (id: string): boolean =>
  !/^[a-zA-Z0-9_\-\.]+$/.test(id) ||
  id.includes("..") ||
  id.startsWith(".") ||
  id.endsWith(".") ||
  id.length > MAX_WORKSPACE_ID_LENGTH ||
  /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(id); // Windows device names are not ordinary directories

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
  async provisionWorkspace(spec: WorkspaceSpec, owner?: WorkspaceOwner): Promise<WorkspaceHandle> {
    const violations = getWorkspaceSpecViolations(spec);
    if (violations.length > 0) {
      throw new InvalidWorkspaceError(spec.workspaceId, violations);
    }

    // Identity validation: workspaceId must be a safe directory name
    if (isUnsafeWorkspaceId(spec.workspaceId)) {
      throw new InvalidWorkspaceError(spec.workspaceId, [
        "workspaceId contains invalid characters for directory naming",
      ]);
    }

    if (owner && (typeof owner.runId !== "string" || !owner.runId || typeof owner.leaseId !== "string" || !owner.leaseId)) {
      throw new InvalidWorkspaceError(spec.workspaceId, ["owner.runId and owner.leaseId must be non-empty strings"]);
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

    // Create the leaf workspace directory with restricted 0700 permissions. With an owner, the directory is built under a
    // reserved `.provisioning-*` name with its ownership marker already inside and then renamed into place, so a
    // marker-less `<workspaceId>` directory is never visible to a concurrent sweep.
    if (owner) {
      const stagingDir = path.join(root, `.provisioning-${spec.workspaceId}-${crypto.randomUUID()}`);
      await fs.mkdir(stagingDir, { mode: 0o700 });
      try {
        await fs.writeFile(
          path.join(stagingDir, OWNER_MARKER),
          issueOwnership(root, spec.workspaceId, owner), // new ownership generation: also records the ledger entry outside the workspace
          { mode: 0o600, flag: "wx" }
        );
        await fs.rename(stagingDir, targetDir);
      } catch (err: unknown) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    } else {
      await fs.mkdir(targetDir, { mode: 0o700 });
    }

    // Canonicalize the newly created workspace directory
    const canonicalHostPath = await fs.realpath(targetDir);

    if (!this.isContainedInRoot(root, canonicalHostPath)) {
      // Defensive rollback if realpath somehow escaped. Remove the path we created (rm does not follow a link at the
      // path itself), NEVER the resolved real path, which by definition lies outside the root.
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw new WorkspacePathOutsideBoundaryError(
        canonicalHostPath,
        "Canonical workspace directory escapes root directory"
      );
    }

    const now = new Date().toISOString();
    // Persist workspace metadata on disk
    try {
      const meta = {
        workspaceId: spec.workspaceId,
        runId: spec.runId,
        taskId: spec.taskId,
        createdAt: now,
      };
      await fs.writeFile(
        path.join(canonicalHostPath, ".emerald-workspace.json"),
        JSON.stringify(meta),
        { mode: 0o600 }
      );
    } catch {
      // Best-effort metadata persistence
    }

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
  async disposeWorkspace(workspaceId: string, expectedOwner?: WorkspaceOwner): Promise<void> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      throw new InvalidWorkspaceError(String(workspaceId), [
        "workspaceId must be a non-empty string",
      ]);
    }

    if (isUnsafeWorkspaceId(workspaceId)) {
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

    if (expectedOwner && (await this.disposeOwnedWorkspace(workspaceId, root, targetDir, expectedOwner))) {
      return;
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
   * Race-test seams: `protected` no-ops, NOT part of WorkspacePort and not reachable by port consumers; only a
   * subclass (the deterministic race tests) can override them. They run exactly where a concurrent actor could
   * interleave. The synchronous path has no seam.
   */
  protected async afterOwnerCheck(_targetDir: string): Promise<void> {}
  protected async afterTombstoneRename(_tombstoneDir: string, _targetDir: string): Promise<void> {}

  /** Reads and AUTHENTICATES the marker of the directory `dir` (a direct child of the root) provisioned for `workspaceId`. */
  private async readOwnerMarker(dir: string, workspaceId: string): Promise<OwnerMarkerRead> {
    const markerPath = path.join(dir, OWNER_MARKER);
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(markerPath);
    } catch (err: unknown) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid" };
    }
    if (!st.isFile() || st.isSymbolicLink()) return { state: "invalid" };
    try {
      return readAuthenticatedOwner(path.dirname(dir), workspaceId, await fs.readFile(markerPath, "utf8"));
    } catch (err: unknown) {
      if (err instanceof OwnerKeyError) throw err; // an untrustworthy key is surfaced (actionable), never read as "no owner"
      return { state: "invalid" };
    }
  }

  /**
   * Ownership-aware disposal. A recursive delete only ever happens on a private, uniquely named
   * directory whose ownership marker was verified AFTER it was atomically moved out of the shared
   * workspace path:
   *
   *   1. verify the marker at the workspace path (cheap early exit; NOT trusted for safety);
   *   2. atomically rename the directory to `.disposing-<id>-<uuid>` (unique, cannot clobber anything);
   *   3. re-read the marker inside that private directory - this is the authoritative check, because no
   *      other actor can reach the directory any more; on mismatch the directory is renamed back (or, if
   *      the workspace path is taken again, preserved under its `.disposing-` name) and nothing is deleted;
   *   4. rename to `.disposed-<id>-<uuid>` (verified) and only then recursively delete it.
   *
   * A crash leaves `.disposed-*` (verified, safe to delete) or `.disposing-*` (unverified: never
   * auto-deleted); see cleanupOrphanedWorkspaces. The rename is atomic, so a stale attempt can at worst
   * move a newer attempt's directory aside for the moment it takes to restore it; it can never delete it.
   * The marker is HMAC-authenticated with a key kept outside the workspace directory (see owner-marker.ts for the
   * trust assumptions): a forged or edited marker is "invalid" and refused, never deleted through.
   */
  private async disposeOwnedWorkspace(
    workspaceId: string,
    root: string,
    targetDir: string,
    expected: WorkspaceOwner
  ): Promise<boolean> {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(targetDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.workspaces.delete(workspaceId);
        return true; // idempotent: already disposed
      }
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceOwnershipError(workspaceId, expected.leaseId, null);
    }
    const sameOwner = (m: OwnerMarkerRead): boolean =>
      !expected.unknownLease && m.state === "owner" && m.leaseId === expected.leaseId && m.runId === expected.runId;
    const actualLease = (m: OwnerMarkerRead): string | null => (m.state === "owner" ? m.leaseId : null);

    const early = await this.readOwnerMarker(targetDir, workspaceId);
    // Only a genuinely ABSENT marker may fall back to the legacy delete; an unreadable/corrupt one is never "missing".
    if (early.state === "absent" && expected.tolerateMissingMarker && (await fs.lstat(targetDir).then(() => true, () => false))) {
      return false;
    }
    if (!sameOwner(early)) {
      // A concurrent disposal by the owner may have moved the directory between our lstat and the read.
      if (early.state !== "owner" && !(await fs.lstat(targetDir).then(() => true, () => false))) {
        this.workspaces.delete(workspaceId);
        return true; // idempotent: already disposed
      }
      throw new WorkspaceOwnershipError(workspaceId, expected.leaseId, actualLease(early));
    }
    await this.afterOwnerCheck(targetDir);

    const unique = crypto.randomUUID();
    const pendingDir = path.join(root, `.disposing-${workspaceId}-${unique}`);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(targetDir, pendingDir);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          this.workspaces.delete(workspaceId);
          return true; // a concurrent disposal won the rename
        }
        // Windows reports a sharing violation (EPERM/EBUSY/EACCES) while another actor, e.g. a concurrent
        // disposal reading the ownership marker, has a handle inside the directory. Retry briefly; if the
        // directory disappears meanwhile, someone else disposed it.
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 8) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          if (!(await fs.lstat(targetDir).then(() => true, () => false))) {
            this.workspaces.delete(workspaceId);
            return true;
          }
          continue;
        }
        throw err;
      }
    }
    await this.afterTombstoneRename(pendingDir, targetDir);

    // The marker is read THROUGH the path, which follows a link used as a path component: only a real directory may be
    // verified. A link (or file) swapped in after the owner check is treated as unverifiable and handled like a
    // mismatch (restored / preserved, never read through, never chmod'ed, never deleted).
    const pendingStat = await fs.lstat(pendingDir).catch(() => null);
    const pendingIsRealDir = pendingStat !== null && pendingStat.isDirectory() && !pendingStat.isSymbolicLink();
    const moved: OwnerMarkerRead = pendingIsRealDir
      ? await this.readOwnerMarker(pendingDir, workspaceId)
      : pendingStat === null
        ? { state: "absent" }
        : { state: "invalid" };
    if (moved.state !== "owner" && !(await fs.lstat(pendingDir).then(() => true, () => false))) {
      // Measured on Windows: when two disposals race, the loser's rename can report success although the
      // source was already moved by the winner, so nothing is at our private path. Nothing to verify or delete.
      this.workspaces.delete(workspaceId);
      return true;
    }
    if (!sameOwner(moved)) {
      let restored = false;
      try {
        // POSIX rename(2) silently REPLACES an empty directory at the destination (Windows fails): never restore onto
        // anything that exists, so a directory another actor put at the path is not swapped out from under it.
        if (await fs.lstat(targetDir).then(() => true, () => false)) throw new Error("workspace path is taken");
        await fs.rename(pendingDir, targetDir);
        restored = true;
      } catch {
        // workspace path was taken again: keep the moved directory, unmodified, for an operator
      }
      throw new WorkspaceOwnershipError(workspaceId, expected.leaseId, actualLease(moved), restored ? undefined : pendingDir);
    }

    const verifiedDir = path.join(root, `.disposed-${workspaceId}-${unique}`);
    await fs.rename(pendingDir, verifiedDir);
    await this.ensureWritableRecursive(verifiedDir).catch(() => {});
    await fs.rm(verifiedDir, { recursive: true, force: true });
    if (moved.state === "owner") clearOwnership(root, workspaceId, moved.nonce);
    this.workspaces.delete(workspaceId);
    return true;
  }

  /**
   * Synchronously disposes of an allocated workspace for synchronous recovery paths.
   */
  disposeWorkspaceSync(workspaceId: string, expectedOwner?: WorkspaceOwner): void {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      throw new InvalidWorkspaceError(String(workspaceId), [
        "workspaceId must be a non-empty string",
      ]);
    }

    if (isUnsafeWorkspaceId(workspaceId)) {
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

    if (expectedOwner && this.disposeOwnedWorkspaceSync(workspaceId, root, targetDir, expectedOwner)) {
      return;
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

  private readOwnerMarkerSync(dir: string, workspaceId: string): OwnerMarkerRead {
    const markerPath = path.join(dir, OWNER_MARKER);
    let st: syncFs.Stats;
    try {
      st = syncFs.lstatSync(markerPath);
    } catch (err: unknown) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid" };
    }
    if (!st.isFile() || st.isSymbolicLink()) return { state: "invalid" };
    try {
      return readAuthenticatedOwner(path.dirname(dir), workspaceId, syncFs.readFileSync(markerPath, "utf8"));
    } catch (err: unknown) {
      if (err instanceof OwnerKeyError) throw err;
      return { state: "invalid" };
    }
  }

  /**
   * Synchronous twin of disposeOwnedWorkspace (same protocol: verify, atomic move aside, re-verify inside the
   * private directory, only then delete). Returns true when it handled the request (deleted, already gone, or
   * threw); returns false only for a genuinely marker-less directory with `tolerateMissingMarker`, which the caller
   * then disposes through the legacy unowned path. An unreadable/corrupt marker is refused, never treated as missing.
   */
  private disposeOwnedWorkspaceSync(workspaceId: string, root: string, targetDir: string, expected: WorkspaceOwner): boolean {
    let stat: syncFs.Stats;
    try {
      stat = syncFs.lstatSync(targetDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.workspaces.delete(workspaceId);
        return true;
      }
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceOwnershipError(workspaceId, expected.leaseId, null);
    }
    const sameOwner = (m: OwnerMarkerRead): boolean =>
      !expected.unknownLease && m.state === "owner" && m.leaseId === expected.leaseId && m.runId === expected.runId;
    const actualLease = (m: OwnerMarkerRead): string | null => (m.state === "owner" ? m.leaseId : null);

    const early = this.readOwnerMarkerSync(targetDir, workspaceId);
    if (early.state === "absent" && expected.tolerateMissingMarker) return false;
    if (!sameOwner(early)) {
      throw new WorkspaceOwnershipError(workspaceId, expected.leaseId, actualLease(early));
    }

    const unique = crypto.randomUUID();
    const pendingDir = path.join(root, `.disposing-${workspaceId}-${unique}`);
    try {
      syncFs.renameSync(targetDir, pendingDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.workspaces.delete(workspaceId);
        return true;
      }
      throw err;
    }
    let pendingStat: syncFs.Stats | null = null;
    try {
      pendingStat = syncFs.lstatSync(pendingDir);
    } catch {
      pendingStat = null;
    }
    const pendingIsRealDir = pendingStat !== null && pendingStat.isDirectory() && !pendingStat.isSymbolicLink();
    const moved: OwnerMarkerRead = pendingIsRealDir
      ? this.readOwnerMarkerSync(pendingDir, workspaceId)
      : pendingStat === null
        ? { state: "absent" }
        : { state: "invalid" };
    if (moved.state !== "owner" && !syncFs.existsSync(pendingDir)) {
      this.workspaces.delete(workspaceId);
      return true;
    }
    if (!sameOwner(moved)) {
      let restored = false;
      try {
        // see the async path: POSIX rename(2) would replace an empty directory at the destination
        if (syncFs.lstatSync(targetDir, { throwIfNoEntry: false })) throw new Error("workspace path is taken");
        syncFs.renameSync(pendingDir, targetDir);
        restored = true;
      } catch {
        // path was taken again: keep the moved directory, unmodified, for an operator
      }
      throw new WorkspaceOwnershipError(workspaceId, expected.leaseId, actualLease(moved), restored ? undefined : pendingDir);
    }
    const verifiedDir = path.join(root, `.disposed-${workspaceId}-${unique}`);
    syncFs.renameSync(pendingDir, verifiedDir);
    this.ensureWritableRecursiveSync(verifiedDir);
    syncFs.rmSync(verifiedDir, { recursive: true, force: true });
    if (moved.state === "owner") clearOwnership(root, workspaceId, moved.nonce);
    this.workspaces.delete(workspaceId);
    return true;
  }

  private ensureWritableRecursiveSync(targetDir: string): void {
    // POSIX: no permission walk at all. Removing a directory entry needs only write permission on its PARENT, so read-only
    // FILES never block deletion; and the walk is path-based (lstat-then-chmod), which a live tenant can race by swapping a
    // component for a symlink, making chmod hit a directory OUTSIDE the root (reproduced on Linux: 4 of 60 trials). A read-only
    // DIRECTORY therefore makes the delete fail closed (EACCES): the verified `.disposed-*` tombstone stays for an operator.
    // Windows keeps the walk: there the read-only attribute does block deletion and chmod only toggles that attribute.
    if (process.platform !== "win32") return;
    // chmod and readdir FOLLOW links: never touch anything that is not a real directory at this exact path.
    try {
      const top = syncFs.lstatSync(targetDir);
      if (top.isSymbolicLink() || !top.isDirectory()) return;
    } catch {
      return;
    }
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
      if (entry.isSymbolicLink()) {
        continue; // chmod would change the TARGET of the link, which may lie outside the workspace
      }
      if (entry.isDirectory()) {
        this.ensureWritableRecursiveSync(fullPath);
      } else {
        try {
          if (syncFs.lstatSync(fullPath).nlink > 1) continue; // hard link: see the async twin
          syncFs.chmodSync(fullPath, 0o600);
        } catch {}
      }
    }
  }

  /**
   * Scans the workspace root and cleans up orphaned workspace directories
   * whose leases are no longer active in persistence.
   */
  async cleanupOrphanedWorkspaces(activeFilter: WorkspaceActiveFilter, options: OrphanSweepOptions = {}): Promise<readonly string[]> {
    const root = await this.getCanonicalWorkspaceRoot();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const reclaimed: string[] = [];

    for (const entry of entries) {
      // Only process directories or symlinks
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const dirName = entry.name;

      // Unverified crash leftovers are never deleted automatically; surface them so an operator can look.
      if (entry.isDirectory() && (dirName.startsWith(".disposing-") || dirName.startsWith(".provisioning-"))) {
        options.onUnverifiedLeftover?.(dirName);
        continue;
      }

      // Crash leftovers of ownership-aware disposal: `.disposed-*` was verified before the crash and is
      // safe to finish deleting; `.disposing-*` was never verified and is deliberately left untouched.
      if (entry.isDirectory() && dirName.startsWith(".disposed-")) {
        try {
          await this.ensureWritableRecursive(path.join(root, dirName)).catch(() => {});
          await fs.rm(path.join(root, dirName), { recursive: true, force: true });
          reclaimed.push(dirName);
        } catch (err: unknown) {
          options.onSkipped?.(dirName, `verified tombstone not removable yet: ${describeError(err)}`); // retried by the next scan
        }
        continue;
      }

      // Skip invalid or hidden directory names (e.g. .git, .tmp)
      if (!/^[a-zA-Z0-9_\-\.]+$/.test(dirName) || dirName.startsWith(".")) {
        continue;
      }

      // Check if authoritatively active (evaluated twice for owned workspaces: see below)
      const checkActive = async (owner?: { runId: string; leaseId: string }): Promise<boolean> => {
        if (typeof activeFilter === "function") return Boolean(await activeFilter(dirName, owner));
        if (activeFilter instanceof Set || "has" in activeFilter) return activeFilter.has(dirName);
        return false;
      };

      // If active, NEVER delete. If activity cannot be established (the authority threw), safety is unproven:
      // fail closed - skip this directory, report why, and keep sweeping the others.
      try {
        if (await checkActive()) {
          continue;
        }
      } catch (err: unknown) {
        options.onSkipped?.(dirName, `activity check failed: ${describeError(err)}`);
        continue;
      }

      try {
        // Between the active-set check above and the delete, the directory may be replaced by a newer attempt.
        // When it carries an ownership marker, delete only if it STILL belongs to that owner (re-verified after
        // an atomic move aside); a replaced directory is restored/preserved and not reclaimed. A marker-less
        // (legacy) directory keeps the unowned delete, so that case still has the check-then-delete window.
        const marker = await this.readOwnerMarker(path.join(root, dirName), dirName);
        if (marker.state === "invalid") {
          options.onSkipped?.(dirName, "ownership marker unreadable, invalid or not authenticated");
          continue; // unreadable/corrupt/forged marker: ownership is unprovable, so never delete
        }
        if (marker.state === "owner") {
          // The marker may belong to an attempt that became active AFTER the first check (the directory was
          // replaced in between): look again, this time asking about the marker's own run and lease, then delete only
          // if it still is theirs.
          const owner = { runId: marker.runId, leaseId: marker.leaseId };
          if (await checkActive(owner)) continue;
          await this.disposeWorkspace(dirName, owner);
        } else {
          if (!options.reclaimUnowned) {
            options.onSkipped?.(dirName, "no ownership marker (pass reclaimUnowned to delete legacy workspaces)");
            continue; // a live marker-less workspace cannot be told from an orphan
          }
          await this.disposeWorkspace(dirName); // legacy marker-less directory: unowned delete (check-then-delete window remains)
        }
        reclaimed.push(dirName);
      } catch (err: unknown) {
        // Continue cleaning other orphans if one fails, but never silently: nothing was proven deletable.
        options.onSkipped?.(
          dirName,
          err instanceof WorkspaceOwnershipError
            ? "ownership changed before deletion; directory preserved"
            : `not deleted: ${describeError(err)}`
        );
      }
    }

    return Object.freeze(reclaimed);
  }

  /**
   * Helper to retrieve stored workspace metadata asynchronously.
   */
  async getWorkspaceMetadata(workspaceId: string): Promise<{ runId?: string; taskId?: string } | null> {
    const active = this.workspaces.get(workspaceId);
    if (active) {
      return { runId: active.spec.runId, taskId: active.spec.taskId };
    }
    try {
      if (isUnsafeWorkspaceId(workspaceId)) return null; // never join an unvalidated id into a path
      const root = await this.getCanonicalWorkspaceRoot();
      const metaPath = path.join(root, workspaceId, ".emerald-workspace.json");
      const content = await fs.readFile(metaPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Helper to retrieve stored workspace metadata synchronously.
   */
  getWorkspaceMetadataSync(workspaceId: string): { runId?: string; taskId?: string } | null {
    const active = this.workspaces.get(workspaceId);
    if (active) {
      return { runId: active.spec.runId, taskId: active.spec.taskId };
    }
    try {
      if (isUnsafeWorkspaceId(workspaceId)) return null; // never join an unvalidated id into a path
      const root = this.canonicalWorkspaceRoot ?? this.workspaceRoot;
      const metaPath = path.join(root, workspaceId, ".emerald-workspace.json");
      const content = syncFs.readFileSync(metaPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
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
    // POSIX: no permission walk at all. Removing a directory entry needs only write permission on its PARENT, so read-only
    // FILES never block deletion; and the walk is path-based (lstat-then-chmod), which a live tenant can race by swapping a
    // component for a symlink, making chmod hit a directory OUTSIDE the root (reproduced on Linux: 4 of 60 trials). A read-only
    // DIRECTORY therefore makes the delete fail closed (EACCES): the verified `.disposed-*` tombstone stays for an operator.
    // Windows keeps the walk: there the read-only attribute does block deletion and chmod only toggles that attribute.
    if (process.platform !== "win32") return;
    // chmod and readdir FOLLOW links: never touch anything that is not a real directory at this exact path.
    try {
      const top = await fs.lstat(targetDir);
      if (top.isSymbolicLink() || !top.isDirectory()) return;
    } catch {
      return;
    }
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
      if (entry.isSymbolicLink()) {
        continue; // chmod would change the TARGET of the link, which may lie outside the workspace
      }
      if (entry.isDirectory()) {
        await this.ensureWritableRecursive(fullPath);
      } else {
        try {
          // A hard link would make chmod change an inode that also lives OUTSIDE the workspace: leave multiply-linked files alone
          // (removal needs only write permission on the parent directory, which is made writable above).
          if ((await fs.lstat(fullPath)).nlink > 1) continue;
          await fs.chmod(fullPath, 0o600);
        } catch {
          // Ignore platform errors
        }
      }
    }
  }
}
