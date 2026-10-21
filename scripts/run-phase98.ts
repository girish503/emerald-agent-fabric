/**
 * Phase 98 Evaluation Runner
 *
 * Audits all 29 Phase 98 canonical artifacts in scratch/, audits all 30 negative security
 * controls (N661–N690), validates all 20 core invariants (B1–B20), audits 30 crash recovery
 * scenarios, and confirms 3-sweep byte-identical determinism.
 *
 * ABSOLUTE GOVERNING PRINCIPLE:
 * Agreement may be reconstructed. Authority may never be fabricated.
 */

import fs from "node:fs";
import path from "node:path";
import { FaultGovernancePolicy } from "../src/application/fault-governance-policy.js";
import {
  SECURITY_CONTROLS_PHASE98,
  FAULT_AGREEMENT_INVARIANTS,
} from "../src/domain/fault-injection.js";

const ROOT = process.cwd();
const SCRATCH = path.join(ROOT, "scratch");

const REQUIRED_ARTIFACTS = [
  "phase98-protocol.json",
  "phase98-fault-scenarios.json",
  "phase98-fault-events.json",
  "phase98-message-log.json",
  "phase98-partitions.json",
  "phase98-membership.json",
  "phase98-quorum-decisions.json",
  "phase98-agreements.json",
  "phase98-conflicts.json",
  "phase98-equivocation.json",
  "phase98-stale-messages.json",
  "phase98-byzantine-agents.json",
  "phase98-lease-integrity.json",
  "phase98-contract-integrity.json",
  "phase98-action-attempt-integrity.json",
  "phase98-working-tree-integrity.json",
  "phase98-memory-integrity.json",
  "phase98-speculative-integrity.json",
  "phase98-deadlock-integrity.json",
  "phase98-preemption-integrity.json",
  "phase98-role-integrity.json",
  "phase98-recovery.json",
  "phase98-performance.json",
  "phase98-security.json",
  "phase98-determinism.json",
  "phase98-verification.json",
  "phase98-evaluation.json",
  "phase98-evidence.json",
  "phase98-status.json",
];

console.log("================================================================================");
console.log("PHASE 98: GOVERNED FAULT INJECTION AND BYZANTINE AGREEMENT EVALUATION RUNNER");
console.log("================================================================================");

// 1. Verify existence of all 29 artifacts
console.log("\n[STEP 1] Verifying all 29 Phase 98 canonical artifacts...");
let missing = 0;
for (const artifact of REQUIRED_ARTIFACTS) {
  const p = path.join(SCRATCH, artifact);
  if (!fs.existsSync(p)) {
    console.error(`  MISSING: ${artifact}`);
    missing++;
  } else {
    const stat = fs.statSync(p);
    console.log(`  OK: ${artifact} (${stat.size} bytes)`);
  }
}

if (missing > 0) {
  console.error(`\nFAILED: ${missing} artifacts missing.`);
  process.exit(1);
}

// 2. Audit Security Controls N661–N690 (30 controls)
console.log("\n[STEP 2] Auditing Negative Security Controls N661–N690 (30 controls)...");
const policy = new FaultGovernancePolicy();
const secResult = policy.auditSecurityControls();

let failedControls = 0;
for (const ctrl of SECURITY_CONTROLS_PHASE98) {
  const status = secResult.controlResults[ctrl.id];
  if (status !== "FAIL_CLOSED") {
    console.error(`  FAIL: ${ctrl.id} - ${ctrl.description}`);
    failedControls++;
  } else {
    console.log(`  PASS: ${ctrl.id} - ${ctrl.description} [${status}]`);
  }
}

console.log(`Security Controls: ${SECURITY_CONTROLS_PHASE98.length - failedControls}/${SECURITY_CONTROLS_PHASE98.length} fail-closed.`);
if (failedControls > 0) {
  console.error(`FAILED: ${failedControls} security controls did not fail closed.`);
  process.exit(1);
}

// 3. Audit Core Invariants B1–B20 (20 invariants)
console.log("\n[STEP 3] Auditing Core Invariants B1–B20 (20 invariants)...");
const invResult = policy.auditInvariants();
let brokenInvariants = 0;
for (const inv of FAULT_AGREEMENT_INVARIANTS) {
  const status = invResult.invariantResults[inv.id];
  if (status !== "UPHELD") {
    console.error(`  FAIL: ${inv.id} - ${inv.name}: ${inv.description}`);
    brokenInvariants++;
  } else {
    console.log(`  PASS: ${inv.id} - ${inv.name} [${status}]`);
  }
}

console.log(`Core Invariants: ${FAULT_AGREEMENT_INVARIANTS.length - brokenInvariants}/${FAULT_AGREEMENT_INVARIANTS.length} upheld.`);
if (brokenInvariants > 0) {
  console.error(`FAILED: ${brokenInvariants} core invariants violated.`);
  process.exit(1);
}

// 4. Validate Crash Recovery Corpus (30 scenarios)
console.log("\n[STEP 4] Auditing Crash Recovery Scenarios (30 scenarios)...");
const recoveryData = JSON.parse(fs.readFileSync(path.join(SCRATCH, "phase98-recovery.json"), "utf8"));
if (!recoveryData.scenarios || recoveryData.scenarios.length !== 30) {
  console.error(`FAILED: Expected exactly 30 crash recovery scenarios, found ${recoveryData.scenarios?.length}`);
  process.exit(1);
}
let passedRecovery = 0;
for (const sc of recoveryData.scenarios) {
  if (sc.status === "PASSED" && sc.failClosedOrRecovered) {
    passedRecovery++;
  }
}
console.log(`Crash Recovery: ${passedRecovery}/30 scenarios passed or failed closed.`);
if (passedRecovery !== 30) {
  console.error(`FAILED: Crash recovery did not achieve 30/30.`);
  process.exit(1);
}

// 5. Validate 3-Sweep Determinism
console.log("\n[STEP 5] Validating 3-Sweep Byte-Identical Determinism...");
const determinismData = JSON.parse(fs.readFileSync(path.join(SCRATCH, "phase98-determinism.json"), "utf8"));
if (!determinismData.allSweepsIdentical || determinismData.replaysExecuted !== 3) {
  console.error(`FAILED: Determinism audit failed.`);
  process.exit(1);
}
console.log(`Determinism: 3/3 sweeps byte-identical confirmed.`);
console.log(`  Sweep 1: ${determinismData.sweep1Digest}`);
console.log(`  Sweep 2: ${determinismData.sweep2Digest}`);
console.log(`  Sweep 3: ${determinismData.sweep3Digest}`);

console.log("\n================================================================================");
console.log("PHASE 98 VERIFICATION COMPLETE — ALL SAFETY AND GOVERNANCE CONTROLS PASS");
console.log("================================================================================");
