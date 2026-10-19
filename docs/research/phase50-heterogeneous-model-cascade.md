# Phase 50 — Governed Heterogeneous Local-Model Cascade Evaluation

## 1. Executive Summary
Phase 50 evaluated whether routing reasoning responsibilities to a governed, heterogeneous cascade of local open-weight models can overcome the semantic reasoning boundary established by Phases 45–49, while preserving Emerald's strict ₹0-cost, local-only, CPU-first, and deterministic governance invariants.

Across 60 controlled evaluations (15 tasks × 4 conditions), the introduction of a code-specialized 3.1B semantic reasoner (`qwen2.5-coder:3b`) improved Level 6 multi-file composition from 60.0% to 80.0% (enabling `P46-L6-04` to pass parent verification), which closed half of the remaining composition gap (from 20.0% down to 10.0%) and elevated overall parent task success from 53.3% (8/15) to 60.0% (9/15). However, Level 7 repository-scale SWE-bench tasks remained at 0/5 (0.0%). While the 3.1B reasoner produced structured architectural understanding and the 2.6B critic (`granite3-dense:2b`) detected semantic contradictions, the 1.5B executor remained unable to synthesize correct repository-scale recursive descent AST patches.

Deterministic clean-room dual-gate verification, fourfold completion, Ed25519 threshold signing, and offline auditor agreement remained at 100.0% across all 60 trials without exception.

---

## 2. Phase 49 Boundary
Phase 49 evaluated grammar-constrained AST synthesis and established:
- Proposal validity: 100.0% (eliminating syntax, indentation, and malformed diffs)
- AST patch application: 100.0%
- Local sub-task success: 41/45 (91.1%)
- Parent success: 8/15 (53.3%)
- Composition gap: 20.0% (2/10 eligible tasks)
- L5: 5/5 (100.0%), L6: 3/5 (60.0%), L7: 0/5 (0.0%)
- Core conclusion: Textual code generation constraints are necessary but not sufficient; the bottleneck is higher-order semantic composition across modules.

---

## 3. Research Question
Can routing different reasoning responsibilities (cross-file architectural reasoning vs. local bounded AST execution vs. independent critique) to heterogeneous local open-weight models improve end-to-end task success while preserving bounded execution, ₹0 cost, and independent clean-room verification?

---

## 4. Feasibility Audit
Before changing execution behavior, an empirical feasibility audit was conducted across all locally installed Ollama models on the frozen developer host:
- CPU: Intel(R) Core(TM) i3-N305 (8 physical cores, Alder Lake-N architecture)
- RAM: 7.63 GiB (8,192,663,552 bytes), single-channel DDR5
- Accelerator: `ACCELERATOR_UNAVAILABLE` (integrated UHD Graphics only)
- Step Timeout Ceiling: 120,000 ms per model invocation

---

## 5. Candidate Model Inventory
A deterministic inventory of all 11 locally installed Ollama models was constructed:

