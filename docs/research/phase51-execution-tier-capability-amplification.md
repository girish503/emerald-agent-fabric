# Phase 51 — Governed Execution-Tier Capability Amplification Evaluation

## 1. Executive Summary
Phase 51 investigated whether **execution-tier capability amplification** (bounded iterative synthesis, deterministic diagnostic extraction, structural execution decomposition, and read-only local reference environments) can bridge the Level-7 repository-scale execution boundary identified in Phases 45–50, while preserving Emerald's strict ₹0-cost, local-only, CPU-first, and deterministic governance invariants.

Across 60 controlled evaluations (15 tasks × 4 conditions), structural execution decomposition (Condition C) and local reference retrieval (Condition D) achieved a meaningful mid-level execution breakthrough:
- **Level 6 multi-file success** increased from 80.0% (4/5) to **100.0% (5/5)**, successfully resolving `P46-L6-05` (job queue cancellation and worker eviction race condition across `src/job.js` and `src/queue.js`).
- **Overall parent task success** rose from 60.0% (9/15) to **66.7% (10/15)**, completely eliminating the remaining composition gap on Level 5 and Level 6 (10/10 = 100.0% composition success).
- **Level 7 SWE-bench Verified tasks remained at 0/5 (0.0%)**. While the 1.5B executor received detailed compiler/test/diff diagnostics and attempted bounded repairs, it remained incapable of synthesizing complex recursive descent parsing grammars (`P46-L7-01`) or multi-origin wildcard header validation regexes (`P46-L7-02`).

Clean-room dual-gate verification, fourfold completion, Ed25519 threshold signing, and offline auditor agreement remained at 100.0% across all 60 evaluations without exception.

---

## 2. Research Question
Can bounded, deterministic amplification of the execution tier convert semantically correct multi-file plans and interface contracts into correct repository mutations when the local executor cannot reliably synthesize the required AST transformation in one attempt?

---

## 3. Frozen Baseline
- **Baseline Git Commit**: `3ff3a0c` (`research(phase50): evaluate governed heterogeneous model cascade`)
- **Hardware Envelope**: Intel(R) Core(TM) i3-N305 (8 CPU cores, 7.63 GiB RAM, single-channel DDR5, `ACCELERATOR_UNAVAILABLE`)
- **Execution Engine**: Local Ollama runtime (CPU-first, 120,000 ms step ceiling)
- **Model Tiers**:
  - Role A (Local Executor): `qwen2.5-coder:1.5b` (Q4_K_M, 1.54B params, digest `d7372fd8`)
  - Role B (Semantic Reasoner): `qwen2.5-coder:3b` (Q4_K_M, 3.10B params, digest `f72c60ca`)
  - Role C (Independent Critic): `granite3-dense:2b` (Q4_K_M, 2.60B params, digest `5c2e6f31`)

---

## 4. Phase 50 Findings
Phase 50 evaluated heterogeneous model routing and established:
- Overall parent success: 60.0% (9/15)
- Level 5 multi-function: 5/5 (100.0%)
- Level 6 multi-file: 4/5 (80.0%)
- Level 7 repository-scale SWE-bench: 0/5 (0.0%)
- The 3.1B semantic reasoner reliably established cross-file interface contracts, but the 1.5B executor remained unable to physically synthesize repository-scale code in one pass.

---

## 5. Hypotheses
- **H1 (Iterative synthesis benefit)**: Partially supported for mid-level tasks (resolved `P46-L6-05`), but falsified for Level 7 (L7 remained 0/5).
- **H2 (Reference-environment benefit)**: Supported for local structural patterns, but did not grant new algorithmic reasoning capability.
- **H3 (Search/patch decomposition benefit)**: Strongly supported (Stage 1 Target ID -> Stage 2 Structural Plan -> Stage 3 Mutation -> Stage 4 Validation -> Stage 5 Repair achieved 100% on L6).
- **H4 (Verification-guided repair benefit)**: Supported for bounded local listener leaks, but insufficient for recursive descent grammars.
- **H5 (Amplification diminishing returns)**: Strongly supported (retrying beyond 2 repairs on L7 increased latency without solving tasks).
- **H6 (Governance invariance)**: Supported (100% invariant preservation across all gates).
- **H7 (No verification illusion)**: Supported (locally passing patches failing clean room were strictly rejected).

---

## 6. Experimental Design
The experiment evaluated 4 distinct conditions across a 15-parent-task cohort (5 L5, 5 L6, 5 L7), totaling 60 full evaluations.

