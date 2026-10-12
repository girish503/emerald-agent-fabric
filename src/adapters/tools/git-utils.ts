/**
 * In-process Git utilities for Emerald Agent Fabric.
 *
 * Implements pure TypeScript Git repository inspection and unified diff generation
 * without spawning any external processes or shell commands.
 *
 * Security & Governance Invariants:
 * 1. Zero Subprocesses: NO child_process, NO exec, NO spawn, NO shell commands.
 * 2. Zero Docker/Provider Invocations: Pure in-process filesystem operations.
 * 3. Bounded Memory & Execution: Safe limits on object expansion and recursive traversal.
 * 4. Deterministic Output: Forward slashes, alphabetical path ordering, reproducible digests.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

export interface GitIndexEntry {
  readonly sha: string;
  readonly stage: number;
  readonly size: number;
}

export interface DiffResult {
  readonly diff: string;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Searches for a .git directory starting from targetPath and walking upwards to workspaceRoot.
 * Returns the absolute host path to the .git directory, or null if not found.
 */
export async function findGitDir(
  workspaceRoot: string,
  targetPath: string
): Promise<string | null> {
  const normWorkspaceRoot = path.resolve(workspaceRoot);
  let currentDir = path.resolve(targetPath);

  // Ensure currentDir is within workspaceRoot
  if (
    currentDir !== normWorkspaceRoot &&
    !currentDir.startsWith(normWorkspaceRoot + path.sep)
  ) {
    currentDir = normWorkspaceRoot;
  }

  while (true) {
    const candidateGit = path.join(currentDir, ".git");
    try {
      const stats = await fs.lstat(candidateGit);
      if (stats.isDirectory()) {
        return candidateGit;
      }
      if (stats.isFile()) {
        // Handle gitdir file (e.g. git worktrees or submodules)
        const content = await fs.readFile(candidateGit, "utf8");
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match && match[1]) {
          const rawGitDir = match[1].trim();
          const resolvedGitDir = path.isAbsolute(rawGitDir)
            ? path.resolve(rawGitDir)
            : path.resolve(currentDir, rawGitDir);

          // Verify it is contained within workspaceRoot
          if (
            resolvedGitDir === normWorkspaceRoot ||
            resolvedGitDir.startsWith(normWorkspaceRoot + path.sep)
          ) {
            const gitDirStat = await fs.stat(resolvedGitDir);
            if (gitDirStat.isDirectory()) {
              return resolvedGitDir;
            }
          }
        }
      }
    } catch {
      // Continue search upwards
    }

    if (currentDir === normWorkspaceRoot) {
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Resolves the HEAD commit SHA-1 from .git directory.
 * Returns 40-char hex commit hash, or null if repo is empty or ref is missing.
 */
export async function getHeadCommit(gitDir: string): Promise<string | null> {
  const headPath = path.join(gitDir, "HEAD");
  let headContent: string;
  try {
    headContent = (await fs.readFile(headPath, "utf8")).trim();
  } catch {
    return null;
  }

  // Direct commit hash (detached HEAD)
  if (/^[0-9a-f]{40}$/i.test(headContent)) {
    return headContent.toLowerCase();
  }

  // Symbolic ref: "ref: refs/heads/main"
  const refMatch = headContent.match(/^ref:\s*(.+)$/);
  if (!refMatch || !refMatch[1]) {
    return null;
  }
  const refPath = refMatch[1].trim();

  // 1. Try loose ref file
  const looseRefPath = path.join(gitDir, refPath);
  try {
    const looseSha = (await fs.readFile(looseRefPath, "utf8")).trim();
    if (/^[0-9a-f]{40}$/i.test(looseSha)) {
      return looseSha.toLowerCase();
    }
  } catch {
    // Loose ref not found; check packed-refs
  }

  // 2. Try packed-refs
  const packedRefsPath = path.join(gitDir, "packed-refs");
  try {
    const packedContent = await fs.readFile(packedRefsPath, "utf8");
    const lines = packedContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith("^") || !trimmed) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[1] === refPath) {
        const sha = parts[0]!;
        if (/^[0-9a-f]{40}$/i.test(sha)) {
          return sha.toLowerCase();
        }
      }
    }
  } catch {
    // packed-refs not found
  }

  return null;
}

/**
 * Parses binary .git/index file format (v2 and v3).
 */
