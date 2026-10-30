import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { ProductionToolGateway } from "../src/tools/production-tools.js";

async function main() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "emerald-edge-repro-"));
  const ws = path.join(tempBase, "test-workspace");
  const sibling = path.join(tempBase, "test-workspace-sibling");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });

  const gateway = new ProductionToolGateway({ evaluateProposal: () => ({ authorized: true }) });

  const testCases = [
    "D:file.txt",
    "D:\\file.txt",
    "D:/file.txt",
    "C:file.txt",
    "..\\outside.txt",
    "../outside.txt",
    "src/app.ts",
    ".",
    "../test-workspace-sibling/secret.txt",
  ];

  console.log("TESTING WORKSPACE:", ws);
  const results: any[] = [];
  for (const tc of testCases) {
    try {
      const res = gateway["resolveSafePath"](tc, ws);
      results.push({ testCase: tc, status: "PERMITTED", resolved: res });
    } catch (err: any) {
      results.push({ testCase: tc, status: "DENIED", error: err.message });
    }
  }

  console.log(JSON.stringify(results, null, 2));

  // Clean up
  fs.rmSync(tempBase, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
