#!/usr/bin/env node

/**
 * Emerald Agent Fabric — Executable CLI Entrypoint
 */

import { EmeraldCli } from "../dist/src/cli/emerald-cli.js";

async function main() {
  const cli = new EmeraldCli();
  const args = process.argv.slice(2);
  const result = await cli.run(args);
  if (result.output) {
    console.log(result.output);
  }
  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