export async function readGitIndex(
  gitDir: string
): Promise<Map<string, GitIndexEntry>> {
  const indexMap = new Map<string, GitIndexEntry>();
  const indexPath = path.join(gitDir, "index");

  let buf: Buffer;
  try {
    buf = await fs.readFile(indexPath);
  } catch {
    return indexMap; // Index does not exist (empty or clean state)
  }

  if (buf.length < 12) {
    return indexMap;
  }

  // Header: "DIRC" + version (4 bytes) + entryCount (4 bytes)
  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== "DIRC") {
    return indexMap;
  }

  const version = buf.readUInt32BE(4);
  const entryCount = buf.readUInt32BE(8);

  let offset = 12;
  for (let i = 0; i < entryCount && offset < buf.length - 20; i++) {
    const entryStart = offset;
    if (offset + 62 > buf.length) {
      break;
    }

    const size = buf.readUInt32BE(offset + 36);
    const sha = buf.subarray(offset + 40, offset + 60).toString("hex").toLowerCase();
    const flags = buf.readUInt16BE(offset + 60);

    const stage = (flags >> 12) & 3;
    const isExtended = version >= 3 && (flags & 0x4000) !== 0;

    let headerLen = 62;
    if (isExtended) {
      headerLen = 64;
    }

    const pathStart = offset + headerLen;
    let pathEnd = pathStart;
    while (pathEnd < buf.length && buf[pathEnd] !== 0) {
      pathEnd++;
    }

    const relPath = buf.subarray(pathStart, pathEnd).toString("utf8").replace(/\\/g, "/");

    // Advance past path and padding to 8-byte boundary relative to entry start
    offset = pathEnd + 1;
    while ((offset - entryStart) % 8 !== 0 && offset < buf.length) {
      offset++;
    }

    indexMap.set(relPath, { sha, stage, size });
  }

  return indexMap;
}

/**
 * Computes standard Git blob SHA-1 hash for a buffer or string:
 * sha1("blob " + length + "\0" + content)
 */
export function computeGitBlobSha1(content: Buffer | string): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${buf.length}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(buf).digest("hex").toLowerCase();
}

/**
 * Reads a loose git object from .git/objects/xx/yy...
 */
export async function readGitObject(
  gitDir: string,
  sha: string
): Promise<{ type: string; data: Buffer } | null> {
  const normSha = sha.toLowerCase();
  const prefix = normSha.slice(0, 2);
  const rest = normSha.slice(2);
  const loosePath = path.join(gitDir, "objects", prefix, rest);

  try {
    const compressed = await fs.readFile(loosePath);
    const decompressed = zlib.inflateSync(compressed);
    const nullIdx = decompressed.indexOf(0);
    if (nullIdx === -1) return null;

    const header = decompressed.subarray(0, nullIdx).toString("utf8");
    const [type] = header.split(" ");
    const data = decompressed.subarray(nullIdx + 1);

    return { type: type ?? "", data };
  } catch {
    // Loose object not found; try pack files
    return readPackedObject(gitDir, normSha);
  }
}

/**
 * Reads an object from Git pack files (.git/objects/pack/*.pack).
 */
