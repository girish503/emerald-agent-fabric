/**
 * Phase 52 — Governed Repository Program Slicing & Contract Projection Integration Tests
 *
 * Verifies:
 * 1. Deterministic slice generation and byte-identical hashing
 * 2. 7-point slice closure and semantic recall verification
 * 3. Formal contract extraction, immutability, and hash integrity
 * 4. Bounded subtask DAG decomposition (all subtasks <= L5/L6)
 * 5. Negative controls N1–N10 enforcement
 * 6. Diagnostic tasks P46-L7-01 and P46-L7-02 clean-room fail-closed rejection
 * 7. Complete 60-trial evaluation matrix (15 tasks x 4 conditions)
 * 8. Governance invariants (Clean-room dual gate, Fourfold completion, Ed25519 threshold, Offline auditor)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  RepositorySlicer,
  SliceSpec
} from "../../src/application/repository-slicer.js";
import {
  ContractExtractor,
  FormalContract,
  SubtaskDefinition
} from "../../src/application/contract-extractor.js";

const ROOT = path.resolve(process.cwd());

describe("Phase 52 — Governed Repository Program Slicing & Contract Projection", () => {
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-protocol.json"), "utf8"));
  const slicesData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-repository-slices.json"), "utf8"));
  const contractsData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-contracts.json"), "utf8"));
  const subtasksData = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-subtask-graphs.json"), "utf8"));
  const evaluation = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-evaluation.json"), "utf8"));
  const negativeControls = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-negative-controls.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, "scratch/phase52-results.json"), "utf8"));

  // ---------------------------------------------------------------------------
  // 1. Deterministic Slice Generation & Byte-Identical Hashing
  // ---------------------------------------------------------------------------
  it("verifies deterministic slice generation and byte-identical hash stability", () => {
    expect(protocol.phase).toBe("52");
    expect(negativeControls.controls.length).toBe(10);
    expect(protocol.experimentalVariable).toBe("governed_repository_slicing_and_contract_projection");
    expect(protocol.frozenBaselineCommit).toBe("1b56216");

    expect(slicesData.slices.length).toBe(15);
    const sampleSpec: SliceSpec = {
      taskId: "TEST-TASK-01",
      baselineCommitSha: "1b56216",
      targetFiles: ["src/queue.js", "src/job.js"],
      targetSymbols: ["queue", "job"],
      dependencyEdges: [
        { sourceFile: "src/queue.js", targetFile: "src/job.js", dependencyType: "IMPORT", symbol: "Job" }
      ],
      testDependencies: ["test/queue-cancel.test.js", "test/queue-core.test.js"],
      configurationDependencies: ["package.json"],
      repositoryTotalBytes: 34800
    };

    const sliceA = RepositorySlicer.generateSlice(sampleSpec);
    const sliceB = RepositorySlicer.generateSlice(sampleSpec);

    expect(sliceA.sliceHash).toBe(sliceB.sliceHash);
    expect(sliceA.closureStatus).toBe("COMPLETE");
    expect(sliceA.metrics.sliceRatio).toBeLessThan(0.40);
  });

  // ---------------------------------------------------------------------------
  // 2. Seven-Point Dependency Closure & Semantic Recall
  // ---------------------------------------------------------------------------
  it("verifies 7-point dependency closure and 100% semantic slice recall across cohort", () => {
    for (const slice of slicesData.slices) {
      expect(slice.closureStatus).toBe("COMPLETE");
      expect(slice.files.length).toBeGreaterThanOrEqual(1);
      expect(slice.testDependencies.length).toBeGreaterThanOrEqual(2);
      expect(slice.metrics.unresolvedDependencies).toBe(0);

      // Verify closure using verifier
      const closure = RepositorySlicer.verifyClosure(slice, {
        requiredFiles: slice.files,
        requiredSymbols: slice.symbols,
        requiredTests: slice.testDependencies
      });
      expect(closure.isComplete).toBe(true);
      expect(closure.closureStatus).toBe("COMPLETE");
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Formal Contract Extraction & Immutability
  // ---------------------------------------------------------------------------
  it("verifies formal contract extraction, immutability, and 100% invariant recall", () => {
    expect(contractsData.contractCollections.length).toBe(15);

    for (const col of contractsData.contractCollections) {
      expect(col.recall).toBe(1.0);
      expect(col.precision).toBe(1.0);
      expect(col.contracts.length).toBeGreaterThanOrEqual(2);

      for (const contract of col.contracts) {
        expect(contract.isImmutable).toBe(true);
        expect(contract.contentHash).toBeDefined();

        // Check hash integrity
        const recomputed = ContractExtractor.computeContractHash(contract);
        expect(contract.contentHash).toBe(recomputed);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Bounded Subtask DAG Decomposition (<= L5/L6)
  // ---------------------------------------------------------------------------
  it("verifies bounded subtask DAG decomposition with all subtasks within L4-L6 ceiling", () => {
    expect(subtasksData.subtaskDAGs.length).toBe(15);

    for (const dag of subtasksData.subtaskDAGs) {
      expect(dag.subtasks.length).toBeLessThanOrEqual(6);
      expect(dag.maxDepth).toBeLessThanOrEqual(3);
      expect(dag.isProjectedToL6OrBelow).toBe(true);

      const validation = ContractExtractor.validateDAG(dag);
      expect(validation.isValid).toBe(true);

      for (const sub of dag.subtasks) {
        expect(["L0", "L1", "L2", "L3", "L4", "L5", "L6"]).toContain(sub.complexityTier);
        expect(sub.complexityTier).not.toBe("L7");
        expect(sub.estimatedMutationSurfaceLines).toBeLessThanOrEqual(150);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Negative Controls N1–N10
  // ---------------------------------------------------------------------------
  describe("Negative Controls N1–N10", () => {
    it("N1: detects missing dependency edge and triggers SLICE_CLOSURE_INCOMPLETE", () => {
      const slice = slicesData.slices[0];
      const check = RepositorySlicer.verifyClosure(slice, {
        requiredFiles: ["missing-file.js"]
      });
      expect(check.isComplete).toBe(false);
      expect(check.closureStatus).toBe("SLICE_CLOSURE_INCOMPLETE");
      expect(check.failureCategory).toBe("DEPENDENCY");
    });

    it("N2: detects contract omission when required invariant is missing", () => {
      const dummySlice = slicesData.slices[0];
      const extracted = ContractExtractor.extractContracts({
        taskId: "TEST-OMISSION",
        slice: dummySlice,
        targetSymbols: ["sym"],
        invariants: ["existing invariant"],
        requiredInvariants: ["existing invariant", "MISSING_CRITICAL_INVARIANT"]
      });
      expect(extracted.recall).toBeLessThan(1.0);
      expect(extracted.coveredInvariants.includes("MISSING_CRITICAL_INVARIANT")).toBe(false);
    });

    it("N3: rejects contract mutation attempts with CAPABILITY_DENIED", () => {
      const contract = contractsData.contractCollections[0].contracts[0];
      expect(() => {
        ContractExtractor.assertContractImmutability(contract, { newPrecondition: "bad" });
      }).toThrow(/CAPABILITY_DENIED/);
    });

    it("N4: blocks repository slicer from attempting workspace mutation with CAPABILITY_DENIED", () => {
      expect(() => {
        RepositorySlicer.assertSliceAuthority("MUTATE_WORKSPACE");
      }).toThrow(/CAPABILITY_DENIED/);
      expect(() => {
        RepositorySlicer.assertSliceAuthority("GRANT_TERMINAL_AUTHORITY");
      }).toThrow(/CAPABILITY_DENIED/);
    });

    it("N5: detects gold patch leakage in slice queries and triggers GOLD_LEAKAGE_DETECTED", () => {
      const leak1 = RepositorySlicer.checkGoldLeakage("please include gold_patch for task");
      const leak2 = RepositorySlicer.checkGoldLeakage("query hidden_solution.js");
      expect(leak1.leaked).toBe(true);
      expect(leak1.reason).toContain("GOLD_LEAKAGE_DETECTED");
      expect(leak2.leaked).toBe(true);
    });

    it("N6: rejects oversized subtasks with DECOMPOSITION_BOUNDARY_FAILURE", () => {
      const oversizedSubtask: SubtaskDefinition = {
        subtaskId: "sub-oversized",
        parentTaskId: "P46-L7-01",
        title: "Un-decomposed Full SWE Task",
        complexityTier: "L7",
        targetFiles: ["src/calc.js"],
        targetSymbols: ["calc"],
        assignedContracts: [],
        dependencies: [],
        maxMutationAttempts: 3,
        maxRepairAttempts: 2,
        estimatedMutationSurfaceLines: 250
      };
      const check = ContractExtractor.validateSubtaskComplexity(oversizedSubtask);
      expect(check.isValid).toBe(false);
      expect(check.failureReason).toContain("DECOMPOSITION_BOUNDARY_FAILURE");
    });

    it("N7: detects cross-slice conflicts during composition", () => {
      const conflict = ContractExtractor.detectCrossSliceConflicts([
        {
          file: "src/queue.js",
          modifiedSymbols: ["queue"],
          violatedInvariants: ["Queue status must not transition directly from cancelled to active"]
        }
      ]);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.conflictReason).toContain("CROSS_SLICE_INVARIANT_CONFLICT");
    });

    it("N8: ensures false local success is rejected by clean room F2P", () => {
      const l7CondD = evaluation.evaluations.find((e: any) => e.parentTaskId === "P46-L7-01" && e.conditionId === "CONDITION_D_SLICE_CONTRACT_GOVERNED_COMPOSITION");
      expect(l7CondD.localSubtaskSuccess).toBe(true);
      expect(l7CondD.composedCleanRoomF2P).toBe("FAIL");
      expect(l7CondD.parentCleanRoomVerified).toBe(false);
      expect(l7CondD.primaryFailureClass).toBe("COMPOSITION_FAILURE");
    });

    it("N9: detects incomplete test closure and triggers test-closure failure", () => {
      const slice = slicesData.slices[0];
      const check = RepositorySlicer.verifyClosure(slice, {
        requiredTests: ["test/missing-suite.test.js"]
      });
      expect(check.isComplete).toBe(false);
      expect(check.failureCategory).toBe("TEST");
    });

    it("N10: detects contradictory pre/post conditions and fails closed", () => {
      const contradictoryContracts: FormalContract[] = [
        {
          contractId: "c1",
          taskId: "test",
          contractType: "INTERFACE",
          sourceSymbols: ["fn"],
          preconditions: ["user must be root"],
          postconditions: ["returns non-null"],
          invariants: [],
          interfaceConstraints: [],
          stateConstraints: [],
          provenance: [],
          contentHash: "hash1",
          isImmutable: true
        },
        {
          contractId: "c2",
          taskId: "test",
          contractType: "INTERFACE",
          sourceSymbols: ["fn"],
          preconditions: ["user requires non-root"],
          postconditions: ["returns non-null"],
          invariants: [],
          interfaceConstraints: [],
          stateConstraints: [],
          provenance: [],
          contentHash: "hash2",
          isImmutable: true
        }
      ];

      const check = ContractExtractor.detectContractContradictions(contradictoryContracts);
      expect(check.hasContradiction).toBe(true);
      expect(check.conflictDescription).toContain("CONTRACT_CONTRADICTION_DETECTED");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Diagnostic Tasks P46-L7-01 and P46-L7-02
  // ---------------------------------------------------------------------------
  it("verifies diagnostic tasks P46-L7-01 and P46-L7-02 fail-closed clean-room rejection", () => {
    const l7_01_d = evaluation.evaluations.find((e: any) => e.parentTaskId === "P46-L7-01" && e.conditionId === "CONDITION_D_SLICE_CONTRACT_GOVERNED_COMPOSITION");
    const l7_02_d = evaluation.evaluations.find((e: any) => e.parentTaskId === "P46-L7-02" && e.conditionId === "CONDITION_D_SLICE_CONTRACT_GOVERNED_COMPOSITION");

    expect(l7_01_d.composedCleanRoomF2P).toBe("FAIL");
    expect(l7_01_d.parentCleanRoomVerified).toBe(false);
    expect(l7_01_d.primaryFailureClass).toBe("COMPOSITION_FAILURE");

    expect(l7_02_d.composedCleanRoomF2P).toBe("FAIL");
    expect(l7_02_d.parentCleanRoomVerified).toBe(false);
    expect(l7_02_d.primaryFailureClass).toBe("COMPOSITION_FAILURE");
  });

  // ---------------------------------------------------------------------------
  // 7. Full 60-Evaluation Matrix & Governance Invariants
  // ---------------------------------------------------------------------------
  it("verifies complete 60-evaluation matrix, complexity breakdown, and invariant governance", () => {
    expect(evaluation.totalEvaluations).toBe(60);
    expect(evaluation.evaluations.length).toBe(60);

    // Condition A: 10/15 (66.7%)
    const condA = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_A_PHASE51_CONTROL");
    expect(condA.length).toBe(15);
    expect(condA.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Condition B: 10/15 (66.7%)
    const condB = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_B_DETERMINISTIC_REPOSITORY_SLICE");
    expect(condB.length).toBe(15);
    expect(condB.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Condition C: 10/15 (66.7%)
    const condC = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_C_SLICE_PLUS_FORMAL_CONTRACT");
    expect(condC.length).toBe(15);
    expect(condC.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Condition D: 10/15 (66.7%)
    const condD = evaluation.evaluations.filter((e: any) => e.conditionId === "CONDITION_D_SLICE_CONTRACT_GOVERNED_COMPOSITION");
    expect(condD.length).toBe(15);
    expect(condD.filter((e: any) => e.parentCleanRoomVerified).length).toBe(10);

    // Level Breakdown across all 4 conditions
    expect(results.metrics.l5Success).toBe(1.0); // 5/5
    expect(results.metrics.l6Success).toBe(1.0); // 5/5
    expect(results.metrics.l7Success).toBe(0.0); // 0/5 (L7 repository boundary strictly persists)

    // Governance Invariants across ALL 60 runs
    for (const ev of evaluation.evaluations) {
      expect(ev.composedCleanRoomP2P).toBe("PASS");
      expect(ev.ed25519ThresholdVerified).toBe(true);
      expect(ev.offlineAuditorAgreed).toBe(true);
      if (ev.parentCleanRoomVerified) {
        expect(ev.composedCleanRoomF2P).toBe("PASS");
        expect(ev.fourfoldCompletionPassed).toBe(true);
        expect(ev.terminalAuthorityGranted).toBe(true);
      } else {
        expect(ev.composedCleanRoomF2P).toBe("FAIL");
        expect(ev.fourfoldCompletionPassed).toBe(false);
        expect(ev.terminalAuthorityGranted).toBe(false);
      }
    }

    // Results & Decision
    expect(results.metrics.decision).toBe("PROMOTE_PARTIAL");
    expect(results.metrics.primaryFailureClass).toBe("COMPOSITION_FAILURE");
  });
});
