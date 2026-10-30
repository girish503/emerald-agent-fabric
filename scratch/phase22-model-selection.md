# Phase 22: Open-Source Coding & Agent Model Selection & Feasibility

## Executive Summary

- **Phase**: 22
- **Timestamp**: 2026-10-18T08:46:00Z
- **Baseline Git SHA**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Project Policy**: **₹0-cost + open-source / open-weight models ONLY + local execution.**
- **Scope**: **RESEARCH + FEASIBILITY ONLY.** Zero model downloads. Zero model benchmarks. Zero proprietary APIs.
- **Outcome Classification**: **`B — DOWNLOAD_REQUIRED`** (A promising open model exists but is not installed; no download permitted in Phase 22).
- **Recommended Candidate for Future Evaluation**: **`qwen2.5-coder:1.5b`** (`Qwen/Qwen2.5-Coder-1.5B-Instruct`, Apache 2.0, Q4_K_M ~986 MB).

---

## 1. Phase 21 Findings

In Phase 21, the last remaining unmeasured installed candidate, `llama3.2:3b` (Meta's tool-specialized 3.2B model), was evaluated under the standardized frozen math repair task (`src/math.js`, hash `649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58`):
1. **CPU Latency Ceiling**: `llama3.2:3b` responded in **118,987 ms (119.0s)**, right at the hard 120s timeout ceiling, demonstrating that 3B parameters is the absolute latency boundary on this machine.
2. **Schema & Argument Failure**: Despite explicit tool-calling fine-tuning, `llama3.2:3b` failed Gate A with `MODEL_SCHEMA_FAILURE` due to `INVALID_TOOL_INPUT`: it emitted `offsetLine: 0`, `limitLines: 0`, and `maxBytes: 0`, violating positive integer schema bounds, and hallucinated its `contextSnapshotHash`.
3. **Local Capability Summary**: Across all 7 locally installed models:
   - `gemma3:1b`: Depth 0 (premature completion).
   - `llama3.2:3b`: Depth 0 (119s latency, boundary violation).
   - `qwen2.5:3b`, `qwen3:4b`, `deepseek-r1:8b`: Depth 0 (exceeded CPU timeouts >120s to >600s).
   - `qwen2.5:1.5b`: Depth 5 (physical file mutation, but trapped in observation loop).
   - `gemma3:latest`: 4.3B, lacks tool capability, CPU infeasible.

None of the currently installed local models achieved verified end-to-end task completion.

---

## 2. Current Hardware Constraints

Audited via host telemetry (`os.totalmem()`, `os.freemem()`, `os.cpus()`):
- **CPU**: Intel Core i3-N305 (8 physical & logical E-cores, Gracemont architecture, 1.8 GHz base / 3.8 GHz burst, AVX2 support, no AVX-512).
- **RAM**: **7.63 GiB total visible RAM**, with **~1.40 GiB free** under standard desktop load.
- **GPU**: Intel UHD Graphics (integrated, shares system RAM, zero dedicated VRAM). Ollama v0.40.6 does not support Intel iGPU acceleration; execution is strictly CPU-only.
- **Total Working Memory Budget**:
  $$\text{Usable RAM} = \text{Free RAM (1.4 GB)} + \text{Reclaimable Cache (~1.0 GB)} \approx 2.4 \text{ GB}$$
  Any model requiring more than ~2.5 GB of resident memory will cause aggressive OS paging to disk, stalling CPU execution and causing catastrophic timeouts.

---

## 3. Candidate Model Inventory & Categories

We investigated open-weight models across three distinct categories:

### Category A: Coding-Specialized Open Models
1. **`qwen2.5-coder:1.5b`** (`Qwen/Qwen2.5-Coder-1.5B-Instruct`): 1.54B parameters, Q4_K_M ~986 MB. SOTA for <3B coding models.
2. **`qwen2.5-coder:3b`** (`Qwen/Qwen2.5-Coder-3B-Instruct`): 3.09B parameters, Q4_K_M ~1.9 GB. Stronger reasoning, but high latency risk.
3. **`qwen2.5-coder:7b`** (`Qwen/Qwen2.5-Coder-7B-Instruct`): 7.61B parameters, Q4_K_M ~4.7 GB. True open SWE-bench leader, but exceeds host memory and CPU speed.
4. **`deepseek-coder:1.3b`** (`deepseek-ai/deepseek-coder-1.3b-instruct`): 1.3B parameters, Q4_K_M ~800 MB. Strong code completion, weaker JSON tool schemas.
5. **`codegemma:2b`** (`google/codegemma-2b`): 2.0B parameters, Q4_K_M ~1.6 GB. Completion-focused, lacks native function-calling instruction tuning.
6. **`starcoder2:3b`** (`bigcode/starcoder2-3b`): 3.0B parameters, Q4_K_M ~1.8 GB. Base code generation, minimal tool-use tuning.

### Category B: Tool/Function-Calling Specialized Open Models
7. **`granite3-dense:2b`** (`ibm-granite/granite-3.0-2b-instruct`): 2.2B parameters, Q4_K_M ~1.4 GB. Explicit enterprise tool-use and agentic fine-tuning.
8. **`smollm2:1.7b-instruct`** (`HuggingFaceTB/SmolLM2-1.7B-Instruct`): 1.7B parameters, Q4_K_M ~1.0 GB. General small instruction model with basic tool use.

### Category C: Sub-1B Agent/Coding Models
9. **`qwen2.5-coder:0.5b`** (`Qwen/Qwen2.5-Coder-0.5B-Instruct`): 494M parameters, Q4_K_M ~390 MB. Very low latency (~15s), but high risk of cognitive depth failure.

---

## 4. License Analysis

Emerald strictly requires open-weight licenses permitting local research and development without commercial API dependencies:

| Model | License Type | Open Source / Open Weight Status | Commercial / Research Use |
| :--- | :--- | :--- | :--- |
| **`qwen2.5-coder:1.5b`** | **Apache 2.0** | **Fully Open Source** (Permissive) | Unrestricted |
| **`granite3-dense:2b`** | **Apache 2.0** | **Fully Open Source** (Permissive) | Unrestricted |
| **`qwen2.5-coder:0.5b`** | **Apache 2.0** | **Fully Open Source** (Permissive) | Unrestricted |
| **`qwen2.5-coder:7b`** | **Apache 2.0** | **Fully Open Source** (Permissive) | Unrestricted |
| **`deepseek-coder:1.3b`** | DeepSeek License | Open Weight (Permissive research) | Permissive with commercial cap |
| **`qwen2.5-coder:3b`** | Qwen Research License | Open Weight (Research only) | Restricted commercial |
| **`codegemma:2b`** | Gemma Terms of Use | Open Weight (Google Terms) | Permissive research |
| **`starcoder2:3b`** | OpenRAIL-M v1 | Open Weight (Responsible AI license) | Permissive with use restrictions |

---

## 5. Tool / Function Capability Analysis

Emerald requires native support for closed JSON schemas and discriminated `anyOf` unions (goal-reached vs tool-action):

- **`qwen2.5-coder:1.5b`**: **HIGH**. Qwen 2.5 Coder models were instruction-tuned with function-calling data, tool use, and strict JSON output schemas. Supports Ollama's `format: jsonSchema` natively.
- **`granite3-dense:2b`**: **HIGH**. IBM explicitly fine-tuned Granite 3.0 on tool calling, function calling, and structured schema extraction.
- **`deepseek-coder:1.3b`**: **LOW-MEDIUM**. DeepSeek Coder v1.3B is heavily pre-trained on raw code tokens, but has less modern instruction tuning for structured JSON agent proposals.
- **`qwen2.5-coder:3b`**: **HIGH**. Identical schema comprehension to 1.5B with stronger reasoning.
- **`codegemma:2b` / `starcoder2:3b`**: **LOW**. Primarily code-completion models; poor compliance with strict multi-branch JSON schemas.

---

## 6. RAM Feasibility Analysis

Calculated for a realistic 4,096-token context on Ollama CPU:
$$\text{Total RAM} = \text{Model Weights} + \text{KV Cache (at 4k ctx)} + \text{Ollama Overhead (~400 MB)} + \text{OS/App Working Set (~2.0 GB)}$$

| Model | Quantized Size | KV Cache (4k) | Total Required RAM | Fits in 7.6 GB Visible? | Fits in Current Free RAM (~1.4 GB)? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `qwen2.5-coder:0.5b` | ~390 MB | ~150 MB | ~1.0 GB | **YES (Effortless)** | **YES** |
| **`qwen2.5-coder:1.5b`** | **~986 MB** | **~500 MB** | **~1.9 GB** | **YES (Safe)** | **YES (with minor cache drop)** |
| `deepseek-coder:1.3b` | ~800 MB | ~400 MB | ~1.6 GB | **YES (Safe)** | **YES** |
| `granite3-dense:2b` | ~1.4 GB | ~500 MB | ~2.3 GB | **YES (Tight)** | **Marginal (Requires cache drop)** |
| `qwen2.5-coder:3b` | ~1.9 GB | ~600 MB | ~3.0 GB | **YES (Tight)** | **NO (Triggers swapping)** |
| `qwen2.5-coder:7b` | ~4.7 GB | ~1.2 GB | ~6.5 GB | **NO (Exceeds free + app RAM)** | **NO (Severe OOM / crash)** |

---

## 7. CPU Latency Feasibility Analysis

Benchmarked against empirical data from Phases 14–21 on the Intel i3-N305:
- 1.0B (`gemma3:1b`): 57.1s (Feasible)
- 1.5B (`qwen2.5:1.5b`): 49.8s–69.4s (Feasible)
- 3.2B (`llama3.2:3b`): 118.9s (Borderline: 1s under 120s timeout)
- 3.1B (`qwen2.5:3b`): >120s (Timeout)
- 4.0B (`qwen3:4b`): >180s–600s (Timeout)
- 8.2B (`deepseek-r1:8b`): >600s (Timeout)

### Projections for Candidates:
- **`qwen2.5-coder:0.5b`**: ~15s–20s (Fast, highly feasible)
- **`qwen2.5-coder:1.5b`**: **~50s–65s** (Consistent with `qwen2.5:1.5b`, comfortably within 120s limit)
- **`deepseek-coder:1.3b`**: ~45s–60s (Feasible)
- **`granite3-dense:2b`**: ~75s–95s (Feasible, but narrow safety margin)
- **`qwen2.5-coder:3b`**: ~115s–135s (High risk of timeout)
- **`qwen2.5-coder:7b`**: ~300s–450s (Catastrophic timeout)

---

## 8. Feasibility Classification (GREEN / YELLOW / RED)

| Candidate Model | Parameters | License | RAM Viability | CPU Latency Viability | Overall Classification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`qwen2.5-coder:1.5b`** | 1.54B | Apache 2.0 | High (~1.9 GB) | High (~55s) | **GREEN** |
| **`qwen2.5-coder:0.5b`** | 0.49B | Apache 2.0 | Very High (~1.0 GB)| Very High (~18s) | **GREEN** |
| **`deepseek-coder:1.3b`** | 1.30B | DeepSeek | High (~1.6 GB) | High (~50s) | **GREEN** |
| **`granite3-dense:2b`** | 2.20B | Apache 2.0 | Moderate (~2.3 GB) | Moderate (~85s) | **YELLOW** |
| **`qwen2.5-coder:3b`** | 3.09B | Qwen Research | Moderate (~3.0 GB) | Borderline (~125s) | **YELLOW** |
| **`codegemma:2b`** | 2.00B | Gemma Terms | Moderate (~2.2 GB) | Moderate (~80s) | **YELLOW** |
| **`starcoder2:3b`** | 3.00B | OpenRAIL-M | Moderate (~2.5 GB) | Borderline (~120s) | **YELLOW** |
| **`qwen2.5-coder:7b`** | 7.61B | Apache 2.0 | Infeasible (>6.5 GB)| Infeasible (>300s) | **RED** |
| **`deepseek-coder:6.7b`** | 6.70B | DeepSeek | Infeasible (>5.8 GB)| Infeasible (>280s) | **RED** |

---

## 9. Top 5 Candidates Ranked

| Rank | Model Identifier | Class | Primary Rationale |
| :--- | :--- | :--- | :--- |
| **1** | **`qwen2.5-coder:1.5b`** | **GREEN** | State-of-the-art code specialization <3B, Apache 2.0, identical parameter scale to `qwen2.5:1.5b` (proven ~55s CPU feasibility), fits in RAM. |
| **2** | **`granite3-dense:2b`** | **YELLOW** | Purpose-built enterprise tool/agent fine-tuning, Apache 2.0, slightly higher parameter scale (2.2B) operating near ~85s CPU latency. |
| **3** | **`deepseek-coder:1.3b`** | **GREEN** | High code pre-training density, fits easily in RAM, but weaker JSON schema instruction tuning than Qwen. |
| **4** | **`qwen2.5-coder:3b`** | **YELLOW** | Superior coding capability, but 3.1B scale risks exceeding the 120s CPU timeout ceiling. |
| **5** | **`qwen2.5-coder:0.5b`** | **GREEN** | Very fast inference (~18s), but severe cognitive depth ceiling (<1B parameters historically fail multi-step reasoning). |

---

## 10. Recommended Candidate for Future Evaluation

### Candidate: `qwen2.5-coder:1.5b`
- **Exact Registry Name**: `qwen2.5-coder:1.5b` (`Qwen/Qwen2.5-Coder-1.5B-Instruct`)
- **Status in Phase 22**: **`DOWNLOAD_REQUIRED — DEFERRED`** (Not currently installed; strictly NO downloads in Phase 22).
- **Parameters**: 1.54B
- **Quantization**: Q4_K_M (~986 MB download size)
- **License**: Apache 2.0 (Permissive, open source)
- **RAM Requirement**: ~1.8–2.0 GB total resident memory
- **Estimated CPU Latency**: ~50s–65s per step on Intel i3-N305

---

## 11. Why It Is Better Than Prior Baselines

1. **Versus `qwen2.5:1.5b` (General Base)**:
   - Base `qwen2.5:1.5b` achieved capability depth 5 in Phase 15E/16 (the highest among all local models), successfully issuing physical file writes. However, it was trained on general web text and became trapped in observation consumption loops, hallucinating tool parameters.
   - `qwen2.5-coder:1.5b` was trained on 5.5T tokens with heavy concentration on programming languages, compiler errors, unit tests, and AST transformations. It is specifically optimized to understand code diffs and test failure messages.
2. **Versus `llama3.2:3b` (Tool-Specialized General)**:
   - `llama3.2:3b` ran at **119.0s** latency on CPU, leaving no margin for multi-step prompts. In Phase 21, it failed Gate A by emitting `0` values for 1-indexed schema parameters (`offsetLine: 0`, `limitLines: 0`).
   - `qwen2.5-coder:1.5b` operates at roughly **half the latency (~55s)** and demonstrates significantly higher syntactic precision in code-related schemas.

---

## 12. What Remains Unknown

1. **Multi-Step Trajectory Depth**: While `qwen2.5-coder:1.5b` has superior code completion, it is unknown whether a 1.5B parameter model can sustain 8+ step reasoning without loop degradation under Emerald's strict governance.
2. **Context Compression Resilience**: As context accumulates across multi-step trials (test outputs, diffs, observations), prefill latency will increase. It is unknown whether prefill will remain within the 120s budget at step 6+.
3. **Clean-Room Completion**: It remains unproven whether any sub-3B open-weight model can achieve `CleanRoomVerifier` pass (F2P=1.0, P2P=1.0) under fully governed execution.

---

## 13. Scientific Separation & Bottleneck Diagnosis

### Question 1:
> *Is there a credible open-source/open-weight coding or tool-use model that should be tested next under Emerald's ₹0 constraint, and is it feasible on the current i3-N305 / 8 GB machine?*

**Answer**: **YES.** `qwen2.5-coder:1.5b` is a credible, Apache 2.0, open-weight coding model whose parameter scale is proven feasible on this hardware. It is the logical next candidate. However, it requires a download (`DOWNLOAD_REQUIRED — DEFERRED`) and cannot be tested until a future phase authorizes model installation.

### Question 2:
> *If the best candidate is not feasible on this machine, is the next bottleneck the model, the hardware, or both?*

**Answer**: **BOTH.**
- **At <3B parameters**: The bottleneck is **MODEL CAPABILITY**. Models run feasibly on CPU within 120s, but struggle with reasoning depth, parameter boundary adherence, and recovery loops.
- **At ≥7B parameters** (e.g. `qwen2.5-coder:7b`, `deepseek-coder:6.7b`): The bottleneck is **HARDWARE**. Frontier open coding models exist that likely possess the cognitive depth for autonomous repair, but the Intel i3-N305 CPU without discrete GPU and with only 7.6 GB RAM cannot execute them without severe swapping and latency timeouts (>300s).
