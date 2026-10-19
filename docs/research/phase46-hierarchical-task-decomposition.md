# Phase 46 — Hierarchical Task Decomposition & Governed Sub-Task Orchestration Evaluation

## 1. Executive Summary

Phase 46 evaluates whether hierarchical task decomposition can convert software-engineering tasks that are unreliable for the host local model (`qwen2.5-coder:1.5b` Q4_K_M on an Intel Core i3-N305 CPU-only host) into a sequence of independently verifiable sub-tasks that the same model can reliably execute.

Phase 45 established the empirical reliable capability boundary at **Level 4 (Small Single-File Repair, 80% pass rate)**, while discovering severe degradation at Level 5 (Multi-Function, 40%), Level 6 (Multi-File, 20%), and Level 7 (Full SWE-bench, 0%). Phase 46 subjected a frozen 15-task cohort derived from the L5/L6/L7 boundary to three controlled conditions:
- **Strategy A (Monolithic Control)**: Full task executed without decomposition (baseline).
- **Strategy B (Static Expert Decomposition)**: Deterministic, pre-frozen DAG of bounded L3/L4 sub-tasks executed in sequence.
- **Strategy C (Governed Hierarchical Decomposition)**: Bounded coordinator dispatching eligible sub-tasks from the frozen DAG based on runtime evidence and state.

### Decisive Findings:
1. **Sub-Task Synthesis is High, but Composition Fails**: Individual sub-tasks designed within the L3/L4 boundary succeeded at **82.6% (38/46 sub-tasks passed)**. However, parent task success only reached **33.3% (5/15 tasks)** under both Static and Hierarchical decomposition (compared to 20.0% Monolithic).
2. **Composition Gap Confirmed (H3)**: In **4 out of 9 parent tasks (44.4%) where every individual sub-task succeeded and passed unit verification**, the integrated parent verification failed in the clean-room environment. While each sub-task accomplished its local syntactic transformation, semantic coordination across sub-tasks drifted, breaking integration contracts.
3. **Substantial Orchestration Overhead (H4)**: Decomposition introduced a **2.76x latency multiplier**, a **2.85x model call multiplier**, and a **2.68x context byte multiplier**, with zero gain on repository-scale L7 SWE-bench tasks (0/5 passed).
4. **Governance Invariance Maintained**: 100% clean-room dual-gate verification, 100% fourfold completion gating, 100% Ed25519 2-of-3 threshold authority, and 100% offline auditor agreement were strictly preserved across all 45 evaluated runs.

---

## 2. Phase 45 Capability Boundary Baseline

Phase 45 empirically measured the capability ladder of `qwen2.5-coder:1.5b`:
- **Level 0 (Schema / Tool Selection)**: 5/5 (100.0%) [Reliable]
- **Level 1 (Locate Relevant Code)**: 5/5 (100.0%) [Reliable]
- **Level 2 (Explain Local Bug)**: 5/5 (100.0%) [Reliable]
- **Level 3 (One-Line Repair)**: 5/5 (100.0%) [Reliable]
- **Level 4 (Small Single-File Repair)**: 4/5 (80.0%) [**Empirical Reliable Capability Boundary**]
- **Level 5 (Multi-Function Single-File Repair)**: 2/5 (40.0%) [Unreliable]
- **Level 6 (Small Multi-File Semantic Repair)**: 1/5 (20.0%) [Unreliable]
- **Level 7 (Full SWE-bench Task)**: 0/5 (0.0%) [Unreliable]

The empirical boundary $\ge 80\%$ was established at Level 4.

---

## 3. Scientific Research Questions

1. **Primary Question**: Can Emerald decompose an L5/L6/L7 software-engineering task into a sequence of L3/L4-sized governed sub-tasks such that the composed result becomes independently verifiable and reliably correct?
2. **Composition Gap Question**: If decomposition improves local execution, is the ultimate limitation local code transformation or semantic composition across independently executed changes?

---

## 4. Research Hypotheses

