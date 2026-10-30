import * as path from "node:path";
import { LineAnchoredEditor } from "../src/production/repair/line-anchored-editor.js";

const editor = new LineAnchoredEditor();
const workspace = "C:\\test\\workspace";

console.log("=== Testing LineAnchoredEditor.resolveSafePath ===");

function assertThrows(label: string, fn: () => void) {
  try {
    fn();
    console.error(`FAIL: ${label} did not throw`);
    process.exitCode = 1;
  } catch (err: any) {
    if (err.message.includes("Path traversal denied outside workspace")) {
      console.log(`PASS: ${label} -> caught expected traversal denial: ${err.message}`);
    } else {
      console.error(`FAIL: ${label} -> threw unexpected error: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

function assertResolves(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() === expected.toLowerCase()) {
    console.log(`PASS: ${label} -> ${actual}`);
  } else {
    console.error(`FAIL: ${label} -> expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  }
}

// 1. Valid relative path
assertResolves(
  "Valid in-workspace relative path",
  editor.resolveSafePath("src/index.ts", workspace),
  path.resolve(workspace, "src/index.ts")
);

// 2. Workspace root
assertResolves(
  "Workspace root",
  editor.resolveSafePath(".", workspace),
  path.resolve(workspace)
);

// 3. Sibling prefix collision
assertThrows(
  "Sibling prefix collision (../workspace-evil/file.txt)",
  () => editor.resolveSafePath("../workspace-evil/file.txt", workspace)
);

// 4. Windows drive-relative path
assertThrows(
  "Windows drive-relative path (C:foo/bar.txt)",
  () => editor.resolveSafePath("C:foo/bar.txt", workspace)
);

assertThrows(
  "Windows drive-relative path (D:unqualified.txt)",
  () => editor.resolveSafePath("D:unqualified.txt", workspace)
);

// 5. Absolute path outside workspace
assertThrows(
  "Absolute path outside workspace (D:\\secret.txt)",
  () => editor.resolveSafePath("D:\\secret.txt", workspace)
);

assertThrows(
  "Absolute path on same drive outside workspace (C:\\other\\secret.txt)",
  () => editor.resolveSafePath("C:\\other\\secret.txt", workspace)
);

console.log("All path containment cases verified successfully!");
