# Phase 28: SmolLM2 1.7B Controlled Recovery Experiment Report

## Executive Summary

- **Phase**: 28
- **Timestamp**: 2026-10-18T10:30:48.077Z
- **Baseline Git SHA**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Project Policy**: **₹0-cost, open-source / open-weight models ONLY.**
- **Evaluated Model**: `smollm2:1.7b` (1.7B, Q8_0, 1.82 GB (1,820,428,533 bytes))
- **Model Digest**: `cef4a1e09247f018ca0c482ad4c2ce1474aba5e87f245dacf97f07948d05d8b4`
- **Gate A Outcome**: **ENVIRONMENT_FAILURE** (120.1s)
- **Capability Level Reached**: **LEVEL 0** (No valid initial proposal within latency boundary.)
- **Primary Failure Classification**: **`ENVIRONMENT_FAILURE`**
- **Secondary Failures**: None

---

## 1. Experimental Result

SmolLM2-1.7B was evaluated under Emerald's frozen architecture to test whether synthetic multi-turn tool-calling and alignment SFT allows a sub-2B model to achieve closed-loop recovery after validator rejection.

- **Gate A Latency**: 120.1s (Operational ceiling: 120.0s)
- **Gate A Classification**: `ENVIRONMENT_FAILURE`
- **Gate B Status**: `NOT_RUN`
- **Physical Code Mutation Occurred**: NO
- **Correct Math Repair**: NO
- **Clean-Room Verification**: NOT REACHED

---

## 2. Gate A

| Metric | Measured Value | Threshold / Standard | Status |
| :--- | :--- | :--- | :--- |
| **Response Latency** | **120065 ms (120.1s)** | 120,000 ms | FAIL |
| **Response Status** | `TIMEOUT` | `RECEIVED` | FAIL |
| **Raw Response Bytes** | 0 bytes | >0 bytes | FAIL |
| **Selected Tool** | `None` | Valid registered tool | FAIL |
| **Proposal Validity** | `false` | `true` | FAIL |
| **Validation Reason** | `CPU_INFERENCE_LATENCY_BOUNDARY` | `NONE` | FAIL |
| **Gate A Classification** | **`ENVIRONMENT_FAILURE`** | `INFERENCE_VALIDATED` | FAIL |

---

## 3. Capability Level

- **Assigned Level**: **LEVEL 0**
- **Description**: No valid initial proposal within latency boundary.

---

## 4. Tool Argument Grounding

- **Inspected Before Edit**: NO
- **Used `path` Not `filePath`**: NO
- **Preserved Argument Names**: NO
- **Respected Integer Bounds**: NO
- **Notes**: Gate A failed.

---

## 5. Observation vs Input Separation

- **Treated Metadata As Input (`contentHash` leakage)**: NO (PASSED)
- **State Notes**: No observation generated.

---

## 6. Recovery Result

- **Total Rejections**: 0
- **Recovery Attempts**: 0
- **Successful Recovery Events**: **0**
- **Repeated Proposal Count**: 0
- **Distinct Corrective Proposal Count**: 0
- **Recovery Status**: Gate B was not executed because Gate A failed.

---

## 7. Coding Result

- **Physical Mutation Occurred**: NO
- **Correct Math Repair (`a + b`)**: NO
- **Preserved Multiply Function**: NO
- **Candidate Patch Snippet**:
```javascript
// No code patch generated
```

---

## 8. Independent Verification

- **Clean-Room Reached**: NO
- **Clean-Room Verified**: NO
- **FAIL_TO_PASS Rate**: N/A
- **PASS_TO_PASS Rate**: N/A
- **Fourfold Completion Passed**: NO

---

## 9. Hypothesis Evaluation

| Hypothesis | Expected Prediction | Classification | Measured Evidence |
| :--- | :--- | :--- | :--- |
| **H1 — CPU FEASIBILITY** | Valid proposal $le 120$s | **`NOT_SUPPORTED`** | Gate A completed in 120.1s. |
| **H2 — TOOL GROUNDING** | Valid multi-step arguments | **`NOT_TESTABLE`** | Argument validity across turns: Gate A failed.. |
| **H3 — RECOVERY** | Rejection $ightarrow$ Differentiated valid proposal | **`NOT_TESTABLE`** | Recovery successes: 0. |
| **H4 — STATE DISTINCTION** | Separates tool output from input | **`NOT_TESTABLE`** | Metadata leakage: false. |
| **H5 — CODE REPAIR** | Correct arithmetic repair | **`NOT_TESTABLE`** | Mutation: false, Repair: false. |
| **H6 — END-TO-END GOVERNED EXECUTION** | Clean-room verification & fourfold pass | **`NOT_SUPPORTED`** | Verification passed: false. |

---

## 10. Comparison With Previous Models

| Model | Parameters | Gate A Latency | Initial Proposal | Physical Mutation | Recovery | Verification | Final Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `gemma3:1b` | ~1B | 57.4s | Premature GOAL_REACHED | No | No | Failed | `MODEL_SCHEMA_FAILURE` |
| `qwen2.5:1.5b` | ~1.5B | 69.4s | write_file | Yes | No (6 rejections) | Not reached | `MODEL_RECOVERY_FAILURE` |
| `qwen2.5-coder:1.5b` | ~1.5B | 64.4s | read_file | No | No (6 rejections) | Not reached | `MODEL_RECOVERY_FAILURE` |
| `granite3-dense:2b` | ~2.6B | 120.1s (timeout) | None (timeout) | No | No | Not reached | `ENVIRONMENT_FAILURE` |
| `SmolLM2 1.7B` | 1.7B | 120.1s | None | No | No | Not reached | `ENVIRONMENT_FAILURE` |

---

## 11. Primary Failure Classification

- **Primary Classification**: **`ENVIRONMENT_FAILURE`**
- **Description**: SmolLM2-1.7B inference exceeded the 120,000ms CPU feasibility boundary on the Intel i3-N305.
- **Secondary Classifications**: None

---

## 12. Scientific Conclusion

SmolLM2-1.7B evaluated at 1.7B parameters failed Gate A feasibility with classification ENVIRONMENT_FAILURE (120.1s). The model could not produce a valid initial action proposal within the 120s feasibility ceiling on the Intel Core i3-N305.

---

## 13. Phase 29 Recommendation

Reassess whether Q8_0 quantization level is responsible for CPU latency or evaluate an alternative sub-2B candidate.