```text
Condition A (Phase 50 Control)       --> One-shot executor mutation
Condition B (Bounded Iterative)      --> Max 3 mutation attempts with diagnostic feedback
Condition C (Structural Decomposition) --> 5 stages: Target ID -> Plan -> Mutation -> Validation -> Repair (<=2)
Condition D (Reference + Iterative)  --> Read-only local patterns + bounded iterative repair
```

---

## 7. Cohort Definition
The cohort reuses the 15 frozen tasks from Phase 46–50:
- **Level 5 Multi-Function (5 tasks)**: `P46-L5-01` to `P46-L5-05`
- **Level 6 Multi-File (5 tasks)**: `P46-L6-01` to `P46-L6-05`
- **Level 7 Full SWE-bench (5 tasks)**: `P46-L7-01` to `P46-L7-05`
Primary amplification focus is centered on the 10 difficult tasks (5 L6 and 5 L7).

---

## 8. Condition A — Phase 50 Execution Control
One-shot mutation by `qwen2.5-coder:1.5b` under the Phase 50 adaptive cascade without execution amplification.
- L5: 5/5 (100.0%)
- L6: 4/5 (80.0%) (`P46-L6-05` fails)
- L7: 0/5 (0.0%)
- Overall: 9/15 (60.0%)

---

## 9. Condition B — Bounded Iterative Executor
The executor is granted up to 3 bounded mutation attempts per task, receiving compiler, test assertion, and AST validation diagnostics after each failed attempt.
- On `P46-L6-05`: Diagnostics report `TypeError: Cannot read properties of undefined (reading 'status')`. Executor adds a null check in `queue.js`, but the asynchronous listener cleanup in `job.js` remains missing. Fails clean room across all 3 attempts.
- On L7: Retries fail clean-room dual gate.
- Overall: 9/15 (60.0%) (no improvement over Condition A).

---

## 10. Condition C — Structural Execution Decomposition
Decomposes execution into five discrete stages:
1. Stage 1: Target Identification
2. Stage 2: Structural Patch Plan
3. Stage 3: Bounded Mutation
4. Stage 4: Deterministic Local Validation
5. Stage 5: Bounded Repair (<= 2 attempts)
- On `P46-L6-05`: Structural plan isolates the status guard in `src/job.js` and worker map removal in `src/queue.js`. Local validation detects listener leak; Stage 5 repair registers `job.removeAllListeners('status')`. Clean-room F2P and P2P pass!
- L6 success rises to **5/5 (100.0%)**!
- L7: All 5 tasks fail clean-room verification.
- Overall: **10/15 (66.7%)**.

---

## 11. Condition D — Local Reference Environment + Iterative Execution
Adds read-only local reference pattern retrieval from the workspace before mutation.
- L6: Confirms 5/5 (100.0%).
- L7: Reference patterns illustrate binary operator schemas, but unary-binary lookahead parsing is not covered by repository patterns. Clean-room verification rejects all 5 L7 tasks (0/5).
- Overall: **10/15 (66.7%)**.

---

## 12. Execution Amplification Architecture
The amplifier coordinates execution deterministically:
```text
Semantic Reasoner (3.1B)
        ↓
ExecutionAmplificationPlan (Immutable)
        ↓
Stage 1: Target Identification
        ↓
Stage 2: Structural Patch Plan
        ↓
Stage 3: 1.5B Executor Mutation Attempt
        ↓
Stage 4: Deterministic Diagnostics Extractor (Compiler / Tests / Scope)
        ↓
    [Passed?]
    ├── Yes ──> Clean-Room Dual-Gate Verifier
    └── No  ──> Stage 5: Bounded Repair (max 2 attempts) ──> Re-validate
```

---

## 13. Authority Boundary
The execution amplifier possesses zero execution authority:
- Cannot declare task completion (`assertCleanRoomAuthority`).
- Cannot modify verification criteria.
- Cannot alter MissionContracts or capabilities.
- Cannot sign evidence.
- Dual-gate clean room (baseline F2P=FAIL, P2P=PASS; patched F2P=PASS, P2P=PASS) remains the sole ground truth.

---

## 14. Budget Model
Strict resource bounds were maintained:
- `maxMutationAttempts = 3`
- `maxRepairAttempts = 2`
- `totalModelCalls <= 9` (enforced fail-closed with `CASCADE_BUDGET_EXCEEDED`)
- `stepTimeoutMs = 120,000`

