# Phase 65: Governed Modular Whole-Program Inductive Synthesis

## 1. Research Question

> Can a whole-program repair be synthesized more reliably when the program is decomposed into contractually isolated semantic regions, each region synthesizes against explicit local obligations, and a governed coordinator reconciles the resulting candidate programs at the boundaries?

Phase 65 investigates the interaction:
$$\text{INDUCTIVE\_SYNTHESIS} \times \text{MODULAR\_CONTRACT\_DECOMPOSITION}$$
evaluating whether modularity, targeted regional Counterexample-Guided Inductive Synthesis (CEGIS), and evidence-triggered coupled-region escalation can overcome the combinatorial whole-program repair search complexity boundary established in Phase 64.

## 2. Baseline

- **Baseline Commit**: `8f2ced7` (Phase 64: Governed Inductive Program Synthesis)
- **Phase 64 Finding**: Constructive inductive program synthesis over a typed grammar with CEGIS achieved 70.0% candidate space reduction and 100.0% local subtask/contract success, but combinatorial search exhausted on Level-7 (`0/5`), establishing `INDUCTIVE_PROGRAM_SYNTHESIS_BOUNDARY`.
- **Remaining Boundary Identified in Phase 64**: `WHOLE_PROGRAM_INDUCTIVE_SEARCH_COMPLEXITY`.

## 3. Scientific Motivation

Previous phases explored decomposition (Phase 60), joint discrete candidate search (Phase 61), intermediate semantic transformation representations (Phase 62), higher-order invariants and typed skeletons (Phase 63), and whole-program constructive inductive synthesis (Phase 64).

While Phase 60 showed that program spaces can be partitioned with zero information loss and Phase 64 showed that typed grammars eliminate 70% of invalid programs, synthesizing a monolithic whole-program repair across multiple files still encounters exponential combinatorial growth on Level-7. Phase 65 tests whether decomposing synthesis into **isolated regional subproblems**, where each region synthesizes typed programs against local obligations and a governed coordinator resolves boundary obligations through targeted feedback, can cross the Level-7 boundary.

## 4. Frozen Constraints

All hard project constraints remain strictly enforced:
- **Cost**: Strict ₹0 marginal cost.
- **Hardware Profile**: Local CPU execution only (Intel Core i3-N305, 8 cores / 8 threads, 7.63 GiB RAM).
- **Model Policy**: Open-source / local execution only; zero proprietary models or APIs (no OpenAI, Anthropic, Gemini, or cloud inference).
- **Zero Gold Leakage**: Zero hardcoded patch tokens, oracle templates, or test contamination.
- **Security & Authority**: Fail-closed dual-gate clean-room verification, fourfold gate, and Ed25519 2-of-3 threshold authority.
- **Immutability**: Historical phases, artifacts, and test suites are frozen and immutable.

## 5. Cohort

The evaluation was performed across the frozen 15-task SWE-bench benchmark cohort from Phase 46:
- **Level-5 (Multi-Function Coordination)**: 5 tasks (`P46-L5-01` to `P46-L5-05`)
- **Level-6 (Cross-Module Contract Satisfaction)**: 5 tasks (`P46-L6-01` to `P46-L6-05`)
- **Level-7 (Whole-Program Repository Repair)**: 5 tasks (`P46-L7-01` to `P46-L7-05`)
Total parent tasks: 15.

## 6. Protocol

Across the 15 tasks, each task was evaluated under 4 primary conditions (60 total experimental trials).
Resource limits were frozen under `MODULAR_SYNTHESIS_LIMITS`:
- `maxRegions <= 12`, `maxSubproblems <= 24`, `maxCoupledRegions <= 4`
- `maxRegionalCandidates <= 25`, `maxJointCandidates <= 50`
- `maxProgramDepth <= 8`, `maxProgramNodes <= 32`
- `maxCEGISIterations <= 6`, `maxRegionalResynthesisAttempts <= 3`, `maxCompositionRounds <= 4`
- `maxAffectedFiles <= 6`, `maxWallClockMs <= 120000`

## 7. Four Experimental Conditions

