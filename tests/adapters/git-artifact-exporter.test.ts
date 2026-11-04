/**
 * Milestone 3.1A — Artifact export (adapter)
 *
 * Verifies GitArtifactExporter preserves a run workspace's changes as a reviewable, applicable patch plus a
 * manifest, without ever modifying the workspace, and fails closed.
 *
 * Explicit limits (not proven here, by design):
 * - Repository .gitignore rules are honored, so ignored paths are outside the baseline and the patch.
 * - Requires a git executable; this suite uses the real one.
 * - The patch is a snapshot at export time; it says nothing about whether the change is correct.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitArtifactExporter,
  type ArtifactManifest,
} from "../../src/adapters/workspace/git-artifact-exporter.js";
import { ArtifactExportError } from "../../src/ports/artifact-exporter.port.js";

function digestTree(root: string, skip: (name: string) => boolean = () => false): string {
  const hash = crypto.createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip(entry.name)) continue;
      const full = path.join(dir, entry.name);
      hash.update(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

describe("Milestone 3.1A — GitArtifactExporter", () => {
  let base: string;
  let workspace: string;
  let artifactRoot: string;
  let exporter: GitArtifactExporter;
  const runId = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-artifact-"));
    workspace = path.join(base, "workspace");
    artifactRoot = path.join(base, "artifacts");
    fs.mkdirSync(workspace);
    fs.mkdirSync(artifactRoot);
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"demo"}\n');
    fs.writeFileSync(path.join(workspace, "src", "index.js"), "module.exports = 1;\nconsole.log('a');\n");
    fs.writeFileSync(path.join(workspace, "src", "old.js"), "to be deleted\n");
    fs.writeFileSync(path.join(workspace, "logo.bin"), Buffer.from([0, 1, 2, 3, 255, 254]));
    fs.writeFileSync(path.join(workspace, ".emerald-owner.json"), "marker");
    exporter = new GitArtifactExporter({ artifactRoot });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const scope = (attempt = 1) => ({ runId, attempt, workspacePath: workspace });
  const artifactDir = (attempt = 1) => path.join(artifactRoot, runId, `attempt-${attempt}`);
  const readManifest = (attempt = 1): ArtifactManifest =>
    JSON.parse(fs.readFileSync(path.join(artifactDir(attempt), "manifest.json"), "utf8")) as ArtifactManifest;

  it("reports an empty artifact when nothing changed", async () => {
    await exporter.captureBaseline(scope());

    const summary = await exporter.exportArtifact({ ...scope(), disposalReason: "Run completed successfully" });

    expect(summary).toMatchObject({ changedFiles: 0, added: 0, modified: 0, deleted: 0, patchBytes: 0 });
    expect(summary.patchSha256).toBe(crypto.createHash("sha256").update("").digest("hex"));
    expect(fs.readFileSync(path.join(artifactDir(), "patch.diff"), "utf8")).toBe("");
    expect(readManifest().disposalReason).toBe("Run completed successfully");
  });

  it("records added, modified, deleted and binary files in the manifest", async () => {
    await exporter.captureBaseline(scope());

    fs.writeFileSync(path.join(workspace, "src", "index.js"), "module.exports = 2;\nconsole.log('a');\nconsole.log('b');\n");
    fs.writeFileSync(path.join(workspace, "src", "new.js"), "exports.x = 1;\n");
    fs.rmSync(path.join(workspace, "src", "old.js"));
    fs.writeFileSync(path.join(workspace, "logo.bin"), Buffer.from([9, 8, 7, 6]));

    const summary = await exporter.exportArtifact(scope());
    const manifest = readManifest();

    expect(summary).toMatchObject({ changedFiles: 4, added: 1, modified: 2, deleted: 1 });
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));
    expect(byPath.get("src/index.js")).toMatchObject({ status: "modified", linesAdded: 2, linesRemoved: 1, binary: false });
    expect(byPath.get("src/new.js")).toMatchObject({ status: "added", linesAdded: 1, linesRemoved: 0 });
    expect(byPath.get("src/old.js")).toMatchObject({ status: "deleted", linesAdded: 0, linesRemoved: 1 });
    expect(byPath.get("logo.bin")).toMatchObject({ status: "modified", binary: true, linesAdded: null });
    expect(manifest.totals).toMatchObject({ changedFiles: 4, added: 1, modified: 2, deleted: 1, linesAdded: 3, linesRemoved: 2 });
    expect(manifest.patch.bytes).toBe(summary.patchBytes);
    expect(manifest.patch.sha256).toBe(summary.patchSha256);
    // The manifest holds no file contents.
    expect(JSON.stringify(manifest)).not.toContain("module.exports");
  });

  it("produces a patch that reproduces the final workspace when applied to the baseline", async () => {
    const replay = path.join(base, "replay");
    copyTree(workspace, replay);
    await exporter.captureBaseline(scope());

    fs.writeFileSync(path.join(workspace, "src", "index.js"), "module.exports = 2;\n");
    fs.writeFileSync(path.join(workspace, "src", "new.js"), "exports.x = 1;\n");
    fs.rmSync(path.join(workspace, "src", "old.js"));
    fs.writeFileSync(path.join(workspace, "logo.bin"), Buffer.from([9, 8, 7, 6]));
    await exporter.exportArtifact(scope());

    // A neutral git configuration, so a developer's global core.autocrlf cannot rewrite line endings.
    execFileSync(
      "git",
      ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", path.join(artifactDir(), "patch.diff")],
      {
        cwd: replay,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }
    );

    const skip = (name: string): boolean => name.startsWith(".emerald-");
    expect(digestTree(replay, skip)).toBe(digestTree(workspace, skip));
  });

  it("never modifies the workspace and never creates a .git inside it", async () => {
    await exporter.captureBaseline(scope());
    fs.writeFileSync(path.join(workspace, "src", "new.js"), "x\n");
    const before = digestTree(workspace);

    await exporter.exportArtifact(scope());

    expect(digestTree(workspace)).toBe(before);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
  });

  it("excludes adapter bookkeeping files even when they change", async () => {
    await exporter.captureBaseline(scope());
    fs.writeFileSync(path.join(workspace, ".emerald-owner.json"), "changed marker");
    fs.writeFileSync(path.join(workspace, ".emerald-workspace.json"), "new metadata");

    const summary = await exporter.exportArtifact(scope());

    expect(summary.changedFiles).toBe(0);
  });

  it("honors the repository's .gitignore (ignored paths are outside the baseline and the patch)", async () => {
    fs.writeFileSync(path.join(workspace, ".gitignore"), "build/\n");
    await exporter.captureBaseline(scope());
    fs.mkdirSync(path.join(workspace, "build"));
    fs.writeFileSync(path.join(workspace, "build", "out.js"), "generated\n");
    fs.writeFileSync(path.join(workspace, "src", "kept.js"), "kept\n");

    await exporter.exportArtifact(scope());

    expect(readManifest().files.map((f) => f.path)).toEqual(["src/kept.js"]);
  });

  it("keeps attempts separate so a retry never overwrites an earlier artifact", async () => {
    await exporter.captureBaseline(scope(1));
    fs.writeFileSync(path.join(workspace, "src", "first.js"), "1\n");
    await exporter.exportArtifact(scope(1));
    const firstPatch = fs.readFileSync(path.join(artifactDir(1), "patch.diff"), "utf8");

    await exporter.captureBaseline(scope(2));
    fs.writeFileSync(path.join(workspace, "src", "second.js"), "2\n");
    await exporter.exportArtifact(scope(2));

    expect(fs.readFileSync(path.join(artifactDir(1), "patch.diff"), "utf8")).toBe(firstPatch);
    expect(readManifest(1).files.map((f) => f.path)).toEqual(["src/first.js"]);
    expect(readManifest(2).files.map((f) => f.path)).toEqual(["src/second.js"]);
  });

  it("fails closed: no baseline, repeated baseline, missing workspace, unsafe run id", async () => {
    await expect(exporter.exportArtifact(scope())).rejects.toMatchObject({ code: "ARTIFACT_EXPORT_FAILED" });

    await exporter.captureBaseline(scope());
    await expect(exporter.captureBaseline(scope())).rejects.toMatchObject({ code: "ARTIFACT_BASELINE_FAILED" });

    fs.rmSync(workspace, { recursive: true, force: true });
    await expect(exporter.exportArtifact(scope())).rejects.toBeInstanceOf(ArtifactExportError);

    await expect(
      exporter.captureBaseline({ runId: "../escape", attempt: 1, workspacePath: base })
    ).rejects.toBeInstanceOf(ArtifactExportError);
    expect(fs.existsSync(path.join(base, "escape"))).toBe(false);
  });
});
