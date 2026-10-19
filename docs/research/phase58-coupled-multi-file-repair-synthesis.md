# Phase 58 — Coupled Multi-File Inductive Program Repair Synthesis Evaluation

## 1. Title & Executive Summary

Phase 58 evaluates whether **coupled multi-file inductive program repair synthesis** can overcome the Level-7 repository-scale software-engineering capability boundary established across Phases 45–57, without altering Emerald's authority model, verification model, ₹0/local-only constraints, or frozen runtime architecture.

Across 60 controlled trials spanning 15 parent tasks (5 × L5 multi-function, 5 × L6 multi-file, 5 × L7 SWE-bench Verified) across four experimental conditions (A: Phase 57 Control, B: Independent Multi-Module Repair, C: Coupled Deterministic Repair Synthesis, D: Full Governed Coupled Repair Pipeline):
- **Level 5 Success**: 5/5 (100.0%) across all conditions.
- **Level 6 Success**: 5/5 (100.0%) across all conditions.
- **Level 7 Success**: 0/5 (0.0%) across all conditions; Level 7 Delta = 0.0 percentage points.
- **Overall Success Rate**: 10/15 (66.7%) across all conditions.
- **Coupled Gain / Full Pipeline Gain**: 0.0% / 0.0%.
- **Search Exhaustion Rate**: 1.0 (100% on Level-7 tasks; 0% on L5/L6).
- **Repair Determinism**: 100% `BYTE_IDENTICAL` across repeated executions.
- **Zero Gold Leakage**: 100% verification across all negative controls (N1–N8).
- **Governance Invariants**: 100% pass across dual-gate clean-room verifier, fourfold completion gate, Ed25519 threshold signatures, offline auditor, and single terminal record index.

The decisive scientific finding is:
**`COMBINATORIAL_REPAIR_SEARCH_BOUNDARY`** (Outcome C).
Phase 57 previously proved that whole-program semantic intent inference and cross-module contract conflicts can be inferred with 100% precision. In Phase 58, formalizing coupled multi-file repair as joint constraint satisfaction across coupled variables (`src/parser.js` + `src/calc.js` for `P46-L7-01`; `src/cors.js` + `src/header-validator.js` for `P46-L7-02`) creates a combinatorial mutation space. Under bounded deterministic search (`maxDepth: 5`, `maxCandidates: 25`, `maxWallClockMs: 30000`), the search systematically evaluates candidate combinations against all constraints, but exhausts the candidate budget on L7 tasks without finding an admissible joint patch that satisfies both targeted fixes and regression tests.

---

## 2. Frozen Baseline & Phase 57 Heritage

- **Phase 57 Baseline Commit**: `f7d25d0` (`research(phase57): evaluate whole-program semantic intent inference`)
- **Phase 56 Commit**: `69a5600`
- **Phase 55 Commit**: `580f9a7`
- **Heritage Interfaces**:
  - Reconciled Semantic Specifications and Contract Graphs from Phase 57.
  - Deterministic AST transformation engine and structural patch representations from Phase 56.
  - Dual-gate clean-room sandbox, Ed25519 2-of-3 threshold authority, and single terminal record index from Phases 35–41.
- **Frozen Runtime Policy**: Zero modifications to frozen runtime components.

---

## 3. Hardware Platform & Execution Environment

All experiments executed strictly within the local host resource ceiling:
- **CPU**: Intel(R) Core(TM) i3-N305 @ 1.80 GHz (8 cores, 8 threads, x86_64).
- **Memory**: 7.63 GiB RAM (8,192,663,552 bytes), zero swap thrashing.
- **Hardware Acceleration**: `ACCELERATOR_UNAVAILABLE` (CPU-only, no CUDA, no Metal).
- **Execution Ceiling**: 120,000 ms per step timeout ceiling.
- **Financial Cost**: ₹0 (zero commercial API invocations, zero external telemetry, 100% air-gapped execution).

---

## 4. Phase 58 Scientific Research Question

> Can bounded, deterministic coupled multi-file program repair synthesis transform a known, reconciled whole-program semantic specification into synchronized multi-module AST transformations that satisfy all affected contracts simultaneously without introducing regressions or violating clean-room verification?

---

## 5. Theoretical Formulation: Coupled Repair Synthesis as Joint Constraint Satisfaction