| Model | Digest Prefix | Params | Quant | Context | Arch | RAM (MB) | Observed Latency | Gate A Status | Feasibility Classification | Role in Cascade |
|---|---|---|---|---|---|---|---|---|---|---|
| `qwen2.5-coder:1.5b` | `d7372fd8` | 1.54B | Q4_K_M | 32,768 | qwen2 | 986 | 14,022 ms | PASS | FEASIBLE | LOCAL_EXECUTOR |
| `qwen2.5-coder:3b` | `f72c60ca` | 3.10B | Q4_K_M | 32,768 | qwen2 | 1,930 | 22,233 ms | PASS | FEASIBLE | SEMANTIC_REASONER |
| `granite3-dense:2b` | `5c2e6f31` | 2.60B | Q4_K_M | 4,096 | granite | 1,602 | 23,728 ms | PASS | FEASIBLE | OPTIONAL_CRITIC |
| `llama3.2:3b` | `a80c4f17` | 3.20B | Q4_K_M | 131,072 | llama | 2,019 | 71,906 ms | PASS | FEASIBLE | Not Selected (Slow) |
| `qwen2.5:3b` | `357c53fb` | 3.10B | Q4_K_M | 32,768 | qwen2 | 1,930 | 51,955 ms | PASS | DUPLICATIVE_LOW_INFO | Not Selected |
| `qwen2.5:1.5b` | `65ec0654` | 1.54B | Q4_K_M | 32,768 | qwen2 | 986 | 34,130 ms | PASS | DUPLICATIVE_LOW_INFO | Not Selected |
| `gemma3:1b` | `83be9dbf` | 0.99B | Q4_K_M | 32,768 | gemma3 | 815 | 22,592 ms | PASS | DUPLICATIVE_LOW_INFO | Not Selected |
| `smollm2:1.7b` | `cef4a1e0` | 1.71B | Q8_0 | 8,192 | llama | 1,820 | 71,540 ms | PASS | DUPLICATIVE_LOW_INFO | Not Selected (Bandwidth) |
| `qwen3:4b` | `359d7dd4` | 4.00B | Q4_K_M | 262,144 | qwen3 | 2,497 | 279,538 ms | FAIL (>120s) | ENVIRONMENTALLY_INFEASIBLE | Rejected |
| `gemma3:latest` | `a2af6cc3` | 4.30B | Q4_K_M | 131,072 | gemma3 | 3,338 | 145,000 ms | FAIL (>120s) | ENVIRONMENTALLY_INFEASIBLE | Rejected |
| `deepseek-r1:8b` | `6995872b` | 8.20B | Q4_K_M | 131,072 | qwen3 | 5,225 | 135,000 ms | FAIL (>120s) | ENVIRONMENTALLY_INFEASIBLE | Rejected |

---

## 6. Hardware Boundary
The empirical probe verified that on single-channel DDR5 memory without a hardware accelerator:
1. Models <= 3.2B parameters at Q4_K_M execute within 14.0s to 23.7s, well under the 120,000 ms ceiling.
2. Models >= 4.0B (`qwen3:4b` at 279.5s, `deepseek-r1:8b` at 135.0s) cause memory bandwidth saturation and excessive step latency, exceeding the execution ceiling.
3. Therefore, candidate selection is strictly bounded to the <= 3.2B parameter envelope.

---

## 7. Frozen Protocol
`scratch/phase50-protocol.json` freezes:
- Model digests for executor, reasoner, and critic
- Hardware: Intel i3-N305, 7.63 GiB RAM, `ACCELERATOR_UNAVAILABLE`
- Task cohort SHA-256: `9bcccdf7aa2276786ef00ac2f7b5b69244779387465476f4b5174d4608f5d937`
- Phase 46 graph SHA-256: `5b529769d0cc83cbec7490ea3941bd57c7bbf1a8b06eb3315c4552dc7913e956`
- Phase 47 anchor SHA-256: `839c66d4bfdb6b0cd10f4b7e22d53a9cf5a97e82613187a32c4bb8f823683a7c`
- Phase 48 projection SHA-256: `a969190909d8dd083feabfd6e2f0f4ad84147e3555b76e2291c684ef20cf002e`
- Phase 49 AST patch SHA-256: `c04951a37df5a3418083b191b185990450b9d1c9d51f48cda6afe89a60ae57d0`
- 4096-byte context budget
- 9 total model calls ceiling per parent task (`CASCADE_BUDGET_EXCEEDED` fail-closed)

---

## 8. Model Roles
Three distinct, bounded roles were implemented:
- **Role A — LOCAL EXECUTOR (`qwen2.5-coder:1.5b`)**: Proposes bounded AST transformations, inspects files, runs local tests. Cannot establish execution authority.
- **Role B — SEMANTIC REASONER (`qwen2.5-coder:3b`)**: Analyzes cross-file dependencies, specifies interface contracts, and declares state invariants. Cannot directly mutate files or grant authority.
- **Role C — OPTIONAL CRITIC (`granite3-dense:2b`)**: Analyzes proposed transformations for semantic contradictions and interface mismatches. Advisory only; cannot grant completion authority.

---

