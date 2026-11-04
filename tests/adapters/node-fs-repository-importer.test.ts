/**
 * Milestone 3.0A — Repository import into a run workspace (adapter)
 *
 * Verifies NodeFsRepositoryImporter copies a COPY of a host repository safely and fails closed:
 * containment, exclusions, symlink handling, limits enforced before any copy, and an untouched source.
 *
 * Explicit limits (not proven here, by design):
 * - The import is a snapshot; changes to the source after the copy are not observed.
 * - Secret-file exclusion is name-based and conservative; it does not scan file contents.
 * - Symlink coverage runs only where the host permits creating symlinks (otherwise those tests are skipped).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NodeFsRepositoryImporter,
  isLikelySecretFileName,
} from "../../src/adapters/workspace/node-fs-repository-importer.js";
import { RepositoryImportError } from "../../src/ports/repository-importer.port.js";

function probe(make: (dir: string) => void): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-link-probe-"));
  try {
    make(dir);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function canCreateFileSymlinks(): boolean {
  return probe((dir) => {
    fs.writeFileSync(path.join(dir, "target.txt"), "x");
    fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"));
  });
}

/** Directory junctions need no privilege on Windows; plain directory symlinks cover POSIX. */
function canCreateDirectoryLinks(): boolean {
  return probe((dir) => {
    fs.mkdirSync(path.join(dir, "target"));
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "junction");
  });
}

const FILE_SYMLINKS_SUPPORTED = canCreateFileSymlinks();
const DIRECTORY_LINKS_SUPPORTED = canCreateDirectoryLinks();