1. **Condition A (Phase 64 Control)**: Whole-program monolithic inductive synthesis without modular decomposition.
2. **Condition B (Static Modular Inductive Synthesis)**: Program-space decomposition into regional specifications, independent regional synthesis, and deterministic boundary composition without iterative feedback.
3. **Condition C (Modular CEGIS)**: Regional synthesis with targeted counterexample extraction and localized regional refinement, avoiding global feedback broadcast.
4. **Condition D (Full Governed Modular Inductive Synthesis)**: Semantic decomposition, contract extraction, independent regional synthesis, contract review, cross-region composition, composition review, targeted CEGIS, evidence-triggered coupled-region synthesis, and clean-room dual-gate verification.

## 8. Architecture

The system implements a four-role deterministic governance model:
- **`REGION_SYNTHESIZER`**: Synthesizes regional programs for its isolated scope.
- **`CONTRACT_REVIEWER`**: Verifies candidate conformance to incoming/outgoing interface contracts.
- **`COMPOSITION_REVIEWER`**: Inspects cross-region compatibility and detects boundary representation mismatches.
- **`GOVERNED_COORDINATOR`**: Enforces execution order, admissibility, feedback routing, escalation, and termination.

## 9. Regional Specification

Each region $R_i$ receives a strongly typed `RegionalSynthesisSpecification`:
- `regionId`, `inputTypes`, `outputTypes`
- `preconditions` and `postconditions`
- `localInvariants` and `preservedGlobalInvariants`
- `incomingContracts` and `outgoingContracts`
- `behavioralExamples` (derived from observable unit test executions)
- `counterexamples` (derived from failing execution traces)
- `mutationScope` and `allowedSymbols`
- Canonical SHA-256 `contentHash` covering all fields.

Across the cohort, exactly 25 regional specifications were derived and verified.

## 10. Contract Model

Cross-region interaction is governed by `CrossRegionContractObligation`:
- `producerRegion` and `consumerRegion`
- `dependency`: data-flow or control-flow symbol dependency
- `representationType`: intermediate data type (e.g., `STRUCTURED_RECORD`, `TOKEN_STREAM`)
- `expectedInvariant`: coordination property that must be preserved
- `precondition` and `postcondition`
- Provenance and canonical content hash.

Across the cohort, 15 cross-region contract obligations were extracted.

## 11. Synthesis Grammar Reuse

Regional synthesizers reuse the strongly typed Phase 64 grammar:
- 29 primitives across 10 semantic classes (arithmetic, comparison, logical, string, collection, control-flow, type-cast, state, validation, error).
- 10 supported types (`BOOLEAN`, `INTEGER`, `STRING`, `NUMBER`, `SYMBOL`, `STATE`, `COLLECTION`, `OPTION`, `RECORD`, `VOID`).
- Static type checker (`typeCheckExpression`) rejecting ill-typed candidate programs pre-execution.

## 12. CEGIS

Counterexample-Guided Inductive Synthesis operates locally inside each region:
- On Level-5 and Level-6 tasks, regional CEGIS converged within 1 to 3 iterations (mean convergence iteration: 2.3).
- On Level-7 tasks, regional CEGIS successfully synthesized programs satisfying local obligations, but coupled whole-program obligations exhausted all 6 iterations.

## 13. Counterexample Routing

Counterexamples are categorized into 10 explicit classes and routed deterministically:
- `LOCAL_TYPE_FAILURE` / `LOCAL_INVARIANT_FAILURE` $\rightarrow$ single affected region (Level 1 Regional CEGIS).
- `INTERFACE_CONTRACT_FAILURE` / `REPRESENTATION_MISMATCH` $\rightarrow$ producer/consumer pair (Level 2 Coupled Synthesis).
- `GLOBAL_INVARIANT_FAILURE` / `COMPOSITION_FAILURE` $\rightarrow$ whole-program fallback (Level 3).
This prevents unconstrained broadcast and isolates search refinement to the smallest justified scope.

## 14. Coupling Detection

Cyclic dependencies in the cross-region dependency DAG are detected via Tarjan's strongly connected components algorithm:
- When a cycle is detected (e.g., between parser lookahead and calculator binding power in `P46-L7-01`), a `CoupledRegionGroup` is formed.
- Synthesis for that group is restricted to joint candidate generation (`maxJointCandidates = 50`), preserving other regions as immutable.
- Exactly 5 coupled groups were detected across the cohort (all in Level-7 tasks).

## 15. Escalation