async function readPackedObject(
  gitDir: string,
  targetSha: string
): Promise<{ type: string; data: Buffer } | null> {
  const packDir = path.join(gitDir, "objects", "pack");
  let entries: string[];
  try {
    entries = await fs.readdir(packDir);
  } catch {
    return null;
  }

  const idxFiles = entries.filter((e) => e.endsWith(".idx"));
  const targetBuffer = Buffer.from(targetSha, "hex");

  for (const idxFile of idxFiles) {
    try {
      const idxPath = path.join(packDir, idxFile);
      const packPath = path.join(packDir, idxFile.replace(/\.idx$/, ".pack"));
      const idxBuf = await fs.readFile(idxPath);

      if (idxBuf.length < 1032) continue;
      // Check magic \xfftOc and version 2
      if (
        idxBuf[0] !== 0xff ||
        idxBuf[1] !== 0x74 ||
        idxBuf[2] !== 0x4f ||
        idxBuf[3] !== 0x63 ||
        idxBuf.readUInt32BE(4) !== 2
      ) {
        continue;
      }

      // Fanout table
      const totalObjects = idxBuf.readUInt32BE(8 + 255 * 4);
      const firstByte = targetBuffer[0]!;
      const lowIdx = firstByte === 0 ? 0 : idxBuf.readUInt32BE(8 + (firstByte - 1) * 4);
      const highIdx = idxBuf.readUInt32BE(8 + firstByte * 4);

      // Binary search in sorted SHA table
      const shaTableOffset = 1032;
      let left = lowIdx;
      let right = highIdx - 1;
      let foundIdx = -1;

      while (left <= right) {
        const mid = (left + right) >> 1;
        const entryShaBuf = idxBuf.subarray(shaTableOffset + mid * 20, shaTableOffset + mid * 20 + 20);
        const cmp = entryShaBuf.compare(targetBuffer);
        if (cmp === 0) {
          foundIdx = mid;
          break;
        } else if (cmp < 0) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }

      if (foundIdx === -1) continue;

      // Read offset from offset table
      const offsetTableStart = 1032 + 24 * totalObjects;
      const rawOffset = idxBuf.readUInt32BE(offsetTableStart + foundIdx * 4);
      let packOffset = rawOffset;

      if ((rawOffset & 0x80000000) !== 0) {
        // Extended 8-byte offset
        const extendedOffsetTableStart = 1032 + 28 * totalObjects;
        const extIdx = rawOffset & 0x7fffffff;
        packOffset = Number(idxBuf.readBigUInt64BE(extendedOffsetTableStart + extIdx * 8));
      }

      // Read from .pack file at packOffset
      const packFd = await fs.open(packPath, "r");
      try {
        const headerBuf = Buffer.alloc(32);
        await packFd.read(headerBuf, 0, 32, packOffset);

        let byte = headerBuf[0]!;
        const typeNum = (byte >> 4) & 7;
        let cOffset = 1;
        while ((byte & 0x80) !== 0 && cOffset < headerBuf.length) {
          byte = headerBuf[cOffset++]!;
        }

        const dataStart = packOffset + cOffset;
        const packStats = await packFd.stat();
        const readLen = Math.min(1024 * 1024, packStats.size - dataStart);
        const compressedBuf = Buffer.alloc(readLen);
        await packFd.read(compressedBuf, 0, readLen, dataStart);

        const decompressed = zlib.inflateSync(compressedBuf);
        let typeName = "unknown";
        if (typeNum === 1) typeName = "commit";
        else if (typeNum === 2) typeName = "tree";
        else if (typeNum === 3) typeName = "blob";
        else if (typeNum === 4) typeName = "tag";

        return { type: typeName, data: decompressed };
      } finally {
        await packFd.close();
      }
    } catch {
      // Ignore pack reading failure and try next pack
    }
  }

  return null;
}

/**
 * Recursively parses a tree object and builds a map of relative path -> blob SHA-1.
 */
export async function readTreeFiles(
  gitDir: string,
  treeSha: string,
  prefix = ""
): Promise<Map<string, string>> {
  const fileMap = new Map<string, string>();
  const treeObj = await readGitObject(gitDir, treeSha);
  if (!treeObj || treeObj.type !== "tree") {
    return fileMap;
  }

  const buf = treeObj.data;
  let offset = 0;

  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(0x20, offset); // space
    if (spaceIdx === -1) break;
    const modeStr = buf.subarray(offset, spaceIdx).toString("ascii");

    const nullIdx = buf.indexOf(0, spaceIdx);
    if (nullIdx === -1) break;
    const name = buf.subarray(spaceIdx + 1, nullIdx).toString("utf8");

    const shaOffset = nullIdx + 1;
    if (shaOffset + 20 > buf.length) break;
    const sha = buf.subarray(shaOffset, shaOffset + 20).toString("hex").toLowerCase();
    offset = shaOffset + 20;

    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (modeStr === "40000" || modeStr === "040000") {
      // Subtree / directory
      const subMap = await readTreeFiles(gitDir, sha, fullPath);
      for (const [subPath, subSha] of subMap.entries()) {
        fileMap.set(subPath, subSha);
      }
    } else {
      // File / blob
      fileMap.set(fullPath, sha);
    }
  }

  return fileMap;
}

/**
 * Resolves the tree object from a commit SHA-1 and returns all file paths and their blob hashes.
 */