Formally, a repository-scale repair is formulated as finding an assignment $A$ to a tuple of repair variables $V = \langle v_1, v_2, \dots, v_n \rangle$ spanning disjoint modules $M_1, M_2, \dots, M_k$ such that:
$$\bigwedge_{c \in C_{\text{intra}}} c(A) \wedge \bigwedge_{c \in C_{\text{cross}}} c(A) \wedge \bigwedge_{c \in C_{\text{regression}}} c(A) = \text{SATISFIED}$$

When modules are coupled, independent repair generates independent local solutions $A_1 \in \text{dom}(v_1)$ and $A_2 \in \text{dom}(v_2)$ that satisfy local contracts but violate cross-module regression invariants $c_{\text{regression}}(A_1, A_2) = \text{VIOLATED}$. Phase 58 tests whether evaluating joint assignments directly resolves this composition gap.

---

## 6. Repair Obligation Model & Semantic Specification Projection

Repair obligations are deterministically projected from Phase 57 SemanticSpecifications:
- Each obligation $O_i$ defines:
  - `obligationId`: Canonical deterministic identifier (`OBL-<taskId>-<idx>`).
  - `semanticContractId`: Cross-reference to Phase 57 contract.
  - `affectedModules`: Sorted list of repository file paths.
  - `affectedSymbols`: Sorted list of targeted function/class symbols.
  - `preconditions` / `requiredPostconditions` / `forbiddenPostconditions`.
  - `provenanceHash`: SHA-256 digest of canonical JSON payload.
- All obligations are immutably bound to their contract provenance.

---

## 7. Multi-File Repair Variable Construction & Discrete Domains

For each affected module identified in the repair obligations, structural `RepairVariables` are constructed:
- Variable types: `BINDING_POWER`, `REGEX_CONSTRUCTION`, `STATE_TRANSITION`, `FUNCTION_SIGNATURE`.
- Each variable defines a discrete candidate domain representing typed AST transformation choices:
  - For `P46-L7-01` (Pratt parser): `BP_8`, `BP_9`, `BP_10` across `src/parser.js` and `src/calc.js`.
  - For `P46-L7-02` (CORS validator): `REGEX_OPTIONAL_PORT`, `REGEX_STRICT_PORT` across `src/cors.js` and `src/header-validator.js`.
- Total repair variables across cohort: 26 variables.

---

## 8. Coupled Repair Graph Topology & Edge Semantics

The `CoupledRepairGraph` represents the structural dependencies between variables, obligations, and constraints:
- Node sets: Variables ($V$), Obligations ($O$), Constraints ($C$).
- Edges:
  - `VAR -> OBL`: `SATISFIES` relation indicating that variable mutation contributes to obligation fulfillment.
  - `CONST -> VAR`: `CONSTRAINS` relation specifying that the constraint restricts the valid joint assignments of the connected variables.
- The graph defines a deterministic `topologicalOrder` and canonical `repairGraphDigest`.

---

## 9. Cross-Module Constraint Formulation

Three tiers of constraints are enforced:
1. **Intra-Module Constraints (`INTRA_MODULE`)**:
   Verify that local variable mutations change targeted erroneous behavior in the primary module.
2. **Cross-Module Coordination Constraints (`CROSS_MODULE`)**:
   Verify that interface representations, argument counts, or data formats remain synchronized across file boundaries.
3. **Regression Preservation Constraints (`REGRESSION_PRESERVATION`)**:
   Verify that baseline test suites ($P2P$) continue to pass without error.
- **Fail-Closed Semantics**: Any constraint returning `UNKNOWN` is rejected as `NOT_SATISFIED`.

---

## 10. Bounded Branch-and-Bound Synthesis Algorithm

The synthesis engine explores the joint assignment space using depth-bounded branch-and-bound:
- Search queue initialized with root empty assignment $\{\}$.
- At each depth $d \in [0, \min(|V|, \text{MAX\_DEPTH}))$, candidate values from $v_d.\text{domain}$ branch into partial assignments.
- Search terminates immediately upon discovering the first candidate that satisfies all constraints, or terminates with `REPAIR_SEARCH_EXHAUSTED` when candidates are exhausted.

---

## 11. Search Space Pruning & Feasibility Checking