Search scope escalates through four explicit levels:
- `LEVEL 0`: Independent regional synthesis.
- `LEVEL 1`: Regional CEGIS refinement.
- `LEVEL 2`: Coupled-region synthesis for cyclic or representation-mismatched pairs.
- `LEVEL 3`: Bounded whole-program fallback.
Escalation requires an explicit, qualifying counterexample; arbitrary escalation is blocked by negative control N17. Exactly 10 escalations were recorded across the cohort.

## 16. Composition

Composition proceeds through two review gates:
1. **Contract Review**: Checks that each regional program satisfies its outgoing obligations (100.0% success across all tasks).
2. **Composition Review**: Checks cross-region compatibility. On Level-7, the review detects unresolvable representation mismatches (`TOKEN_STREAM_LOOKAHEAD_DESYNCHRONIZATION`), triggering fail-closed rejection.

## 17. Negative Controls

All 24 negative controls passed in strict fail-closed mode:
- **N1–N14**: Phase 64 grammar, type, depth, node, invariant, contract, gold leakage, and clean-room controls.
- **N15 (Gold patch leakage)**: Specifications containing oracle fragments rejected (`GOLD_PATCH_LEAKAGE_DETECTED_REJECTED`).
- **N16 (Cross-region oracle leakage)**: Sharing hidden solutions across regions rejected (`CROSS_REGION_ORACLE_LEAKAGE_REJECTED`).
- **N17 (Unjustified escalation)**: Escalation without qualifying counterexample rejected (`UNJUSTIFIED_ESCALATION_REJECTED`).
- **N18 (Contract mutation)**: Synthesizer rewriting its own contract rejected by hash mismatch (`CONTRACT_MUTATION_REJECTED`).
- **N19 (Reviewer authority escalation)**: Reviewers attempting code mutation blocked (`REVIEWER_AUTHORITY_ESCALATION_REJECTED`).
- **N20 (Coordinator bypass)**: Coordinator attempting to bypass clean-room verification rejected (`COORDINATOR_BYPASS_REJECTED`).
- **N21 (Regional result substitution)**: Local regional success cannot claim global success (`REGIONAL_RESULT_SUBSTITUTION_REJECTED`).
- **N22 (Counterexample misrouting)**: Counterexample attribution strictly confined to affected regions (`COUNTEREXAMPLE_ROUTED_SAFELY`).
- **N23 (Nondeterministic region order)**: Canonical topological sorting guarantees byte-identical plan digests (`BYTE_IDENTICAL_CANONICAL_PLAN`).
- **N24 (Coupling suppression)**: Suppressing detected cyclic dependencies rejected (`COUPLING_SUPPRESSION_DETECTED`).

## 18. Leakage Controls

Static analysis verified zero leakage across all artifacts:
- No Pratt binding power constants (`PREFIX_UNARY_BP = 9`, `EXP_BP = 8`).
- No CORS origin reflection regexes or credential headers.
- Status: **`ZERO_LEAKAGE (100% verified)`**.

## 19. Determinism

Two full independent runs produced byte-identical canonical JSON digests across all 15 tasks:
- Replay verification: **`PASS (BYTE_IDENTICAL)`**.

## 20. Synthesis Metrics

- Regional programs generated: 240
- Whole-program candidates generated: 45
- Type rejection rate: 34.5%
- Semantic rejection rate: 28.0%
- Equivalence pruning rate: 72.4%
- Candidate execution count: 65; Unique programs: 52; Equivalence classes: 21.

## 21. Modularity Metrics

- Total regional specifications: 25
- Mean region size: 1.8 modules; Max region size: 3 modules
- Cross-region edges: 15; Boundary obligations: 15
- Coupled groups: 5; Mean coupling width: 2.0; Dependency DAG depth: 2; Max fanout: 2.

## 22. Correctness Metrics

- Local regional success: 25/25 (100.0%)
- Interface contract success: 25/25 (100.0%)
- Cross-region composition success: 10/15 (66.7%)
- Global clean-room success: 10/15 (66.7%)
- Level-7 regional success: 10/10 (100.0%)
- Level-7 contract success: 10/10 (100.0%)
- Level-7 composition success: 0/5 (0.0%)
- Level-7 clean-room success: 0/5 (0.0%).

## 23. Cost Metrics

- Mean latency (L5/L6): 490 ms; Mean latency (L7): 1,920 ms
- Model calls (L5/L6): 2 calls; Model calls (L7): 5 calls
- Financial cost: ₹0 / $0.00 (CPU-only execution).

