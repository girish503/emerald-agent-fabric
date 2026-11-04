/**
 * Node filesystem repository importer.
 *
 * Safety properties:
 * - The source must be an absolute path to an existing directory; it is resolved with realpath first.
 * - The destination must be an existing directory that is empty apart from the workspace ownership marker.
 * - Source and destination must not overlap (neither may contain the other).
 * - Symbolic links and special files are never followed or copied; they are counted and skipped.
 * - VCS metadata, dependency directories and likely secret files are excluded and counted.
 * - A scan pass enforces the file-count and total-size limits BEFORE anything is copied, so a limit
 *   violation leaves the destination untouched.
 * - Files are copied with COPYFILE_EXCL, so nothing already in the destination is overwritten.
 *
 * The source is only ever read. Delivery of the copy is a snapshot: later edits to the source are not seen.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  RepositoryImportError,
  type RepositoryImportLimits,
  type RepositoryImporterPort,
  type RepositoryImportSummary,
} from "../../ports/repository-importer.port.js";

export const DEFAULT_REPOSITORY_IMPORT_LIMITS: RepositoryImportLimits = Object.freeze({
  maxFiles: 20_000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
});

const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([".git", "node_modules"]);
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([".pem", ".key", ".p12", ".pfx"]);
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
]);
const ENV_TEMPLATE_SUFFIXES: readonly string[] = [".example", ".sample", ".template"];
/** Workspace-adapter bookkeeping files (ownership marker, metadata) live in the workspace and are never repository content. */
const ADAPTER_FILE_PREFIX = ".emerald-";

/** True when a file name is likely to hold credentials and must not be placed in a model-readable workspace. */
export function isLikelySecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(ADAPTER_FILE_PREFIX)) return true;
  if (SECRET_FILE_NAMES.has(lower)) return true;
  if (SECRET_EXTENSIONS.has(path.extname(lower))) return true;
  if (lower === ".env" || lower.startsWith(".env.")) {
    return !ENV_TEMPLATE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  }
  return false;
}

interface PlannedFile {
  readonly relativePath: string;
  readonly size: number;
}

interface ImportPlan {
  readonly directories: string[];
  readonly files: PlannedFile[];
  totalBytes: number;
  skippedSymlinks: number;
  skippedSpecialFiles: number;
  excludedEntries: number;
  oversizeSkipped: number;
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class NodeFsRepositoryImporter implements RepositoryImporterPort {
  async importRepository(
    sourcePath: string,
    destinationPath: string,
    limits?: Partial<RepositoryImportLimits>
  ): Promise<RepositoryImportSummary> {
    const effective: RepositoryImportLimits = { ...DEFAULT_REPOSITORY_IMPORT_LIMITS, ...limits };

    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
      throw new RepositoryImportError("SOURCE_INVALID", "Repository source path must be an absolute path");
    }

    let sourceReal: string;
    try {
      sourceReal = fs.realpathSync(sourcePath);
      if (!fs.statSync(sourceReal).isDirectory()) {
        throw new RepositoryImportError("SOURCE_INVALID", "Repository source path is not a directory");
      }
    } catch (err: unknown) {
      if (err instanceof RepositoryImportError) throw err;
      throw new RepositoryImportError("SOURCE_INVALID", "Repository source path does not exist or is unreadable");
    }

    let destinationReal: string;
    try {
      destinationReal = fs.realpathSync(destinationPath);
      if (!fs.statSync(destinationReal).isDirectory()) {
        throw new RepositoryImportError("DESTINATION_INVALID", "Import destination is not a directory");
      }
      const leftovers = fs
        .readdirSync(destinationReal)
        .filter((name) => !name.toLowerCase().startsWith(ADAPTER_FILE_PREFIX));
      if (leftovers.length > 0) {
        throw new RepositoryImportError("DESTINATION_INVALID", "Import destination is not empty");
      }
    } catch (err: unknown) {
      if (err instanceof RepositoryImportError) throw err;
      throw new RepositoryImportError("DESTINATION_INVALID", "Import destination does not exist or is unreadable");
    }

    if (isWithin(sourceReal, destinationReal) || isWithin(destinationReal, sourceReal)) {
      throw new RepositoryImportError(
        "OVERLAPPING_PATHS",
        "Repository source and import destination must not contain one another"
      );
    }

    const plan = this.plan(sourceReal, effective);
    this.copy(sourceReal, destinationReal, plan);

    return {
      sourcePath: sourceReal,
      fileCount: plan.files.length,
      totalBytes: plan.totalBytes,
      skippedSymlinks: plan.skippedSymlinks,
      skippedSpecialFiles: plan.skippedSpecialFiles,
      excludedEntries: plan.excludedEntries,
      oversizeSkipped: plan.oversizeSkipped,
    };
  }

  /** Walks the source without following links and enforces the limits before any byte is copied. */
  private plan(sourceRoot: string, limits: RepositoryImportLimits): ImportPlan {
    const plan: ImportPlan = {
      directories: [],
      files: [],
      totalBytes: 0,
      skippedSymlinks: 0,
      skippedSpecialFiles: 0,
      excludedEntries: 0,
      oversizeSkipped: 0,
    };

    const walk = (relativeDir: string): void => {
      const absoluteDir = path.join(sourceRoot, relativeDir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
      } catch {
        throw new RepositoryImportError("COPY_FAILED", "A source directory could not be read");
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const entry of entries) {
        const relativePath = relativeDir === "" ? entry.name : path.join(relativeDir, entry.name);

        if (entry.isSymbolicLink()) {
          plan.skippedSymlinks++;
        } else if (entry.isDirectory()) {
          if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
            plan.excludedEntries++;
            continue;
          }
          plan.directories.push(relativePath);
          walk(relativePath);
        } else if (entry.isFile()) {
          if (isLikelySecretFileName(entry.name)) {
            plan.excludedEntries++;
            continue;
          }
          let size: number;
          try {
            size = fs.lstatSync(path.join(sourceRoot, relativePath)).size;
          } catch {
            throw new RepositoryImportError("COPY_FAILED", "A source file could not be inspected");
          }
          if (size > limits.maxFileBytes) {
            plan.oversizeSkipped++;
            continue;
          }
          plan.files.push({ relativePath, size });
          plan.totalBytes += size;
          if (plan.files.length > limits.maxFiles) {
            throw new RepositoryImportError(
              "LIMIT_EXCEEDED",
              `Repository exceeds the file-count limit (${limits.maxFiles})`
            );
          }
          if (plan.totalBytes > limits.maxTotalBytes) {
            throw new RepositoryImportError(
              "LIMIT_EXCEEDED",
              `Repository exceeds the total-size limit (${limits.maxTotalBytes} bytes)`
            );
          }
        } else {
          plan.skippedSpecialFiles++;
        }
      }
    };

    walk("");
    return plan;
  }

  private copy(sourceRoot: string, destinationRoot: string, plan: ImportPlan): void {
    try {
      for (const dir of plan.directories) {
        fs.mkdirSync(path.join(destinationRoot, dir), { recursive: true, mode: 0o700 });
      }
      for (const file of plan.files) {
        const target = path.join(destinationRoot, file.relativePath);
        if (!isWithin(destinationRoot, target)) {
          throw new RepositoryImportError("COPY_FAILED", "Computed copy target escapes the destination");
        }
        fs.copyFileSync(path.join(sourceRoot, file.relativePath), target, fs.constants.COPYFILE_EXCL);
      }
    } catch (err: unknown) {
      if (err instanceof RepositoryImportError) throw err;
      throw new RepositoryImportError(
        "COPY_FAILED",
        `Repository copy failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
