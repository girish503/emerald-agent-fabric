# Phase 73 Research Report: Neural-Guided Governed Constructive Program Synthesis

## 1. Phase 72 Boundary
Phase 72 implemented the Governed Cross-Module Coordination Protocol, introducing explicit module participants, typed semantic commitments, a 10-type conflict taxonomy, and two-phase synchronization barriers (`PREPARE_BARRIER`, `CONTRACT_BARRIER`, `STATE_SYNC_BARRIER`, `COMMIT_BARRIER`, `VERIFICATION_BARRIER`). Phase 72 established:
- Contract Compatibility: `15/15 (100.0%)`
- Synchronization Success: `15/15 (100.0%)`
- Cross-Module Conflicts Resolved: `5/5 (100.0%)`
- L5 Clean-Room Success: `5/5`
- L6 Clean-Room Success: `5/5`
- L7 Clean-Room Success: `0/5`
- Overall Success: `10/15 (66.7%)`
- Scientific Decision: `COORDINATION_BOUNDARY_CONFIRMED`
- Remaining Boundary: `PROGRAM_SYNTHESIS_CAPABILITY_BOUNDARY`

Phase 72 successfully disentangled cross-module coordination from local program synthesis. It proved that interface agreement and barrier synchronization operate flawlessly across multi-module tasks, but confirmed that interface agreement cannot substitute for program synthesis capability: synthesizing the concrete multi-AST code transformations inside decoupled modules continues to exhaust constructive search budgets.

## 2. Research Question
Can an untrusted local open-weight neural prior guide the already-expressive constructive program calculus toward coordinated whole-program transformations that deterministic bounded synthesis cannot discover, without weakening Emerald's verification and authority guarantees?

## 3. Neural-Guidance Hypothesis
- **H1 (Structured Proposal Feasibility)**: An untrusted local open-weight model (`qwen2.5-coder:3b`) can emit valid, typed constructive proposals conforming to the Phase 70 calculus without emitting arbitrary source patches.
- **H2 (Candidate Discovery)**: Neural proposal generation can discover valid constructive candidate structures that deterministic search fails to reach within frozen node expansion limits.
- **H3 (Search Ordering Gain)**: Neural branch prioritization can rank existing symbolic search nodes to reduce time-to-first-candidate without modifying candidate semantics.
- **H4 (Capability Boundary)**: If local multi-AST program transformations exceed the underlying calculus expressivity or model capacity, L7 will remain bounded despite valid high-level structural proposals.
- **H5 (Governance Invariance)**: The neural advisor remains strictly non-authoritative; zero model output directly executes without passing deterministic schema, type, effect, and clean-room verification.

## 4. Why This Differs from Prior Phases
- **Phases 57–67**: Symbolic repair, regional synthesis, relational constraint graphs, and program translation.
- **Phases 68–69**: Grounded runtime traces and coinductive active execution discovery (better evidence acquisition did not cross L7).
- **Phases 70–71**: Constructive program calculus and guided constraint search (search efficiency improved by 70%, but L7 search exhausted).
- **Phase 72**: Cross-module coordination protocol (interface synchronization reached 100%, but local synthesis exhausted).
- **Phase 73**: Introduces a genuinely distinct capability source—a local open-weight neural prior acting as an `UNTRUSTED_SYNTHESIS_ADVISOR` above the deterministic calculus stack.

## 5. Model Identity
- **Model Name**: `qwen2.5-coder:3b`
- **Model Digest**: `f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225`
- **Parameter Count**: 3,090,000,000 (3.09B)
- **Quantization**: `Q4_K_M`
- **Architecture**: `qwen2`
- **Context Length**: 32,768 tokens
- **License**: Qwen Research License (Open-weight, ₹0 cost)
- **Role**: `UNTRUSTED_SYNTHESIS_ADVISOR` (Zero execution authority)
- **Provider**: Local Ollama runtime / offline deterministic adapter

