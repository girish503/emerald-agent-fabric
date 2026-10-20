/**
 * Phase 85 — Governed Cross-Repository Context Propagation and Multi-Project Repair Verification Runner
 *
 * Runs end-to-end evaluation:
 * - 60-trial cross-repository experiment matrix (15 tasks x 4 conditions)
 * - Negative controls N281–N300 (20/20)
 * - Multi-sweep determinism check (100% byte-identical)
 * - Verification of all 16 canonical scratch artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CrossRepositoryRepairOrchestrator,
  buildPhase85Cohort,
  generateRepositoryIdentities,
  generateDependencyEdges,
  generateContracts,
} from "../src/application/cross-repository-repair-orchestrator.js";
import { canonicalJsonStringify, sha256Hex } from "../src/domain/canonical-hash.js";

async function main() {
  console.log("================================================================================");
  console.log("  EMERALD AGENT FABRIC — PHASE 85 EVALUATION RUNNER");
  console.log("  Governed Cross-Repository Context Propagation & Multi-Project Repair");
  console.log("================================================================================");

  const orchestrator = new CrossRepositoryRepairOrchestrator();
  const tasks = buildPhase85Cohort();
  const repositoryIdentities = generateRepositoryIdentities(tasks);
  const dependencyEdges = generateDependencyEdges(tasks);
  const contracts = generateContracts(tasks, dependencyEdges);

  console.log("\n[1/4] Running 60-Trial Cross-Repository Experiment Matrix...");
  const conditions = [
    "CONDITION_A_LOCAL_CONTROL" as const,
    "CONDITION_B_CONTRACT_CONTEXT" as const,
    "CONDITION_C_GOVERNED_COORDINATION" as const,
    "CONDITION_D_FULL_CLEAN_ROOM" as const,
  ];

  const trialResults = [];
  for (const condition of conditions) {
    for (const task of tasks) {
      orchestrator.resetTerminalIndex();
      const workflowId = `wf-run-${task.taskId}-${condition.toLowerCase()}`;
      const taskEdges = dependencyEdges.filter(
        (e) => task.producerRepoId === e.producerRepositoryId && task.consumerRepoIds.includes(e.consumerRepositoryId)
      );
      const taskContracts = contracts.filter(
        (c) => task.producerRepoId === c.producerRepositoryId && task.consumerRepoIds.includes(c.consumerRepositoryId)
      );
      const taskIdentities = repositoryIdentities.filter((r) => task.repositoryIds.includes(r.repositoryId));
      const roots = Object.fromEntries(task.repositoryIds.map((r) => [r, `workspace/${r}`]));

      const result = await orchestrator.executeWorkflow({
        workflowId,
        task,
        condition,
        repositoryIdentities: taskIdentities,
        dependencyEdges: taskEdges,
        contracts: taskContracts,
        workspaceRoots: roots,
        humanCollaborationProvided: false,
      });

      trialResults.push(result);
    }
  }

  for (const cond of conditions) {
    const trials = trialResults.filter((t) => t.condition === cond);
    const successCount = trials.filter((t) => t.terminalSuccess).length;
    const partialCount = trials.filter((t) => t.isPartialRepair).length;
    console.log(`  ${cond.padEnd(35)}: Success: ${successCount}/15 (${((successCount / 15) * 100).toFixed(1)}%) | Partials Trapped: ${partialCount}`);
  }

  console.log("\n[2/4] Running Negative Controls (N281–N300)...");
  const sampleTask = tasks[0];
  const sampleIdentities = repositoryIdentities.filter((r) => sampleTask.repositoryIds.includes(r.repositoryId));
  const sampleEdges = dependencyEdges.filter((e) => sampleTask.producerRepoId === e.producerRepositoryId);
  const sampleContracts = contracts.filter((c) => sampleTask.producerRepoId === c.producerRepositoryId);
  const sampleRoots = Object.fromEntries(sampleTask.repositoryIds.map((r) => [r, `workspace/${r}`]));

  const secResults = orchestrator.executeSecurityControls(
    sampleTask,
    sampleIdentities,
    sampleEdges,
    sampleContracts,
    sampleRoots
  );
  const passedControls = secResults.filter((r) => r.blocked);
  console.log(`  Negative Controls Passed:           ${passedControls.length}/${secResults.length} fail closed`);

  if (passedControls.length !== secResults.length) {
    console.error("  FAILED negative security controls detected!");
    process.exit(1);
  }

  console.log("\n[3/4] Verifying Determinism Across 3 Consecutive Sweeps...");
  const sweepDigests: string[] = [];
  for (let s = 1; s <= 3; s++) {
    const sweepTasks = buildPhase85Cohort();
    const sweepIdentities = generateRepositoryIdentities(sweepTasks);
    const sweepEdges = generateDependencyEdges(sweepTasks);
    const sweepContracts = generateContracts(sweepTasks, sweepEdges);
    sweepDigests.push(
      sha256Hex(
        canonicalJsonStringify({
          tasks: sweepTasks,
          identities: sweepIdentities,
          edges: sweepEdges,
          contracts: sweepContracts,
        })
      )
    );
  }
  const isIdentical = sweepDigests[0] === sweepDigests[1] && sweepDigests[1] === sweepDigests[2];
  console.log(`  Deterministic Match:               ${isIdentical ? "YES (byte-identical across 3 sweeps)" : "NO"}`);

  if (!isIdentical) {
    console.error("  Determinism violation detected!");
    process.exit(1);
  }

  console.log("\n[4/4] Verifying Canonical Research Artifacts in scratch/...");
  const expectedArtifacts = [
    "phase85-protocol.json",
    "phase85-repository-cohort.json",
    "phase85-repository-identities.json",
    "phase85-dependency-graph.json",
    "phase85-contracts.json",
    "phase85-context-projection.json",
    "phase85-repair-plans.json",
    "phase85-evaluation.json",
    "phase85-verification.json",
    "phase85-performance.json",
    "phase85-failure-taxonomy.json",
    "phase85-security.json",
    "phase85-determinism.json",
    "phase85-recovery.json",
    "phase85-evidence.json",
    "phase85-status.json",
  ];

  let missingCount = 0;
  for (const artifact of expectedArtifacts) {
    const p = path.join(process.cwd(), "scratch", artifact);
    if (!fs.existsSync(p)) {
      console.error(`  MISSING: scratch/${artifact}`);
      missingCount++;
    } else {
      const stat = fs.statSync(p);
      console.log(`  OK: scratch/${artifact.padEnd(36)} (${stat.size} bytes)`);
    }
  }

  if (missingCount > 0) {
    console.error(`\nFAILED: ${missingCount} artifact(s) missing!`);
    process.exit(1);
  }

  console.log("\n================================================================================");
  console.log("  PHASE 85 EVALUATION SUCCESSFUL — ALL CHECKS PASSED");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
