import * as path from "node:path";
import { ProductionToolGateway } from "../src/tools/production-tools.js";

async function main() {
  const g = new ProductionToolGateway({ evaluateProposal: () => ({ authorized: true }) });
  const ws = path.resolve("./workspaces/test-workspace");

  // 1. Prefix-sharing sibling path traversal must be denied fail-closed
  let siblingBlocked = false;
  let siblingError = "";
  try {
    // Sibling directory shares prefix 'test-workspace'
    g["resolveSafePath"]("../test-workspace-sibling/secret.txt", ws);
  } catch (err: any) {
    siblingBlocked = Boolean(err.message?.includes("Path traversal denied outside workspace"));
    siblingError = err.message;
  }

  // 2. Normal in-workspace path must be permitted
  let normalPermitted = false;
  try {
    const safe = g["resolveSafePath"]("src/app.ts", ws);
    normalPermitted = safe === path.resolve(ws, "src/app.ts");
  } catch {
    normalPermitted = false;
  }

  // 3. Workspace root itself must be permitted
  let rootPermitted = false;
  try {
    const safe = g["resolveSafePath"](".", ws);
    rootPermitted = safe === ws;
  } catch {
    rootPermitted = false;
  }

  const ok = siblingBlocked && normalPermitted && rootPermitted;
  console.log(
    JSON.stringify({
      ok,
      siblingBlocked,
      siblingError,
      normalPermitted,
      rootPermitted,
    }),
  );

  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