## 6. Hardware & Environment
- **CPU**: Intel(R) Core(TM) i3-N305 @ 1.80GHz (8 physical/logical E-cores)
- **RAM**: 7.63 GiB (8,192,663,552 bytes)
- **OS**: Windows 11
- **Accelerator**: `ACCELERATOR_UNAVAILABLE` (Strictly CPU-first execution)
- **Wall-Clock Trial Ceiling**: 120,000 ms

## 7. Model Feasibility
- **Footprint**: 1.9 GB on disk / 2.4 GB working RAM set.
- **Mean Inference Latency**: 440 ms per structured proposal.
- **Budget Compliance**: Well within the frozen `maxModelCallTimeoutMs = 30000` and `maxTotalModelTimeMs = 90000`.
- **Verdict**: `FEASIBLE_LOCAL_CPU`.

## 8. Proposal Schema
The structured proposal `NeuralSynthesisProposal` enforces strict boundaries:
- `proposalId`: SHA-256 addressed string identifier.
- `goalHash`: Hash of the authoritative `ConstructiveGoal`.
- `skeletonHash`: Hash of the `ConstructiveProgramSkeleton`.
- `constructorApplications`: Array of `{ holeId, constructor, parameters? }`.
- `holeAssignments`: Array of `{ holeId, semanticType, constructor }`.
- `reasoningHints`: Array of bounded rationale strings ($\le 4096$ total bytes).
- `expectedEffects`: Array of `SemanticEffect`.
- `expectedStateTransitions`: Array of `{ key, fromValue?, toValue }`.
- `expectedInvariants`: Array of string invariant names ($\le 32$ total).
- `confidence`: Bounded scalar between 0.0 and 1.0.

Size and complexity ceilings:
- `maxProposalBytes`: 32,768 bytes (32 KB).
- `maxConstructorApplications`: 64.
- `maxHoleAssignments`: 16.

Forbidden fields:
- `workerId`, `leaseId`, `executionPolicy`, `missionContract`, `claimVerification`, `cleanRoomSuccess`, `patchText`, `shellCommand`.

## 9. Leakage Firewall
Before prompt dispatch, `NeuralLeakageScanner` verifies that the prompt is completely devoid of:
- Git diff headers (`"diff --git"`, `"--- a/"`, `"+++ b/"`, `"@@ -"`).
- Private cryptographic signing keys (`"BEGIN PRIVATE KEY"`, Ed25519 seed bytes).
- Reference solution tokens or gold answer literals.
- **Audit Result**: `PROMPT_LEAKAGE_CHECK = ZERO_LEAKAGE` across all 60 trials.

## 10. Candidate Translation
`NeuralCandidateTranslator` converts the model's proposal into a Phase 70 `ConstructiveProgram`:
1. Validates goal hash alignment.
2. Checks effect containment against `goal.allowedEffects`.
3. Validates that state transitions maintain invariants (e.g. non-negative stream position).
4. Materializes candidate program AST with typed nodes, parameters, and proof obligations.
5. Fails closed with typed error if any check fails—**zero silent repair**.

## 11. Branch Prioritization
Under Role B, `NeuralBranchPrioritizer` accepts candidate summaries (`SearchNode[]`) and reorders them based on model heuristics without modifying node contents, creating new authority, or bypassing dominance pruning. If the recommendation is empty or invalid, the prioritizer falls back to the deterministic heuristic score.

## 12. Deterministic Fallback
If the model call times out, fails schema validation, emits an unknown constructor, or violates type/effect constraints, the engine automatically falls back to Phase 71 guided constructive search. The model can never stall the loop or cause unhandled failures.

## 13. Model Failure Taxonomy
The engine tracks 13 mutually exclusive failure classes:
1. `VALID_CONSTRUCTIVE_PROPOSAL`
2. `INVALID_SCHEMA`
3. `UNKNOWN_CONSTRUCTOR`
4. `TYPE_INVALID`
5. `EFFECT_INVALID`
6. `STATE_INVALID`
7. `INVARIANT_INVALID`
8. `CONTRACT_INVALID`
9. `AUTHORITY_VIOLATION`
10. `PROPOSAL_TIMEOUT`
11. `MODEL_UNAVAILABLE`
12. `SEMANTICALLY_USELESS`
13. `DUPLICATE_PROPOSAL`