/** A stable digest of every file path and content under a directory. */
function digestTree(root: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      hash.update(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

describe("Milestone 3.0A — NodeFsRepositoryImporter", () => {
  let base: string;
  let source: string;
  let dest: string;
  const importer = new NodeFsRepositoryImporter();

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-import-"));
    source = path.join(base, "repo");
    dest = path.join(base, "workspace");
    fs.mkdirSync(source);
    fs.mkdirSync(dest);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(source, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("copies files and nested directories and reports an accurate summary", async () => {
    write("package.json", '{"name":"demo"}');
    write("src/index.js", "module.exports = 1;\n");
    write("src/lib/util.js", "exports.x = 2;\n");

    const summary = await importer.importRepository(source, dest);

    expect(listTree(dest)).toEqual(["package.json", "src/index.js", "src/lib/util.js"]);
    expect(fs.readFileSync(path.join(dest, "src/lib/util.js"), "utf8")).toBe("exports.x = 2;\n");
    expect(summary).toMatchObject({
      fileCount: 3,
      skippedSymlinks: 0,
      skippedSpecialFiles: 0,
      excludedEntries: 0,
      oversizeSkipped: 0,
    });
    expect(summary.totalBytes).toBe(
      Buffer.byteLength('{"name":"demo"}') +
        Buffer.byteLength("module.exports = 1;\n") +
        Buffer.byteLength("exports.x = 2;\n")
    );
  });

  it("never modifies the source repository", async () => {
    write("a.txt", "alpha");
    write("dir/b.txt", "beta");
    const before = digestTree(source);

    await importer.importRepository(source, dest);

    expect(digestTree(source)).toBe(before);
  });

  it("excludes VCS metadata, dependency directories and likely secret files, and counts them", async () => {
    write("keep.js", "ok");
    write(".git/config", "[core]");
    write("node_modules/dep/index.js", "dep");
    write(".env", "TOKEN=secret");
    write(".env.production", "TOKEN=secret");
    write(".env.example", "TOKEN=");
    write("certs/server.pem", "-----BEGIN-----");
    write("id_rsa", "private");
    write(".npmrc", "//registry:_authToken=secret");
    write(".emerald-workspace.json", "would collide with adapter metadata");

    const summary = await importer.importRepository(source, dest);

    expect(listTree(dest)).toEqual([".env.example", "keep.js"]);
    // .git, node_modules, .env, .env.production, server.pem, id_rsa, .npmrc, .emerald-workspace.json
    expect(summary.excludedEntries).toBe(8);
    expect(summary.fileCount).toBe(2);
  });

  it("recognizes secret-looking names without flagging ordinary files", () => {
    for (const name of [".env", ".ENV", ".env.local", "key.pem", "cert.PFX", "id_ed25519", ".netrc"]) {
      expect(isLikelySecretFileName(name), name).toBe(true);
    }
    for (const name of [".env.example", ".env.sample", ".env.template", "environment.md", "keyboard.js", "index.js"]) {
      expect(isLikelySecretFileName(name), name).toBe(false);
    }
  });

  it("skips files over the per-file limit and counts them", async () => {
    write("small.txt", "tiny");
    write("big.bin", "x".repeat(64));

    const summary = await importer.importRepository(source, dest, { maxFileBytes: 16 });

    expect(listTree(dest)).toEqual(["small.txt"]);
    expect(summary.oversizeSkipped).toBe(1);
    expect(summary.fileCount).toBe(1);
  });

  it("fails closed on the file-count limit before copying anything", async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`, "x");

    await expect(importer.importRepository(source, dest, { maxFiles: 3 })).rejects.toMatchObject({
      name: "RepositoryImportError",
      code: "LIMIT_EXCEEDED",
    });
    expect(listTree(dest)).toEqual([]);
  });

  it("fails closed on the total-size limit before copying anything", async () => {
    write("a.txt", "x".repeat(40));
    write("b.txt", "x".repeat(40));

    await expect(importer.importRepository(source, dest, { maxTotalBytes: 50 })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(listTree(dest)).toEqual([]);
  });

  it("rejects a relative source path", async () => {
    await expect(importer.importRepository("relative/repo", dest)).rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });

  it("rejects a missing source and a source that is a file", async () => {
    await expect(importer.importRepository(path.join(base, "nope"), dest)).rejects.toMatchObject({
      code: "SOURCE_INVALID",
    });
    write("single.txt", "x");
    await expect(importer.importRepository(path.join(source, "single.txt"), dest)).rejects.toMatchObject({
      code: "SOURCE_INVALID",
    });
  });

  it("rejects a non-empty destination but tolerates the workspace adapter's own files", async () => {
    write("a.txt", "x");
    fs.writeFileSync(path.join(dest, ".emerald-owner.json"), "marker");
    fs.writeFileSync(path.join(dest, ".emerald-workspace.json"), "metadata");
    await expect(importer.importRepository(source, dest)).resolves.toMatchObject({ fileCount: 1 });

    const dirty = path.join(base, "dirty");
    fs.mkdirSync(dirty);
    fs.writeFileSync(path.join(dirty, "stray.txt"), "x");
    await expect(importer.importRepository(source, dirty)).rejects.toMatchObject({ code: "DESTINATION_INVALID" });
  });

  it("rejects overlapping source and destination in both directions", async () => {
    write("a.txt", "x");
    const nestedDest = path.join(source, "workspace");
    fs.mkdirSync(nestedDest);
    await expect(importer.importRepository(source, nestedDest)).rejects.toMatchObject({ code: "OVERLAPPING_PATHS" });

    const outerDest = base;
    const innerSource = path.join(base, "repo");
    await expect(importer.importRepository(innerSource, outerDest)).rejects.toBeInstanceOf(RepositoryImportError);
  });

  it("is deterministic: importing the same repository twice yields identical summaries and trees", async () => {
    write("a.txt", "alpha");
    write("dir/b.txt", "beta");
    const dest2 = path.join(base, "workspace2");
    fs.mkdirSync(dest2);

    const first = await importer.importRepository(source, dest);
    const second = await importer.importRepository(source, dest2);

    expect(second).toEqual(first);
    expect(digestTree(dest2)).toBe(digestTree(dest));
  });

  it.skipIf(!FILE_SYMLINKS_SUPPORTED)("never follows or copies symbolic links to files", async () => {
    const outside = path.join(base, "outside-secret.txt");
    fs.writeFileSync(outside, "do not copy");
    write("real.txt", "real");
    fs.symlinkSync(outside, path.join(source, "link-to-file.txt"));

    const summary = await importer.importRepository(source, dest);

    expect(listTree(dest)).toEqual(["real.txt"]);
    expect(summary.skippedSymlinks).toBe(1);
    expect(fs.existsSync(path.join(dest, "link-to-file.txt"))).toBe(false);
  });

  it.skipIf(!DIRECTORY_LINKS_SUPPORTED)("never follows or copies links to directories outside the repository", async () => {
    write("real.txt", "real");
    const outsideDir = path.join(base, "outside-dir");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "do not copy");
    fs.symlinkSync(outsideDir, path.join(source, "link-to-dir"), "junction");

    const summary = await importer.importRepository(source, dest);

    expect(listTree(dest)).toEqual(["real.txt"]);
    expect(summary.skippedSymlinks).toBe(1);
    expect(fs.existsSync(path.join(dest, "link-to-dir"))).toBe(false);
  });
});