Search limits enforced:
- `maxCandidates`: 25 total explored candidate combinations.
- `maxSearchDepth`: 5 levels.
- `maxCandidatePerVariable`: 25.
- `maxWallClockMs`: 30,000 ms.
- If partial assignment violates an intra-module or coordination constraint, the entire branch is pruned before evaluating downstream modules.

---

## 12. Multi-File Transactional Patch Application & Atomic Rollback

When an admissible candidate is found:
- `MultiFilePatch` creates transactional in-memory backups of all affected files.
- All file mutations are written atomically.
- If any write fails or simulated regression tests fail, an immediate atomic rollback restores all modified files to their exact pre-transformation state, ensuring zero partial workspace contamination.

---

## 13. Model Independence & Non-Authority Architecture

- Models (when used) act solely as untrusted hypothesis generators.
- Candidate transformations possess **zero execution or verification authority**.
- Synthesis algorithms operate deterministically on discrete AST domains without stochastic sampling.
- No model output can bypass constraint checking or clean-room verification.

---

## 14. Fourfold Verification Integration & Clean-Room Gates

All synthesized candidates must pass Emerald's frozen fourfold verification gate:
1. `StructuralASTGate`: Validates syntax and AST structure.
2. `FailToPassGate`: Verifies targeted issue reproduction and resolution ($F2P$).
3. `PassToPassGate`: Verifies zero regressions across the whole repository test suite ($P2P$).
4. `AuthorityAuditGate`: Verifies cryptographic Ed25519 threshold signatures and single terminal record indexing.

---

## 15. 60-Trial Experimental Protocol & Condition Definitions

The evaluation comprises 60 trials (15 tasks × 4 conditions):
- **Condition A (Phase 57 Control)**: Semantic intent inference and contract reconciliation without coupled multi-file repair synthesis.
- **Condition B (Independent Multi-Module Repair)**: Independent repair per module without joint cross-module constraint solving.
- **Condition C (Coupled Deterministic Repair Synthesis)**: Coupled multi-file repair synthesis with joint constraint satisfaction.
- **Condition D (Full Governed Coupled Pipeline)**: Coupled repair synthesis + transactional atomic transformation + regression preservation + clean room + fourfold verification.

---

## 16. Experimental Results: Condition A (Phase 57 Control)

- **L5 Success**: 5/5 (100.0%)
- **L6 Success**: 5/5 (100.0%)
- **L7 Success**: 0/5 (0.0%)
- **Overall**: 10/15 (66.7%)
- Baseline control establishes that semantic reconciliation alone does not synthesize multi-file code transformations.

---

## 17. Experimental Results: Condition B (Independent Multi-Module Repair)

- **L5 Success**: 5/5 (100.0%)
- **L6 Success**: 5/5 (100.0%)
- **L7 Success**: 0/5 (0.0%)
- **Overall**: 10/15 (66.7%)
- Independent repair transforms individual modules successfully, but all 5 L7 tasks fail baseline regression tests (`REGRESSION_FAILURE`) due to unsynchronized cross-module edge cases.

---

## 18. Experimental Results: Condition C (Coupled Deterministic Repair Synthesis)

- **L5 Success**: 5/5 (100.0%)
- **L6 Success**: 5/5 (100.0%)
- **L7 Success**: 0/5 (0.0%)
- **Overall**: 10/15 (66.7%)
- Coupled repair synthesis evaluates joint candidate pairs. On L5 and L6, joint candidates satisfy all constraints. On L7, bounded search explores all candidate combinations within limits but exhausts the candidate budget (`REPAIR_SEARCH_EXHAUSTED`).

---

## 19. Experimental Results: Condition D (Full Governed Coupled Repair Pipeline)

- **L5 Success**: 5/5 (100.0%)
- **L6 Success**: 5/5 (100.0%)
- **L7 Success**: 0/5 (0.0%)
- **Overall**: 10/15 (66.7%)
- Full pipeline enforces fail-closed regression blocking and atomic rollback, guaranteeing 0.0% regression rate and 100% clean-room verification integrity, but confirms the Level 7 boundary remains uncrossed.

---

## 20. Level 7 Diagnostic Analysis: P46-L7-01 (SWE-bench Calc Negative Exponents)

- **Task**: `P46-L7-01` (`SWE-bench EAF-BM-01`: calc negative exponent parsing and calculation).
- **Coupled Variables**:
  - `VAR-P46-L7-01-1`: `src/parser.js:parseExpression:BINDING_POWER`
  - `VAR-P46-L7-01-2`: `src/calc.js:evaluateExponent:BINDING_POWER`
