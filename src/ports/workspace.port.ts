/**
 * Workspace and Repository Acquisition Ports.
 *
 * Defines the abstract interface boundaries for workspace lifecycle management
 * and repository checkout without any infrastructure or platform dependencies.
 */

import { RepositorySource, WorkspaceSpec } from "../domain/workspace.js";

/**
 * Handle representing an allocated workspace managed by an infrastructure adapter.
 */
export interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly runId: string;
  readonly hostPath: string;           // Canonical absolute directory path on host
  readonly containerMountPath: string; // Fixed container path: "/workspace"
  readonly createdAt: string;
  readonly maxWorkspaceBytes: number;
}

/**
 * Port interface for managing isolated workspace directory lifecycles.
 * Implemented by infrastructure adapters (e.g. NodeFsWorkspaceAdapter).
 */
/**
 * Identity of the attempt that owns a workspace directory. The workspace id is stable per run (`ws-<runId>`),
 * so only the lease id distinguishes one attempt's directory from the next attempt's.
 */
export interface WorkspaceOwner {
  readonly runId: string;
  readonly leaseId: string;
  /**
   * Only for callers that may legitimately clean up a workspace provisioned WITHOUT an owner marker (older or
   * non-worker workspaces): a missing marker then falls back to the unowned delete. A marker that is present
   * and names a different lease is ALWAYS refused.
   */
  readonly tolerateMissingMarker?: boolean;
  /**
   * The caller does not know which lease owns the workspace (`leaseId` is then ignored). Nothing carrying an ownership
   * marker may be deleted for such a caller; a genuinely marker-less directory is still subject to tolerateMissingMarker.
   */
  readonly unknownLease?: boolean;
}

/** Activity predicate for the orphan sweep. The second argument is present on the re-check made after the ownership marker was read. */
export type WorkspaceActiveFilter =
  | ReadonlySet<string>
  | ((workspaceId: string, owner?: { readonly runId: string; readonly leaseId: string }) => boolean | Promise<boolean>);

export interface OrphanSweepOptions {
  /**
   * Also delete directories that carry NO ownership marker (legacy or non-worker workspaces). Default false: without a marker
   * a live workspace cannot be told from an orphan, and the check-then-delete window cannot be closed.
   */
  readonly reclaimUnowned?: boolean;
  /** Called for `.disposing-*` / `.provisioning-*` crash leftovers, which are never deleted automatically. */
  readonly onUnverifiedLeftover?: (name: string) => void;
  /** Called for each directory the sweep deliberately did not delete because ownership could not be proven. */
  readonly onSkipped?: (name: string, reason: string) => void;
}

export interface WorkspacePort {
  /**
   * Provisions a dedicated isolated directory for a workspace and returns its handle.
   */
  provisionWorkspace(spec: WorkspaceSpec, owner?: WorkspaceOwner): Promise<WorkspaceHandle>;

  /**
   * Resolves a relative path within a workspace to its canonical, symlink-verified host path.
   * Guarantees that the final real path remains strictly inside the workspace directory.
   */
  resolvePath(workspaceId: string, relativePath: string): Promise<string>;

  /**
   * Disposes of a workspace, recursively deleting host files and freeing storage.
   */
  disposeWorkspace(workspaceId: string, expectedOwner?: WorkspaceOwner): Promise<void>;

  /**
   * Optional synchronous workspace disposal for synchronous transactional recovery paths.
   */
  disposeWorkspaceSync?(workspaceId: string, expectedOwner?: WorkspaceOwner): void;

  /**
   * Scans the workspace root and cleans up orphaned workspace directories
   * whose leases are no longer active in persistence.
   */
  cleanupOrphanedWorkspaces(activeFilter: WorkspaceActiveFilter, options?: OrphanSweepOptions): Promise<readonly string[]>;

  /**
   * Optional helper to retrieve stored workspace metadata.
   */
  getWorkspaceMetadata?(workspaceId: string): Promise<{ runId?: string; taskId?: string } | null>;
  getWorkspaceMetadataSync?(workspaceId: string): { runId?: string; taskId?: string } | null;
}

/**
 * Result metrics from acquiring a repository source.
 */
export interface RepositoryAcquisitionResult {
  readonly resolvedRevision: string; // Immutable commit SHA or archive hash
  readonly fileCount: number;
  readonly totalBytes: number;
}

/**
 * Port interface for acquiring source repositories at an immutable revision.
 * Implemented by infrastructure adapters (e.g. GitCliRepositoryAdapter).
 */
export interface RepositoryAcquisitionPort {
  acquire(source: RepositorySource, targetDirectory: string): Promise<RepositoryAcquisitionResult>;
}
