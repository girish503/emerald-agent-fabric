/**
 * Verification Script: Production Prompt Contract Alignment for read_file
 *
 * Verifies that BenchmarkManifestLoader.buildUntrustedPromptForModel generates the
 * canonical read_file tool contract ({"path": string}) and that local qwen2.5-coder:3b
 * produces a 100% valid proposal without extraneous keys.
 */

import { BenchmarkManifestLoader } from "../src/production/benchmark/benchmark-manifest.js";
import { CalibrationManifestLoader } from "../src/production/benchmark/calibration-manifest.js";
import { OllamaModelAdapter } from "../src/production/benchmark/ollama-model-adapter.js";
import { validateStructuredProposal } from "../src/production/adapter/structured-proposal-schema.js";

async function main() {
  const bLoader = new BenchmarkManifestLoader();
  const cLoader = new CalibrationManifestLoader();

  const bTask = bLoader.loadManifest().tasks[0]!;
  const cTask = cLoader.loadManifest().tasks[0]!;

  const bPrompt = bLoader.buildUntrustedPromptForModel(bTask, { lineAnchoredEditingEnabled: true });
  const cPrompt = cLoader.buildUntrustedPromptForModel(cTask, { lineAnchoredEditingEnabled: true });

  console.log("[VERIFY PROMPT BUILDER] Checking prompt text for canonical read_file contract...");

  if (bPrompt.includes("offsetLine") || bPrompt.includes("limitLines")) {
    throw new Error("Benchmark prompt still contains offsetLine or limitLines!");
  }
  if (!bPrompt.includes('- read_file: inspect file contents ({"path": string})')) {
    throw new Error("Benchmark prompt does not contain canonical read_file contract!");
  }

  if (cPrompt.includes("offsetLine") || cPrompt.includes("limitLines")) {
    throw new Error("Calibration prompt still contains offsetLine or limitLines!");
  }
  if (!cPrompt.includes('- read_file: inspect file contents ({"path": string})')) {
    throw new Error("Calibration prompt does not contain canonical read_file contract!");
  }

  console.log("✓ Both benchmark and calibration prompt builders generate canonical read_file contracts.");

  // Test with local Ollama model qwen2.5-coder:3b
  console.log("\n[VERIFY OLLAMA PROPOSAL] Dispatching prompt to local qwen2.5-coder:3b...");
  const adapter = new OllamaModelAdapter("qwen2.5-coder:3b", "http://127.0.0.1:11434", 90000, true);

  const tStart = Date.now();
  const proposal = await adapter.proposeAction(bPrompt);
  const durationMs = Date.now() - tStart;

  console.log(`[VERIFY OLLAMA PROPOSAL] Received proposal in ${durationMs} ms:`);
  console.log(JSON.stringify(proposal, null, 2));

  const val = validateStructuredProposal({ version: "v1.8.0", ...proposal });
  console.log("\n[VALIDATION RESULT]:", val.valid ? "PASSED" : "FAILED");
  if (!val.valid) {
    console.error("Validation error:", val.error);
    process.exit(1);
  }

  console.log("✓ Proposal validated successfully under strict Zod validation!");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
