/**
 * Git-backed artifact exporter.
 *
 * The baseline lives in a private git repository under the artifact root, never inside the workspace, so
 * nothing the agent does in the workspace can alter it. The workspace is only ever used as a git work tree
 * for reading: every command runs with an explicit --git-dir, so git never writes into the workspace.
 *
 * Layout: <artifactRoot>/<runId>/attempt-<n>/{baseline.git, patch.diff, manifest.json}
 *
 * Semantics worth knowing:
 * - Repository .gitignore rules are honored: ignored paths are neither in the baseline nor in the patch.
 * - Adapter bookkeeping files (.emerald-*) are always excluded.
 * - git is invoked without a shell, with global/system configuration disabled, and with external diff and
 *   text conversion drivers off, so repository content cannot make it run anything.
 * - The patch is a normal binary-safe git patch: `git apply` reproduces the final tree from the baseline.
 */

import { execFile, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  ArtifactExportError,
  type ArtifactExporterPort,
  type ArtifactExportSummary,
  type ArtifactScope,
} from "../../ports/artifact-exporter.port.js";

const execFileAsync = promisify(execFile);

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Git understands this spelling on every platform (Git for Windows maps it to NUL); os.devNull is not accepted as a config path there. */
const GIT_NULL_DEVICE = "/dev/null";

export interface GitArtifactExporterOptions {
  /** Existing directory that receives artifacts. It must not be inside any run workspace. */
  readonly artifactRoot: string;
  /** git executable; defaults to `git` on PATH. */
  readonly gitPath?: string;
}

export interface ArtifactManifestFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "typechange";
  readonly linesAdded: number | null;
  readonly linesRemoved: number | null;
  readonly binary: boolean;
}

export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attempt: number;
  readonly createdAt: string;
  readonly disposalReason: string | null;
  readonly baselineCommit: string;
  readonly files: readonly ArtifactManifestFile[];
  readonly totals: {
    readonly changedFiles: number;
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
  };
  readonly patch: { readonly file: "patch.diff"; readonly bytes: number; readonly sha256: string };
}

/** Throws when the git executable cannot be run, so a misconfigured worker fails at startup instead of mid-run. */
export function assertGitAvailable(gitPath = "git"): void {
  try {
    execFileSync(gitPath, ["--version"], { stdio: "ignore", windowsHide: true });
  } catch {
    throw new Error(`git executable not found or not runnable: ${gitPath}`);
  }
}

export function artifactDirectory(artifactRoot: string, runId: string, attempt: number): string {
  if (!SAFE_SEGMENT.test(runId) || runId === "." || runId === "..") {
    throw new ArtifactExportError("ARTIFACT_EXPORT_FAILED", "Run id is not a safe directory name");
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new ArtifactExportError("ARTIFACT_EXPORT_FAILED", "Attempt must be a positive integer");
  }
  return path.join(artifactRoot, runId, `attempt-${attempt}`);
}

export class GitArtifactExporter implements ArtifactExporterPort {
  private readonly artifactRoot: string;
  private readonly gitPath: string;

  constructor(options: GitArtifactExporterOptions) {
    this.artifactRoot = options.artifactRoot;
    this.gitPath = options.gitPath ?? "git";
  }