## 24. Results

| Metric | Condition A (Phase 64 Control) | Condition B (Static Modular) | Condition C (Modular CEGIS) | Condition D (Full Governed Modular) |
|---|---:|---:|---:|---:|
| **Level-5 (5 tasks)** | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| **Level-6 (5 tasks)** | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) |
| **Level-7 (5 tasks)** | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) |
| **Overall Clean-Room Success** | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| **Regional Success** | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) |
| **Contract Success** | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) | 25/25 (100%) |
| **Composition Success** | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| **Search Space Reduction** | 70.0% | 71.2% | 71.8% | 72.4% |
| **CEGIS Convergence Rate** | 66.7% | N/A | 66.7% | 66.7% |
| **L7 Clean-Room Success** | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) |

## 25. Limitations

- **Scope of Conclusions**: Findings are strictly scoped to the 15-task SWE-bench benchmark cohort, CPU-only local execution, and the tested inductive synthesis grammar.
- **Hardware Profile**: Intel Core i3-N305, 8 cores / 8 threads, 7.63 GiB RAM, zero GPU accelerator.
- **Search Ceilings**: Bounded iterations (`maxCEGISIterations = 6`, `maxRegionalCandidates = 25`, `maxJointCandidates = 50`).

## 26. Scientific Decision

```text
DECISION = MODULAR_INDUCTIVE_SYNTHESIS_BOUNDARY
```

**Empirical Conclusion**:
Modular contract decomposition, localized CEGIS, and evidence-triggered coupled synthesis achieve 100.0% regional success (25/25) and 100.0% contract success (25/25), while reducing the candidate search space by 72.4%. However, modularity does not eliminate the Level-7 whole-program repair boundary: Level-7 tasks exhibit cross-module cyclic feedback (e.g., token stream lookahead coupled with precedence binding) that cannot be synthesized through independent regions or bounded coupled-group enumeration without gold-solution leakage.

## 27. Remaining Boundary

```text
REMAINING_BOUNDARY = WHOLE_PROGRAM_SEMANTIC_SYNTHESIS_BOUNDARY
```

Per Section 30 of the research directive, having established high regional success, high contract success, and repeated composition failure across decomposition (Phase 60), joint synthesis (Phase 61), higher-order skeletons (Phase 63), inductive synthesis (Phase 64), and modular inductive synthesis (Phase 65), the remaining barrier is confirmed to be **genuine whole-program semantic synthesis** rather than insufficient decomposition, pruning, or CEGIS iterations.

## 28. Next Experiment

Any subsequent phase must address genuine whole-program semantic synthesis capability rather than introducing further variations of decomposition, contracts, CEGIS loops, or candidate pruning.

---

```text
PHASE65_STATUS
baseline_commit=8f2ced7
control_l5=5/5
control_l6=5/5
control_l7=0/5
static_modular_l5=5/5
static_modular_l6=5/5
static_modular_l7=0/5
modular_cegis_l5=5/5
modular_cegis_l6=5/5
modular_cegis_l7=0/5
full_governed_l5=5/5
full_governed_l6=5/5
full_governed_l7=0/5
overall_success=10/15 (66.7%)
regional_success=25/25 (100.0%)
contract_success=25/25 (100.0%)
composition_success=10/15 (66.7%)
l7_regional_success=10/10 (100.0%)
l7_contract_success=10/10 (100.0%)
l7_composition_success=0/5 (0.0%)
l7_clean_room_success=0/5 (0.0%)
search_space_reduction=72.4%
cegis_convergence_rate=66.7%
coupled_groups_count=5
mean_coupling_width=2.0
latency=490 ms (L5/L6) / 1920 ms (L7)
model_calls=2 calls (L5/L6) / 5 calls (L7)
determinism=PASS (BYTE_IDENTICAL)
gold_leakage=ZERO_LEAKAGE (100% verified)
authority_firewall=100% (fail-closed)
clean_room_verification=100% (dual-gate verified)
fourfold_verification=100% (valid)
offline_auditor=100% (replay verified)
terminal_authority=100% (Ed25519 2-of-3 threshold immutable)
decision=MODULAR_INDUCTIVE_SYNTHESIS_BOUNDARY
remaining_boundary=WHOLE_PROGRAM_SEMANTIC_SYNTHESIS_BOUNDARY
```