- **H1 (Decomposition Benefit)**: Breaking an L5/L6/L7 task into independently executable L3/L4 sub-tasks increases end-to-end governed task completion. *(Outcome: Partially Supported — gain of +13.3%, but remains at 33.3%, far below the 80% reliability threshold).*
- **H2 (Verification Preservation)**: Every successful sub-task remains independently verifiable through the existing clean-room/fourfold gate. *(Outcome: Supported — 100% verified).*
- **H3 (Composition Gap)**: Even if every individual sub-task succeeds, composition may fail because later sub-tasks depend on semantic state produced by earlier sub-tasks. *(Outcome: Confirmed — 4/9 tasks with all subtasks passing failed final parent verification).*
- **H4 (Planning Overhead)**: Decomposition introduces additional model calls, context, latency, and Actions/Attempts. *(Outcome: Confirmed — 2.76x latency, 2.85x model calls, 2.68x context).*
- **H5 (Error Containment)**: A failed sub-task is isolated and does not corrupt the overall evidence chain or permit an invalid final completion claim. *(Outcome: Confirmed — 100% fail-closed).*
- **H6 (Decomposition Ceiling)**: There is a complexity beyond which decomposition overhead or cross-sub-task coordination exceeds the benefit. *(Outcome: Confirmed — L7 full SWE tasks remained 0/5).*

---

## 5. Frozen Protocol Specification

- **Protocol Version**: `emerald-phase46-task-decomposition-v1`
- **Protocol Digest**: `ee4683be056492da817850dc099089c0e1dd3555abadaf21ea958cf1f7d510d2`
- **Model**: `qwen2.5-coder:1.5b` (Q4_K_M, digest: `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668`)
- **Hardware**: Intel(R) Core(TM) i3-N305 (8 cores, 7.63 GiB RAM, `ACCELERATOR_UNAVAILABLE`)
- **Experimental Variable**: `task_decomposition_strategy` (isolated single variable)
- **Coordinator Ceilings**:
  - Maximum decomposition depth: 3
  - Maximum sub-tasks per parent task: 6
  - Maximum coordinator decisions: 8
  - Budget exceeded terminal state: `DECOMPOSITION_BUDGET_EXCEEDED` (fails closed)

---

## 6. Frozen Task Cohort

- **Cohort Digest**: `9bcccdf7aa2276786ef00ac2f7b5b69244779387465476f4b5174d4608f5d937`
- **Cohort Size**: Exactly 15 parent tasks derived from Phase 45:
  - **L5-derived (5 tasks)**: `P46-L5-01` to `P46-L5-05` (multi-function single-file repairs)
  - **L6-derived (5 tasks)**: `P46-L6-01` to `P46-L6-05` (multi-file semantic coordination)
  - **L7-derived (5 tasks)**: `P46-L7-01` to `P46-L7-05` (repository-scale SWE-bench tasks)

---

## 7. Frozen Decomposition Graphs

- **Graphs Digest**: `5b529769d0cc83cbec7490ea3941bd57c7bbf1a8b06eb3315c4552dc7913e956`
- **Total Graphs**: 15
- **Total Sub-Tasks**: 46
- **DAG Validation**: 15/15 graphs confirmed valid acyclic directed graphs with maximum depth $\le 3$ and fan-out $\le 6$.
- **Complexity Assignment**: Every sub-task is explicitly constrained to Level 3 (single-line / single-construct edit) or Level 4 (small bounded single-function repair).

---

## 8. Strategy Definitions

### Strategy A — Monolithic Control
The un-decomposed task description is supplied to the model. The model must locate, diagnose, and repair all interacting functions and files within a single execution trajectory.

### Strategy B — Static Expert Decomposition
The deterministic frozen decomposition graph is executed in topological order. Each sub-task runs independently with bounded scope, passes local unit verification, and produces an immutable evidence snapshot.

### Strategy C — Governed Hierarchical Decomposition
A bounded coordinator inspects task progress, queries graph dependencies, and activates eligible sub-tasks. The coordinator is constrained to max 8 decisions, max depth 3, and cannot synthesize new sub-tasks or expand capabilities.

---

## 9. Governance & Sub-Task Contract Model

The `SubTaskContract` is immutable and inherits all parent MissionContract security constraints:
- `subTaskId`, `parentTaskId`, `sequenceNumber`, `objective`, `allowedTools`, `workspaceScope`, `verificationSpec`, `dependencySubTaskIds`, `status`.
- **Authority Non-Escalation**: Sub-tasks cannot request tools or capabilities outside the parent MissionContract. Attempts to escalate authority are rejected immediately.
- **Scope Fencing**: Sub-tasks are strictly confined to their declared `workspaceScope`. File modifications outside this scope cause verification failure.

---

## 10. Sub-Task State Machine

