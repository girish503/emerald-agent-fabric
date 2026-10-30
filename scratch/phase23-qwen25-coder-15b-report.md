# Phase 23: Qwen2.5-Coder:1.5B Controlled Capability Experiment Report

## Executive Summary

- **Phase**: 23
- **Timestamp**: 2026-10-18T09:08:02.176Z
- **Baseline Git SHA**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Project Policy**: **₹0-cost, open-source/open-weight-model-only (Proprietary cloud models strictly rejected)**
- **Evaluated Model**: `qwen2.5-coder:1.5b` (1.54B, Q4_K_M, 986 MB (986,062,089 bytes))
- **Model Digest**: `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668`
- **Gate A Outcome**: **PASS** (`INFERENCE_VALIDATED`)
- **Gate B Status**: `EXECUTED`
- **Gate C (Clean-Room) Status**: `NOT_RUN`
- **Gate D (Fourfold Completion)**: `FAILED`
- **Primary Classification**: `MODEL_RECOVERY_FAILURE`
- **Scientific Question Classification**: **`CODING_SPECIALIZATION_NOT_SUPPORTED`**

---

## 1. Model Identity & Hardware Telemetry

| Field | Value |
| :--- | :--- |
| **Identifier** | `qwen2.5-coder:1.5b` |
| **Ollama Digest** | `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668` |
| **Parameters** | 1.54B |
| **Quantization** | Q4_K_M |
| **Model Size** | 986 MB (986,062,089 bytes) |
| **Architecture** | qwen2 |
| **Context Length** | 32768 |
| **License** | Apache License 2.0 (Open-source, ₹0 cost) |
| **Hardware** | CPU (Intel Core i3-N305, 8 E-cores, 8 GB RAM) |

---

## 2. Gate A — Inference Feasibility

| Metric | Measured Value | Ceiling / Standard | Status |
| :--- | :--- | :--- | :--- |
| **Response Latency** | **64378 ms (64.4s)** | 120,000 ms | PASS |
| **Response Status** | `RECEIVED` | `RECEIVED` | PASS |
| **Response Bytes** | 228 bytes | >0 | PASS |
| **Selected Tool** | `read_file` | Valid registered tool | PASS |
| **Valid Proposal** | `true` | true | PASS |
| **Premature Goal Reached** | `false` | false | PASS |
| **Validation Reason** | `NONE` | NONE | PASS |
| **Gate A Classification** | `INFERENCE_VALIDATED` | `INFERENCE_VALIDATED` | PASS |

### Gate A Raw Output
```json
{
  "isGoalReached": false,
  "proposalId": "read_file",
  "toolName": "read_file",
  "inputPayload": {
    "path": "src/math.js"
  },
  "contextSnapshotHash": "abbc952da335cc0d6fa10dc48b9658a465e6b27593710bad394d664f1efe7641"
}
```

---

## 3. Primary Scientific Comparison Table

| Metric | qwen2.5:1.5b (Phase 15E/16) | qwen2.5-coder:1.5b (Phase 23) | Delta / Assessment |
| :--- | :--- | :--- | :--- |
| **Parameters** | 1.54B | 1.54B | Identical parameter scale |
| **Quantization** | Q4_K_M | Q4_K_M | Identical |
| **Gate A latency** | 49.8s – 69.4s | 64.4s | Comparable CPU latency |
| **Valid proposal (Gate A)** | Yes (write_file) | Yes (read_file) | PASS |
| **First valid tool** | write_file | read_file | read_file |
| **Physical actions** | 1 (write_file) | 1 | 1 |
| **Physical mutation** | Yes (src/math.js) | No | No Mutation |
| **Proposal rejection count** | 6 (max reached) | 6 | 6 |
| **Maximum capability depth** | Depth 5 (Workspace mutation) | Depth 2 (First physical tool execution succeeded) | Evaluated |
| **Correct code generated** | Partial (incomplete add) | No | NOT_VERIFIED |
| **Clean-room reached** | No | No | Gate C |
| **FAIL_TO_PASS** | N/A | 0.0 / N/A | Clean-room verification |
| **PASS_TO_PASS** | N/A | 0.0 / N/A | Clean-room regression |
| **SUITE_RAN** | N/A | No | Clean-room execution |
| **Fourfold completion** | FAILED | FAILED | Gate D |
| **Final classification** | `MODEL_RECOVERY_FAILURE` | `MODEL_RECOVERY_FAILURE` | Final classification |

---

## 4. Special Coding Capability Analysis

- **A. Code inspection (`read_file`)**: Model explicitly invoked `read_file` to inspect the source file before modifying.
- **B. Argument construction**: Path: valid. Offset/Limit lines: Complied with schema constraints.
- **C. Observation interpretation**: Hallucinated contentHash into tool input: **NO (Properly handled)**.
- **D. Code generation**: Produced JavaScript: No. Used placeholders: No.
- **E. Recovery**: Failed to recover after rejected proposals.
- **F. Completion**: Avoided premature GOAL_REACHED: Yes.

---

## 5. Hypothesis Test & Scientific Conclusion

- **Hypothesis H1**: *Coding specialization improves Emerald tool-use and coding capability at approximately the same parameter scale.*
- **Hypothesis Result**: **NOT_SUPPORTED**
- **Scientific Classification**: **`CODING_SPECIALIZATION_NOT_SUPPORTED`**
- **Detailed Evaluation**: qwen2.5-coder:1.5b exhibited similar structural limitations (terminalReason: MAX_PROPOSAL_REJECTIONS, depth: 2) without reaching independent clean-room verification. Coding specialization alone at ~1.5B scale was insufficient to cross the governed completion threshold.
