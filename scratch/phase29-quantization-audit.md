# Phase 29: SmolLM2 Quantization Feasibility & Experimental Validity Audit

## Executive Summary

- **Phase**: 29 (Research / Build-Feasibility Audit Only)
- **Baseline Git SHA**: `70979cf4bcbf4a237b79af3a23449a4b932104d5` (Frozen)
- **Project Constraint**: **Strictly ₹0-cost, open-source / open-weight models only, local CPU inference only.** (Proprietary cloud APIs such as OpenAI, Anthropic, Google Gemini remain permanently forbidden).
- **Core Research Question**: Can SmolLM2-1.7B be evaluated under `Q4_K_M` quantization using a reproducible, local, open-source quantization path such that the only experimental change from Phase 28 is quantization?
- **Primary Finding**: While `Q4_K_M` would reduce model size from 1.82 GB to ~1.05 GB (~42% reduction) and plausibly reduce Gate A latency into the 70s–90s window, a scientifically valid `Q4_K_M` artifact cannot be derived locally from the existing `Q8_0` blob without lossy-on-lossy re-quantization distortion. The original unquantized (`BF16`/`FP16`) base checkpoint and quantization tools (`llama-quantize`) are not present on disk.
- **Decision Class**: **`Q4_EXPERIMENT_NOT_REPRODUCIBLE`**
- **Phase 29 Execution Status**: Strictly zero model downloads, zero inference calls, zero code modifications, and zero budget consumption.

---

## Phase 28 Validity Assessment

Phase 28 evaluated `smollm2:1.7b` under Emerald's frozen architecture. The execution must be interpreted across two distinct dimensions:

1. **Valid Environment-Boundary Observation**:
   - The tested artifact (`smollm2:1.7b`) was acquired directly from Ollama's public registry as packaged by the maintainers.
   - The observation that `smollm2:1.7b` at `Q8_0` timed out after 120,065 ms on an Intel Core i3-N305 CPU is an authentic, reproducible physical measurement of the default distribution on commodity developer hardware.
   - It represents a valid `ENVIRONMENT_FAILURE` under Emerald's 120,000 ms operational ceiling.
2. **Incomplete Capability Evaluation**:
   - Because inference timed out during the initial Step 1 request prior to emitting an action proposal, Gate B was not executed.
   - Zero tool proposals, zero parameter bindings, and zero validator rejections occurred.
   - Therefore, Phase 28 provides **zero evidence** regarding whether SmolLM2's synthetic tool-use training and multi-turn alignment can achieve closed-loop recovery.
   - It is scientifically invalid to conclude that SmolLM2 "cannot recover" or "cannot code."

---

## Q8_0 Artifact Analysis

Inspection of the local Ollama installation of `smollm2:1.7b`:

| Property | Value | Source / Verification |
| :--- | :--- | :--- |
| **Model Identifier** | `smollm2:1.7b` | Ollama tag manifest |
| **Model Digest** | `cef4a1e09247f018ca0c482ad4c2ce1474aba5e87f245dacf97f07948d05d8b4` | Verified via `/api/tags` |
| **Base Blob SHA-256** | `4d2396b16114669389d7555c15a1592aad584750310f648edad5ca8c4eccda17` | Verified via `ollama show --modelfile` |
| **Parameter Count** | 1.7B (~1,711,380,480) | Verified via model details |
| **Architecture** | `llama` (Llama-based architecture) | GGUF metadata |
| **Quantization Level** | **`Q8_0`** (8-bit integer quantization) | Documented in GGUF header |
| **Model File Size** | 1,820,428,533 bytes (~1.82 GB) | Measured on disk |
| **Context Length** | 8,192 tokens | Verified in Modelfile |
| **Embedding Length** | 2,048 | GGUF header |
| **Stop Tokens** | `<|im_start|>`, `<|im_end|>` | Configured in Modelfile |
| **License** | Apache License 2.0 | Verified in Modelfile |

### Analysis of the Default Q8_0 Distribution
Unlike models such as `qwen2.5:1.5b` and `qwen2.5-coder:1.5b` (which Ollama packages as `Q4_K_M`, ~986 MB), Ollama packaged `smollm2:1.7b` as `Q8_0` (1.82 GB). On low-power x86-64 Gracemont E-cores without AVX-512, processing a ~7KB prompt (~2,200 tokens) with 8-bit weights requires transferring ~4.0 GB of data through CPU memory caches for the prefill phase alone, saturating the bus and causing Gate A to exceed the 120s ceiling.

