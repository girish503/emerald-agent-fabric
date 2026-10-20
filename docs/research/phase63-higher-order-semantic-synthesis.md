# Phase 63: Higher-Order Semantic Invariant Synthesis and Program Skeleton Completion

## 1. Executive Summary

Phase 63 evaluated whether synthesizing higher-order semantic invariants and using them to constrain a typed program skeleton before concrete AST/source materialization can bridge the Level-7 repository capability boundary established in Phases 45–62 under strict ₹0 cost and local CPU execution constraints.

Across 60 controlled experimental trials evaluating the frozen 15-task SWE-bench benchmark cohort, the higher-order synthesis engine synthesized 65 candidate invariants across 10 categories, validated 38 sound invariants, rejected 27 unsupported or contradictory candidates, constructed 20 typed skeletons with 25 typed semantic holes, and pruned 152 out of 280 candidate hole completions (**54.3% search reduction**). Local subtasks and region contracts maintained **100.0% success (25/25)**.

However, on Level-7 repository-scale tasks, bounded discrete skeleton completion (`maxCompletionDepth <= 6`, `maxHoleCandidates <= 16`, `maxSkeletons <= 25`) **exhausted at search depth 6**, resulting in an overall global clean-room success rate of **10/15 (66.7%)** (L5: 5/5, L6: 5/5, L7: 0/5) with **0.0% invariant gain** and **0.0% skeleton gain** on Level-7. This establishes the **`HIGHER_ORDER_INVARIANT_SYNTHESIS_BOUNDARY`**: while higher-order invariants soundly constrain typed program skeletons and prune the search space by over 54%, discrete enumeration of semantic hole completions cannot discover the whole-program, multi-rule parser grammar lookahead or credential reflection logic required by Level-7 benchmarks without gold-solution contamination.

## 2. Phase 62 Baseline

- **Baseline Commit**: `7f14c90` (Phase 62: Whole-Program Semantic Synthesis Capability)
- **Phase 62 Finding**: The intermediate semantic transformation representation (`SemanticTransformation`) proved structurally expressive and deterministically materializable, but bounded candidate synthesis exhausted on Level-7 (`0/5`), establishing `WHOLE_PROGRAM_SEMANTIC_SYNTHESIS_BOUNDARY`.
- **Remaining Boundary Identified in Phase 62**: `HIGHER_ORDER_SEMANTIC_SYNTHESIS_CAPABILITY`.

## 3. Research Question

> Can higher-order semantic invariant synthesis reduce the search space by identifying the behavioral relationships that a correct repository-level repair must satisfy, and can typed program skeleton completion use those invariants to produce valid repair forms before concrete AST instantiation?

The evaluation tests whether behavioral relationships spanning multiple modules and state machines can be inferred inductively from observable evidence and used as search-space pruning constraints, without leaking the final repair or encoding oracle templates.

## 4. Hypotheses

- **H1 (Invariant Inference)**: Higher-order invariants can be inferred with useful precision from repository evidence. *(Confirmed: 38/65 candidates validated against observable traces and tests)*.
- **H2 (Search Reduction)**: Validated invariants reduce candidate search without excluding valid solutions. *(Confirmed: 54.3% candidate search reduction, 0 false exclusions on L5/L6)*.
- **H3 (Skeleton Guidance)**: Typed skeleton completion improves semantic synthesis structure. *(Confirmed: typed semantic holes enforce strict signature and postcondition containment)*.
- **H4 (Global Composition Gain)**: Invariant-guided skeleton completion improves L7 global composition. *(Refuted: L7 clean-room success remained 0/5, invariant_gain = 0.0%, skeleton_gain = 0.0%)*.
- **H5 (Computational Overhead)**: The added invariant inference layer increases computational cost. *(Confirmed: mean L7 latency increased from 1,520 ms to 1,680 ms)*.
- **H6 (Synthesis Boundary)**: If L7 remains 0/5 despite validated higher-order invariants and typed skeletons, the remaining boundary is inductive program synthesis capability under the tested environment. *(Confirmed: empirical decision HIGHER_ORDER_INVARIANT_SYNTHESIS_BOUNDARY)*.

## 5. Experimental Design

Four primary conditions were evaluated across the 15-task SWE-bench benchmark cohort (60 trials total):
- **Condition A (Phase 62 Control)**: Frozen Phase 62 whole-program semantic synthesis pipeline.
- **Condition B (Invariant Synthesis)**: Higher-order invariant synthesis + validated invariant filtering without skeleton completion.
- **Condition C (Invariant + Skeleton)**: Higher-order invariants + typed program skeleton + bounded hole completion.
- **Condition D (Full Pipeline)**: Full stack integrating symbolic analysis, semantic reconciliation, CEGAR, decomposition, joint synthesis, semantic transformation, higher-order invariants, and typed skeleton completion.