```
  PENDING
   ├──> ELIGIBLE ──> RUNNING ──> VERIFICATION_PENDING ──> VERIFIED
   ├──> BLOCKED
   └──> CANCELLED
```
- Dependencies must have status `VERIFIED` before a child sub-task can transition to `ELIGIBLE` or `RUNNING`.
- Predecessor failure immediately transitions downstream sub-tasks to `BLOCKED`.

---

## 11. Parent Task Completion Semantics

A parent task can transition to `COMPLETED` **if and only if**:
```
ALL_REQUIRED_SUBTASKS_VERIFIED
AND
FINAL_PARENT_VERIFICATION_PASSED
AND
POLICY_SATISFIED
AND
EVIDENCE_COMPLETE
AND
TERMINAL_AUTHORITY_ESTABLISHED
```
Under no circumstances does sub-task completion imply parent task completion. The composed patch must independently pass the pristine dual-gate clean-room verifier.

---

## 12. Experimental Results & Strategy Comparison

| Metric | Strategy A (Monolithic) | Strategy B (Static Expert) | Strategy C (Hierarchical) |
|---|---|---|---|
| **Parent Task Success Rate** | **20.0% (3/15)** | **33.3% (5/15)** | **33.3% (5/15)** |
| L5 Parent Tasks Passed | 2/5 (40.0%) | 3/5 (60.0%) | 3/5 (60.0%) |
| L6 Parent Tasks Passed | 1/5 (20.0%) | 2/5 (40.0%) | 2/5 (40.0%) |
| L7 Parent Tasks Passed | 0/5 (0.0%) | 0/5 (0.0%) | 0/5 (0.0%) |
| **Individual Sub-Task Pass Rate** | N/A | **82.6% (38/46)** | **82.6% (38/46)** |
| Tasks with All Subtasks Verified | N/A | 9/15 (60.0%) | 9/15 (60.0%) |
| Parent Verification Passed | 3/15 (20.0%) | 5/15 (33.3%) | 5/15 (33.3%) |
| **Composition Failures** | N/A | **4/9 (44.4%)** | **4/9 (44.4%)** |
| Mean Latency per Task | 58.6 s | 161.8 s (2.76x) | 168.4 s (2.87x) |
| Mean Model Calls per Task | 14.2 | 40.5 (2.85x) | 43.1 (3.03x) |
| Mean Context Bytes per Task | 6,800 B | 18,200 B (2.68x) | 19,100 B (2.81x) |

---

## 13. Deep Dive: The Composition Gap

The central discovery of Phase 46 is the **Composition Gap**:
- Out of 15 parent tasks, **9 tasks achieved 100% success on all their constituent sub-tasks** (e.g. `P46-L5-04`, `P46-L6-03`, `P46-L6-04`, `P46-L7-01`).
- However, when the clean-room verifier executed the integrated parent test suite against the merged patch, **4 of those 9 tasks failed integration (44.4% composition failure rate)**.

### Concrete Failure Mechanisms:
1. **Semantic Drift (`P46-L6-03`)**: Sub-task 1 extracted `formatJson()` in `json.js` with its own error-handling convention, while Sub-task 2 wired `formatJson()` into `logger.js` expecting an exception to be thrown rather than a fallback string. Both passed unit tests, but the integrated logger test suite failed.
2. **Partial Interface Contract Mismatch (`P46-L6-04`)**: Normalizer in `request.js` lower-cased headers, but client transport in `client.js` assumed standard mixed-case for `Content-Type` boundary lookups.
3. **Hidden Context Assumption (`P46-L7-01`)**: Sub-task 1 tokenized negative exponents and Sub-task 2 calculated powers correctly in isolation, but the AST visitor in Sub-task 3 failed to propagate unary negative signs through nested parentheses in SWE-bench integration tests.

---

## 14. Orchestration Cost Analysis

Decomposition is not free:
- **Latency Multiplier**: **2.76x** (161.8s vs 58.6s). On a CPU-only host, evaluating 46 sub-tasks across 15 tasks took substantial execution time.
- **Model Call Multiplier**: **2.85x** (40.5 calls vs 14.2 calls).
- **Context Multiplier**: **2.68x** (18,200 bytes cumulative vs 6,800 bytes).
- **Decomposition Gain**: Only **+13.3%** absolute gain (from 20.0% to 33.3%).

---

## 15. Negative Controls (N1–N8)

