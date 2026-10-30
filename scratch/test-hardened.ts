import * as path from "node:path";

function resolveSafePath(filePath: string, workspacePath: string): string {
  // Reject Windows drive-relative paths (e.g. 'C:file.txt', 'D:dir/file.txt') fail-closed
  if (/^[a-zA-Z]:(?![\/\\])/.test(filePath)) {
    throw new Error(`Path traversal denied outside workspace: ${filePath}`);
  }

  const normalized = path.normalize(filePath);
  const resolved = path.resolve(workspacePath, normalized);
  const normResolved = resolved.replace(/\\/g, "/").toLowerCase();
  const normBase = path.resolve(workspacePath).replace(/\\/g, "/").toLowerCase();
  const normBaseWithSlash = normBase.endsWith("/") ? normBase : normBase + "/";
  if (normResolved !== normBase && !normResolved.startsWith(normBaseWithSlash)) {
    throw new Error(`Path traversal denied outside workspace: ${filePath}`);
  }
  return resolved;
}

const ws = "C:\\Users\\Test\\workspace";
const testCases = [
  "D:file.txt",
  "D:\\file.txt",
  "D:/file.txt",
  "C:file.txt",
  "C:sub/file.txt",
  "C:\\Users\\Test\\workspace\\sub\\file.txt",
  "C:/Users/Test/workspace/sub/file.txt",
  "..\\outside.txt",
  "../outside.txt",
  "src/app.ts",
  "./src/app.ts",
  "src/../src/app.ts",
  ".",
  "../workspace-sibling/secret.txt",
];

for (const tc of testCases) {
  try {
    const res = resolveSafePath(tc, ws);
    console.log("[PERMITTED]", tc, "->", res);
  } catch (err: any) {
    console.log("[DENIED]", tc, "->", err.message);
  }
}
