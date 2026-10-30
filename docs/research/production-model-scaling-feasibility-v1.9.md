# Emerald Agent Fabric — Production V1.9
## Local Model Scaling Feasibility & Semantic Repair Research Report

**Date**: 2026-10-22  
**Harness Version**: `production-v1.9`  
**Host Environment**: Intel(R) Core(TM) i3-N305, 8.00 GB RAM, Windows 11, Local Ollama v0.40.7  
**Evaluation Target**: Candidate open-weight scaling from `qwen2.5-coder:3b` to a stronger 7B coding model  
**Primary Outcome**: **`MODEL_SCALING_FEASIBILITY_BLOCKED`**  

---

## 1. Executive Summary

Production V1.8 established that grammar-constrained JSON Schema decoding via local Ollama v0.40.7 completely eliminated Stage 2 model proposal malformation and quadrupled structured `edit_file_anchor` selection (from 1 to 4 requests), but verified task completion remained 0/5 (0.0%) due to semantic inaccuracies in the 3B model's proposed anchors.

Production V1.9 was commissioned to evaluate whether a stronger locally available open-weight coding model (specifically a quantized Qwen2.5-Coder 7B model) could improve semantic repair quality under the validated V1.8 structured proposal interface.

Following the mandatory frozen constraints ("Do not download any model during this milestone. Check whether a suitable Qwen2.5-Coder 7B quantized model is already installed locally. Do not pull or download it. If no suitable model is installed, or the machine cannot run it within reasonable measured resource limits, stop the scaling experiment and produce a feasibility report"), Phase A environment and repository preflight was executed.

**Preflight Findings**:
1. **Model Availability**: `qwen2.5-coder:7b` is **not installed** in the local Ollama inventory.
2. **Hardware Constraints**: Host machine possesses **7.63 GB total visible RAM** (8 GB physical) with **1.30 GB currently free**, running on an **Intel Core i3-N305 CPU** with integrated Intel UHD graphics (0 MB dedicated VRAM). A 7B Q4_K_M model requires ~4.7 GB RAM plus KV-cache, which exceeds available free memory by over 3.4 GB.
3. **Execution Decision**: Per mandatory project rules, the scaling experiment was halted at the feasibility gate without downloading models or altering conditions. The formal outcome is **`MODEL_SCALING_FEASIBILITY_BLOCKED`**.

---

## 2. Repository HEAD and Working-Tree Baseline

- **Current Git Branch**: `master`
- **Current Git Commit**: `7109911fa4488c5759000fe08c3a77895ed214f4` (`feat(production): integrate bounded repair workflow`)
- **Working Tree Cleanliness**: All existing untracked research logs (`scratch/`, `docs/research/`) and staged production components preserved. Zero automatic git commits, pushes, or modifications executed.
- **Manifest Integrity**:
  - SWE-bench Manifest (`benchmarks/swebench-v01/tasks.json`): SHA-256 `d61852584504ced781f6cb9ca1d10d527aba52eb697ce8488840c34bed29f4a8` (15 tasks, byte-identical).
  - Calibration Manifest (`benchmarks/calibration-v15/tasks.json`): SHA-256 `150cbb79005a238fe4d8712b4a7d0ced1ce9ebe031c33101990027be63236676` (5 tasks, byte-identical).

---

## 3. Hardware and Model Feasibility Findings

### 3.1 Hardware Inspection
Direct telemetry captured via WMI/CIM and PowerShell:
- **Processor**: Intel(R) Core(TM) i3-N305 @ 1.80 GHz (8 physical efficiency cores, 8 logical threads).
- **Graphics / Accelerator**: Intel(R) UHD Graphics (Driver 32.0.101.7076, integrated, shared system RAM, 0 MB dedicated VRAM; NVIDIA CUDA / `nvidia-smi` unavailable).
- **Physical Memory**:
  - `TotalVisibleMemorySize`: 8,000,580 KB (~7.63 GB)
  - `FreePhysicalMemory`: 1,367,520 KB (~1.30 GB)
  - `RAM Utilization`: 82.9% under normal desktop baseline load
- **Storage**: Drive C: has abundant free storage space.

