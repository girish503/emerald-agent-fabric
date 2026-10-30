# Phase 26: Granite 2B Controlled Agent Capability Experiment Report

## Experimental Result

- **Phase**: 26
- **Timestamp**: 2026-10-18T09:52:18.121Z
- **Baseline Commit**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Project Constraint**: ₹0-cost, open-weight only, local inference only
- **Model Under Test**: `granite3-dense:2b` (2.63B parameters, Q4_K_M quantization, 1.6 GB size)
- **Model Digest**: `5c2e6f3112f4f396c4c5221e4b5c85d002d17d06911604cd56b9359d7e6e5f7a`
- **Ollama Version**: 0.40.6
- **Host Hardware**: Intel Core i3-N305 (8 physical/logical E-cores, AVX2), 7,813 MB RAM (1,662 MB free)
- **Overall Success Level**: **LEVEL 0 — INFERENCE FAILURE** (No valid proposal produced within the 120,000ms ceiling)
- **Primary Failure Classification**: **`ENVIRONMENT_FAILURE`**
- **Secondary Failures**: None

---

## Gate A Result

| Metric | Measured Value | Ceiling / Target | Status |
| :--- | :--- | :--- | :--- |
| **Inference Latency** | **120,053 ms (120.1s)** | 120,000 ms | FAIL (ENVIRONMENT_FAILURE) |
| **Response Status** | `TIMEOUT` | `RECEIVED` | FAIL |
| **Selected Tool** | `NONE` | Valid registered tool | FAIL |
| **Proposal Valid** | `false` | true | FAIL |
| **Rejection Reason** | `CPU_INFERENCE_LATENCY_BOUNDARY` | NONE | FAIL |
| **Gate A Classification** | `ENVIRONMENT_FAILURE` | `INFERENCE_VALIDATED` | FAIL |

### Raw Proposal Output
```json
// No output (timed out after 120,053ms)
```

---

## Closed-Loop Result

Gate B was NOT executed because Gate A halted with `ENVIRONMENT_FAILURE` per Section 8 stop conditions. Zero physical actions were dispatched; zero workspace mutations occurred.

---

## Tool Argument Grounding

- **Used `path` instead of `filePath`**: N/A (Gate A timed out before producing proposal)
- **Preserved tool argument names**: N/A
- **Respected integer bounds**: N/A
- **Grounding assessment**: Gate A timed out before a proposal could be evaluated.

---

## Observation-to-Action Result

- **Treated observation metadata as future tool input**: N/A (No tool observation generated)
- **Observation incorporation notes**: Gate B not reached; observation transition untestable.

---

## Recovery Result

- **Recovery Events (Rejections received)**: 0
- **Recovery Successes (Corrected valid proposal after rejection)**: 0
- **Repeated identical invalid proposal**: N/A
- **Recovery assessment**: Gate B was not executed because Gate A timed out.

---

## Coding Result

- **Called `read_file` before editing**: NO
- **Physical workspace mutation occurred**: NO
- **Repaired addition defect (`return a + b;`)**: NO
- **Preserved `multiply` utility**: NO
- **Candidate patch content**: None (Zero workspace mutations)

---

## Independent Verification Result

- **Clean-room reached**: NO
- **Clean-room verified**: NO
- **Dual-gate FAIL_TO_PASS**: N/A
- **Dual-gate PASS_TO_PASS**: N/A
- **Fourfold Completion Gate**: FAILED (`TaskSatisfied: false`, `VerificationPassed: false`)

---

## Hypothesis Evaluation

- **H1 (INTERMEDIATE_CAPACITY)**: *A ~2.6B model can remain inside the 120-second CPU boundary while providing stronger agent capability than the tested ~1.5B models.* $\rightarrow$ **NOT_SUPPORTED** (Latency of 120,053 ms exceeded the 120s ceiling).
- **H2 (TOOL_TRAINING)**: *Explicit function/tool-calling training improves tool argument grounding.* $\rightarrow$ **NOT_TESTABLE** (Model timed out before tool proposals could be parsed).
- **H3 (RECOVERY)**: *Tool/function-calling training improves response to validator rejection.* $\rightarrow$ **NOT_TESTABLE** (Rejections not reached).
- **H4 (CODING)**: *Granite can perform the elementary math repair correctly.* $\rightarrow$ **NOT_TESTABLE** (Workspace mutations not reached).
- **H5 (END_TO_END)**: *Granite can complete the full governed inspect $\rightarrow$ edit $\rightarrow$ verify trajectory.* $\rightarrow$ **NOT_SUPPORTED** (Halted at Gate A).

---

## Comparison With Previous Models

| Model | Params | Gate A Latency | Initial Proposal | Mutation | Recovery | Verification | Final Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **gemma3:1b** | ~1B | 57.4s | Premature GOAL_REACHED | No | No | Failed | `MODEL_SCHEMA_FAILURE` |
| **qwen2.5:1.5b** | ~1.5B | 69.4s | write_file | Yes | No (6 rejections) | Not reached | `MODEL_RECOVERY_FAILURE` |
| **qwen2.5-coder:1.5b** | ~1.5B | 64.4s | read_file | No | No (6 rejections) | Not reached | `MODEL_RECOVERY_FAILURE` |
| **llama3.2:3b** | ~3B | 119.0s | read_file (invalid bounds) | No | No | Not reached | `MODEL_SCHEMA_FAILURE` |
| **qwen2.5:3b** | ~3B | >120.0s | None (timeout) | No | No | Not reached | `ENVIRONMENT_FAILURE` |
| **qwen2.5-coder:3b** | ~3B | 120.0s (timeout) | None (timeout) | No | No | Not reached | `ENVIRONMENT_FAILURE` |
| **Granite 2B** | ~2.6B | **120.1s (timeout)** | **None (timeout)** | **No** | **No** | **Not reached** | **`ENVIRONMENT_FAILURE`** |

---

## Primary Failure Classification

**`ENVIRONMENT_FAILURE`**

- **Reason**: `CPU_INFERENCE_LATENCY_BOUNDARY`
- **Description**: Granite 2B (`granite3-dense:2b`) inference exceeded the 120,000ms CPU feasibility boundary on the Intel Core i3-N305 (120,053 ms elapsed). Local CPU compute throughput prevented evaluation of model coding capability under Emerald's fixed operational ceiling.

---

## Scientific Conclusion

`granite3-dense:2b` evaluated at ~2.63B parameters failed Gate A feasibility due to `ENVIRONMENT_FAILURE` (120.1s latency). Like `qwen2.5-coder:3b` (120.0s) and `llama3.2:3b` (119.0s), 2.6B+ parameter models cannot sustain interactive single-step generation within a 120s ceiling on the commodity 8-core Gracemont CPU baseline without dedicated hardware acceleration. The hypothesis that an intermediate ~2.6B parameter model could remain within the CPU operational budget while improving agent capabilities is definitively refuted for this host architecture.

---

## Phase 27 Recommendation

Because all tested open-weight models at or above 2.6B parameters (`granite3-dense:2b` at 120.1s, `qwen2.5-coder:3b` at 120.0s, `llama3.2:3b` at 119.0s) hit or exceed the 120s CPU boundary, any future sub-3B local testing must target the **1.5B–2.0B parameter bracket** (e.g., `smollm2:1.7b`), or Emerald must explore CPU inference optimizations (e.g., KV-cache persistence, thread pinning, or context pruning).