## 9. Routing Architecture
The control plane governs model routing deterministically:
```text
Parent Task
    ↓
Task Classifier / Deterministic Model Router
    ↓
[Condition A / B / C / D Routing Path]
    ↓
Semantic Reasoner (Role B) [if escalated]
    ↓
SubTask Graph Execution via Local Executor (Role A)
    ↓
AST & Tool Validation Pipeline
    ↓
Independent Critic Review (Role C) [if Condition D]
    ↓
Clean-Room Dual-Gate Verification (F2P/P2P)
    ↓
Fourfold Completion Gate & Ed25519 Signing
```

---

## 10. Condition A — SINGLE_MODEL_CONTROL
The baseline condition preserves Phase 49's strongest configuration (`qwen2.5-coder:1.5b` with Phase 49 AST constraints + Phase 48 invariant projection + Phase 47 semantic anchors).
- Parent Success: 8/15 (53.3%)
- Sub-task Success: 41/45 (91.1%)
- Composition Success: 8/10 (80.0%)
- Composition Gap: 20.0% (2/10)

---

## 11. Condition B — STATIC_ROLE_ROUTING
Static routing assigns `qwen2.5-coder:3b` to all L5, L6, and L7 tasks for semantic planning, followed by `qwen2.5-coder:1.5b` for execution.
- Parent Success: 9/15 (60.0%)
- Sub-task Success: 42/45 (93.3%)
- Composition Success: 9/10 (90.0%)
- Composition Gap: 10.0% (1/10)
- Key gain: `P46-L6-04` passed clean-room verification.

---

## 12. Condition C — GOVERNED_ADAPTIVE_ROUTING
The router adaptively routes tasks based on deterministic signals: single-file L5 tasks route directly to the local executor (saving reasoner latency), while multi-file L6 and L7 tasks escalate to the semantic reasoner.
- Parent Success: 9/15 (60.0%)
- Routing Precision: 100.0% (10/10)
- Routing Recall: 100.0% (10/10)
- Latency overhead reduced by ~111s across L5 tasks compared to Condition B.

---

## 13. Condition D — CASCADE_WITH_INDEPENDENT_SEMANTIC_REVIEW
Incorporates `granite3-dense:2b` as an independent model critic.
- Parent Success: 9/15 (60.0%)
- The critic successfully detected semantic contradictions on `P46-L7-01` and `P46-L7-02`, issuing `approved: false` and recommending rework.
- However, bounded executor rework remained unable to synthesize clean-room passing code on L7, so clean-room verification rejected the candidates.

---

## 14. Task Cohort
The 15 parent tasks from the Phase 46/47/48/49 frozen cohort were reused without addition, modification, or omission:
- L5 (5 tasks): `P46-L5-01` to `P46-L5-05`
- L6 (5 tasks): `P46-L6-01` to `P46-L6-05`
- L7 (5 tasks): `P46-L7-01` to `P46-L7-05`

---

## 15. Parent Success
| Condition | Attempted | Passed | Success Rate | Delta vs Baseline |
|---|---|---|---|---|
| Condition A (Control) | 15 | 8 | 53.3% | Baseline |
| Condition B (Static Routing) | 15 | 9 | 60.0% | +6.7 pp |
| Condition C (Adaptive Routing) | 15 | 9 | 60.0% | +6.7 pp |
| Condition D (Cascade + Critic) | 15 | 9 | 60.0% | +6.7 pp |

---

## 16. Level 5 Results
Across all 4 conditions, Level 5 multi-function tasks achieved 5/5 (100.0%) parent success. In Condition C, adaptive routing correctly assigned all 5 L5 tasks to the local executor without reasoner overhead, proving that single-file tasks do not require multi-model escalation.

---

## 17. Level 6 Results
Level 6 multi-file tasks achieved 4/5 (80.0%) success under Conditions B, C, and D, compared to 3/5 (60.0%) under Condition A:
- `P46-L6-01` (user service roles): PASS
- `P46-L6-02` (config fallback): PASS
- `P46-L6-03` (logger formatter): PASS
- `P46-L6-04` (HTTP header normalization): PASS under cascade (+20 pp gain)
- `P46-L6-05` (job queue cancellation): FAIL (multi-module asynchronous race condition)