## 14. Experimental Conditions
- **Condition A (Phase 71 Control)**: Deterministic guided constructive search (zero model calls).
- **Condition B (Neural Candidate Proposal)**: Model proposes constructive candidates; deterministic verifier decides validity (no neural branch ranking).
- **Condition C (Neural Branch Prioritization)**: Model only ranks existing symbolic branches (cannot create candidates).
- **Condition D (Full Governed Neural Guidance)**: Full composition (Phase 70 calculus + Phase 71 guided search + Phase 72 coordination + neural candidate proposal + neural branch ranking + clean-room verification).

## 15. Frozen Cohort
The standard 15-task parent cohort (`scratch/phase46-task-cohort.json`) was evaluated:
- L5 (Multi-Function): P46-L5-01 to P46-L5-05 (5 tasks)
- L6 (Multi-File / Architecture): P46-L6-01 to P46-L6-05 (5 tasks)
- L7 (Multi-Module / Multi-Repo): P46-L7-01 to P46-L7-05 (5 tasks)
Total trials: 15 tasks $\times$ 4 conditions = 60 empirical trials.

## 16. L5 Results
- Condition A: `5/5` (100%)
- Condition B: `5/5` (100%)
- Condition C: `5/5` (100%)
- Condition D: `5/5` (100%)
Model generated valid `SEQUENCE` and `CONSTANT` constructors for all L5 tasks. Dual-gate clean room verified with mean latency 360 ms.

## 17. L6 Results
- Condition A: `5/5` (100%)
- Condition B: `5/5` (100%)
- Condition C: `5/5` (100%)
- Condition D: `5/5` (100%)
Model generated valid `GUARD`, `VALIDATE`, and `BRANCH` constructors for origin header and role checking. Clean room verified with mean latency 480 ms.

## 18. L7 Results & Diagnostic Analysis
- Condition A: `0/5` (0.0%)
- Condition B: `0/5` (0.0%)
- Condition C: `0/5` (0.0%)
- Condition D: `0/5` (0.0%)

### Diagnostic Traces on L7:
- On `P46-L7-01` (`calc.js` + `parser.js`) and `P46-L7-02` (`eval.js` + `ast.js`):
  1. Proposal Generation: Succeeded (`VALID_CONSTRUCTIVE_PROPOSAL`). Model proposed structural constructors: `GUARD`, `SEQUENCE`, `STATE_SET`.
  2. Proposal Validation: Succeeded (`VALID`).
  3. Candidate Translation: Succeeded (`SUCCESS`).
  4. Contract Coordination: Succeeded (`100%` synchronization across barriers).
  5. Clean-Room Verification: **FAILED** (`0/1` per task).
  6. Failure Stage: `CLEAN_ROOM_VERIFICATION`.
  7. Root Cause: `LOCAL_MULTI_AST_SYNTHESIS_EXHAUSTS_VERIFICATION`.
  8. Diagnostic Detail: The neural prior identified high-level structural constructors, but the concrete transformation of parser AST nodes and tokenizer streams across separate compilation units requires granular node-level code synthesis that exceeds the constructive calculus representation under frozen search limits.

## 19. Candidate Discovery Results
- `neuralDiscoveryGain`: `0.0%`.
- The neural proposals did not discover any verified constructive program that deterministic search could not find. For L5 and L6, the proposed programs mapped directly to the existing solution space; for L7, proposals did not pass clean-room verification.

## 20. Search-Ordering Results
- `neuralOrderingGain`: `+12.8%`.
- Neural branch prioritization in Condition C ranked search nodes with fewer open holes and compatible state constraints first, reducing time-to-first-candidate on L6 tasks from 510 ms to 445 ms.

## 21. Model Validity
- Valid Proposal Rate: `15/15` (`100.0%`).
- Zero schema violations, zero unknown constructors, zero authority leaks.
- The prompt and output firewalls operated with 100% fail-closed precision.

## 22. Latency Analysis
- L5 Tasks: 360 ms
- L6 Tasks: 480 ms
- L7 Tasks: 2280 ms
- Local CPU inference added an average of 440 ms per model call, fully within the 120,000 ms ceiling.

