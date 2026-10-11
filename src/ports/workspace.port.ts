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
export interface WorkspacePort {
  /**
   * Provisions a dedicated isolated directory for a workspace and returns its handle.
   */
  provisionWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle>;

  /**
   * Resolves a relative path within a workspace to its canonical, symlink-verified host path.
   * Guarantees that the final real path remains strictly inside the workspace directory.
   */
  resolvePath(workspaceId: string, relativePath: string): Promise<string>;

  /**
   * Disposes of a workspace, recursively deleting host files and freeing storage.
   */
  disposeWorkspace(workspaceId: string): Promise<void>;

  /**
   * Optional synchronous workspace disposal for synchronous transactional recovery paths.
   */
  disposeWorkspaceSync?(workspaceId: string): void;

  /**
   * Scans the workspace root and cleans up orphaned workspace directories
   * whose leases are no longer active in persistence.
   */
  cleanupOrphanedWorkspaces(
    activeFilter: ReadonlySet<string> | ((workspaceId: string) => boolean | Promise<boolean>)
  ): Promise<readonly string[]>;

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