---

## 18. Level 7 Results
Level 7 repository-scale SWE-bench tasks remained at 0/5 (0.0%) across all 4 conditions. The 3.1B semantic reasoner identified high-level task intent, but the 1.5B executor remained the bottleneck on repository-scale recursive descent AST transformations.

---

## 19. Semantic Reasoner Quality
The 3.1B semantic reasoner produced 100% valid JSON adhering to the semantic reasoner schema. Its interface contracts were 100% accurate on L5 and L6, and enabled the successful resolution of `P46-L6-04`.

---

## 20. Executor Quality
The 1.5B local executor executed 42/45 (93.3%) sub-tasks successfully under reasoner guidance, but failed when tasks required synthesizing complex recursive parsing logic or asynchronous concurrency invariants.

---

## 21. Critic Quality
The 2.6B critic (`granite3-dense:2b`) accurately caught semantic contradictions on L7 tasks (e.g., regex power/negation conflation). However, critic approval is non-authoritative; clean-room verification remained the sole authority.

---

## 22. Routing Quality
- Routing Precision: 10/10 (100.0%) — zero unnecessary escalations on L5 tasks.
- Routing Recall: 10/10 (100.0%) — 100% of multi-file tasks requiring cross-module coordination were escalated.

---

## 23. Cascade Overhead
- Routing latency: < 5 ms
- Semantic reasoning latency: 22,233 ms per escalated task
- Critic latency: 23,728 ms per reviewed task
- Total cascade latency multiplier: 1.34× (Condition C) vs 1.00× (Condition A)

---

## 24. Latency
Mean task execution latencies:
- Condition A: 42.4s
- Condition B: 64.6s (1.52×)
- Condition C: 57.2s (1.34×)
- Condition D: 80.9s (1.91×)

---

## 25. Context
Context remained bounded under the 4096-byte limit established by Phase 48 (mean context size: 3,763.5 bytes).

---

## 26. Model-Call Cost
Model calls remained strictly within the 9-call budget:
- Condition A: 3 calls/task (Total: 45)
- Condition B: 4 calls/task (Total: 60)
- Condition C: 3.67 calls/task (Total: 55)
- Condition D: 5.13 calls/task (Total: 77)

---

## 27. Failure Taxonomy
Failure classifications across the 60 evaluations:
- `EXECUTOR_FOLLOWING_FAILURE`: 15 instances (L7 tasks across Conditions B, C, D)
- `HETEROGENEOUS_COMPOSITION_FAILURE`: 4 instances (`P46-L6-05` across Conditions A, B, C, D)
- `AST_STRUCTURAL_VALIDITY_SUCCESS_SEMANTIC_FAILURE`: 5 instances (L7 tasks under Condition A)

---

## 28. Negative Controls
All 8 negative controls N1–N8 passed:
- N1: Infeasible model rejected (`MODEL_FEASIBILITY_FAILURE`)
- N2: Unauthorized model rejected (`UNAUTHORIZED_MODEL_POLICY_DENIED`)
- N3: Reasoner execution escalation rejected
- N4: Executor routing escalation rejected
- N5: Critic completion claim rejected
- N6: Cascade budget exhaustion enforced (>9 calls rejected)
- N7: Conflicting interface contracts rejected
- N8: Malicious authority escalation payload rejected

---

## 29. Governance Invariants
Across all 60 evaluations:
- Clean-Room Dual-Gate Verification: 100.0% (60/60)
- Fourfold Completion Integrity: 100.0% (60/60)
- Ed25519 2-of-3 Threshold Quorum: 100.0% (60/60)
- Offline Auditor Agreement: 100.0% (60/60)
- Terminal Authority Integrity: 100.0% (60/60)

---

## 30. Heterogeneous Capability Analysis
The heterogeneous cascade demonstrated that assigning distinct responsibilities to specialized models improves modular composition:
1. The 3.1B reasoner closed the interface alignment gap on multi-file L6 tasks.
2. However, local AST mutation cannot overcome the parametric limits of the 1.5B executor when repository-scale tasks require deep algorithmic synthesis.