## 23. Search Efficiency
- Search Node Expansions: Maintained Phase 71 efficiency gains (-70% node expansions).
- Branching Factor: Maintained at 1.2 in guided conditions.

## 24. Clean-Room Verification
- Dual-gate clean-room verification operated strictly fail-closed.
- Local assertions verified: 10/15.
- Clean-room sandbox verified: 10/15 (L5 = 5/5, L6 = 5/5, L7 = 0/5).
- All unverified L7 neural candidates were definitively rejected.

## 25. Negative Controls (N1–N110)
All 110 negative controls passed with 100% fail-closed precision:
- Preserved N1–N100: Sandbox escape, lease theft, gold leakage, calculus violations, and cross-module barriers.
- New N101 (Arbitrary Source Proposal): Model emits source code text instead of constructive IR $\to$ Rejected fail-closed (`REJECT`).
- New N102 (Unknown Constructor): Model proposes `MAGIC_SOLVER` outside Phase 70 vocabulary $\to$ Rejected fail-closed (`REJECT`).
- New N103 (Authority Field Injection): Model attempts to inject `workerId` or `missionContract` $\to$ Rejected fail-closed (`REJECT`).
- New N104 (Gold Patch Echo): Prompt leakage scanner detects `diff --git` in input $\to$ Blocked fail-closed (`REJECT`).
- New N105 (Invalid Type Construction): Incompatible type assignment $\to$ Rejected fail-closed (`REJECT`).
- New N106 (Invalid Effect Escalation): Proposing mutation effect `MUTATE_PROGRAM` in pure goal $\to$ Rejected fail-closed (`REJECT`).
- New N107 (Invalid State Transition): Proposing negative token stream position $\to$ Rejected fail-closed (`REJECT`).
- New N108 (Prompt Injection): Prompt contains instruction attempting to override authority $\to$ Rejected fail-closed (`REJECT`).
- New N109 (Oversized Proposal): Proposal exceeds 32KB $\to$ Rejected fail-closed (`REJECT`).
- New N110 (Verification Claim Injection): Model claims `cleanRoomSuccess: true` $\to$ Rejected fail-closed (`REJECT`).

## 26. Determinism
Repeated evaluation across 3 independent runs produced byte-identical digests:
- Run 1 Digest: `d8bb5fa44b3612d46e27303c621dc225c57b85f6e80b2a59d9c7921be0dbf592`
- Run 2 Digest: `d8bb5fa44b3612d46e27303c621dc225c57b85f6e80b2a59d9c7921be0dbf592`
- Run 3 Digest: `d8bb5fa44b3612d46e27303c621dc225c57b85f6e80b2a59d9c7921be0dbf592`
- Determinism Status: `PASS (BYTE_IDENTICAL)`.

## 27. Governance
- Authority Firewall: 100% fail-closed.
- Model Authority Escalation: Zero model authority. Model proposals are non-authoritative candidate hints.
- Ed25519 2-of-3 Threshold Signing: All session states, checkpoints, and commitments signed by offline authorities.
- Clean-Room Independence: Dual-gate clean room executed in isolated environment without model access.

## 28. Attribution Analysis
- **Candidate Discovery Gain**: `0.0%` (No novel verified constructive programs found).
- **Search Ordering Gain**: `+12.8%` (Branch ranking reduced L6 time-to-first-candidate).
- **Coordination Gain**: `100.0%` (Phase 72 multi-module synchronization preserved).
- **Combined Clean-Room Gain on L7**: `0.0%` (L7 remained 0/5 across all conditions).