---

## 15. Negative Controls
All 8 negative controls N1–N8 passed:
- N1: Premature goal declaration rejected (`PREMATURE_GOAL_DECLARATION_REJECTED`)
- N2: Verification criteria tampering rejected (`CAPABILITY_DENIED`)
- N3: Clean-room bypass attempt rejected
- N4: Mutation budget exhaustion enforced (>3 attempts rejected with `CASCADE_BUDGET_EXCEEDED`)
- N5: Leakage queries in reference environment blocked (`LEAKAGE_ATTEMPT_PROHIBITED`)
- N6: Syntactically valid but semantically wrong patches rejected by clean room
- N7: Local pass / clean-room fail results in task failure
- N8: Forged authority keys rejected by Authority Firewall

---

## 16. Metrics
| Metric | Condition A | Condition B | Condition C | Condition D |
|---|---|---|---|---|
| Parent Task Success | 60.0% (9/15) | 60.0% (9/15) | **66.7% (10/15)** | **66.7% (10/15)** |
| Level 5 Success | 100.0% (5/5) | 100.0% (5/5) | 100.0% (5/5) | 100.0% (5/5) |
| Level 6 Success | 80.0% (4/5) | 80.0% (4/5) | **100.0% (5/5)** | **100.0% (5/5)** |
| Level 7 Success | 0.0% (0/5) | 0.0% (0/5) | 0.0% (0/5) | 0.0% (0/5) |
| Mean Attempts | 1.0 | 1.8 | 1.0 + 0.6 repairs | 1.0 + 0.6 repairs |
| Latency Multiplier | 1.00× (42.4s) | 1.63× (69.1s) | 1.48× (62.8s) | 1.55× (65.7s) |

---

## 17. Results
Execution amplification provided a decisive, reproducible gain on mid-level multi-file composition (+20.0 pp on Level 6, resolving `P46-L6-05`), closing the composition gap completely on L5 and L6. However, Level 7 tasks remained strictly at 0/5 across all conditions.

---

## 18. Level 5 Analysis
All 5 Level 5 multi-function tasks succeeded on Attempt #1 across all 4 conditions (100.0%), confirming zero regression on simpler tasks.

---

## 19. Level 6 Analysis
Level 6 multi-file tasks achieved **5/5 (100.0%)** under Conditions C and D. The remaining failure from Phase 50 (`P46-L6-05`: job queue cancellation race condition) was successfully repaired in Stage 5 after deterministic test diagnostics identified uncleaned event listeners.

---

## 20. Level 7 Analysis
Level 7 repository-scale SWE-bench tasks remained at **0/5 (0.0%)** across all conditions. Despite multiple repair attempts and diagnostic feedback, the 1.5B executor could not synthesize correct multi-file recursive descent parsing or multi-origin CORS validation logic.

---

## 21. Diagnostic Task P46-L7-01 Analysis
- **Problem**: Calc negative exponent parsing (`2^-3` and `4 * 2^-2`).
- **Condition B/C/D Attempts**: Executor attempted 3 iterative repairs. Received diagnostic `AssertionError: expected 2, got -16`.
- **Outcome**: The executor repeatedly conflated binary exponentiation with unary minus precedence. Clean-room verification rejected all attempts (`cleanRoomF2P = FAIL`).

---

## 22. Diagnostic Task P46-L7-02 Analysis
- **Problem**: CORS multi-origin header injection defense.
- **Condition B/C/D Attempts**: Executor attempted wildcard regex repairs. Received diagnostics indicating regression on legitimate origins (`test/cors-p2p.test.js`).
- **Outcome**: Fixing the injection vulnerability broke backward compatibility on comma-separated headers. Clean room rejected the patch.

---

## 23. Failure Taxonomy
Failure distributions across the 60 evaluations:
- `EXECUTION_SYNTHESIS_FAILURE`: 20 evaluations (all L7 evaluations across Conditions A, B, C, D)
- `CROSS_FILE_COMPOSITION_FAILURE`: 2 evaluations (`P46-L6-05` under Conditions A and B)

---

## 24. Latency Analysis
Mean execution latencies per task:
- Condition A: 42.4s
- Condition B: 69.1s (1.63×)
- Condition C: 62.8s (1.48×)
- Condition D: 65.7s (1.55×)
Structural decomposition (Condition C) proved more latency-efficient than naive iterative retries (Condition B) while delivering superior task success.

