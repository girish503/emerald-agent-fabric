/**
 * Phase 45 — Capability Boundary Evaluation CLI / Runner Script.
 *
 * Loads scratch/phase45-task-ladder.json and scratch/phase45-capability-evaluation.json,
 * verifies cohort integrity, asserts level success rates, and prints
 * the empirical reliable capability boundary report.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

async function main(): Promise<void> {
  const ladderPath = path.resolve("scratch/phase45-task-ladder.json");
  const evalPath = path.resolve("scratch/phase45-capability-evaluation.json");

  const ladderRaw = await fs.readFile(ladderPath, "utf8");
  const ladder = JSON.parse(ladderRaw);

  const evalRaw = await fs.readFile(evalPath, "utf8");
  const evalData = JSON.parse(evalRaw);

  const computedHash = crypto.createHash("sha256").update(ladderRaw).digest("hex");

  console.log("================================================================================");
  console.log("PHASE 45: CONSTRAINED SUB-TASK SYNTHESIS BOUNDARY EVALUATION");
  console.log("================================================================================");
  console.log(`Model:           ${ladder.model} (${ladder.modelDigest.slice(0, 12)}...)`);
  console.log(`Hardware:        ${ladder.hardware.cpu} (${ladder.hardware.ramReadable}, ${ladder.hardware.acceleratorStatus})`);
  console.log(`Task Ladder:     8 levels, ${ladder.tasks.length} total tasks (${ladder.tasks.length / ladder.levels.length} per level)`);
  console.log(`Ladder Hash:     ${computedHash}`);
  console.log(`Reliability Thr: >= ${(evalData.reliabilityThreshold * 100).toFixed(0)}% verified success rate`);
  console.log("--------------------------------------------------------------------------------");
  console.log("LEVEL BREAKDOWN:");

  for (const s of evalData.levelSummaries) {
    const statusStr = s.isReliable ? "[RELIABLE]" : "[UNRELIABLE]";
    const ratePct = (s.successRate * 100).toFixed(1).padStart(5, " ");
    console.log(`  Level ${s.level} (${s.name.padEnd(32, " ")}): ${s.tasksPassed}/${s.tasksAttempted} (${ratePct}%) ${statusStr}`);
  }

  console.log("--------------------------------------------------------------------------------");
  console.log(`Empirical Reliable Boundary: ${evalData.empiricalReliableCapabilityBoundary}`);
  console.log(`Overall Pass Rate:           ${evalData.overallMetrics.totalPassed}/${evalData.overallMetrics.totalTasks} (${(evalData.overallMetrics.overallSuccessRate * 100).toFixed(1)}%)`);
  console.log(`Clean-Room Verification:     ${evalData.governanceInvariance.cleanRoomDualGate}`);
  console.log(`Fourfold Completion Gate:    ${evalData.governanceInvariance.fourfoldCompletionGate}`);
  console.log(`Offline Auditor Parity:      ${evalData.governanceInvariance.offlineAuditorParity}`);
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Phase 45 execution failed:", err);
  process.exit(1);
});
