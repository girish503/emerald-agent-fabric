#!/usr/bin/env node

/**
 * Emerald Agent Fabric — CLI Executable Runner
 */

import { EmeraldCli } from "./emerald-cli.js";

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