  async captureBaseline(scope: ArtifactScope): Promise<void> {
    try {
      const dir = artifactDirectory(this.artifactRoot, scope.runId, scope.attempt);
      const gitDir = path.join(dir, "baseline.git");
      if (fs.existsSync(gitDir)) {
        throw new Error("a baseline was already captured for this attempt");
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await this.git(dir, gitDir, scope.workspacePath, ["init", "--quiet"]);
      fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
      fs.writeFileSync(path.join(gitDir, "info", "exclude"), ".emerald-*\n", "utf8");
      await this.git(dir, gitDir, scope.workspacePath, ["add", "-A"]);
      await this.git(dir, gitDir, scope.workspacePath, ["commit", "--quiet", "--allow-empty", "-m", "baseline"]);
    } catch (err: unknown) {
      if (err instanceof ArtifactExportError) throw err;
      throw new ArtifactExportError(
        "ARTIFACT_BASELINE_FAILED",
        `Artifact baseline capture failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async exportArtifact(scope: ArtifactScope & { readonly disposalReason?: string }): Promise<ArtifactExportSummary> {
    try {
      const dir = artifactDirectory(this.artifactRoot, scope.runId, scope.attempt);
      const gitDir = path.join(dir, "baseline.git");
      if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
        throw new Error("no baseline exists for this attempt");
      }

      // Stage the workspace into the PRIVATE index (inside baseline.git); the workspace is not written.
      await this.git(dir, gitDir, scope.workspacePath, ["add", "-A"]);
      const diffArgs = ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
      const patch = await this.gitBuffer(dir, gitDir, scope.workspacePath, [...diffArgs, "--binary", "HEAD"]);
      const nameStatus = await this.gitBuffer(dir, gitDir, scope.workspacePath, [
        ...diffArgs,
        "--name-status",
        "-z",
        "HEAD",
      ]);
      const numstat = await this.gitBuffer(dir, gitDir, scope.workspacePath, [...diffArgs, "--numstat", "-z", "HEAD"]);
      const baselineCommit = (
        await this.gitBuffer(dir, gitDir, scope.workspacePath, ["rev-parse", "HEAD"])
      )
        .toString("utf8")
        .trim();

      const files = this.parseFiles(nameStatus, numstat);
      const patchSha256 = crypto.createHash("sha256").update(patch).digest("hex");
      const totals = {
        changedFiles: files.length,
        added: files.filter((f) => f.status === "added").length,
        modified: files.filter((f) => f.status === "modified" || f.status === "typechange").length,
        deleted: files.filter((f) => f.status === "deleted").length,
        linesAdded: files.reduce((sum, f) => sum + (f.linesAdded ?? 0), 0),
        linesRemoved: files.reduce((sum, f) => sum + (f.linesRemoved ?? 0), 0),
      };
      const manifest: ArtifactManifest = {
        schemaVersion: 1,
        runId: scope.runId,
        attempt: scope.attempt,
        createdAt: new Date().toISOString(),
        disposalReason: scope.disposalReason ?? null,
        baselineCommit,
        files,
        totals,
        patch: { file: "patch.diff", bytes: patch.length, sha256: patchSha256 },
      };

      this.writeAtomically(path.join(dir, "patch.diff"), patch);
      this.writeAtomically(path.join(dir, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

      return {
        artifactPath: path.posix.join(scope.runId, `attempt-${scope.attempt}`),
        attempt: scope.attempt,
        changedFiles: totals.changedFiles,
        added: totals.added,
        modified: totals.modified,
        deleted: totals.deleted,
        patchBytes: patch.length,
        patchSha256,
      };
    } catch (err: unknown) {
      if (err instanceof ArtifactExportError) throw err;
      throw new ArtifactExportError(
        "ARTIFACT_EXPORT_FAILED",
        `Artifact export failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private parseFiles(nameStatus: Buffer, numstat: Buffer): ArtifactManifestFile[] {
    const stats = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
    for (const entry of numstat.toString("utf8").split("\0").filter(Boolean)) {
      const [added, removed, ...rest] = entry.split("\t");
      const filePath = rest.join("\t");
      const binary = added === "-" && removed === "-";
      stats.set(filePath, {
        added: binary ? null : Number(added),
        removed: binary ? null : Number(removed),
        binary,
      });
    }

    const tokens = nameStatus.toString("utf8").split("\0").filter(Boolean);
    const files: ArtifactManifestFile[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const code = tokens[i]!;
      const filePath = tokens[i + 1]!;
      const status: ArtifactManifestFile["status"] =
        code === "A" ? "added" : code === "D" ? "deleted" : code === "T" ? "typechange" : "modified";
      const stat = stats.get(filePath);
      files.push({
        path: filePath,
        status,
        linesAdded: stat?.added ?? null,
        linesRemoved: stat?.removed ?? null,
        binary: stat?.binary ?? false,
      });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private writeAtomically(target: string, content: Buffer): void {
    const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(temp, content, { mode: 0o600 });
      fs.renameSync(temp, target);
    } catch (err: unknown) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // best effort
      }
      throw err;
    }
  }

  private async git(cwd: string, gitDir: string, workTree: string, args: readonly string[]): Promise<void> {
    await this.gitBuffer(cwd, gitDir, workTree, args);
  }

  private async gitBuffer(cwd: string, gitDir: string, workTree: string, args: readonly string[]): Promise<Buffer> {
    const fullArgs = [
      "--git-dir",
      gitDir,
      "--work-tree",
      workTree,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      "core.fileMode=false",
      "-c",
      "core.quotepath=off",
      "-c",
      "core.hooksPath=" + GIT_NULL_DEVICE,
      "-c",
      "core.excludesFile=" + GIT_NULL_DEVICE,
      "-c",
      "user.name=emerald",
      "-c",
      "user.email=emerald@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ];
    try {
      const { stdout } = await execFileAsync(this.gitPath, fullArgs, {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
      return stdout;
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer | string }).stderr;
      const detail = stderr ? stderr.toString().trim().split("\n")[0] : err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
  }
}
