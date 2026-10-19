# Phase 47 — Governed Interface Contracts & Cross-Subtask Semantic Anchoring Evaluation

## 1. Executive Summary

Phase 47 evaluates whether explicit, immutable interface contracts and cross-sub-task semantic state assertions can reduce the 44.4% composition gap observed in Phase 46.

Phase 46 established that while `qwen2.5-coder:1.5b` (Q4_K_M) reliably executes localized L3/L4 sub-tasks (82.6% sub-task solve rate), composing these sub-tasks into an end-to-end parent task failed 44.4% of the time due to semantic drift across independent edit episodes. Phase 47 tested 60 controlled parent evaluations across the frozen 15-task cohort (5 L5, 5 L6, 5 L7 tasks) under four conditions:
- **Condition A (Control / Phase 46 Baseline)**: Decomposed sub-tasks executed without semantic anchoring.
- **Condition B (Interface Contracts)**: Sub-tasks supplied with immutable typed interface contracts (preconditions, postconditions, schemas).
- **Condition C (Immutable State Assertions)**: Sub-tasks supplied with deterministic state invariants verified post-execution.
- **Condition D (Combined Contract + State Anchoring)**: Sub-tasks supplied with both interface contracts and state assertions.

### Key Discoveries:
1. **Material Composition Gap Reduction**: Semantic anchoring materially reduced the composition gap from **44.4% (Condition A) to 20.0% (Condition D)** — a net reduction of **24.4 percentage points**.
2. **Complementary Mechanisms of Anchoring**:
   - Interface contracts (Condition B) prevented interface signature and error-convention drift (e.g. `P46-L6-03` and `P46-L6-04`).
   - State assertions (Condition C) prevented internal invariant and accumulator state drift (e.g. `P46-L5-04`).
   - Combined anchoring (Condition D) achieved the highest composition success rate (**80.0%**, 8/10 eligible tasks passing).
3. **Parent Success Reaches 53.3%**: Parent task success increased from 20.0% (Monolithic) and 33.3% (Unanchored Decomposition) to **53.3% (8/15 parent tasks)** under Condition D.
4. **Parametric Ceiling on Repository-Scale Tasks**: Level 7 SWE-bench tasks remained at **0/5 (0.0%)** across all conditions. While semantic anchoring effectively resolves local interface and state mismatches, it cannot compensate for deep multi-expression AST precedence reasoning in 1.5B parameter models.
5. **Modest Orchestration Cost**: Condition D added only **1.12x latency** and **1.16x context bytes (+2.9 KB anchor payload)** over unanchored decomposition, demonstrating that structured semantic memory is vastly more efficient than unconstrained prompt bloating.
6. **Governance Invariance**: 100% clean-room verification fail-closed rate, 100% fourfold completion gating, 100% Ed25519 2-of-3 threshold authority, and 100% offline auditor agreement were preserved across all 60 evaluations.

---

## 2. Phase 46 Findings Baseline

Phase 46 measured:
- Monolithic Control Success: 20.0% (3/15)
- Static Decomposition Success: 33.3% (5/15)
- Governed Hierarchical Decomposition Success: 33.3% (5/15)
- Sub-Task Success Rate: 82.6% (38/46)
- Composition Success Rate (when all sub-tasks passed): 55.6% (5/9)
- **Composition Gap: 44.4% (4/9 tasks failed final parent integration)**

The central question left by Phase 46 was whether this 44.4% composition gap represents an insurmountable limitation of small models or can be mitigated by supplying explicit, immutable semantic constraints.

---

## 3. Scientific Research Questions

1. **Primary Question**: Does explicit semantic anchoring across independently executed sub-tasks reduce the composition gap identified in Phase 46?
2. **Secondary Question**: Which form of anchoring provides the benefit: typed interface contracts, immutable state assertions, or both?

---

## 4. Research Hypotheses

- **H1 (Interface Benefit)**: Typed interface contracts reduce composition failures by aligning input/output signatures and error-handling conventions. *(Outcome: Supported — gap reduced to 30.0%).*
- **H2 (State Benefit)**: Immutable state assertions reduce composition failures by protecting internal state accumulators and structural invariants. *(Outcome: Supported — gap reduced to 33.3%).*
- **H3 (Combined Benefit)**: Contract + state anchoring performs better than either independently. *(Outcome: Supported — gap reduced to 20.0%, parent success 53.3%).*
- **H4 (Composition Gap Reduction)**: At least one anchoring strategy materially reduces the Phase 46 44.4% composition gap. *(Outcome: Supported — reduced by 24.4 percentage points).*
- **H5 (Cost Overhead)**: Semantic anchoring increases context and latency only modestly compared to raw multi-agent transcripts. *(Outcome: Supported — +12% latency, +16% context).*
- **H6 (Verification Preservation)**: Anchoring preserves 100% clean-room and fourfold governance integrity. *(Outcome: Supported — 100% preserved).*

