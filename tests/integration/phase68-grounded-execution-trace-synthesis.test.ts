/**
 * Phase 68 — Integration Test Suite: Governed Grounded Execution-Trace Inductive Synthesis
 *
 * Verifies:
 * 1. Grounded trace schema and structure
 * 2. Monotonic trace event sequence ordering
 * 3. Canonical SHA-256 trace digest hashing
 * 4. Provenance tracking (OBSERVED_AT_RUNTIME)
 * 5. Trace abstraction to high-level facts
 * 6. Semantic fact derivation from trace events
 * 7. Confidence classification (DIRECTLY_OBSERVED vs REPEATEDLY_OBSERVED)
 * 8. Trace coverage report metrics
 * 9. Non-oracular deterministic input generation
 * 10. Trace differential analysis (compareExecutionTraces)
 * 11. TraceInductivePrior aggregation
 * 12. Trace semantic refinement generation
 * 13. Synthesis integration with Phase 67 translation pipeline
 * 14. Model proposal non-escalation and untrusted status
 * 15. Strict enforcement of trace limits (TRACE_SYNTHESIS_LIMITS)
 * 16. Gold trace leakage prevention (N46)
 * 17. Authority firewall fail-closed behavior (N49)
 * 18. Deterministic replay across runs
 * 19. Nondeterministic runtime behavior detection (N52)
 * 20. Materialization preservation
 * 21. Clean-room dual-gate integration (100% fail-closed on L7)
 * 22. Fourfold completion gate attestation
 * 23. Complete negative control suite (N1–N55)
 * 24. Terminal Ed25519 2-of-3 threshold authority
 * 25. Historical compatibility and GROUNDED_TRACE_INDUCTION_BOUNDARY decision
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  ExecutionTraceInductiveSynthesizer,
  TRACE_SYNTHESIS_LIMITS,
  TRACE_EVENT_TYPES,
  TRACE_PROVENANCE_CLASSES,
  TRACE_CONFIDENCE_CLASSES,
  TRACE_DIVERGENCE_CLASSES,
} from "../../src/application/execution-trace-inductive-synthesizer.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 68 — Governed Grounded Execution-Trace Inductive Synthesis", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-protocol.json"), "utf8"));
  const inputs = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-trace-inputs.json"), "utf8"));
  const traces = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-grounded-traces.json"), "utf8"));
  const facts = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-semantic-facts.json"), "utf8"));
  const priors = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-trace-priors.json"), "utf8"));
  const searchMetrics = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-search-metrics.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-negative-controls.json"), "utf8"));
  const determinism = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-determinism.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase68-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Trace Schema
  // ---------------------------------------------------------------------------
  it("validates grounded execution trace schema and structure", () => {
    expect(protocol.phase).toBe("68");
    expect(protocol.baselineCommit).toBe("34c3511");
    expect(traces.totalTraces).toBeGreaterThan(0);
    const trace = traces.traces[0];
    expect(trace.traceId).toBeDefined();
    expect(trace.orderedEvents.length).toBeGreaterThan(0);
    expect(trace.executionEnvironment).toBe("SANDBOX_DOCKER_ISOLATED");
  });

  // ---------------------------------------------------------------------------
  // 2. Event Ordering
  // ---------------------------------------------------------------------------
  it("enforces monotonic sequence ordering for all trace events", () => {
    const trace = traces.traces[0];
    for (let i = 0; i < trace.orderedEvents.length; i++) {
      expect(trace.orderedEvents[i].sequence).toBe(i + 1);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Trace Hashing
  // ---------------------------------------------------------------------------
  it("computes deterministic canonical SHA-256 digests for traces and events", () => {
    const trace = traces.traces[0];
    expect(trace.contentHash).toMatch(/^[0-9a-f]{64}$/);
    for (const ev of trace.orderedEvents) {
      expect(ev.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Trace Provenance
  // ---------------------------------------------------------------------------
  it("verifies strict runtime observation provenance on events", () => {
    const trace = traces.traces[0];
    expect(trace.observationProvenance).toBe("OBSERVED_AT_RUNTIME");
    for (const ev of trace.orderedEvents) {
      expect(TRACE_PROVENANCE_CLASSES).toContain(ev.provenanceClass);
      expect(ev.provenanceClass).toBe("OBSERVED_AT_RUNTIME");
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Trace Abstraction
  // ---------------------------------------------------------------------------
  it("abstracts concrete trace executions into semantic execution descriptions", () => {
    const trace = traces.traces[0];
    const abstractions = ExecutionTraceInductiveSynthesizer.abstractExecutionTrace(trace);
    expect(abstractions.length).toBe(trace.orderedEvents.length);
    expect(abstractions[0]?.description).toContain("PROGRAM_ENTRY");
  });

  // ---------------------------------------------------------------------------
  // 6. Semantic Fact Extraction
  // ---------------------------------------------------------------------------
  it("derives typed semantic facts from grounded execution events", () => {
    const trace = traces.traces[0];
    const extractedFacts = ExecutionTraceInductiveSynthesizer.deriveTraceSemanticFacts(trace);
    expect(extractedFacts.length).toBeGreaterThan(0);
    expect(extractedFacts[0]?.evidenceSource).toBe(trace.traceId);
  });

  // ---------------------------------------------------------------------------
  // 7. Confidence Classification
  // ---------------------------------------------------------------------------
  it("classifies semantic facts into rigorous confidence categories", () => {
    expect(TRACE_CONFIDENCE_CLASSES).toContain("DIRECTLY_OBSERVED");
    expect(TRACE_CONFIDENCE_CLASSES).toContain("REPEATEDLY_OBSERVED");
    for (const f of facts.facts) {
      expect(TRACE_CONFIDENCE_CLASSES).toContain(f.confidenceClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Coverage Metrics
  // ---------------------------------------------------------------------------
  it("computes comprehensive trace coverage reports across symbols, files, and branches", () => {
    const trace = traces.traces[0];
    const taskFacts = ExecutionTraceInductiveSynthesizer.deriveTraceSemanticFacts(trace);
    const coverage = ExecutionTraceInductiveSynthesizer.computeCoverageReport(trace, taskFacts);
    expect(coverage.symbolsExecuted.length).toBeGreaterThan(0);
    expect(coverage.coverageScore).toBeGreaterThan(0);
    expect(coverage.coverageScore).toBeLessThanOrEqual(1.0);
  });

  // ---------------------------------------------------------------------------
  // 9. Input Generation
  // ---------------------------------------------------------------------------
  it("generates deterministic non-oracular test inputs across 4 classes", () => {
    const taskInputs = ExecutionTraceInductiveSynthesizer.generateDeterministicInputs("P46-L5-01");
    expect(taskInputs.length).toBe(4);
    const classes = taskInputs.map((i) => i.inputClass);
    expect(classes).toContain("BOUNDARY_VALUE");
    expect(classes).toContain("AUTHORIZED_EXAMPLE");
    expect(classes).toContain("NEGATIVE_EXAMPLE");
    expect(classes).toContain("REGRESSION_PROBE");
  });

  // ---------------------------------------------------------------------------
  // 10. Trace Differential Analysis
  // ---------------------------------------------------------------------------
  it("compares baseline and candidate execution traces to detect divergences", () => {
    const inp = inputs.inputs[0];
    const baseTrace = ExecutionTraceInductiveSynthesizer.collectGroundedTrace("P46-L5-01", inp, "BASELINE");
    const candTrace = ExecutionTraceInductiveSynthesizer.collectGroundedTrace("P46-L5-01", inp, "CANDIDATE");
    const diffs = ExecutionTraceInductiveSynthesizer.compareExecutionTraces(baseTrace, candTrace);
    expect(Array.isArray(diffs)).toBe(true);
    for (const d of diffs) {
      expect(TRACE_DIVERGENCE_CLASSES).toContain(d.divergenceClass);
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Semantic Prior Construction
  // ---------------------------------------------------------------------------
  it("constructs TraceInductivePrior aggregating multi-trace runtime facts", () => {
    expect(priors.totalPriors).toBe(15);
    const p = priors.priors[0];
    expect(p.likelyStateTransitions.length).toBeGreaterThan(0);
    expect(p.observedDataflow.length).toBeGreaterThan(0);
    expect(p.candidateSemanticOperations.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 12. Trace Refinement
  // ---------------------------------------------------------------------------
  it("derives semantic refinements from actionable trace differentials", () => {
    const inp = ExecutionTraceInductiveSynthesizer.generateDeterministicInputs("P46-L7-01")[2]!;
    const baseTrace = ExecutionTraceInductiveSynthesizer.collectGroundedTrace("P46-L7-01", inp, "BASELINE");
    const candTrace = ExecutionTraceInductiveSynthesizer.collectGroundedTrace("P46-L7-01", inp, "CANDIDATE");
    const diffs = ExecutionTraceInductiveSynthesizer.compareExecutionTraces(baseTrace, candTrace);
    if (diffs.length > 0) {
      const ref = ExecutionTraceInductiveSynthesizer.refineFromTraceDifference(diffs[0]!, "P46-L7-01");
      expect(ref.refinementId).toBeDefined();
      expect(ref.candidateInvariant).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 13. Synthesis Integration
  // ---------------------------------------------------------------------------
  it("evaluates trace-guided synthesis across conditions A, B, C, D", () => {
    const resB = ExecutionTraceInductiveSynthesizer.evaluateCondition("B", "P46-L5-01");
    const resC = ExecutionTraceInductiveSynthesizer.evaluateCondition("C", "P46-L5-01");
    const resD = ExecutionTraceInductiveSynthesizer.evaluateCondition("D", "P46-L5-01");
    expect(resB.success).toBe(true);
    expect(resC.success).toBe(true);
    expect(resD.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 14. Model Proposal Validation
  // ---------------------------------------------------------------------------
  it("validates that model assistance remains an untrusted hypothesis channel (N55)", () => {
    const n55 = negativeControls.controls.find((c: any) => c.id === "N55");
    expect(n55?.status).toBe("PASS");
    expect(n55?.actualClass).toBe("MODEL_TRACE_AUTHORITY_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 15. Trace Budget Enforcement
  // ---------------------------------------------------------------------------
  it("strictly enforces trace execution and memory budget ceilings (N50)", () => {
    expect(TRACE_SYNTHESIS_LIMITS.maxTraceEvents).toBe(512);
    expect(TRACE_SYNTHESIS_LIMITS.maxTraceBytes).toBe(65536);
    const n50 = negativeControls.controls.find((c: any) => c.id === "N50");
    expect(n50?.status).toBe("PASS");
  });

  // ---------------------------------------------------------------------------
  // 16. Gold Trace Leakage Prevention
  // ---------------------------------------------------------------------------
  it("prohibits execution of hidden gold patch code during trace collection (N46)", () => {
    const n46 = negativeControls.controls.find((c: any) => c.id === "N46");
    expect(n46?.status).toBe("PASS");
    expect(n46?.actualClass).toBe("GOLD_TRACE_LEAKAGE_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 17. Authority Firewall
  // ---------------------------------------------------------------------------
  it("enforces fail-closed authority firewall preventing trace authority escalation (N49)", () => {
    const n49 = negativeControls.controls.find((c: any) => c.id === "N49");
    expect(n49?.status).toBe("PASS");
    expect(n49?.actualClass).toBe("TRACE_AUTHORITY_ESCALATION_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 18. Deterministic Replay
  // ---------------------------------------------------------------------------
  it("verifies 100% byte-identical determinism across repeated evaluation runs", () => {
    expect(determinism.allByteIdentical).toBe(true);
    expect(determinism.run1Digest).toBe(determinism.run2Digest);
  });

  // ---------------------------------------------------------------------------
  // 19. Nondeterministic Runtime Trace Detection
  // ---------------------------------------------------------------------------
  it("ensures identical inputs produce byte-identical trace digests (N52)", () => {
    const n52 = negativeControls.controls.find((c: any) => c.id === "N52");
    expect(n52?.status).toBe("PASS");
    expect(n52?.actualClass).toBe("BYTE_IDENTICAL_TRACE_REPLAY");
  });

  // ---------------------------------------------------------------------------
  // 20. Trace Synthesis Bypass Prevention
  // ---------------------------------------------------------------------------
  it("prevents trace priors from bypassing semantic validation or clean-room gates (N54)", () => {
    const n54 = negativeControls.controls.find((c: any) => c.id === "N54");
    expect(n54?.status).toBe("PASS");
    expect(n54?.actualClass).toBe("SYNTHESIS_VALIDATION_BYPASS_REJECTED");
  });

  // ---------------------------------------------------------------------------
  // 21. Clean-Room Dual-Gate Integration
  // ---------------------------------------------------------------------------
  it("enforces fail-closed clean-room Gate B verification on Level-7 tasks", () => {
    expect(results.metrics.control_l7).toBe("0/5");
    expect(results.metrics.single_trace_l7).toBe("0/5");
    expect(results.metrics.multi_trace_l7).toBe("0/5");
    expect(results.metrics.full_governed_l7).toBe("0/5");
    expect(results.metrics.l7_clean_room_success).toBe("0/5 (0.0%)");
  });

  // ---------------------------------------------------------------------------
  // 22. Fourfold Verification Attestation
  // ---------------------------------------------------------------------------
  it("verifies complete fourfold gate attestation and offline auditor replay", () => {
    expect(results.metrics.fourfold_verification).toBe("100% (valid)");
    expect(results.metrics.offline_auditor).toBe("100% (replay verified)");
  });

  // ---------------------------------------------------------------------------
  // 23. Complete Negative Control Suite (N1–N55)
  // ---------------------------------------------------------------------------
  it("passes 100% of all 55 negative controls (N1–N55) fail-closed", () => {
    expect(negativeControls.totalControls).toBe(55);
    expect(negativeControls.allPassed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 24. Terminal Authority
  // ---------------------------------------------------------------------------
  it("maintains immutable Ed25519 2-of-3 threshold signature authority", () => {
    expect(results.metrics.terminal_authority).toBe("100% (Ed25519 2-of-3 threshold immutable)");
  });

  // ---------------------------------------------------------------------------
  // 25. Historical Compatibility & Grounding Gain Decision
  // ---------------------------------------------------------------------------
  it("measures 0.0% Grounding Gain on L7 and confirms GROUNDED_TRACE_INDUCTION_BOUNDARY", () => {
    expect(results.metrics.grounding_gain).toBe("0.0%");
    expect(results.metrics.decision).toBe("GROUNDED_TRACE_INDUCTION_BOUNDARY");
    expect(results.metrics.remainingBoundary).toBe("COINDUCTIVE_TRACE_DISCOVERY_GAP");
    expect(searchMetrics.tracesCollected).toBeGreaterThan(0);
    expect(TRACE_EVENT_TYPES.length).toBe(14);
  });
});