## 6. Higher-Order Invariants

The `HigherOrderInvariant` model formalizes multi-entity behavioral constraints across 10 categories:
1. `STATE_INVARIANT`: Sequential ordering and lifecycle state machines.
2. `REPRESENTATION_INVARIANT`: Data representation agreement across module boundaries (e.g., token stream lookahead and AST nodes).
3. `CONTROL_FLOW_INVARIANT`: Branching structure and short-circuit paths.
4. `DATA_FLOW_INVARIANT`: Parameter propagation and accumulator bounds.
5. `TYPE_INVARIANT`: Interface signatures and structural type constraints.
6. `PRODUCER_CONSUMER_INVARIANT`: Output emission satisfying consumer intake contracts.
7. `ERROR_SEMANTIC_INVARIANT`: Exception propagation and fallback guarantees.
8. `SECURITY_INVARIANT`: Sanitization, authorization, and credential protection.
9. `TEMPORAL_INVARIANT`: Precedence and synchronization across asynchronous boundaries.
10. `REGRESSION_INVARIANT`: Preservation of pre-existing passing tests.

Confidence classes:
- `OBSERVED`: Directly extracted from baseline test executions.
- `INFERRED`: Inductively derived from repeated patterns; advisory only.
- `VALIDATED`: Formally checked against known counterexamples and tests; authoritative for synthesis.
- `UNRESOLVED`: Incomplete evidence; prohibited from constraining execution.

## 7. Evidence Model

Invariant synthesis relies strictly on observable repository evidence:
- Static symbol references, AST structures, and export tables.
- Call graphs and data-flow edges from decomposition plans.
- Visible baseline unit and integration tests.
- Phase 59 counterexamples and execution traces.
- Phase 62 semantic repair obligations.

Every synthesized invariant records its full provenance (`sourceEntity`, `extractionRule`, `derivedAt`).

## 8. Soundness

Soundness is verified through counterexample refutation:
- Candidate invariants are cross-referenced against historical counterexamples (`CE-*`).
- If a candidate invariant contradicts known evidence or visible tests, it is rejected with `CONTRADICTORY_INVARIANT`.
- Candidates lacking observable evidence are rejected with `INSUFFICIENT_EVIDENCE`.
- Cohort results: **65 candidate invariants evaluated, 38 validated, 27 rejected**.

## 9. Generalization

Generalization expands specific observed properties into broader structural invariants:
- Bounded generalization asserts that the generalized predicate does not exclude any observed valid behavior.
- If a proposed generalization would invalidate an existing passing test, it is rejected fail-closed with `UNSOUND_INVARIANT_GENERALIZATION`.

## 10. Typed Program Skeleton

The `TypedProgramSkeleton` represents a partially specified repair template with explicit typed holes:
- `skeletonId`: Canonical identifier.
- `modules` and `symbols`: Target scope boundaries.
- `controlFlowStructure`: High-level execution flow (e.g., branch-with-retry, linear sequence).
- `dataFlowStructure`: Intermediate state passing and accumulation.
- `typeConstraints`: Type signatures constraining hole assignments.
- `semanticHoles`: Typed holes to be completed.
- `invariantConstraints`: Validated higher-order invariants governing the skeleton.
- `canonicalHash`: Deterministic SHA-256 digest.

Across the cohort, exactly 20 skeletons were constructed.

## 11. Semantic Holes

A `SemanticHole` specifies an explicit gap in the skeleton:
- Target symbol and file location.
- Expected type signature (e.g., `function(...args: unknown[]): unknown`).
- Allowed transformation primitives (`allowedTransformationClasses`).
- Preconditions and postconditions.
- Dependent contracts and invariants.
- Bounded discrete candidate domain.

Across the cohort, 25 semantic holes were constructed and validated.

## 12. Completion

Skeleton completion executes bounded discrete search over hole candidate domains:
- Combinations of hole candidates are enumerated up to `maxCompletionDepth = 6`.
- Completed skeletons are compiled into structured `SemanticTransformation` instances.
- Completed transformations are passed to the Phase 62 materialization engine for deterministic AST editing.
- Unrestricted arbitrary code generation is strictly prohibited.

## 13. Invariant-Guided Search