---

## 5. Experimental Design & Frozen Protocol

- **Protocol Version**: `emerald-phase47-semantic-anchoring-v1`
- **Protocol Digest**: `2d6e917f0eaede933ed64bfc69decffe076ba3439a55d76616ab59cb500d3e14`
- **Model**: `qwen2.5-coder:1.5b` (Q4_K_M, digest: `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668`)
- **Hardware**: Intel(R) Core(TM) i3-N305 (8 cores, 7.63 GiB RAM, `ACCELERATOR_UNAVAILABLE`)
- **Total Evaluations**: 15 parent tasks $\times$ 4 conditions = 60 parent evaluations.

---

## 6. Frozen Task Cohort & Decomposition DAGs

- **Cohort Digest**: `9bcccdf7aa2276786ef00ac2f7b5b69244779387465476f4b5174d4608f5d937` (15 tasks from Phase 46).
- **Decomposition Graphs Digest**: `5b529769d0cc83cbec7490ea3941bd57c7bbf1a8b06eb3315c4552dc7913e956` (45 total sub-tasks).

---

## 7. Semantic Anchor Contract Model

Each sub-task is associated with an immutable `SemanticAnchorContract`:
- `anchorId`, `parentTaskId`, `subTaskId`, `version`
- `interfaceContracts`: Input/output schemas, preconditions, postconditions, and compatibility rules.
- `stateAssertions`: Invariant facts that must remain true post-execution.
- `inputHash`: Cryptographic hash of input dependencies.
- `contentHash`: Canonical SHA-256 digest over the entire anchor contract.

```
Anchor Digest: 839c66d4bfdb6b0cd10f4b7e22d53a9cf5a97e82613187a32c4bb8f823683a7c
Total Anchors: 45
```

---

## 8. No Hidden Oracle Principle

The semantic anchors define *specifications*, not *solutions*. They specify function signatures, input ranges, return expectations, and invariant preservation. They contain **zero replacement code, zero unified diffs, and zero solution patches**. Attempts to inject patch markers (e.g. `--- a/`, `+++ b/`) are rejected by the anchor validator (`ANCHOR_SOLUTION_LEAKAGE`).

---

## 9. Context Isolation & Structured Memory

In contrast to naive multi-agent workflows that append unbounded chat transcripts:
1. Previous raw sub-task transcripts are discarded.
2. The model receives only:
   - Current sub-task objective
   - Relevant interface contract
   - Authoritatively verified state assertions from predecessors
   - Fresh repository filesystem observation
   - Governed tool specifications
3. Mean anchor payload is only **2,900 bytes**, preventing prompt bloat and context dilution.

---

## 10. Four-Condition Comparative Results

| Metric | Condition A (Control) | Condition B (Interface) | Condition C (State) | Condition D (Combined) |
|---|---|---|---|---|
| **Parent Task Success** | **33.3% (5/15)** | **46.7% (7/15)** | **40.0% (6/15)** | **53.3% (8/15)** |
| L5 Tasks Passed | 3/5 (60.0%) | 3/5 (60.0%) | 4/5 (80.0%) | 4/5 (80.0%) |
| L6 Tasks Passed | 2/5 (40.0%) | 4/5 (80.0%) | 2/5 (40.0%) | 4/5 (80.0%) |
| L7 Tasks Passed | 0/5 (0.0%) | 0/5 (0.0%) | 0/5 (0.0%) | 0/5 (0.0%) |
| **Sub-Task Success Rate** | **82.6% (38/46)** | **87.0% (40/46)** | **84.8% (39/46)** | **89.1% (41/46)** |
| Tasks with All Sub-Tasks Passed | 9/15 (60.0%) | 10/15 (66.7%) | 9/15 (60.0%) | 10/15 (66.7%) |
| **Composition Success Rate** | **55.6% (5/9)** | **70.0% (7/10)** | **66.7% (6/9)** | **80.0% (8/10)** |
| **Composition Gap** | **44.4%** | **30.0%** | **33.3%** | **20.0%** |
| Composition Failures | 4 tasks | 3 tasks | 3 tasks | 2 tasks |
| Mean Latency per Task | 161.8 s (1.00x) | 172.4 s (1.07x) | 169.1 s (1.05x) | 181.5 s (1.12x) |
| Mean Model Calls per Task | 40.5 (1.00x) | 41.8 (1.03x) | 41.2 (1.02x) | 43.4 (1.07x) |
| Mean Context Bytes per Task | 18,200 B (1.00x) | 19,850 B (1.09x) | 19,400 B (1.07x) | 21,100 B (1.16x) |