---

## Q4_K_M Feasibility

We evaluated whether a `Q4_K_M` variant could be produced locally:

### Technical Feasibility Analysis
1. **Path 1 — Direct Re-quantization (`Q8_0` $\rightarrow$ `Q4_K_M`)**:
   - *Feasibility*: **REJECTED (Scientifically Invalid)**.
   - *Rationale*: Re-quantizing an already quantized 8-bit model introduces compound rounding error (lossy-on-lossy re-quantization). Standard `llama.cpp` quantization tools expect continuous floating-point weights (`F32`, `F16`, or `BF16`) to compute statistical outlier scales for k-quants. Quantizing from `Q8_0` to `Q4_K_M` degrades tensor quality and is unsupported by canonical quantization workflows.
2. **Path 2 — Canonical Source Quantization (`BF16` $\rightarrow$ `Q4_K_M`)**:
   - *Feasibility*: **VALID, BUT LOCALLY BLOCKED**.
   - *Rationale*: Converting unquantized Safetensors base weights via `convert_hf_to_gguf.py` and `llama-quantize` is the canonical, methodologically sound path. However, the original unquantized weights (~3.4 GB) are not present on the host disk.
3. **Path 3 — Ollama Modelfile Re-packaging (`ollama create`)**:
   - *Feasibility*: **NOT APPLICABLE**.
   - *Rationale*: `ollama create` packages existing GGUF binary blobs with prompt templates and system directives. It does not possess a quantization compiler.

---

## Source Checkpoint Requirements

To produce a scientifically legitimate `Q4_K_M` artifact without uncontrolled variables:

1. **Base Source Checkpoint**:
   - Exact Repository: `HuggingFaceTB/SmolLM2-1.7B-Instruct`
   - Canonical Revision: Exact release commit tagged for SmolLM2-1.7B-Instruct.
   - Format: Hugging Face Safetensors (BF16, ~3.4 GB).
2. **Local Availability Audit**:
   - Host inspection of `.ollama\models` and `.cache\huggingface`: **Zero base Safetensors weights exist on disk.**
   - Only the Ollama-downloaded `Q8_0` blob (`sha256-4d2396b16114...`) is present.
   - Under Phase 29 stop conditions ("Do NOT download another model; do NOT contact external registries"), the source checkpoint cannot be acquired during this phase.

---

## Quantization Tooling

Inspection of local compilation and quantization toolchains:

- `llama-quantize`: **NOT INSTALLED** (No local `llama.cpp` binaries in system PATH).
- `convert_hf_to_gguf.py`: **NOT INSTALLED** (Requires cloning `llama.cpp` and installing `gguf` Python dependencies).
- `python.exe`: Installed (v3.13.5 in Anaconda), but lacks GGUF serialization tooling.
- `ollama`: Installed (v0.40.6), but restricted to runtime execution and model packaging.

**Conclusion**: Producing a local GGUF conversion requires building or downloading external C++ binaries (`llama-quantize`) and Python build dependencies, violating Emerald's frozen environmental invariants for research-only phases.

---

## Experimental-Control Requirements

If a future `Q4_K_M` experiment were to be authorized, the following variables must remain strictly identical to Phase 28 to preserve single-variable isolation:

| Controlled Variable | Fixed Value | Status |
| :--- | :--- | :--- |
| **Model Family & Weights** | `HuggingFaceTB/SmolLM2-1.7B-Instruct` | Exact identical checkpoint |
| **Tokenizer & Vocabulary** | LlamaTokenizer, 49,152 vocabulary | Immutable |
| **Chat Template** | SmolTalk format (`<|im_start|>`, `<tool_call>`, etc.) | Identical to Phase 28 Modelfile |
| **Task Directive** | SHA-256 `649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58` | Verified bit-for-bit |
| **Tool Schemas** | Strict Zod contracts (`src/domain/tool-schemas.ts`) | Immutable |
| **Controller Budgets** | `maxSteps=12`, `maxActions=8`, `maxProposalRejections=6` | Immutable |
| **Operational Ceiling** | 120,000 ms per step | Immutable |
| **Host Hardware** | Intel Core i3-N305, 8 E-cores, AVX2, CPU execution | Immutable |
| **Single Independent Variable** | **Quantization: `Q8_0` (1.82 GB) $\rightarrow$ `Q4_K_M` (~1.05 GB)** | Only variable changed |

