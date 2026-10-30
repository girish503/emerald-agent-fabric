import * as fs from "node:fs";
import * as path from "node:path";
import { ProductionToolGateway } from "../src/tools/production-tools.js";

async function main() {
  const repoRoot = path.resolve(".");
  const g = new ProductionToolGateway({ evaluateProposal: () => ({ authorized: true }) });

  // 1. Directory write should be rejected cleanly with domain error
  const dirRes = await g.executeTool("write_file", { path: "src", content: "test" }, { workspacePath: repoRoot });

  // 2. Normal file write should succeed
  const testFile = "scratch/task-d-probe.txt";
  const fileRes = await g.executeTool("write_file", { path: testFile, content: "task-d-verified" }, { workspacePath: repoRoot });

  let fileContentMatches = false;
  const absTestFile = path.resolve(repoRoot, testFile);
  if (fs.existsSync(absTestFile)) {
    fileContentMatches = fs.readFileSync(absTestFile, "utf8") === "task-d-verified";
    try {
      fs.unlinkSync(absTestFile);
    } catch {
      // Ignore cleanup
    }
  }

  const directoryCleanlyRejected =
    !dirRes.success && Boolean(dirRes.error?.includes("Target path is not a regular file"));
  const normalWriteSucceeded = Boolean(fileRes.success) && fileContentMatches;

  console.log(
    JSON.stringify({
      directoryCleanlyRejected,
      normalWriteSucceeded,
      dirError: dirRes.error,
      fileSuccess: fileRes.success,
    }),
  );

  if (!directoryCleanlyRejected || !normalWriteSucceeded) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
