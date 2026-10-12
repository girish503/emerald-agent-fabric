/**
 * Test helper for constructing authentic Git repositories directly in-memory and on disk
 * without spawning any external processes or shell commands.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

export interface MockRepoFile {
  path: string;
  content: string;
}

export async function createMockGitRepository(
  workspaceHostPath: string,
  committedFiles: MockRepoFile[]
): Promise<{ commitSha: string; fileBlobShas: Map<string, string> }> {
  const gitDir = path.join(workspaceHostPath, ".git");
  const objectsDir = path.join(gitDir, "objects");
  const refsDir = path.join(gitDir, "refs", "heads");

  await fs.mkdir(objectsDir, { recursive: true });
  await fs.mkdir(refsDir, { recursive: true });

  const fileBlobShas = new Map<string, string>();

  // 1. Write blobs
  for (const file of committedFiles) {
    const contentBuf = Buffer.from(file.content, "utf8");
    const header = Buffer.from(`blob ${contentBuf.length}\0`, "utf8");
    const sha = crypto
      .createHash("sha1")
      .update(header)
      .update(contentBuf)
      .digest("hex");

    fileBlobShas.set(file.path, sha);
    await writeLooseObject(gitDir, sha, Buffer.concat([header, contentBuf]));

    // Also write to working tree
    const targetPath = path.join(workspaceHostPath, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }

  // 2. Build tree object
  const treeEntries: Buffer[] = [];
  const sortedFiles = [...committedFiles].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const sha = fileBlobShas.get(file.path)!;
    const shaBuf = Buffer.from(sha, "hex");
    const entryHeader = Buffer.from(`100644 ${file.path}\0`, "utf8");
    treeEntries.push(Buffer.concat([entryHeader, shaBuf]));
  }

  const treeData = Buffer.concat(treeEntries);
  const treeHeader = Buffer.from(`tree ${treeData.length}\0`, "utf8");
  const treeSha = crypto
    .createHash("sha1")
    .update(treeHeader)
    .update(treeData)
    .digest("hex");

  await writeLooseObject(gitDir, treeSha, Buffer.concat([treeHeader, treeData]));

  // 3. Build commit object
  const commitBody = [
    `tree ${treeSha}`,
    `author Test Author <test@emerald.internal> 1700000000 +0000`,
    `committer Test Author <test@emerald.internal> 1700000000 +0000`,
    ``,
    `Initial test commit`,
    ``,
  ].join("\n");

  const commitData = Buffer.from(commitBody, "utf8");
  const commitHeader = Buffer.from(`commit ${commitData.length}\0`, "utf8");
  const commitSha = crypto
    .createHash("sha1")
    .update(commitHeader)
    .update(commitData)
    .digest("hex");

  await writeLooseObject(gitDir, commitSha, Buffer.concat([commitHeader, commitData]));

  // 4. Write HEAD and branch ref
  await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await fs.writeFile(path.join(refsDir, "main"), `${commitSha}\n`, "utf8");

  // 5. Write binary .git/index file
  await writeMockIndex(gitDir, sortedFiles, fileBlobShas);

  return { commitSha, fileBlobShas };
}

async function writeLooseObject(
  gitDir: string,
  sha: string,
  rawPayload: Buffer
): Promise<void> {
  const prefix = sha.slice(0, 2);
  const rest = sha.slice(2);
  const dir = path.join(gitDir, "objects", prefix);
  await fs.mkdir(dir, { recursive: true });

  const compressed = zlib.deflateSync(rawPayload);
  await fs.writeFile(path.join(dir, rest), compressed);
}

async function writeMockIndex(
  gitDir: string,
  files: MockRepoFile[],
  fileBlobShas: Map<string, string>
): Promise<void> {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, 4, "ascii");
  header.writeUInt32BE(2, 4); // version 2
  header.writeUInt32BE(files.length, 8); // count

  const entries: Buffer[] = [];

  for (const file of files) {
    const sha = fileBlobShas.get(file.path)!;
    const pathBuf = Buffer.from(file.path, "utf8");

    // Stat data: 40 bytes
    const statBuf = Buffer.alloc(40);
    // sha: 20 bytes
    const shaBuf = Buffer.from(sha, "hex");
    // flags: 2 bytes (stage 0, path len)
    const flagsBuf = Buffer.alloc(2);
    flagsBuf.writeUInt16BE(Math.min(0xfff, pathBuf.length), 0);

    const fixedLen = 40 + 20 + 2; // 62 bytes
    const pathAndNull = Buffer.concat([pathBuf, Buffer.from([0])]);
    const totalBeforePad = fixedLen + pathAndNull.length;
    const padLen = (8 - (totalBeforePad % 8)) % 8;
    const padding = Buffer.alloc(padLen, 0);

    const entry = Buffer.concat([statBuf, shaBuf, flagsBuf, pathAndNull, padding]);
    entries.push(entry);
  }

  const indexBuf = Buffer.concat([header, ...entries]);
  // Compute and append SHA-1 checksum of index buffer
  const checksum = crypto.createHash("sha1").update(indexBuf).digest();
  await fs.writeFile(path.join(gitDir, "index"), Buffer.concat([indexBuf, checksum]));
}
