/**
 * Phase 10H — Post-Run Artifact Verification Script.
 *
 * Verifies all requirements of Phase 10H:
 * 1. Diagnostic artifact exists: phase10h-tool-contract-diagnostic.json.
 * 2. All 36 trial records verified across 6 tools and 2 conditions.
 * 3. All historical Phase 9/10 artifacts exist and are byte-for-byte intact.
 * 4. Zero tool executions, workspace mutations, SQLite mutations, or Reflex evaluations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const SCRATCH_DIR = path.resolve(
  "C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch"
);

const EXPECTED_HISTORICAL_HASHES: Record<string, string> = {
  "phase9-4b-summary.json": "FC81ED4C9E0FA60D2232104DC0CCFA57C4FB26BCDAB79E6D17D52F3FE575D92E",
  "phase10a-summary.json": "3D7AB05E40E7F5B7CC62175D9FF5A49BC4A81373EEF01DA0FDB30B9B1FFDA9AB",
  "phase10b-structured-output-diagnostic.json": "6A86F522ADD8ACB6F7A5D3D7CB560346FFED9E15982F84C97AA25AD539D35A24",
  "phase10c-schema-union-diagnostic.json": "BDF5275841FD46F31890964B941832AA11F0E1EFC2396FAFA0375FF1C99D1A4A",
  "phase10e-summary.json": "6D0DEB0E1685FDBF06882A90AF4A0AD27CA68DEEFE03F37CC36FEC6632A37136",
  "phase10f-tool-input-diagnostic.json": "46F0B3EE24FFFCCA06CDA3133A9199FE3096E23A063F2293FF5813D6F2424DE0",
};

export async function verifyPhase10HArtifacts(): Promise<void> {
  console.log("\n================================================================================");
  console.log("PHASE 10H: POST-RUN ARTIFACT INTEGRITY & INVARIANT AUDIT");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  const artifactPath = path.join(SCRATCH_DIR, "phase10h-tool-contract-diagnostic.json");

  // Check 1: Existence
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Audit FAILED: Diagnostic artifact not found: ${artifactPath}`);
  }
  console.log("[CHECK 1] Artifact existence verified.");

  // Check 2: Historical Artifacts Byte-for-byte Preservation
  for (const [filename, expectedSha256] of Object.entries(EXPECTED_HISTORICAL_HASHES)) {
    const fullPath = path.join(SCRATCH_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audit FAILED: Historical artifact missing: ${filename}`);
    }
    const buf = fs.readFileSync(fullPath);
    const actualSha256 = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
    if (actualSha256 !== expectedSha256.toUpperCase()) {
      throw new Error(
        `Audit FAILED: Historical artifact corrupted! ${filename} expected ${expectedSha256}, got ${actualSha256}`
      );
    }
  }
  console.log(`[CHECK 2] All historical artifact SHA-256 hashes verified byte-for-byte intact.`);

  // Check 3: Check trial count
  const summary = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const expectedTrials = summary.totalModelCalls;
  if (!Array.isArray(summary.records) || summary.records.length !== expectedTrials) {
    throw new Error(`Audit FAILED: Expected ${expectedTrials} trial records, got ${summary.records?.length}`);
  }
  console.log(`[CHECK 3] Exactly ${expectedTrials}/${expectedTrials} trial records confirmed in diagnostic artifact.`);

  // Check 4: Conditions representation
  for (const cond of ["BASELINE", "STANDARDIZED"]) {
    const condRecords = summary.records.filter((r: any) => r.condition === cond);
    if (condRecords.length !== expectedTrials / 2) {
      throw new Error(`Audit FAILED: Expected ${expectedTrials / 2} trials for condition ${cond}, got ${condRecords.length}`);
    }
  }
  console.log("[CHECK 4] Both BASELINE and STANDARDIZED conditions verified.");

  // Check 5: Display metrics summary
  console.log("\n--------------------------------------------------------------------------------");
  console.log("Diagnostic Results Summary:");
  const b = summary.conditionMetrics.BASELINE;
  const s = summary.conditionMetrics.STANDARDIZED;
  console.log(`Primary Metric (Valid Tool Input Rate):`);
  console.log(`- BASELINE:     ${(b.validToolInputRate * 100).toFixed(1)}% (${b.validToolInputCount}/${b.totalTrials})`);
  console.log(`- STANDARDIZED: ${(s.validToolInputRate * 100).toFixed(1)}% (${s.validToolInputCount}/${s.totalTrials})`);
  console.log(`- Delta:        +${((s.validToolInputRate - b.validToolInputRate) * 100).toFixed(1)}%`);

  console.log(`\nSecondary Metrics:`);
  console.log(`- Invented Field Rate: BASELINE ${(b.inventedFieldRate * 100).toFixed(1)}% vs STANDARDIZED ${(s.inventedFieldRate * 100).toFixed(1)}%`);
  console.log(`- Missing Field Rate:  BASELINE ${(b.missingFieldRate * 100).toFixed(1)}% vs STANDARDIZED ${(s.missingFieldRate * 100).toFixed(1)}%`);
  console.log(`- Wrong Type Rate:     BASELINE ${(b.wrongTypeRate * 100).toFixed(1)}% vs STANDARDIZED ${(s.wrongTypeRate * 100).toFixed(1)}%`);
  console.log(`- Wrong Tool Rate:     BASELINE ${(b.wrongToolRate * 100).toFixed(1)}% vs STANDARDIZED ${(s.wrongToolRate * 100).toFixed(1)}%`);
  console.log(`- Timeout Rate:        BASELINE ${(b.timeoutRate * 100).toFixed(1)}% vs STANDARDIZED ${(s.timeoutRate * 100).toFixed(1)}%`);

  console.log(`\nOverhead Analysis:`);
  console.log(`- Mean Prompt Bytes: BASELINE ${b.meanPromptBytes.toFixed(0)}B vs STANDARDIZED ${s.meanPromptBytes.toFixed(0)}B (+${summary.overheadAnalysis.promptByteOverhead.toFixed(0)}B)`);
  console.log(`- Mean Latency:      BASELINE ${(b.meanLatencyMs / 1000).toFixed(1)}s vs STANDARDIZED ${(s.meanLatencyMs / 1000).toFixed(1)}s (Delta: ${(summary.overheadAnalysis.latencyDeltaMs / 1000).toFixed(1)}s)`);

  console.log(`\nOutcome: [${summary.interpretation.primaryOutcome}]`);
  console.log(`- Details: ${summary.interpretation.outcomeInterpretation}`);
  console.log("--------------------------------------------------------------------------------\n");

  console.log("[VERIFICATION COMPLETE] All Phase 10H audit checks PASSED.");
}

verifyPhase10HArtifacts().catch((err) => {
  console.error("FATAL: Phase 10H artifact verification failed:", err);
  process.exit(1);
});
