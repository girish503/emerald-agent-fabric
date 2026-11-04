/**
 * Repository importer port.
 *
 * Copies a host repository into a freshly provisioned, empty run workspace so a governed agent can read
 * and modify a COPY of it. The source is never modified. Implementations must fail closed: on any limit
 * violation or unsafe path they throw, and the caller disposes the workspace.
 */

import type { RepositoryImportSummary } from "../domain/events.js";

export type { RepositoryImportSummary } from "../domain/events.js";

export interface RepositoryImportLimits {
  /** Maximum number of files copied. Exceeding it fails the import. */
  readonly maxFiles: number;
  /** Maximum total bytes copied. Exceeding it fails the import. */
  readonly maxTotalBytes: number;
  /** Files larger than this are skipped and counted, not copied. */
  readonly maxFileBytes: number;
}

export interface RepositoryImporterPort {
  /**
   * Copies `sourcePath` into the existing, empty `destinationPath`.
   * Never follows symbolic links, never copies VCS metadata, dependency directories or likely secret files,
   * and never writes outside `destinationPath`.
   */
  importRepository(
    sourcePath: string,
    destinationPath: string,
    limits?: Partial<RepositoryImportLimits>
  ): Promise<RepositoryImportSummary>;
}

export type RepositoryImportErrorCode =
  | "SOURCE_INVALID"
  | "DESTINATION_INVALID"
  | "OVERLAPPING_PATHS"
  | "LIMIT_EXCEEDED"
  | "COPY_FAILED";

export class RepositoryImportError extends Error {
  constructor(
    readonly code: RepositoryImportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RepositoryImportError";
  }
}
