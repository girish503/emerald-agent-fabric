#!/usr/bin/env node

/**
 * Emerald Agent Fabric — Executable CLI Entrypoint
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist/src/cli/emerald-cli.js");

async function main() {
  if (!fs.existsSync(distPath)) {
    console.error("Error: Emerald CLI distribution build not found.");
    console.error("Please run 'npm run build' before executing the emerald CLI.");
    process.exit(1);
  }

  const { EmeraldCli } = await import(pathToFileURL(distPath).href);
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
