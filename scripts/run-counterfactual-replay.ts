/**
 * Phase 9.4 — Standalone Counterfactual Reflex Replay Runner.
 *
 * Ingests the immutable Phase 9.4B empirical summary artifact:
 *   phase9-4b-summary.json
 *
 * Executes the C1–C8 counterfactual scenarios twice to verify:
 * - Determinism across all scenarios
 * - Authority monotonicity on every replayed decision
 * - Trigger boundaries for failure loops
 * - Input hash sensitivity and state change sensitivity
 * - Distinct failure domains (policy vs execution, schema vs execution)
 * - Fail-closed UNKNOWN outcome handling
 *
 * Writes the separate result artifact:
 *   phase9-4-counterfactual-results.json
 *
 * Invariants:
 * 1. Offline only: Zero model calls, zero tool execution, zero network, zero Docker.
 * 2. Immutable Historical Evidence: Phase 9.4B artifacts are never mutated or overwritten.
 * 3. Strict Credential Firewall: Zero secrets or keys in generated result.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  runAllCounterfactualScenarios,
} from "../src/domain/counterfactual-replay.js";
import {
  FROZEN_RULE_BASED_REFLEX_CONFIG_HASH,
} from "../src/domain/reflex.js";
import {
  assertCredentialBoundary,
} from "../src/domain/evaluation-evidence.js";

async function main() {
  const summaryPath = path.resolve(
    process.env.PHASE9_4B_SUMMARY_PATH ??
      path.resolve(__dirname, "../tests/fixtures/phase9-4b-summary.json")
  );
  const outputPath = path.resolve(
    process.env.PHASE9_4_RESULTS_PATH ??
      path.resolve(__dirname, "../tests/fixtures/phase9-4-counterfactual-results.json")
  );

  console.log("=======================================================");
  console.log("PHASE 9.4: COUNTERFACTUAL REFLEX REPLAY RUNNER");
  console.log("=======================================================");
  console.log(`Source summary artifact: ${summaryPath}`);
  console.log(`Target result artifact:  ${outputPath}`);

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Source artifact not found at ${summaryPath}`);
  }

  const rawSummary = fs.readFileSync(summaryPath, "utf-8");
  const summaryData = JSON.parse(rawSummary);

  console.log(`Loaded empirical trials: ${summaryData.totalCompletedTrials ?? summaryData.records?.length}`);
  console.log(`Frozen Reflex Hash:      ${FROZEN_RULE_BASED_REFLEX_CONFIG_HASH}`);

  const results = await runAllCounterfactualScenarios(summaryData);

  assertCredentialBoundary(results);

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  console.log("\n=======================================================");
  console.log("COUNTERFACTUAL REPLAY RESULTS SUMMARY");
  console.log("=======================================================");
  console.log(`Scenarios evaluated:     ${results.scenarios.length} (C1–C8)`);
  console.log(`Determinism verified:    ${results.determinismVerified}`);
  console.log(`Authority monotonicity:  ${results.authorityMonotonicityVerified}`);
  for (const s of results.scenarios) {
    console.log(`  [${s.scenarioId}] ${s.scenarioName}:`);
    console.log(`    Decisions: [${s.decisionSequence.join(", ")}]`);
    console.log(`    Reasons:   [${s.reasonCodes.join(", ")}]`);
    console.log(`    Triggered: ${s.repetitionTriggered} (step ${s.repetitionTriggerStep ?? "N/A"})`);
  }
  console.log(`\nOutput written to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Counterfactual replay failed:", err);
  process.exit(1);
});