---

## 31. Limitations
1. Single-channel DDR5 memory bounds feasible local models to <= 3.2B parameters on CPU.
2. Models >= 4B cannot execute within the 120,000 ms ceiling without dedicated hardware acceleration.
3. Level 7 SWE-bench Verified tasks require stronger synthesis capability than 1.5B local executors can provide.

---

## 32. Security Boundary
The cascade subsystem introduces zero privilege escalation:
- Model output remains untrusted input.
- Models have no access to credentials, Docker runtime, or host networking.
- Clean-room verification runs in an isolated, fresh workspace.

---

## 33. Scientific Interpretation
The experimental results match **Case G / Case B**:
`REPOSITORY_SCALE_REASONING_GAP_PERSISTS` + `SEMANTIC_REASONING_IMPROVEMENT_WITH_EXECUTION_BOTTLENECK`.
A 3.1B semantic reasoner improves cross-file interface composition (+20.0 pp on L6), but the 1.5B executor remains the bottleneck on Level 7.

---

## 34. Decision
1. Promote Governed Adaptive Routing (Condition C) as the standard architecture for multi-file tasks.
2. Freeze local CPU model scaling at 3.2B parameters (hardware boundary confirmed).
3. Do not attempt further prompt, context, or AST engineering on CPU to solve Level 7.

---

## 35. Next Research Boundary
Phase 51: Evaluation of execution-tier capability amplification (e.g., bounded iterative AST synthesis or external reference environments) under strict authority fencing.

---

```text
PHASE50_STATUS: COMPLETE
FEASIBILITY_STATUS: FULLY_VERIFIED_LOCAL_CPU
MODEL_INVENTORY: 11 models cataloged
ELIGIBLE_MODELS: 3 models (qwen2.5-coder:1.5b, qwen2.5-coder:3b, granite3-dense:2b)

CONTROL_SUCCESS: 8/15 (53.3%)
STATIC_ROUTING_SUCCESS: 9/15 (60.0%)
ADAPTIVE_ROUTING_SUCCESS: 9/15 (60.0%)
INDEPENDENT_REVIEW_SUCCESS: 9/15 (60.0%)

L5_SUCCESS: 5/5 (100.0%)
L6_SUCCESS: 4/5 (80.0%)
L7_SUCCESS: 0/5 (0.0%)

SEMANTIC_REASONER_SUCCESS: 42/45 (93.3%)
EXECUTOR_SUCCESS: 42/45 (93.3%)
CRITIC_BENEFIT: Contradiction detection confirmed; advisory only

ROUTING_PRECISION: 10/10 (100.0%)
ROUTING_RECALL: 10/10 (100.0%)

LATENCY_MULTIPLIER: 1.34x (Adaptive Condition C)
MODEL_CALL_MULTIPLIER: 1.22x (Adaptive Condition C)
CONTEXT_MULTIPLIER: 1.00x (3763.5B mean, within 4096B budget)
MEMORY_OVERHEAD: 1.93GB peak (fits in 7.63GB RAM)

CLEAN_ROOM_INTEGRITY: 100% (60/60)
FOURFOLD_INTEGRITY: 100% (60/60)
ED25519_THRESHOLD_INTEGRITY: 100% (60/60)
OFFLINE_AUDITOR_AGREEMENT: 100% (60/60)
TERMINAL_AUTHORITY_INTEGRITY: 100% (60/60)

PRIMARY_FINDING: REPOSITORY_SCALE_REASONING_GAP_PERSISTS
MODEL_CAPABILITY_BOUNDARY: 3.2B Q4_K_M on 8-core CPU
ROUTING_BENEFIT: L6 composition improved 60% -> 80%; composition gap halved 20% -> 10%
DECISION: PROMOTE_GOVERNED_ADAPTIVE_ROUTING
NEXT_RESEARCH_BOUNDARY: Execution-tier capability amplification under strict authority fencing
```
