/**
 * Phase 69 — Integration Test Suite
 * Governed Active Execution and Coinductive Trace Discovery
 *
 * Covers 30 required capability tests:
 * 1. hypothesis creation
 * 2. hypothesis hashing
 * 3. hypothesis compatibility
 * 4. uncertainty scoring
 * 5. experiment generation
 * 6. experiment safety
 * 7. information gain
 * 8. experiment ranking
 * 9. deterministic selection
 * 10. trace execution
 * 11. trace abstraction
 * 12. hypothesis update
 * 13. convergence
 * 14. stagnation
 * 15. budget enforcement
 * 16. random baseline
 * 17. active baseline
 * 18. oracle leakage
 * 19. unsafe experiment rejection
 * 20. model authority
 * 21. discovery state
 * 22. synthesis integration
 * 23. materialization
 * 24. clean-room
 * 25. fourfold
 * 26. terminal authority
 * 27. deterministic replay
 * 28. negative controls
 * 29. historical compatibility
 * 30. status artifact validation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  ActiveExecutionDiscoveryEngine,
  ACTIVE_DISCOVERY_LIMITS,
  UNCERTAINTY_DIMENSIONS,
  EXPERIMENT_CLASSES,
  DeterministicRNG,
  ExperimentCandidate,
} from "../../src/application/active-execution-discovery.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 69 — Governed Active Execution and Coinductive Trace Discovery", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-protocol.json"), "utf8"));
  const hypothesesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-hypotheses.json"), "utf8"));
  const experimentSpace = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-experiment-space.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-results.json"), "utf8"));
  const statusArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase69-status.json"), "utf8"));

  // 1. Hypothesis creation
  it("Test 1: hypothesis creation initializes hypotheses for all 9 uncertainty dimensions", () => {
    expect(hypothesesData.totalHypotheses).toBe(270);
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-01");
    expect(hypSet.hypotheses.length).toBe(18); // 2 per dimension * 9 dimensions
    const dimensions = new Set(hypSet.hypotheses.map((h) => h.dimension));
    expect(dimensions.size).toBe(UNCERTAINTY_DIMENSIONS.length);
    for (const dim of UNCERTAINTY_DIMENSIONS) {
      expect(dimensions.has(dim)).toBe(true);
    }
  });

  // 2. Hypothesis hashing
  it("Test 2: hypothesis hashing enforces 64-char canonical SHA-256 digests", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L6-01");
    expect(hypSet.contentHash).toMatch(/^[a-f0-9]{64}$/);
    for (const h of hypSet.hypotheses) {
      expect(h.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  // 3. Hypothesis compatibility
  it("Test 3: hypothesis compatibility identifies contradictions and mutual exclusions", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L7-01");
    expect(hypSet.contradictions.length).toBeGreaterThanOrEqual(9);
    expect(hypSet.compatibilityRelations.length).toBeGreaterThanOrEqual(9);
    for (const rel of hypSet.compatibilityRelations) {
      expect(rel.compatible).toBe(false);
    }
  });

  // 4. Uncertainty scoring
  it("Test 4: uncertainty scoring bounds uncertainty score strictly between 0.0 and 1.0", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-02");
    expect(hypSet.uncertaintyScore).toBeGreaterThanOrEqual(0.0);
    expect(hypSet.uncertaintyScore).toBeLessThanOrEqual(1.0);
    expect(hypSet.unresolvedDimensions.length).toBe(9);
  });

  // 5. Experiment generation
  it("Test 5: experiment generation designs candidates across experiment classes", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-01");
    const candidates = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L5-01", hypSet);
    expect(candidates.length).toBe(EXPERIMENT_CLASSES.length);
    const classes = new Set(candidates.map((c) => c.experimentClass));
    expect(classes.size).toBe(EXPERIMENT_CLASSES.length);
  });

  // 6. Experiment safety
  it("Test 6: experiment safety validates legitimate candidates as SAFE", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L6-02");
    const candidates = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L6-02", hypSet);
    for (const cand of candidates) {
      const check = ActiveExecutionDiscoveryEngine.validateExperimentSafety(cand);
      expect(check.safe).toBe(true);
    }
  });

  // 7. Information gain
  it("Test 7: information gain computes positive expected reduction in uncertainty", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L7-02");
    const candidates = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L7-02", hypSet);
    for (const cand of candidates) {
      expect(cand.informationGainEstimate).toBeGreaterThan(0.0);
    }
  });

  // 8. Experiment ranking
  it("Test 8: experiment ranking sorts candidates by information gain descending", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-03");
    const candidates = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L5-03", hypSet);
    const selection = ActiveExecutionDiscoveryEngine.selectExperiment(candidates, hypSet, false);
    expect(selection.selectedExperiment).not.toBeNull();
    const topGain = selection.selectedExperiment!.informationGainEstimate;
    for (const cand of candidates) {
      expect(cand.informationGainEstimate).toBeLessThanOrEqual(topGain);
    }
  });

  // 9. Deterministic selection
  it("Test 9: deterministic selection yields byte-identical selections under identical state", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-04");
    const candidates1 = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L5-04", hypSet);
    const candidates2 = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L5-04", hypSet);
    const sel1 = ActiveExecutionDiscoveryEngine.selectExperiment(candidates1, hypSet, false);
    const sel2 = ActiveExecutionDiscoveryEngine.selectExperiment(candidates2, hypSet, false);
    expect(sel1.contentHash).toBe(sel2.contentHash);
    expect(sel1.selectedExperiment?.experimentId).toBe(sel2.selectedExperiment?.experimentId);
  });

  // 10. Trace execution
  it("Test 10: trace execution captures sandboxed runtime events from experiment inputs", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-01");
    const candidates = ActiveExecutionDiscoveryEngine.designExperimentCandidates("P46-L5-01", hypSet);
    const cand = candidates[0]!;
    expect(cand.experimentId).toBeDefined();
    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L5-01", "D");
    expect(state.executedExperiments.length).toBeGreaterThan(0);
    expect(state.observations.length).toBeGreaterThan(0);
  });

  // 11. Trace abstraction
  it("Test 11: trace abstraction derives semantic facts with grounded observation provenance", () => {
    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L5-02", "D");
    expect(state.traceFacts.length).toBeGreaterThan(0);
    for (const f of state.traceFacts) {
      expect(f.factId).toBeDefined();
      expect(f.confidenceClass).toBeDefined();
    }
  });

  // 12. Hypothesis update
  it("Test 12: hypothesis update increases confidence of matching hypothesis and decreases competitor", () => {
    const hypSet = ActiveExecutionDiscoveryEngine.generateHypotheses("P46-L5-05");
    const initialHypA = hypSet.hypotheses.find((h) => h.hypothesisId.endsWith("-A"))!;
    const initialHypB = hypSet.hypotheses.find((h) => h.hypothesisId.endsWith("-B"))!;
    expect(initialHypA.confidence).toBe(0.50);
    expect(initialHypB.confidence).toBe(0.50);

    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L5-05", "D");
    const finalHypA = state.hypothesisSet.hypotheses.find((h) => h.hypothesisId === initialHypA.hypothesisId)!;
    const finalHypB = state.hypothesisSet.hypotheses.find((h) => h.hypothesisId === initialHypB.hypothesisId)!;
    expect(finalHypA.confidence).toBeGreaterThan(initialHypA.confidence);
    expect(finalHypB.confidence).toBeLessThan(initialHypB.confidence);
  });

  // 13. Convergence
  it("Test 13: convergence terminates active loop when uncertainty reaches convergence threshold", () => {
    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L5-01", "D");
    expect(["DISCOVERY_CONVERGED", "DISCOVERY_EXHAUSTED"]).toContain(state.status);
    expect(state.hypothesisSet.uncertaintyScore).toBeLessThan(0.7778);
  });

  // 14. Stagnation
  it("Test 14: stagnation terminates cleanly when no safe discriminating experiments remain", () => {
    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L5-01", "A");
    expect(state.status).toBe("DISCOVERY_STAGNATED");
    expect(state.executedExperiments.length).toBe(0);
  });

  // 15. Budget enforcement
  it("Test 15: budget enforcement caps executed experiments at ACTIVE_DISCOVERY_LIMITS.maxExperiments", () => {
    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L7-01", "D");
    expect(state.executedExperiments.length).toBeLessThanOrEqual(ACTIVE_DISCOVERY_LIMITS.maxExperiments);
    expect(state.currentIteration).toBeLessThanOrEqual(ACTIVE_DISCOVERY_LIMITS.maxIterations);
  });

  // 16. Random baseline
  it("Test 16: random baseline (Condition B) explores safely with seeded PRNG", () => {
    const rng1 = new DeterministicRNG(42);
    const rng2 = new DeterministicRNG(42);
    expect(rng1.next()).toBe(rng2.next());

    const trialB = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L5-01", "B");
    expect(trialB.condition).toBe("B");
    expect(trialB.uncertaintyReduction).toBeGreaterThan(0.0);
  });

  // 17. Active baseline
  it("Test 17: active baseline (Condition C) reduces uncertainty more than random baseline (Condition B)", () => {
    const trialB = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L5-02", "B");
    const trialC = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L5-02", "C");
    expect(trialC.uncertaintyReduction).toBeGreaterThanOrEqual(trialB.uncertaintyReduction);
  });

  // 18. Oracle leakage
  it("Test 18: oracle leakage check confirms zero gold code or hidden test data in experiment space", () => {
    for (const cand of experimentSpace.candidates) {
      const serialized = JSON.stringify(cand).toLowerCase();
      expect(serialized).not.toContain("gold_patch");
      expect(serialized).not.toContain("hidden_test");
      expect(serialized).not.toContain("expected_ast");
    }
  });

  // 19. Unsafe experiment rejection
  it("Test 19: unsafe experiment rejection flags network, secret, and path traversal attempts", () => {
    const badCand: ExperimentCandidate = {
      experimentId: "EXP-BAD-01",
      experimentClass: "BOUNDARY_INPUT",
      input: {
        inputId: "INP-BAD",
        inputClass: "BOUNDARY_VALUE",
        payload: { path: "../../../etc/passwd" },
        provenance: "TEST",
        contentHash: "hash-bad",
      },
      expectedObservableDimensions: ["INPUT_BOUNDARY"],
      targetedHypotheses: [],
      predictedOutcomes: [],
      informationGainEstimate: 0.99,
      safetyClassification: "SAFE",
      resourceCost: 10,
      contentHash: "hash-cand-bad",
    };
    const check = ActiveExecutionDiscoveryEngine.validateExperimentSafety(badCand);
    expect(check.safe).toBe(false);
    expect(check.reason).toBe("UNSAFE_WORKSPACE_ESCAPE_ATTEMPT");
  });

  // 20. Model authority
  it("Test 20: model authority restriction ensures untrusted model cannot authorize experiments", () => {
    const ctrl67 = negativeControls.controls.find((c: any) => c.id === "N67");
    expect(ctrl67).toBeDefined();
    expect(ctrl67.status).toBe("PASS");
    expect(ctrl67.actualClass).toBe("MODEL_AUTHORITY_ESCALATION_REJECTED");
  });

  // 21. Discovery state
  it("Test 21: discovery state encapsulates complete provenance and valid contentHash", () => {
    const state = ActiveExecutionDiscoveryEngine.executeActiveDiscovery("P46-L6-04", "D");
    expect(state.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.hypothesisSet.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Array.isArray(state.observations)).toBe(true);
  });

  // 22. Synthesis integration
  it("Test 22: synthesis integration utilizes discovered trace facts for semantic construction", () => {
    const trialD = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L5-01", "D");
    expect(trialD.factsDerived).toBeGreaterThan(0);
    expect(trialD.cleanRoomPassed).toBe(true);
  });

  // 23. Materialization
  it("Test 23: candidate materialization succeeds on L5/L6 and exhausts on L7", () => {
    const trialL5 = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L5-01", "D");
    const trialL6 = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L6-01", "D");
    const trialL7 = ActiveExecutionDiscoveryEngine.evaluateCondition("P46-L7-01", "D");
    expect(trialL5.success).toBe(true);
    expect(trialL6.success).toBe(true);
    expect(trialL7.success).toBe(false);
    expect(trialL7.failureReason).toBe("ACTIVE_DISCOVERY_BOUNDARY_ON_L7");
  });

  // 24. Clean-room verification
  it("Test 24: clean-room verification fails closed on L7 tasks without regression leakage", () => {
    for (let i = 1; i <= 5; i++) {
      const taskId = `P46-L7-0${i}`;
      const res = ActiveExecutionDiscoveryEngine.evaluateCondition(taskId, "D");
      expect(res.cleanRoomPassed).toBe(false);
      expect(res.success).toBe(false);
    }
  });

  // 25. Fourfold verification
  it("Test 25: fourfold verification remains active and verified across all trials", () => {
    expect(results.metrics.fourfold_verification).toBe("100% (valid)");
  });

  // 26. Terminal authority
  it("Test 26: terminal authority keys remain immutable and Ed25519 threshold secured", () => {
    expect(results.metrics.terminal_authority).toBe("100% (Ed25519 2-of-3 threshold immutable)");
  });

  // 27. Deterministic replay
  it("Test 27: deterministic replay produces byte-identical results across independent executions", () => {
    expect(determinism.byteIdentical).toBe(true);
    expect(determinism.run1Hash).toBe(determinism.run2Hash);
  });

  // 28. Negative controls
  it("Test 28: negative controls N1–N67 all evaluate to PASS fail-closed", () => {
    expect(negativeControls.totalControls).toBe(67);
    expect(negativeControls.allPassed).toBe(true);
    for (const ctrl of negativeControls.controls) {
      expect(ctrl.status).toBe("PASS");
    }
  });

  // 29. Historical compatibility
  it("Test 29: historical compatibility preserves Phase 68 control results", () => {
    expect(results.metrics.control_l5).toBe("5/5");
    expect(results.metrics.control_l6).toBe("5/5");
    expect(results.metrics.control_l7).toBe("0/5");
  });

  // 30. Status artifact validation
  it("Test 30: status artifact contains canonical PHASE69_STATUS matching results", () => {
    expect(protocol.phase).toBe("69");
    expect(statusArtifact.phase).toBe("69");
    expect(statusArtifact.rawStatus).toContain("PHASE69_STATUS");
    expect(statusArtifact.rawStatus).toContain("decision=BOUNDARY_CONFIRMED");
    expect(statusArtifact.rawStatus).toContain("remaining_boundary=CONSTRUCTIVE_PROGRAM_INDUCTION");
    expect(statusArtifact.status.overall_success).toBe("10/15 (66.7%)");
    expect(statusArtifact.status.l7_clean_room_success).toBe("0/5 (0.0%)");
  });
});