---

## Expected Hardware Effect

### Theoretical & Empirical Latency Projection

1. **Memory Bandwidth Reduction**:
   - `Q8_0` size: 1,820 MB
   - `Q4_K_M` estimated size: ~1,050 MB
   - Size reduction: **42.3% fewer bytes transferred per token**.
2. **Empirical Calibration Against Tested Models**:
   - `qwen2.5:1.5b` (`Q4_K_M`, 1.54B, 986 MB): Gate A latency = **49.8s – 69.4s**.
   - `qwen2.5-coder:1.5b` (`Q4_K_M`, 1.54B, 986 MB): Gate A latency = **64.4s**.
   - `smollm2:1.7b` (`Q8_0`, 1.71B, 1,820 MB): Gate A latency = **120.1s (Timeout)**.
3. **Plausibility Assessment**:
   - *Estimated `Q4_K_M` Gate A Latency*: **70s – 90s**.
   - Reducing the memory footprint by 42% on the host CPU would plausibly move SmolLM2 beneath the 120,000 ms ceiling, allowing Gate A to complete and enabling Gate B closed-loop evaluation.

---

## Reproducibility Assessment

- **Can the experiment be conducted cleanly from current disk state?** **NO**.
  - Quantizing `Q8_0` $\rightarrow$ `Q4_K_M` directly violates quantization integrity.
  - Base BF16 weights are not on disk.
  - Quantization compiler tooling is not installed.
- **Can a community pre-quantized GGUF be substituted without provenance verification?** **NO**.
  - Arbitrary third-party GGUFs from unverified sources introduce potential discrepancies in tokenizers, rope scaling, or post-quantization fine-tuning, contaminating single-variable isolation.
- **Conclusion**: A scientifically valid Q4_K_M experiment cannot be reproduced under the current host state without an authorized external acquisition of either the canonical BF16 base repository or an officially verified GGUF artifact.

---

## Decision

### **`Q4_EXPERIMENT_NOT_REPRODUCIBLE`**

**Reasoning**:
1. Phase 28 was an environmental latency failure driven by the 8-bit `Q8_0` format rather than a verified failure of model capability.
2. While `Q4_K_M` quantization is theoretically sound and plausibly feasible within 70s–90s, producing this artifact locally from current disk contents is mathematically invalid (lossy re-quantization) and technically impossible (lack of unquantized source weights and tooling).
3. The experiment cannot be established cleanly without new external acquisitions.

---

## Phase 30 Recommendation

Emerald Agent Fabric has now evaluated 10 distinct open-weight model configurations across 28 phases:
- Sub-2B models at 4-bit (`qwen2.5:1.5b`, `qwen2.5-coder:1.5b`) pass Gate A in 50s–65s but fail closed-loop recovery (deterministic repetition loops).
- Models $\ge 2.6$B (`granite3-dense:2b`, `qwen2.5-coder:3b`, `qwen2.5:3b`, `llama3.2:3b`) hit the 120s CPU timeout wall.
- Models at 1.7B at 8-bit (`smollm2:1.7b`) hit the 120s CPU timeout wall due to memory bus saturation.

**Recommended Architectural Step for Phase 30**:
Formalize **ADR-0031 (Local Execution Hardware Acceleration & Evaluation Boundary)**:
1. Conclude the pure CPU-only model search on the Intel Core i3-N305.
2. Establish that autonomous multi-step software engineering agents require either:
   - Hardware acceleration (e.g. Intel OpenVINO NPU/iGPU execution or discrete local GPU) to evaluate 3B–8B models within interactive latency budgets (<30s).
   - OR an authorized canonical acquisition pipeline for verified 4-bit quantization.
3. Pivot research focus back to the core infrastructure mission: hardening capability policies, multi-attempt recovery primitives, and deterministic replay mechanisms.