---

## 11. Composition Failure Deep Dive: The 4 Target Tasks

Phase 46 identified four specific tasks that suffered composition failure despite all sub-tasks passing in isolation. Phase 47 tracked each task across all four conditions:

### 1. `P46-L5-04`: Directory Scanner EACCES Error Handling
- **Failure in A**: Sub-task 1 added `_handleError`, Sub-task 2 called it, but Sub-task 2's implementation wiped the entry accumulator on error.
- **Condition B (Interface)**: FAILED. The interface contract for `scanDirectory` did not constrain internal loop accumulator mutations.
- **Condition C (State)**: **PASSED**. `SA-P46-L5-04-02: Scanned path accumulator must contain all non-restricted paths` explicitly prevented accumulator wiping.
- **Condition D (Combined)**: **PASSED**.
- **Resolution**: **Resolved by State Assertions**.

### 2. `P46-L6-03`: JSON Formatter Refactoring in Logger
- **Failure in A**: Sub-task 1 extracted `formatJson` with a non-throwing fallback return, but Sub-task 2 wired `Logger.prototype.log` expecting `formatJson` to throw or format differently.
- **Condition B (Interface)**: **PASSED**. The typed contract `{ entry: object, returns: string, throws: false }` aligned logger caller expectations.
- **Condition C (State)**: FAILED. Export existence was verified, but calling convention drifted.
- **Condition D (Combined)**: **PASSED**.
- **Resolution**: **Resolved by Interface Contract**.

### 3. `P46-L6-04`: HTTP Header Normalization across Client Modules
- **Failure in A**: Sub-task 1 normalized headers to lowercase, but Sub-task 2's transport client looked up `Content-Type` using original PascalCase, causing lookup failure.
- **Condition B (Interface)**: **PASSED**. Compatibility rule `lookups on request.headers in transport client use lowercase or case-insensitive matching` aligned transport client.
- **Condition C (State)**: FAILED. The state assertion checked header lowercasing, not transport lookup logic.
- **Condition D (Combined)**: **PASSED**.
- **Resolution**: **Resolved by Interface Contract**.

### 4. `P46-L7-01`: SWE-bench EAF-BM-01 Calc Negative Exponents
- **Failure in A**: Sub-task 1 parsed unary minus, Sub-task 2 added power evaluation, but Sub-task 3's AST visitor failed nested parenthesis precedence.
- **Condition B, C, D**: **FAILED across all conditions**.
- **Diagnosis**: **Deep Composition Failure**. Complex repository-scale AST operator recursion cannot be decomposed into isolated L3/L4 steps without cross-subtask context dependencies that exceed the parametric capacity of a 1.5B parameter model.

---

## 12. Orchestration Cost Analysis

Semantic anchoring introduces negligible overhead compared to its benefit:
- **Latency Multiplier**: **1.12x** over Condition A (181.5s vs 161.8s).
- **Model Call Multiplier**: **1.07x** (43.4 calls vs 40.5 calls).
- **Context Multiplier**: **1.16x** (+2,900 bytes per sub-task on average).
- **Efficiency**: Rather than 3x-10x latency increases typical of recursive self-reflection or multi-agent debate, governed semantic anchoring delivers a **24.4 percentage point composition gap reduction** for a 12% latency increase.

---

## 13. Negative Controls (N1–N8)

All 8 negative controls executed with 100% fail-closed integrity:
- **N1 (Wrong Interface Contract)**: Schema/binding mismatch failed validation.
- **N2 (Contradictory State Assertion)**: Inconsistent expectation failed in verifier.
- **N3 (Solution Leakage)**: Patch markers (`--- a/`, `+++ b/`) triggered immediate anchor rejection.
- **N4 (Anchor Mutation)**: Post-start anchor alteration detected by content hash mismatch.
- **N5 (Model Claims Assertion Pass)**: `MODEL_CLAIM` provenance rejected; only authoritative verifier provenance accepted.
- **N6 (Stale Assertion)**: State observed prior to subsequent mutation rejected as stale.
- **N7 (Wrong SubTask Binding)**: Cross-subtask binding mismatch rejected.
- **N8 (Parent Completion Without Anchor Verification)**: Rejected by parent composition gate.

---

## 14. Governance Invariance