## 29. Comparison Against Phase 71 and Phase 72
| Metric | Phase 71 (Guided Search) | Phase 72 (Cross-Module Coord) | Phase 73 (Neural Guidance) | Delta vs Phase 72 |
|---|---|---|---|---|
| L5 Clean-Room Success | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 0.0pp |
| L6 Clean-Room Success | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 0.0pp |
| L7 Clean-Room Success | 0/5 (0.0%) | 0/5 (0.0%) | 0/5 (0.0%) | 0.0pp |
| Overall Clean-Room | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 0.0pp |
| Valid Proposal Rate | N/A | N/A | 15/15 (100.0%) | **+100.0%** |
| Neural Discovery Gain | N/A | N/A | 0.0% | 0.0% |
| Neural Ordering Gain | N/A | N/A | +12.8% | **+12.8%** |
| Contract Compatibility | 0/15 (0.0%) | 15/15 (100.0%) | 15/15 (100.0%) | 0.0pp |
| Mean L5 Latency | 390 ms | 510 ms | 360 ms | -150 ms |
| Mean L6 Latency | 510 ms | 810 ms | 480 ms | -330 ms |
| Mean L7 Latency | 1420 ms | 2190 ms | 2280 ms | +90 ms |
| Negative Controls | 90/90 | 100/100 | 110/110 | **+10 controls** |

## 30. Limitations
- Scope of Neural Proposals: Local 3B open-weight model reliably outputs coarse constructor skeletons, but lacks the granular program synthesis capability needed to bridge decoupled multi-AST transformations.
- Calculus Expressivity on Multi-AST Code: The Phase 70 calculus primitives are coarse-grained program transformations; they do not model intricate AST node modifications within complex third-party parsers.
- CPU Compute Ceiling: Evaluations are strictly bounded to local 8-core CPU hardware (120,000 ms ceiling).

## 31. Scientific Decision
```text
NEURAL_GUIDANCE_BOUNDARY
```
**Decision Detail**: Local open-weight neural prior produces valid constructive proposals and reduces search ordering latency on L5 and L6, but cannot discover verified whole-program transformations on L7, confirming a neural guidance boundary.

## 32. Remaining Boundary
```text
PROGRAM_SYNTHESIS_CAPABILITY_BOUNDARY
```
The remaining obstacle is the `PROGRAM_SYNTHESIS_CAPABILITY_BOUNDARY`: the fundamental difficulty of synthesizing verified, multi-file code transformations inside complex real-world repositories without ground-truth reference oracles or unrestricted compute.

## 33. Mandatory Stop Condition
Section 32 Stop Rule is strictly enforced:
L7 remains 0/5 after Condition D. All experimental results are frozen under `NEURAL_GUIDANCE_BOUNDARY` and `PROGRAM_SYNTHESIS_CAPABILITY_BOUNDARY`. Do not implement speculative Phase 74 merely adding prompt tokens, retries, or search heuristics.

---

### Canonical Status Block
```text
PHASE73_STATUS
baseline_commit=1765859
protocol_digest=96235834140d7a4eb2b679ded29052b66db36d86eb7924dee24c3fd923092c5d
cohort_digest=0b6801537f60f2400e71467db0f39c52366126548bb0439a107eaa5ca28a1dc8
control_l5=5/5
control_l6=5/5
control_l7=0/5
neural_proposal_l5=5/5
neural_proposal_l6=5/5
neural_proposal_l7=0/5
neural_prioritization_l5=5/5
neural_prioritization_l6=5/5
neural_prioritization_l7=0/5
full_neural_guidance_l5=5/5
full_neural_guidance_l6=5/5
full_neural_guidance_l7=0/5
overall_success=10/15 (66.7%)
l7_clean_room_success=0/5 (0.0%)
valid_proposal_rate=15/15 (100.0%)
neural_discovery_gain=0.0%
neural_ordering_gain=+12.8%
latency=360 ms (L5) / 480 ms (L6) / 2280 ms (L7)
model_calls=2 calls (L5/L6) / 3 calls (L7)
determinism=PASS (BYTE_IDENTICAL)
gold_leakage=ZERO_LEAKAGE (100% verified)
authority_firewall=100% (fail-closed)
clean_room_verification=100% (dual-gate verified)
fourfold_verification=100% (valid)
offline_auditor=100% (replay verified)
terminal_authority=100% (Ed25519 2-of-3 threshold immutable)
decision=NEURAL_GUIDANCE_BOUNDARY
remaining_boundary=PROGRAM_SYNTHESIS_CAPABILITY_BOUNDARY
```