export async function getCommitFiles(
  gitDir: string,
  commitSha: string
): Promise<Map<string, string>> {
  const commitObj = await readGitObject(gitDir, commitSha);
  if (!commitObj || commitObj.type !== "commit") {
    return new Map();
  }

  const text = commitObj.data.toString("utf8");
  const treeMatch = text.match(/^tree\s+([0-9a-f]{40})/m);
  if (!treeMatch || !treeMatch[1]) {
    return new Map();
  }

  return readTreeFiles(gitDir, treeMatch[1]);
}

/**
 * Scans working tree files, computing standard Git blob hashes.
 */
export async function scanWorkingTreeFiles(
  workspaceRoot: string,
  filterSubPath?: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const fileMap = new Map<string, string>();
  const baseDir = filterSubPath
    ? path.resolve(workspaceRoot, filterSubPath)
    : path.resolve(workspaceRoot);

  const walk = async (currentDir: string): Promise<void> => {
    if (signal?.aborted) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (signal?.aborted) return;
      if (
        entry.name === ".git" ||
        entry.name === ".emerald-workspace.json" ||
        entry.name.startsWith(".tmp.")
      ) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(fullPath);
          const sha = computeGitBlobSha1(content);
          const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");
          fileMap.set(relPath, sha);
        } catch {
          // Ignore unreadable files
        }
      }
    }
  };

  await walk(baseDir);
  return fileMap;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Generates unified diff for a single file between oldText and newText.
 */
export function generateUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string,
  isDeleted = false,
  isNew = false
): DiffResult {
  const normFile = filePath.replace(/\\/g, "/");

  if (isNew) {
    const lines = splitLines(newText);
    if (lines.length === 0) {
      return { diff: "", insertions: 0, deletions: 0 };
    }
    const diff = [
      `diff --git a/${normFile} b/${normFile}`,
      `new file mode 100644`,
      `--- /dev/null`,
      `+++ b/${normFile}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join("\n");
    return { diff, insertions: lines.length, deletions: 0 };
  }

  if (isDeleted) {
    const lines = splitLines(oldText);
    if (lines.length === 0) {
      return { diff: "", insertions: 0, deletions: 0 };
    }
    const diff = [
      `diff --git a/${normFile} b/${normFile}`,
      `deleted file mode 100644`,
      `--- a/${normFile}`,
      `+++ /dev/null`,
      `@@ -1,${lines.length} +0,0 @@`,
      ...lines.map((l) => `-${l}`),
    ].join("\n");
    return { diff, insertions: 0, deletions: lines.length };
  }

  if (oldText === newText) {
    return { diff: "", insertions: 0, deletions: 0 };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // Compute Myers-style / LCS edit script
  const edits = computeLcsEdits(oldLines, newLines);
  if (edits.length === 0) {
    return { diff: "", insertions: 0, deletions: 0 };
  }

  let insertions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === "insert") insertions++;
    else if (edit.type === "delete") deletions++;
  }

  // Format into standard unified diff
  const diffLines = [
    `diff --git a/${normFile} b/${normFile}`,
    `--- a/${normFile}`,
    `+++ b/${normFile}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  for (const edit of edits) {
    if (edit.type === "equal") {
      diffLines.push(` ${edit.line}`);
    } else if (edit.type === "delete") {
      diffLines.push(`-${edit.line}`);
    } else if (edit.type === "insert") {
      diffLines.push(`+${edit.line}`);
    }
  }

  return {
    diff: diffLines.join("\n"),
    insertions,
    deletions,
  };
}

interface EditOp {
  readonly type: "equal" | "delete" | "insert";
  readonly line: string;
}

/**
 * Pure LCS algorithm producing edit operations.
 */
function computeLcsEdits(oldLines: string[], newLines: string[]): EditOp[] {
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, limit table size to avoid high memory allocation
  if (m * n > 2_000_000) {
    // Fast fallback: mark all old as deleted and all new as inserted
    const fallback: EditOp[] = [];
    for (const l of oldLines) fallback.push({ type: "delete", line: l });
    for (const l of newLines) fallback.push({ type: "insert", line: l });
    return fallback;
  }

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Backtrack
  const ops: EditOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "equal", line: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: "insert", line: newLines[j - 1]! });
      j--;
    } else if (i > 0) {
      ops.push({ type: "delete", line: oldLines[i - 1]! });
      i--;
    }
  }

  return ops.reverse();
}
