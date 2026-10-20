# Phase 61: Governed Joint Semantic Synthesis and Multi-Region Composition

## 1. Executive Summary

Phase 61 evaluated whether a governed joint semantic synthesis engine—constructing joint repair variables across coupled semantic regions and pruning the joint search space with cross-region constraints—can resolve the composition failure established in Phase 60 under strict ₹0 and local CPU execution constraints.

Across 60 controlled experimental trials evaluating the frozen 15-task SWE-bench benchmark cohort, the joint synthesis engine successfully discovered 15 coupled region groups, constructed 25 joint repair variables, extracted 45 canonical cross-region constraints, and pruned 165 out of 300 candidates (55.0% pruning ratio). Local subtasks and region contracts achieved **100.0% success (25/25)**. However, on all Level-7 tasks, bounded joint search (`maxSearchDepth <= 6`, `maxCandidates <= 50`, `maxJointVariables <= 32`) **exhausted at search depth 6**, yielding an overall global clean-room success rate of **10/15 (66.7%)** (L5: 5/5, L6: 5/5, L7: 0/5) with a **0.0% joint composition gain** over Phase 60. This establishes the **`JOINT_SYNTHESIS_CAPABILITY_BOUNDARY`**: the remaining bottleneck is not independent vs. joint formulation, but the **intrinsic capability to synthesize coordinated, higher-order AST transformations across repository boundaries**.

## 2. Phase 60 Baseline

- **Baseline Commit**: `267badc`
- **Phase 60 Finding**: Program-space decomposition established 100% local subproblem solvability (25/25), but post-hoc composition failed on Level-7 (0/5), revealing a 100% composition gap on Level-7 (`SEMANTIC_COMPOSITION_BOUNDARY`).
- **Research Question for Phase 61**: Can joint synthesis of coupled regions (searching over a synchronized multi-variable space with cross-region constraints) bridge this composition gap?

## 3. Research Question

> Can a governed joint synthesis process generate coordinated transformations across coupled semantic regions such that all local contracts, cross-region constraints, global invariants, and regression requirements are simultaneously satisfied?

## 4. Hypotheses

- **H1 (Joint Composition)**: Joint synthesis improves L7 composition over independent post-hoc composition. *(Refuted: L7 global success remained 0/5)*.
- **H2 (Constraint Pruning)**: Cross-region constraints reduce locally-valid but globally-invalid candidate combinations. *(Confirmed: 165/300 candidates pruned)*.
- **H3 (CEGAR Acceleration)**: CEGAR feedback soundly eliminates incompatible joint variable assignments. *(Confirmed: 55.0% pruning without unsound elimination)*.
- **H4 (Global Reconciliation)**: Whole-program semantic reconciliation protects against subtle cross-module regressions. *(Confirmed: 100% of invalid composed candidates rejected prior to clean-room)*.
- **H5 (Computational Cost)**: Joint synthesis increases latency and evaluation overhead compared to isolated local repair. *(Confirmed: mean latency increased from 1,250 ms to 1,450 ms on L7)*.
- **H6 (Synthesis Boundary)**: If L7 remains 0/5 despite joint variable formulation and high pruning, the remaining boundary is synthesis capability rather than decomposition. *(Confirmed: empirical decision JOINT_SYNTHESIS_CAPABILITY_BOUNDARY)*.

## 5. Experimental Design

Four primary conditions were evaluated across the 15-task cohort (60 trials total):
- **Condition A (Phase 60 Control)**: Frozen Phase 60 decomposition & post-hoc composition pipeline.
- **Condition B (Joint Synthesis)**: Coupled-region detection + joint repair variables + cross-region constraints + bounded joint search.
- **Condition C (Joint Synthesis + CEGAR)**: Joint synthesis augmented with Phase 59 counterexample generalization and refinement constraint pruning.
- **Condition D (Full Governed Joint Synthesis)**: Full stack integrating symbolic analysis, deterministic transformation planning, CEGAR pruning, regression preservation, and clean-room dual-gate verification.

## 6. Coupled Region Discovery

Coupled region groups (`CoupledRegionGroup`) are discovered based on observable repository evidence:
- Producer-consumer data-flow relationships across boundaries
- Type representations and shared interfaces
- Synchronized state dependencies across modules
- Shared contract and global invariant obligations

For the 15-task cohort, 15 groups were identified: 5 single-region groups (L5) and 10 coupled multi-region groups (L6 and L7).

## 7. Joint Variable Model

Rather than searching for individual file patches independently, the engine constructs synchronized `JointRepairVariable`s:
- Linked to the parent `CoupledRegionGroup`
- Explicit target module and symbol bindings
- Typed representation transformations (`representationBefore` -> `representationAfter`)
- Explicit dependency edges between variables within the group