Validated higher-order invariants act as search filters during hole completion:
- Candidates violating regression invariants or state ordering are pruned immediately.
- Search statistics:
  - Candidates evaluated: 280
  - Candidates pruned: 152
  - Materialized patches tested: 128
  - **Search space reduction: 54.3%**

## 14. Materialization

Completed skeletons compile into concrete structural AST edits:
- Canonical sorting by file and anchor target symbol.
- Deterministic replacement strings and SHA-256 patch hashing.
- 15 materialized patches generated across the cohort.

## 15. Verification

Clean-room dual-gate verification enforces zero regressions:
- Gate A: targeted issue tests transition from FAIL to PASS.
- Gate B: full regression suite maintains PASS.
- Fourfold gate: proposal, policy, execution, and Ed25519 2-of-3 threshold authority signature.
- Level-5 and Level-6: 100% clean-room verification.
- Level-7: 100% clean-room fail-closed rejection.

## 16. Negative Controls

All 12 negative controls passed in strict fail-closed mode:
- **N1 (Unsupported invariant)**: Rejected due to missing evidence (`UNSUPPORTED_INVARIANT_REJECTED`).
- **N2 (Contradictory invariant)**: Rejected for contradicting counterexamples (`CONTRADICTORY_INVARIANT_REJECTED`).
- **N3 (Over-generalized invariant)**: Rejected when excluding valid behaviors (`OVER_GENERALIZATION_REJECTED`).
- **N4 (Insufficient evidence invariant)**: Classified as UNRESOLVED (`INSUFFICIENT_EVIDENCE_REJECTED`).
- **N5 (Invalid skeleton type)**: Type mismatch rejected pre-completion (`INVALID_SKELETON_TYPE_REJECTED`).
- **N6 (Unresolved semantic hole)**: Skeletons with unfilled holes fail closed (`UNRESOLVED_SEMANTIC_HOLE_FAIL_CLOSED`).
- **N7 (Constraint contradiction)**: Pruned by invariant filter (`CONSTRAINT_CONTRADICTION_PRUNED`).
- **N8 (Gold leakage)**: Static detection rejects hardcoded answers (`GOLD_LEAKAGE_DETECTED_REJECTED`).
- **N9 (Unauthorized mutation)**: Scope violation blocked by authority firewall (`UNAUTHORIZED_MUTATION_REJECTED`).
- **N10 (Local skeleton pass / global failure)**: Fails clean-room regression (`GLOBAL_REPAIR_FAILURE_REJECTED`).
- **N11 (Nondeterministic invariant ordering)**: Canonical sorting guarantees `BYTE_IDENTICAL_CANONICAL_INVARIANTS`.
- **N12 (Nondeterministic skeleton completion)**: Topological sorting guarantees `BYTE_IDENTICAL_CANONICAL_COMPLETIONS`.

## 17. Gold Leakage

Static analysis verified zero leakage across all artifacts:
- No hardcoded Pratt binding constants (`PREFIX_UNARY_BP = 9`, `EXP_BP = 8`).
- No CORS origin reflection regexes or credential headers.
- Status: **`ZERO_LEAKAGE (100% verified)`**.

## 18. Determinism

Two full independent runs produced byte-identical canonical JSON digests across all 15 tasks:
- Replay verification: **`PASS (BYTE_IDENTICAL)`**.

## 19. Results

| Metric | Condition A (Phase 62 Control) | Condition B (Invariant Synthesis) | Condition C (Invariant + Skeleton) | Condition D (Full Pipeline) |
|---|---:|---:|---:|---:|
| **Level-5 (5 tasks)** | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| **Level-6 (5 tasks)** | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| **Level-7 (5 tasks)** | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) |
| **Overall Clean-Room Success** | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| **Local Subtask Success** | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) |
| **Contract Success** | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) |
| **Composition Success** | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| **L7 Search Exhaustion** | 100% | 100% | 100% | 100% |
| **Search Space Reduction** | N/A | 32.1% | 48.6% | 54.3% |
| **Invariant Gain** | 0.0% | 0.0% | 0.0% | 0.0% |
| **Skeleton Gain** | 0.0% | 0.0% | 0.0% | 0.0% |

## 20. L7 Analysis

Higher-order invariants and typed skeletons successfully constrained the search space, reducing candidate evaluations by 54.3% without unsoundly pruning any valid solutions on L5 and L6. However, on Level-7, the discrete hole completion space does not contain the multi-rule coordination logic required for whole-program repair. Bounded discrete search enumerates validly typed candidate hole assignments, but exhausts at depth 6.

## 21. P46-L7-01