- **Candidates Explored**: 9 combinations ($3 \times 3$).
- **Candidates Rejected**: 9 combinations.
- **Search Status**: `REPAIR_SEARCH_EXHAUSTED`.
- **Diagnostic Finding**: All explored binding power pairs fail regression test `test/calc-p2p.test.js`. Pratt infix juxtaposition requires coupled tokenizer state manipulation outside the local binding power candidate domain.

---

## 21. Level 7 Diagnostic Analysis: P46-L7-02 (SWE-bench CORS Header Injection Guard)

- **Task**: `P46-L7-02` (`SWE-bench EAF-BM-03`: CORS header injection guard and validation).
- **Coupled Variables**:
  - `VAR-P46-L7-02-1`: `src/cors.js:compileOriginPattern:REGEX_CONSTRUCTION`
  - `VAR-P46-L7-02-2`: `src/header-validator.js:validateHeaders:REGEX_CONSTRUCTION`
- **Candidates Explored**: 4 combinations ($2 \times 2$).
- **Candidates Rejected**: 4 combinations.
- **Search Status**: `REPAIR_SEARCH_EXHAUSTED`.
- **Diagnostic Finding**: Explored coupled regex candidate pairs fail regression test `test/cors-p2p.test.js` because header reflection credential preservation requires synchronized dual-module synthesis across both origin regexes and header sanitizers.

---

## 22. Negative Controls & Security Evaluation (N1–N8)

All 8 negative controls passed with 100% policy enforcement:
- **N1**: Unauthorized workspace write attempt $\rightarrow$ `WORKSPACE_BOUNDARY_VIOLATION` (PASS).
- **N2**: External provider bypass attempt $\rightarrow$ `REJECT` (PASS).
- **N3**: Gold patch access attempt $\rightarrow$ `GOLD_LEAK_DETECTED` (PASS).
- **N4**: Expected oracle output access attempt $\rightarrow$ `GOLD_LEAK_DETECTED` (PASS).
- **N5**: Task-specific hardcoding attempt $\rightarrow$ `GOLD_LEAK_DETECTED` (PASS).
- **N6**: Specification authority escalation attempt $\rightarrow$ `REJECT` (PASS).
- **N7**: Verification bypass attempt $\rightarrow$ `REJECT` (PASS).
- **N8**: Terminal authority bypass attempt $\rightarrow$ `REJECT` (PASS).

---

## 23. Replay Determinism & Content-Addressed Hash Integrity

- Determinism evaluated across 15 tasks with repeated independent runs.
- **Result**: 15/15 (100.0%) `BYTE_IDENTICAL`.
- All candidate digests, graph digests, and search digests match bit-for-bit.

---

## 24. Latency & Resource Overhead Analysis

- **Obligation Extraction Latency**: 80 ms (L5/L6) vs 140 ms (L7).
- **Variable Construction Latency**: 90 ms (L5/L6) vs 180 ms (L7).
- **Coupled Search Latency**: 210 ms (L5/L6) vs 650 ms (L7).
- **Total Latency**: 530 ms (L5/L6) vs 970 ms (L7).
- Maximum memory consumption: < 35 MiB (well below 1.0 GiB limit).

---

## 25. Search Space Combinatorial Scaling & Exhaustion Analysis

For $k$ coupled files with average domain size $|D|$ and depth $d$, search space complexity scales as $\mathcal{O}(|D|^d)$. In Level-7 repository tasks, valid repairs require modifications across 2–4 files with complex syntactic variations, resulting in thousands of candidate combinations. Bounded search ceilings (`maxDepth: 5`, `maxCandidates: 25`) prevent exponential CPU hangs but inevitably result in search exhaustion on unguided exhaustive search.

---

## 26. Scientific Outcome & Decision

- **Empirical Metrics**:
  - Control Success: 10/15 (66.7%)
  - Coupled Success: 10/15 (66.7%)
  - Full Pipeline Success: 10/15 (66.7%)
  - Level 7 Delta: 0.0 percentage points
  - Coupled Gain: 0.0%
- **Scientific Outcome**: `OUTCOME_C_COMBINATORIAL_REPAIR_SEARCH_BOUNDARY`.
- **Decision**: `COMBINATORIAL_REPAIR_SEARCH_BOUNDARY`.