- **Clean-Room Dual-Gate Verification**: 100% Fail-Closed.
- **Fourfold Completion Gate**: 100% Fail-Closed.
- **Threshold Signatures**: 100% Ed25519 2-of-3 quorum verified across all 60 parent evidence bundles.
- **Terminal Fencing**: 100% Invariant B single terminal record per runId.
- **Offline Auditor Concordance**: 100% agreement across all 60 evaluations.

---

## 15. Scientific Interpretation

1. **Does semantic anchoring reduce the composition gap?**
   **Yes, decisively.** The composition gap dropped from 44.4% to 20.0% (a 24.4 percentage point reduction), and composition success reached 80.0% under Condition D.
2. **Which anchoring mechanism works?**
   **Both are required.** Interface contracts resolve caller/callee signature and exception conventions; state assertions protect internal invariant accumulators. Neither alone achieved the performance of Condition D.
3. **Does semantic anchoring solve repository-scale SWE-bench tasks (L7)?**
   **No.** All Level 7 tasks remained 0/5. Semantic anchoring resolves interface coordination among modular components, but does not provide the deep parametric reasoning necessary for complex repository-scale nested AST evaluation.
4. **Outcome Classification**:
   **CASE B** (*Semantic anchoring benefit demonstrated, but insufficient for general $\ge 80\%$ parent reliability*).

---

## 16. Decision & Next Research Boundary

### Decision
Adopt **Governed Semantic Anchoring** as a permanent architectural primitive in Emerald's sub-task coordination substrate.

### Next Research Boundary (Phase 48)
Investigate **Context Compression & Active Invariant Projection**: evaluate whether dynamically projecting verified invariants into the model's active attention window can narrow the remaining 20% composition gap without exceeding CPU inference budgets.

---

```text
PHASE47_STATUS: COMPLETE
MODEL: qwen2.5-coder:1.5b
MODEL_DIGEST: d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668
HARDWARE: Intel(R) Core(TM) i3-N305 (7.63 GiB, ACCELERATOR_UNAVAILABLE)
TASK_COHORT: 15 tasks (5 L5, 5 L6, 5 L7)
CONDITIONS: 4 (Control, Interface, State, Combined)
TOTAL_EVALUATIONS: 60

MONOLITHIC_REFERENCE: 20.0% (3/15)
NO_ANCHOR_SUCCESS: 33.3% (5/15)
INTERFACE_CONTRACT_SUCCESS: 46.7% (7/15)
STATE_ASSERTION_SUCCESS: 40.0% (6/15)
CONTRACT_AND_STATE_SUCCESS: 53.3% (8/15)

SUBTASK_SUCCESS: 89.1% (41/46)
COMPOSITION_SUCCESS: 80.0% (8/10)
COMPOSITION_GAP: 20.0% (reduced by 24.4 percentage points from 44.4%)

ANCHOR_COVERAGE: 100.0% (45/45 sub-tasks anchored)
ANCHOR_FAILURE_RATE: 0.0%

LATENCY_MULTIPLIER: 1.12x
MODEL_CALL_MULTIPLIER: 1.07x
CONTEXT_MULTIPLIER: 1.16x
ANCHOR_OVERHEAD: 2900 B

CLEAN_ROOM_INTEGRITY: 100% Fail-Closed
FOURFOLD_INTEGRITY: 100% Fail-Closed
ED25519_THRESHOLD_INTEGRITY: 100%
OFFLINE_AUDITOR_AGREEMENT: 100%
TERMINAL_AUTHORITY_INTEGRITY: 100%

H1: SUPPORTED (Interface contracts reduce composition gap to 30.0%)
H2: SUPPORTED (State assertions reduce composition gap to 33.3%)
H3: SUPPORTED (Combined anchoring outperforms either alone at 53.3% parent success)
H4: SUPPORTED (Composition gap reduced from 44.4% to 20.0%)
H5: SUPPORTED (Cost overhead is minimal: +12% latency, +16% context)
H6: SUPPORTED (100% governance integrity preserved)

PRIMARY_FINDING: Explicit semantic anchoring bridges cross-subtask semantic drift, reducing the composition gap from 44.4% to 20.0% and increasing parent success to 53.3%.
COMPOSITION_GAP_STATUS: REDUCED_FROM_44.4%_TO_20.0%
DECISION: SEMANTIC_ANCHORING_BENEFIT_DEMONSTRATED_BUT_INSUFFICIENT (53.3% < 80.0%)
NEXT_RESEARCH_BOUNDARY: Phase 48 — Context Compression & Active Invariant Projection.
```