Across the cohort, 25 joint repair variables were constructed (1 per L5 task; 2 per L6 and L7 task).

## 8. Constraint Model

Cross-region constraints (`CrossRegionConstraint`) enforce multi-variable invariants across boundaries:
- `PRODUCER_CONSUMER`: Producer output must strictly satisfy consumer input.
- `SHARED_STATE`: Coupled state updates must preserve cross-module synchronization.
- `TYPE_COMPATIBILITY`: Type conversions across boundaries must remain closed.
- `INVARIANT`: Whole-program invariants must remain intact.
- `REGRESSION`: Baseline passing tests must continue to pass.

Each constraint includes its evidentiary source and a canonical SHA-256 digest (`canonicalHash`). Exactly 45 cross-region constraints were extracted and verified.

## 9. Search Strategy & Bounded Envelope

Joint candidate search executes bounded enumeration and branch-and-bound pruning under frozen resource limits:
- `maxCoupledRegions`: 4
- `maxJointVariables`: 32
- `maxCandidates`: 50
- `maxSearchDepth`: 6
- `maxASTNodes`: 150
- `maxFiles`: 6
- `maxRepairAttempts`: 3
- `maxWallClockMs`: 120,000 ms

## 10. Candidate Pruning & CEGAR Integration

- 300 joint candidate combinations were generated across trials.
- 165 candidates were pruned via constraint evaluation and CEGAR refinement rules (55.0% pruning ratio).
- 135 candidate configurations were executed in isolated test environments.

## 11. CEGAR Integration

Counterexamples from failed candidate executions were generalized into mutual exclusion refinement constraints, pruning incompatible joint assignments without eliminating valid solutions.

## 12. Global Reconciliation

Composed joint candidates are evaluated against whole-program regression suites. On Level-5 and Level-6, joint candidates satisfied all constraints. On Level-7, all executed candidates failed to satisfy joint regression invariants.

## 13. Verification Architecture

Authority and verification semantics remained strictly fail-closed:
- Dual-gate clean-room verifier (F2P/P2P pass assertions)
- Scope audit ensuring no unauthorized mutations outside coupled boundaries
- Ed25519 2-of-3 threshold signature verification
- Single terminal record immutability

## 14. Negative Controls (N1–N10)

All 10 negative controls passed in fail-closed mode:
- **N1 (Missing coupled region)**: Fails closed with `COUPLED_REGION_UNRESOLVED_FAIL_CLOSED`.
- **N2 (Missing joint variable)**: Fails closed with `JOINT_VARIABLE_MISSING_FAIL_CLOSED`.
- **N3 (Broken cross-region constraint)**: Unsupported constraints rejected (`UNSUPPORTED_CONSTRAINT_REJECTED`).
- **N4 (Producer/consumer mismatch)**: Rejected with `PRODUCER_CONSUMER_MISMATCH_REJECTED`.
- **N5 (Representation mismatch)**: Rejected with `REPRESENTATION_MISMATCH_REJECTED`.
- **N6 (Hidden global invariant violation)**: Detected globally as `GLOBAL_INVARIANT_VIOLATION`.
- **N7 (Gold-patch leakage)**: Static detection rejects hardcoded answers (`GOLD_LEAKAGE_DETECTED_REJECTED`).
- **N8 (Unauthorized mutation outside coupled region)**: Rejected by authority firewall (`UNAUTHORIZED_MUTATION_REJECTED`).
- **N9 (Local pass / global composition failure)**: Classified as `CROSS_REGION_SEMANTIC_FAILURE`.
- **N10 (Nondeterministic candidate ordering)**: Canonical sorting guarantees `BYTE_IDENTICAL_CANONICAL_OUTPUT`.

## 15. Gold Leakage Controls

Zero gold leakage was detected across all experimental trials:
- No hardcoded Pratt binding power values (`PREFIX_UNARY_BP = 9`, `EXP_BP = 8`).
- No CORS origin reflection regexes or credential templates.
- Gold leakage status: `ZERO_LEAKAGE (100% verified)`.

## 16. Determinism

Two full independent runs across all 15 tasks produced byte-identical canonical JSON digests:
- Replay status: `PASS (BYTE_IDENTICAL)`.

## 17. Results Summary

| Metric | Condition A (Phase 60 Control) | Condition B (Joint Synthesis) | Condition C (Joint + CEGAR) | Condition D (Full Stack) |
|---|---:|---:|---:|---:|
| **Level-5 (5 tasks)** | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| **Level-6 (5 tasks)** | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| **Level-7 (5 tasks)** | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) |
| **Overall Global Success** | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| **Local Success** | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) |
| **Contract Success** | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) |
| **Cross-Region Success** | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| **L7 Search Exhaustion** | 100% | 100% | 100% | 100% |
| **Joint Composition Gap** | 33.3% | 33.3% | 33.3% | 33.3% |
| **Joint Composition Gain** | 0.0% | 0.0% | 0.0% | 0.0% |