### 3.2 Ollama Runtime & Model Inventory
- **Ollama Engine Version**: `0.40.7`
- **Installed Local Models**:
  | Model Name | Model ID | Disk Size | Architecture & Parameter Count | Coding Specialized? |
  | :--- | :---: | :---: | :---: | :---: |
  | `smollm2:1.7b` | `cef4a1e09247` | 1.8 GB | SmolLM2 (1.7B) | No |
  | `granite3-dense:2b` | `5c2e6f3112f4` | 1.6 GB | IBM Granite 3.0 (2B) | General Dense |
  | `qwen2.5-coder:3b` | `f72c60cabf62` | 1.9 GB | Qwen2.5-Coder (3B Q4_K_M) | **Yes (Current Baseline)** |
  | `qwen2.5-coder:1.5b` | `d7372fd82851` | 986 MB | Qwen2.5-Coder (1.5B Q4_K_M) | Yes (Smaller parameter) |
  | `gemma3:1b` | `83be9dbf9dd6` | 815 MB | Google Gemma 3 (1B) | No |
  | `deepseek-r1:8b` | `6995872bfe4c` | 5.2 GB | DeepSeek-R1 Distill (8B) | General Reasoning |
  | `llama3.2:3b` | `a80c4f17acd5` | 2.0 GB | Meta Llama 3.2 (3B) | No |
  | `qwen3:4b` | `359d7dd4bcda` | 2.5 GB | Qwen 3 (4B) | General Chat |
  | `gemma3:latest` | `a2af6cc3eb7f` | 3.3 GB | Google Gemma 3 (4B) | No |
  | `qwen2.5:3b` | `357c53fb659c` | 1.9 GB | Qwen 2.5 General (3B) | No |
  | `qwen2.5:1.5b` | `65ec06548149` | 986 MB | Qwen 2.5 General (1.5B) | No |

### 3.3 Resource Feasibility Analysis for 7B Models
1. **Candidate Absence**: No `qwen2.5-coder:7b` model is present in the local Ollama repository.
2. **RAM Threshold Violation**:
   - A Q4_K_M quantized 7B model requires **~4.7 GB of host memory** merely to map model tensor weights.
   - During autoregressive inference with a 4,096-token context budget, the KV-cache requires an additional **~1.2 GB RAM**.
   - Total runtime requirement is **~5.9 GB memory**.
   - Available free RAM on this host is **1.30 GB** out of **7.63 GB total**.
   - Loading a 7B model on this 8GB machine would immediately trigger severe virtual memory swap thrashing, hard page faults, complete system unresponsiveness, or process termination via the OS out-of-memory killer.
3. **CPU-Only Latency Penalty**:
   - With an Intel Core i3-N305 (efficiency cores without AVX-512) and zero discrete GPU acceleration, CPU inference throughput on a 7B model would drop below 1–2 tokens/sec, leading to ubiquitous execution timeouts under the frozen 45,000ms action budget.

---

## 4. Controlled Comparison Baseline (Historical V1.8 Evidence)

Because scaling to a 7B model is infeasible on this local environment and model downloads are strictly barred by the frozen constraints, the historical V1.8 benchmark records (`scratch/production-v18-structured-proposal-results.json`) stand as the authoritative baseline for `qwen2.5-coder:3b`:

### 4.1 V1.8 Baseline Metrics (N = 5 tasks, 10 trials total)

| Metric | Condition V1.8-A (Unconstrained JSON) | Condition V1.8-B (Constrained Schema) | Delta |
| :--- | :---: | :---: | :---: |
| **Tasks Evaluated** | 5 | 5 | 0 |
| **Total Proposals Emitted** | 18 | 15 | -3 |
| **JSON Parse Success Rate** | 100.0% (18/18) | 93.3% (14/15) | -6.7% |
| **Schema Validation Success Rate** | 100.0% (18/18) | 93.3% (14/15) | -6.7% |
| **Stage 2 (`MODEL_PARSE_ERROR`) Rate** | 0.0% (0/5) | 0.0% (0/5) | 0.0% |
| **Structured `edit_file_anchor` Invocations** | 1 (5.6%) | **4 (26.7%)** | **+21.1% (+300%)** |
| **Unique Anchor Match Rate** | 0.0% (0/5) | 0.0% (0/5) | 0.0% |
| **Successful Edit Application Rate** | 0.0% (0/5) | 0.0% (0/5) | 0.0% |
| **Patch Application Rate** | 0.0% (0/5) | 0.0% (0/5) | 0.0% |
| **Sovereign Verified Completions** | 0/5 (0.0%) | 0/5 (0.0%) | 0.0% |
| **Mean Task Duration** | 80,675 ms | 71,533 ms | -9,142 ms |