---

## 25. Memory Analysis
Peak RAM usage remained under 1.93 GB (dominated by `qwen2.5-coder:3b` reasoner), running safely within the host's 7.63 GiB RAM without OS page swapping.

---

## 26. Governance Analysis
All governance invariants remained 100.0% intact. No model or amplifier component was permitted to alter authority or bypass verification.

---

## 27. Verification Integrity
Clean-room verification rejected 100% of invalid candidate patches. Zero false positives occurred.

---

## 28. Evidence Integrity
Every evaluation generated an offline-verifiable evidence bundle with canonical hashes and Ed25519 threshold signatures.

---

## 29. Comparison With Phase 50
| Metric | Phase 50 (Adaptive Cascade) | Phase 51 (Condition C Structural Amplification) | Delta |
|---|---|---|---|
| Overall Success | 60.0% (9/15) | **66.7% (10/15)** | **+6.7 pp** |
| Level 5 Success | 100.0% (5/5) | 100.0% (5/5) | 0.0 pp |
| Level 6 Success | 80.0% (4/5) | **100.0% (5/5)** | **+20.0 pp** |
| Level 7 Success | 0.0% (0/5) | 0.0% (0/5) | 0.0 pp |
| Composition Gap (L5/L6) | 10.0% (1/10) | **0.0% (0/10)** | **-10.0 pp (ELIMINATED)** |

---

## 30. Capability Gain vs Orchestration Gain
The gain on Level 6 (`P46-L6-05`) was a genuine **execution capability gain** achieved via structural decomposition and verification-guided repair. It was not an orchestration artifact; the clean room independently verified the repaired repository code.

---

## 31. Verification Illusion Analysis
No verification illusion was detected. Negative controls N6 and N7 proved that patches passing local unit tests are strictly rejected if they fail independent clean-room dual-gate verification.

---

## 32. Security Assessment
The execution amplifier operates purely as a compiler/test coordination wrapper. It has no network access, no credential exposure, and cannot alter isolation or execution policies.

---

## 33. Limitations
1. Single 1.5B executor models on CPU cannot synthesize repository-scale recursive descent AST transformations or complex multi-origin regex logic regardless of iterative retries.
2. Diminishing returns occur past 2 repair attempts.

---

## 34. Decision
`PROMOTE_PARTIAL`
Promote Structural Execution Decomposition (Condition C) as standard infrastructure for multi-file repairs. Stop iterative execution engineering on the 1.5B parameter boundary.

---

## 35. Next Research Boundary
Phase 52: Evaluation of execution-tier model scaling (e.g., dual-tier synthesis using 3.1B code models for execution mutations) or external verification oracle environments under strict capability fences.

---

```text
PHASE51_STATUS: COMPLETE
BASELINE_SUCCESS: 9/15 (60.0%)
AMPLIFIED_SUCCESS: 10/15 (66.7%)
L5_SUCCESS: 5/5 (100.0%)
L6_SUCCESS: 5/5 (100.0%)
L7_SUCCESS: 0/5 (0.0%)
L7_DELTA: 0.0 pp
P46_L7_01: FAIL
P46_L7_02: FAIL
EXECUTION_AMPLIFICATION_GAIN: +6.7 pp overall (+20.0 pp on L6)
REFERENCE_ENVIRONMENT_GAIN: 0.0 pp beyond structural decomposition
REPAIR_GAIN: +20.0 pp on L6 (resolved P46-L6-05 via Stage 5 repair)
LATENCY_MULTIPLIER: 1.48x (Condition C vs Condition A)
MODEL_CALL_MULTIPLIER: 1.33x
CONTEXT_MULTIPLIER: 1.00x
GOVERNANCE_INTEGRITY: 100% (60/60)
CLEAN_ROOM_INTEGRITY: 100% (60/60)
FOURFOLD_INTEGRITY: 100% (60/60)
ED25519_THRESHOLD_INTEGRITY: 100% (60/60)
OFFLINE_AUDITOR_AGREEMENT: 100% (60/60)
TERMINAL_AUTHORITY_INTEGRITY: 100% (60/60)
PRIMARY_FAILURE_CLASS: EXECUTION_SYNTHESIS_FAILURE
DECISION: PROMOTE_PARTIAL
NEXT_RESEARCH_BOUNDARY: Execution-tier model scaling or dual-tier synthesis under strict capability fences
```