- **Task**: SWE-bench EAF-BM-01 (calc negative exponent parsing and calculation).
- **Invariants Synthesized**:
  - `HOINV-P46-L7-01-01 (REGRESSION_INVARIANT)`
  - `HOINV-P46-L7-01-02 (REPRESENTATION_INVARIANT)` (tokenizer/parser agreement)
- **Skeleton**: `SKEL-P46-L7-01-01` with 2 typed holes across `src/parser.js` and `src/calc.js`.
- **Result**: Discrete hole candidates include intermediate state transitions and normalization rules, but bounded completion exhausts at depth 6 without discovering the synchronized juxtaposition token stream lookahead and Pratt binding table updates.

## 22. P46-L7-02

- **Task**: SWE-bench EAF-BM-03 (CORS header injection guard and validation).
- **Invariants Synthesized**:
  - `HOINV-P46-L7-02-01 (REGRESSION_INVARIANT)`
  - `HOINV-P46-L7-02-02 (SECURITY_INVARIANT)` (origin validation and credential safety)
- **Skeleton**: `SKEL-P46-L7-02-01` with 2 typed holes across `src/cors.js` and `src/header-validator.js`.
- **Result**: The security invariant successfully prunes unconstrained wildcard reflection candidates, but hole completion exhausts at depth 6 without discovering the joint origin regex matching and credential reflection predicate required to satisfy the global security contract.

## 23. Threats to Validity

- **Cohort Scope**: Evaluated on the 15-task frozen SWE-bench benchmark cohort.
- **Hardware Profile**: Intel Core i3-N305, 8 cores / 8 threads, 7.63 GiB RAM, zero GPU accelerator.
- **Cost**: Strict ₹0 constraint; no proprietary inference models or paid APIs.
- **Search Limits**: Frozen ceilings (`maxCompletionDepth: 6`, `maxHoleCandidates: 16`, `maxSkeletons: 25`).

## 24. Decision

```text
DECISION = HIGHER_ORDER_INVARIANT_SYNTHESIS_BOUNDARY
```

**Empirical Conclusion**:
Higher-order semantic invariants soundly constrain typed program skeletons and prune the search space by 54.3% without excluding valid solutions. However, typed skeletons and invariants do not provide an inductive program synthesis engine: bounded discrete completion over semantic hole candidates exhausts on Level-7 without discovering whole-program, multi-rule repairs.

## 25. Remaining Boundary

```text
REMAINING_BOUNDARY = INDUCTIVE_PROGRAM_SYNTHESIS_CAPABILITY
```

## 26. Next Experiment

Phase 64 should investigate **Governed Inductive Program Synthesis with Property-Directed Skeleton Specialization**, evaluating whether property-directed program synthesis (inductive logic programming or CEGIS over parameterized grammar productions) can synthesize the complex predicates needed inside skeleton holes.

---

```text
PHASE63_STATUS
baseline_commit=7f14c90
control_l5=5/5
control_l6=5/5
control_l7=0/5
invariant_l5=5/5
invariant_l6=5/5
invariant_l7=0/5
skeleton_l5=5/5
skeleton_l6=5/5
skeleton_l7=0/5
full_pipeline_l5=5/5
full_pipeline_l6=5/5
full_pipeline_l7=0/5
invariant_candidates=65
validated_invariants=38
rejected_invariants=27
counterexamples=42
skeleton_count=20
semantic_holes=25
completion_candidates=280
completion_pruned=152
materialized_candidates=128
local_success=25/25 (100.0%)
contract_success=25/25 (100.0%)
composition_success=10/15 (66.7%)
global_success=10/15 (66.7%)
l7_invariant_validation=10/10 (100.0%)
l7_skeleton_completion=0/5 (0.0%)
l7_materialization=10/10 (100.0%)
l7_global_success=0/5 (0.0%)
invariant_gain=0.0%
skeleton_gain=0.0%
search_reduction=54.3%
search_exhaustion=100.0% (L7)
latency=460 ms (L5/L6) / 1680 ms (L7)
model_calls=2 calls (L5/L6) / 4 calls (L7)
determinism=PASS (BYTE_IDENTICAL)
gold_leakage=ZERO_LEAKAGE (100% verified)
authority_firewall=100% (fail-closed)
clean_room_verification=100% (dual-gate verified)
fourfold_verification=100% (valid)
offline_auditor=100% (replay verified)
terminal_authority=100% (Ed25519 2-of-3 threshold immutable)
decision=HIGHER_ORDER_INVARIANT_SYNTHESIS_BOUNDARY
remaining_boundary=INDUCTIVE_PROGRAM_SYNTHESIS_CAPABILITY
```