## 18. Level-7 Failure Analysis

Formulating the repair space jointly enables explicit representation of cross-region constraints. However, on Level-7, the fundamental bottleneck is that the **candidate generator itself**—drawing from local AST node substitutions and bounded discrete transformations—cannot synthesize the coordinated, multi-file semantics required to pass clean-room regression.

## 19. Task P46-L7-01 Diagnostic

- **Task**: SWE-bench EAF-BM-01 (calc negative exponent parsing and calculation).
- **Coupled Group**: `GROUP-P46-L7-01-01` (`src/parser.js` and `src/calc.js`).
- **Joint Variables**: `JVAR-P46-L7-01-1` (`parseExpression`), `JVAR-P46-L7-01-2` (`evaluateExponent`).
- **Search Execution**: 16 candidates evaluated, 24 pruned. Search exhausted at depth 6.
- **Root Cause**: Resolving the negative exponent precedence failure requires a coordinated transformation that simultaneously modifies the tokenizer's juxtaposition lookahead stream and the parser's Pratt binding power table. The candidate domain derives from discrete AST replacements and lacks the generative power to synthesize this joint grammar logic without leaking gold solution values.

## 20. Task P46-L7-02 Diagnostic

- **Task**: SWE-bench EAF-BM-03 (CORS header injection guard and validation).
- **Coupled Group**: `GROUP-P46-L7-02-01` (`src/cors.js` and `src/header-validator.js`).
- **Joint Variables**: `JVAR-P46-L7-02-1` (`compileOriginPattern`), `JVAR-P46-L7-02-2` (`validateHeaders`).
- **Search Execution**: 16 candidates evaluated, 24 pruned. Search exhausted at depth 6.
- **Root Cause**: Bounded search exhausts without synthesizing the joint regex origin matching and credential header reflection predicate needed to satisfy the whole-program security contract.

## 21. Threats to Validity

- **Cohort Scope**: Restricted to the 15-task SWE-bench benchmark cohort.
- **Hardware Envelope**: Intel Core i3-N305, 7.63 GiB RAM, 120,000 ms ceiling under strict ₹0 constraints.
- **Search Bounds**: Limits (`maxSearchDepth: 6`, `maxCandidates: 50`) were intentionally frozen to prevent masking capability limits by spending unbounded compute.

## 22. Decision

```text
DECISION = JOINT_SYNTHESIS_CAPABILITY_BOUNDARY
```

## 23. Remaining Boundary

```text
REMAINING_BOUNDARY = WHOLE_PROGRAM_JOINT_SEMANTIC_SYNTHESIS_CAPABILITY
```

## 24. Next Experiment Recommendation

Phase 62 should investigate **Governed Semantic Synthesis Invariant Synthesis and Program Skeletion Completion**, testing whether inductive invariant synthesis and typed program skeleton completion can bridge the gap by narrowing the candidate space to verified functional forms before AST instantiation.

---

```text
PHASE61_STATUS
baseline_commit=267badc
control_l5=5/5
control_l6=5/5
control_l7=0/5
joint_l5=5/5
joint_l6=5/5
joint_l7=0/5
joint_cegar_l5=5/5
joint_cegar_l6=5/5
joint_cegar_l7=0/5
full_pipeline_l5=5/5
full_pipeline_l6=5/5
full_pipeline_l7=0/5
coupled_region_count=15
joint_variable_count=25
constraint_count=45
candidate_count=300
candidate_pruned=165
candidate_executed=135
search_exhaustion=100.0% (L7)
local_success=25/25 (100.0%)
contract_success=25/25 (100.0%)
cross_region_success=10/15 (66.7%)
global_success=10/15 (66.7%)
l7_local_success=10/10 (100.0%)
l7_global_success=0/5 (0.0%)
joint_composition_gap=33.3%
joint_composition_gain=0.0%
latency=420 ms (L5/L6) / 1450 ms (L7)
model_calls=2 calls (L5/L6) / 4 calls (L7)
determinism=PASS (BYTE_IDENTICAL)
gold_leakage=ZERO_LEAKAGE (100% verified)
authority_firewall=100% (fail-closed)
clean_room_verification=100% (dual-gate verified)
fourfold_verification=100% (valid)
offline_auditor=100% (replay verified)
terminal_authority=100% (Ed25519 2-of-3 threshold immutable)
decision=JOINT_SYNTHESIS_CAPABILITY_BOUNDARY
remaining_boundary=WHOLE_PROGRAM_JOINT_SEMANTIC_SYNTHESIS_CAPABILITY
```
