#!/usr/bin/env node
/**
 * Emerald Agent Fabric — Live End-to-End Scenarios CLI (Step 5)
 *
 * Usage:
 *   node bin/run-live-e2e-scenarios.js [--server-url http://127.0.0.1:3000] [--db scratch/e2e-live/state.db]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LiveE2EScenariosRunner } from "../dist/src/application/evaluation/live-e2e-scenarios-runner.js";

async function main() {
  const args = process.argv.slice(2);
  let serverUrl = "http://127.0.0.1:3000";
  let dbPath = "scratch/e2e-live/state.db";
  let evidenceDir = "scratch/e2e-live-evidence";
  let spendCapUsd = 2.0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server-url" && args[i + 1]) {
      serverUrl = args[++i];
    } else if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === "--evidence-dir" && args[i + 1]) {
      evidenceDir = args[++i];
    } else if (args[i] === "--spend-cap" && args[i + 1]) {
      spendCapUsd = parseFloat(args[++i]);
    }
  }

  const runner = new LiveE2EScenariosRunner({
    serverUrl,
    dbPath,
    evidenceDir,
    spendCapUsd,
  });

  const outcome = await runner.runAll();

  const summaryFile = path.resolve(evidenceDir, "e2e-suite-results.json");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(summaryFile, JSON.stringify(outcome, null, 2), "utf8");
  console.log(`\nEvidence manifest written to: ${summaryFile}`);

  if (outcome.failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal E2E suite error:", err);
  process.exit(1);
});
