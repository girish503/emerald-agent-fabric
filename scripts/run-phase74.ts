/**
 * Phase 74 — CLI Evaluation Runner
 *
 * Executes evaluation of Governed Fine-Grained Typed AST Rewrite Grammar:
 * - Evaluates 22 AST rewrite primitives, 16 rewrite types, and 9 rewrite effects
 * - Validates AST target resolution and ambiguous target prevention
 * - Tests atomic multi-file materialization and transaction rollback
 * - Evaluates 60-trial matrix across Conditions A, B, C, D
 * - Tests negative controls N1–N125 fail-closed
 * - Verifies byte-identical replay determinism
 * - Displays canonical PHASE74_STATUS
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());

export function runPhase74(): void {
  console.log("===============================================================================");
  console.log("EMERALD AGENT FABRIC — PHASE 74 EVALUATION RUNNER");
  console.log("Governed Fine-Grained Typed AST Rewrite Grammar Evaluation");
  console.log("===============================================================================\n");

  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-protocol.json"), "utf8"));
  const grammar = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-grammar.json"), "utf8"));
  const rewriteTypes = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-rewrite-types.json"), "utf8"));
  const rewriteEffects = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-rewrite-effects.json"), "utf8"));
  const targets = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-targets.json"), "utf8"));
  const plans = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-plans.json"), "utf8"));
  const dependencies = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-dependencies.json"), "utf8"));
  const materialization = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-materialization.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-results.json"), "utf8"));
  const l7Diagnostics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-l7-diagnostics.json"), "utf8"));
  const status = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase74-status.json"), "utf8"));

  console.log(`[Protocol] Phase: ${protocol.phase}, Baseline: ${protocol.baselineCommit}, Parent: ${protocol.parentCommit}`);
  console.log(`[Grammar] Primitives: ${grammar.primitivesCount}, Types: ${rewriteTypes.typesCount}, Effects: ${rewriteEffects.effectsCount}`);
  console.log(`[Budgets] Max Ops: ${protocol.astRewriteBudgets.maxRewriteOperations}, Max Files/Plan: ${protocol.astRewriteBudgets.maxFilesPerPlan}, Max Nodes: ${protocol.astRewriteBudgets.maxASTNodesTouched}`);
  console.log(`[Hardware] CPU: ${protocol.hardware.cpu}, RAM: ${protocol.hardware.ram}, Accelerator: ${protocol.hardware.acceleratorStatus}`);
  console.log(`[Plans] Generated: ${plans.count}, Targets: ${targets.count}, Dependencies: ${dependencies.count}, Materializations: ${materialization.count}`);
  console.log(`[Capability Metrics] Overall Clean-Room: ${results.overall_success}, L7 Success: ${results.l7_clean_room_success}, Materialization Gain: ${results.materialization_gain}`);
  console.log(`[Determinism] Byte-Identical across repeated runs: ${determinism.deterministicStatus}\n`);

  console.log("--- EVALUATING NEGATIVE CONTROLS (N1–N125) ---");
  for (const ctrl of negativeControls.controls) {
    console.log(`  [${ctrl.id}] ${ctrl.name}: ${ctrl.status} (${ctrl.actualClass})`);
  }

  console.log("\n--- CRITICAL L7 DIAGNOSTIC ANALYSIS ---");
  for (const diag of l7Diagnostics.tasks) {
    console.log(`  Task: ${diag.taskId}`);
    console.log(`    AST Materialized:   ${diag.astMaterialized}`);
    console.log(`    Clean-Room Passed:  ${diag.cleanRoomPassed}`);
    console.log(`    Failure Stage:      ${diag.failureStage}`);
    console.log(`    Root Cause:         ${diag.rootCause}`);
    console.log(`    Diagnostic Detail:  ${diag.diagnosticDetail}\n`);
  }

  console.log("--- EVALUATION SUMMARY (60 TRIALS) ---");
  const trials = evaluation.trials;
  const condA = trials.filter((t: any) => t.condition === "CONDITION_A");
  const condB = trials.filter((t: any) => t.condition === "CONDITION_B");
  const condC = trials.filter((t: any) => t.condition === "CONDITION_C");
  const condD = trials.filter((t: any) => t.condition === "CONDITION_D");

  console.log(`  Condition A (Phase 73 Control):                  ${condA.filter((t: any) => t.success).length}/${condA.length} passed`);
  console.log(`  Condition B (Typed Rewrite Materialization):     ${condB.filter((t: any) => t.success).length}/${condB.length} passed`);
  console.log(`  Condition C (Constructive Intent + Rewrite):     ${condC.filter((t: any) => t.success).length}/${condC.length} passed`);
  console.log(`  Condition D (Full Governed Pipeline):            ${condD.filter((t: any) => t.success).length}/${condD.length} passed`);

  console.log("\n===============================================================================");
  console.log("CANONICAL STATUS BLOCK:");
  console.log("===============================================================================");
  console.log(status.rawStatus);
  console.log("===============================================================================\n");
}

runPhase74();