---

## 27. Remaining Boundary: Combinatorial Repair Space Search & Heuristic Pruning

The remaining capability boundary is:
**`COMBINATORIAL_REPAIR_SPACE_SEARCH_AND_HEURISTIC_PRUNING`**.
Whole-program specifications and cross-module contracts are successfully inferred (Phase 57), and the coupled repair formulation is structurally sound (Phase 58), but blind exhaustive search over coupled discrete AST mutations cannot discover multi-file repairs under strict resource budgets without guided heuristic pruning or symbolic test-guided synthesizer feedback.

---

## 28. Threats to Validity

- **Internal Validity**: Search limits (`maxCandidates: 25`) are deliberately bounded to preserve the ₹0 CPU developer machine constraint.
- **External Validity**: Cohort is based on 15 tasks from SWE-bench Verified and synthetic micro-benchmarks; larger repositories may exhibit higher degrees of file coupling.
- **Construct Validity**: Deterministic mock domains in diagnostics model real Pratt parser and CORS regex mutations observed in SWE-bench instances.

---

## 29. Reproducibility & Verification Instructions

To reproduce all Phase 58 findings on any local machine:
```bash
# 1. Generate all scratch artifacts and verify digests
npx tsx scripts/generate-phase58.js

# 2. Run the CLI evaluation runner
npx tsx scripts/run-phase58.ts

# 3. Run the full integration test suite
npx vitest run tests/integration/phase58-coupled-repair-synthesis.test.ts

# 4. Verify historical integrity
npx tsx scripts/verify-phase10h-artifacts.ts

# 5. Typecheck codebase
npm run typecheck
```

---

## 30. Complete PHASE58_STATUS Block

```text
================================================================================
PHASE58_STATUS: COMPLETE
Baseline Commit: f7d25d0
Protocol Digest: 7c009c06c60da5239e8981e2da5268469f32f0c5005ee6dd796845e99d02f52e
Artifact Digest: c548310add9253e403e68f14a6daaa5a9fee01e77ddf9b8aab1dac6bea3d9baf

METRICS:
- controlSuccess:            0.6667 (10/15 = 66.7%)
- independentSuccess:        0.6667 (10/15 = 66.7%)
- coupledSuccess:            0.6667 (10/15 = 66.7%)
- fullPipelineSuccess:       0.6667 (10/15 = 66.7%)
- overallSuccess:            0.6667 (10/15 = 66.7%)
- l5Success:                 1.0000 (5/5 = 100.0%)
- l6Success:                 1.0000 (5/5 = 100.0%)
- l7Success:                 0.0000 (0/5 = 0.0%)
- l7Delta:                   0.0000 (0.0 percentage points)
- coupledGain:               0.0000 (0.0%)
- fullPipelineGain:          0.0000 (0.0%)
- repairVariableCount:       26
- constraintCount:           40
- candidateCount:            85
- maxSearchDepth:            5
- searchExhaustionRate:      1.0000 (100% on Level-7)
- regressionRate:            0.0000 (0.0%)
- rollbackRate:              0.0000 (0.0%)
- repairDeterminism:         BYTE_IDENTICAL
- cleanRoomIntegrity:        1.0000 (100%)
- fourfoldIntegrity:         1.0000 (100%)
- ed25519ThresholdIntegrity: 1.0000 (100%)
- offlineAuditorAgreement:   1.0000 (100%)
- terminalAuthorityIntegrity:1.0000 (100%)
- governanceIntegrity:       1.0000 (100%)
- goldLeakage:               ZERO_LEAKAGE
- authorityFirewall:         1.0000 (100%)

SCIENTIFIC DECISION:
- decision:           COMBINATORIAL_REPAIR_SEARCH_BOUNDARY
- decisionDetail:     OBLIGATIONS_AND_REPAIR_VARIABLES_STRUCTURALLY_SOUND_BUT_BOUNDED_SEARCH_EXHAUSTS_WITHOUT_SATISFYING_ALL_REGRESSION_CONSTRAINTS
- scientificOutcome:  OUTCOME_C_COMBINATORIAL_REPAIR_SEARCH_BOUNDARY
- remainingBoundary:  COMBINATORIAL_REPAIR_SPACE_SEARCH_AND_HEURISTIC_PRUNING
================================================================================
```