All 8 negative controls executed and passed with 100% fail-closed integrity:
- **N1 (All Sub-Tasks Pass, Integration Fails)**: Parent transitioned to `FAILED`; terminal reason `COMPOSITION_FAILURE`.
- **N2 (Sub-Task Failure Blocks Child)**: Downstream task transitioned to `BLOCKED`.
- **N3 (Scope Violation)**: File edit outside declared `workspaceScope` failed sub-task verification.
- **N4 (No-Mutation Claim)**: Empty diff rejected by authoritative completion gate.
- **N5 (Premature Execution)**: Dispatch attempt before dependency verification was blocked.
- **N6 (Unsanctioned Sub-Task Insertion)**: Dynamic graph modification rejected; graph is frozen.
- **N7 (Authority Escalation)**: Capability outside parent MissionContract rejected.
- **N8 (Parent Completion Without Verification)**: Rejected by fourfold gate.

---

## 16. Governance & Evidence Integrity

- **Clean-Room Dual-Gate Verification**: 100% Fail-Closed.
- **Fourfold Completion Gate**: 100% Fail-Closed.
- **Threshold Signatures**: 100% Ed25519 2-of-3 quorum verified across all sub-task and parent evidence bundles.
- **Terminal Fencing**: 100% Invariant B single terminal record per run.
- **Offline Auditor Concordance**: 100% agreement across all 45 evaluated runs.

---

## 17. Scientific Interpretation

Phase 46 answers the core research questions unambiguously:
1. **Does decomposition convert unreliable tasks into reliable execution?**
   **No.** While individual sub-task success is high (82.6%), end-to-end parent task success only improved from 20.0% to 33.3%, far below the 80% reliability threshold.
2. **What is the root cause?**
   The primary limitation is **semantic composition across sub-tasks**, not local code transformation. Small models (`1.5B`) lack the parametric capacity to maintain subtle global invariants and interface contracts across independent edit steps.
3. **Outcome Classification**:
   **CASE B** (*Intermediate benefit, insufficient for reliability*) combined with **CASE D** (*Composition Gap Confirmed*).

---

## 18. Decision & Next Research Boundary

### Decision
Do **NOT** build an open-ended multi-agent planning engine or expand decomposition complexity. Orchestration overhead is high (2.76x latency) and does not bridge the semantic composition gap.

### Next Research Boundary (Phase 47)
Investigate **Governed Interface Contracts & Cross-Subtask Semantic Anchoring**: evaluate whether formal typed interface specifications and shared invariant schemas can prevent semantic drift between decomposed sub-tasks.

---

```text
PHASE46_STATUS: COMPLETE
MODEL: qwen2.5-coder:1.5b
MODEL_DIGEST: d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668
HARDWARE: Intel(R) Core(TM) i3-N305 (7.63 GiB, ACCELERATOR_UNAVAILABLE)
TASK_COHORT: 15 tasks (5 L5, 5 L6, 5 L7)
PARENT_TASKS: 15

MONOLITHIC_SUCCESS: 20.0% (3/15)
STATIC_DECOMPOSITION_SUCCESS: 33.3% (5/15)
HIERARCHICAL_DECOMPOSITION_SUCCESS: 33.3% (5/15)

SUBTASK_SUCCESS: 82.6% (38/46)
COMPOSITION_SUCCESS: 55.6% (5/9)
FINAL_VERIFICATION: 33.3% (5/15)

DECOMPOSITION_GAIN: +13.3%
LATENCY_MULTIPLIER: 2.76x
MODEL_CALL_MULTIPLIER: 2.85x
CONTEXT_MULTIPLIER: 2.68x

GOVERNANCE_INVARIANCE: 100%
CLEAN_ROOM_INTEGRITY: 100% Fail-Closed
FOURFOLD_INTEGRITY: 100% Fail-Closed
OFFLINE_AUDITOR_AGREEMENT: 100%
TERMINAL_AUTHORITY_INTEGRITY: 100%

PRIMARY_FINDING: Sub-task synthesis within L3/L4 boundary is reliable (82.6%), but parent composition fails (44.4% composition failure rate).
COMPOSITION_GAP: CONFIRMED (4/9 tasks with all subtasks passing failed final parent integration).
DECISION: DECOMPOSITION_BENEFIT_DEMONSTRATED_BUT_INSUFFICIENT (33.3% < 80%).
NEXT_RESEARCH_BOUNDARY: Phase 47 — Governed Interface Contracts & Cross-Subtask Semantic Anchoring.
```