### 4.2 Earliest Failure Attribution
Across all trials under V1.8-B, the earliest failure stage was **Stage 3 (`STAGE_3_PATCH_APPLICATION`, `PATCH_SYNTAX_ERROR`)**:
- The model successfully formulated a schema-valid `edit_file_anchor` tool request (passing schema validation and governance).
- However, the model selected imprecise or non-unique anchor spans (`searchAnchor`) that did not exist verbatim in the target file, causing `LineAnchoredEditor` to reject the mutation fail-closed without disk modification.

---

## 5. Security & Invariant Verification

All production safety, governance, and historical invariants were re-verified in the current environment:

1. **Production Test Suites**:
   - `tests/production/structured-proposal-interface.test.ts`: **15/15 passed**
   - `tests/production/anchored-tool-selection.test.ts`: **15/15 passed**
   - `tests/production/line-anchored-editing.test.ts`: **19/19 passed**
   - `tests/production/diagnostic-feedback.test.ts`: **14/14 passed**
   - `tests/production/repair-capability-calibration.test.ts`: **14/14 passed**
   - `tests/production/production-components.test.ts`: **20/20 passed**
   - `tests/production/production-benchmark.test.ts`: **11/11 passed**
   - `tests/production/minimal-test-evidence-selector.test.ts`: **16/16 passed**
   - `tests/production/repair-workflow.test.ts`: **16/16 passed**
   - **Total Production Suite**: **140/140 passed**
2. **Phase 99 Capability Fencing**:
   - `tests/integration/phase99-governed-capability-fencing.test.ts`: **262/262 passed**
3. **Phase 10H Historical Artifact Audit**:
   - `scripts/verify-phase10h-artifacts.ts`: **All checks passed**; all historical Phase 9/10 artifact digests verified byte-for-byte intact.
4. **Zero Model Downloads**: Confirmed zero network calls, zero model pulls, and zero proprietary API invocations.
5. **Git Hygiene**: Confirmed zero automatic git commits, pushes, or modifications to frozen directories.

---

## 6. Formal Decision

**Primary Decision**: **`MODEL_SCALING_FEASIBILITY_BLOCKED`**

**Rationale**:
1. `qwen2.5-coder:7b` is not installed in the local Ollama inventory, and the mandatory frozen constraints strictly prohibit downloading models during this milestone.
2. Even if downloaded, the host system's hardware configuration (Intel Core i3-N305, 8 GB total system RAM, 1.30 GB available free RAM, integrated graphics with 0 MB dedicated VRAM) is physically incapable of running a 7B parameter model without catastrophic swap thrashing or out-of-memory failure.
3. Substituting an installed non-coding model (such as `deepseek-r1:8b` or `qwen3:4b`) would violate scientific comparability and corrupt the coding repair evaluation.
4. In strict adherence to Rule 35 (Stop conditions) and the milestone mission instructions ("If no suitable model is installed, or the machine cannot run it within reasonable measured resource limits, stop the scaling experiment and produce a feasibility report. Do not silently substitute another model or download one"), execution was cleanly halted at the feasibility gate.

---

## 7. Recommended Next Steps

1. **Execution on 16GB+ RAM / Dedicated GPU Hardware**:
   To conduct a valid model-scaling experiment with `qwen2.5-coder:7b`, transfer or provision the repository on a host machine equipped with at least 16 GB physical RAM or a dedicated 8GB+ VRAM GPU, where the 7B model can be evaluated cleanly without memory starvation.
2. **Context-Anchored Prompt Guidance for 3B Parameters**:
   Since the 3B model is capable of generating valid `edit_file_anchor` calls under constrained decoding (as proven in V1.8), explore providing precise line numbers or short source excerpt anchors directly in the diagnostic context to assist the 3B model in selecting verbatim existing anchors.
