# Phase 25: Open-Source Agent Capability Gap Analysis & Model Selection

## Executive Summary

- **Phase**: 25 (Research & Capability Gap Analysis Only)
- **Baseline Git SHA**: `70979cf4bcbf4a237b79af3a23449a4b932104d5` (Frozen)
- **Project Constraint**: **Strictly ₹0-cost, open-source / open-weight models only, local inference only.** (Proprietary cloud APIs such as OpenAI, Anthropic, Google Gemini remain permanently forbidden).
- **Core Research Question**: Determine exactly which agent capabilities are missing in tested small open-weight models and whether a credible open-weight candidate can address them while remaining feasible on the host CPU.
- **Outcome Classification**: **`DOWNLOAD_REQUIRED_DEFERRED`**
- **Recommended Candidate**: **`granite3-dense:2b`** (2.63B parameters, IBM Granite 3.0, Apache 2.0, explicit function/tool-calling architecture).
- **Status**: No model downloads, zero inference calls, zero code modifications in Phase 25.

---

## 1. Frozen Baseline & Scope Boundary

In strict accordance with the master engineering constitution, all components of Emerald Agent Fabric remain immutable on baseline commit `70979cf4bcbf4a237b79af3a23449a4b932104d5`:
- Runtime state machine (`CREATED` $\rightarrow$ `COMPLETED` / `FAILED`)
- Durable SQLite persistence, worker leases, and crash recovery
- Docker execution provider and container isolation
- `MissionContract`, `CapabilityPolicy`, and least-privilege enforcement
- Workspace provisioning and path isolation
- Typed tools (`read_file`, `write_file`, `git_status`, `git_diff`, `run_command`)
- `ToolGateway`, `Action` / `Attempt` relational accounting
- `ContextEngine`, `ContextSource`, and observation snapshotting
- `AgentStepController` and budget enforcement (`maxSteps`, `maxActions`, `maxProposalRejections`)
- `ProposalValidator`, `Reflex` engine, and schema validation
- `CleanRoomVerifier` (Phase 14 dual-gate independent verification)
- Standardized tool projection and prompt construction

Zero production source files (`src/`) were modified.

---

## 2. Empirical Evidence Base (Phases 15–24)

Across 10 phases of controlled empirical execution on the host hardware, 8 distinct open-weight models have been benchmarked against the standardized `src/math.js` repair task (`649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58`):

| Model | Parameters | Quantization | Size | Gate A Latency | Gate A Status | Cap. Depth | Failure Mode | Phase |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `gemma3:1b` | 999.89M | Q4_K_M | 815 MB | 57.4s | `SCHEMA_FAIL` | Depth 0 | Premature `isGoalReached: true` at sequence 1 without any physical actions | Phase 19 |
| `qwen2.5:1.5b` | 1.54B | Q4_K_M | 986 MB | 49.8s–69.4s | `VALIDATED` | Depth 5 | Mutated code, but hallucinated `contentHash` into tool input; repeated invalid proposals 5x until max rejections | Phase 15E/16 |
| `llama3.2:3b` | 3.21B | Q4_K_M | 2.0 GB | 119.0s | `SCHEMA_FAIL` | Depth 0 | Violated integer schema bounds (`offsetLine: 0, limitLines: 0`); hallucinated context hash; 1s from timeout | Phase 21 |
| `qwen2.5:3b` | 3.09B | Q4_K_M | 1.9 GB | >120.0s | `ENV_FAIL` | Depth 0 | Timed out on CPU exceeding 120s feasibility ceiling | Phase 15D |
| `qwen3:4b` | 4.02B | Q4_K_M | 2.5 GB | >180.0s | `ENV_FAIL` | Depth 0 | Severe CPU latency (>180s–600s per step); exceeded operational ceiling | Phase 15 |
| `deepseek-r1:8b` | 8.20B | Q4_K_M | 5.2 GB | >600.0s | `ENV_FAIL` | Depth 0 | Severe memory swapping and latency on 7.6GB RAM; unusable on CPU | Phase 17 |
| `qwen2.5-coder:1.5b` | 1.54B | Q4_K_M | 986 MB | 64.4s | `VALIDATED` | Depth 2 | Executed `read_file`, but hallucinated `filePath` key and dummy path; repeated defective code; 5x identical invalid proposals | Phase 23 |
| `qwen2.5-coder:3b` | 3.09B | Q4_K_M | 1.9 GB | 120.05s | `ENV_FAIL` | Depth 0 | Timed out at 120,047ms on CPU; prevented evaluation of coding capability | Phase 24 |

---

## 3. Host Hardware Profile & Invariants

Empirical telemetry established during Phase 18 and re-verified throughout Phases 21–24:
- **Processor**: Intel Core i3-N305 (8 physical/logical Gracemont E-cores, AVX2, up to 1.8 GHz base / 3.8 GHz burst).
- **Memory**: 7.63 GiB visible physical RAM, with ~1.40 GiB free headroom under standard desktop baseline.
- **Graphics / Acceleration**: Intel UHD Graphics (integrated, no discrete compute support in Ollama; 100% CPU-only execution).
- **Storage**: ~194 GiB free SSD headroom on `C:\`.
- **Operational Ceilings**: 120,000 ms per step feasibility ceiling; 6 proposal rejections ceiling; 12 max steps; 8 max physical actions.

---

## 4. Empirical Capability Gaps

Analysis of model performance across the 15 agentic capability dimensions:

| Capability Dimension | Classification | Measured Empirical Evidence |
| :--- | :--- | :--- |
| **1. Tool argument grounding** | **PARTIALLY DEMONSTRATED** | Grounded correctly on Step 1 under direct prompt instruction (`path: "src/math.js"` in `qwen2.5:1.5b` and `qwen2.5-coder:1.5b`). Grounding completely collapsed on Step 2+ once multi-turn history was present (invented `filePath` or `/path/to/output/file.js`). |
| **2. Strict structured-output adherence** | **DEMONSTRATED** | All evaluated 1.5B–3B models (`qwen2.5`, `qwen2.5-coder`, `llama3.2`) successfully produced syntactically valid JSON matching the outer discriminated `anyOf` proposal schema. |
| **3. Schema constraint adherence** | **NOT DEMONSTRATED** | Models consistently violated strict `.strict()` Zod schemas on subsequent turns: `llama3.2:3b` violated numeric minimums (`offsetLine: 0`); `qwen2.5:1.5b` injected unrecognized keys (`contentHash`); `qwen2.5-coder:1.5b` hallucinated keys (`filePath`). |
| **4. Observation $\rightarrow$ next-action transformation** | **NOT DEMONSTRATED** | Models failed to parse tool outputs into logical actions: `qwen2.5:1.5b` treated observation metadata as tool inputs; `qwen2.5-coder:1.5b` read defective code from `read_file` and regurgitated it verbatim into `write_file` without repairing the defect. |
| **5. Error-message interpretation** | **NOT DEMONSTRATED** | Structured rejection messages (`INVALID_TOOL_INPUT: path: Required, Unrecognized key(s): filePath`) were explicitly provided in the context snapshot, but models failed to parse them or extract the missing parameter. |
| **6. Recovery after validator rejection** | **NOT DEMONSTRATED** | Zero successful recovery events observed across all live model runs. In 100% of cases, an initial rejection resulted in consecutive rejections until budget exhaustion (`6 >= 6`). |
| **7. Repeated-failure avoidance** | **NOT DEMONSTRATED** | Models entered rigid, deterministic repetition loops upon receiving validator rejection feedback, emitting identical invalid payloads across 5–6 consecutive steps. |
| **8. Code reasoning** | **NOT DEMONSTRATED** | `qwen2.5-coder:1.5b` read `return a - b;` alongside the explicit directive `add(2, 3) must return 5`, yet failed to deduce that subtraction must become addition (`return a + b;`). |
| **9. Code editing** | **PARTIALLY DEMONSTRATED** | `qwen2.5:1.5b` successfully synthesized valid JavaScript and wrote it to disk, modifying the file in Phase 15E/16. However, `qwen2.5-coder:1.5b` failed to construct valid arguments for `write_file`, preventing editing. |
| **10. Context retention** | **NOT DEMONSTRATED** | As context size grew from ~3.8 KB (Step 1) to >8.3 KB (Step 2) with observation history, model generation quality degraded sharply into ungrounded hallucination and repetition. |
| **11. Tool-state understanding** | **NOT DEMONSTRATED** | Models failed to maintain an accurate internal representation of repository state, treating previously observed state as static prompt text rather than dynamic workspace reality. |
| **12. Completion-state judgment** | **PARTIALLY DEMONSTRATED** | Qwen models avoided premature `isGoalReached: true` across all turns. In contrast, `gemma3:1b` failed immediately by claiming goal completion at Step 0 without executing any tools. |
| **13. Distinguishing observations from inputs** | **NOT DEMONSTRATED** | Models repeatedly exhibited parameter leakage, treating fields present in tool execution observations (`contentHash`, execution status) as valid inputs for subsequent tool invocations. |
| **14. Maintaining multi-step execution plans** | **NOT DEMONSTRATED** | No tested model maintained a coherent multi-step plan (`inspect` $\rightarrow$ `edit` $\rightarrow$ `diff` $\rightarrow$ `verify`) beyond Step 2. Models either skipped inspection or collapsed immediately after inspection. |
| **15. Preserving task constraints across steps** | **PARTIALLY DEMONSTRATED** | Syntactic preservation of unaffected code (e.g. keeping `multiply(a, b)` intact) was observed in drafts, but schema parameter constraints degraded completely under multi-turn context. |

---

## 5. Proven vs Hypothesized Causes

### Proven Facts (Empirical Evidence)
1. **CPU Latency Scaling**: On the Intel Core i3-N305, models $\ge 3$B parameters (`qwen2.5:3b`, `qwen2.5-coder:3b`, `qwen3:4b`, `deepseek-r1:8b`) reliably hit or exceed the 120,000 ms operational ceiling on multi-thousand token contexts.
2. **Interface Compression Is Not a Cure**: Phase 16 proved that reducing prompt size from 7,169B to 3,200B dropped latency by 28% (69.4s $\rightarrow$ 49.8s), but the model still hallucinated `contentHash`, suffered 6 rejections, and achieved the exact same capability depth (Depth 5).
3. **Coding Pre-Training Does Not Equal Tool Protocol Adherence**: Phase 23 proved that pre-training on 5.5T code tokens (`qwen2.5-coder:1.5b`) did not fix tool parameter hallucination (`filePath` vs `path`) or enable in-context recovery.
4. **Sub-2B General Models Enter Repetition Loops**: Both `qwen2.5:1.5b` and `qwen2.5-coder:1.5b` entered deterministic 5-step repetition loops when presented with negative structured feedback.

### Hypothesized Causes
1. **Attention Dispersion on Multi-Turn Context**: Sub-2B models suffer from rapid attention dispersion when context switches from a single directive to multi-turn JSON histories containing schema definitions, observations, and error messages.
2. **Lack of Negative Feedback Fine-Tuning**: Small models are trained on positive demonstration trajectories (SFT) and lack reinforcement learning or DPO on *rejection-recovery* pairs, causing them to treat error feedback as general conversational text rather than a constraint to update prior output tokens.
3. **Parameter Gap for In-Context Meta-Reasoning**: Meta-reasoning (recognizing "my last proposal had error $X$, so I must change key $Y$ to $Z$") may have a hard parameter floor between 2B and 3B parameters.

---

## 6. Model Candidate Matrix

Evaluating available open-source/open-weight models in the 0.5B–2.5B range (without downloading):

| Candidate Model | Parameter Count | Quantization & Size | RAM Footprint | Expected CPU Latency | Tool & Function Training Pedigree | License | Confidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`granite3-dense:2b`** | **2.63B** | **Q4_K_M (~1.6 GB)** | **~2.4 GB** | **80s–95s (Feasible)** | **High (Native ToolBench, BFCL, and function-calling pre-training by IBM)** | **Apache 2.0** | **MEDIUM-HIGH** |
| `smollm2:1.7b` | 1.71B | Q4_K_M (~1.1 GB) | ~2.0 GB | 60s–75s (Feasible) | Moderate (Synthetic function-calling fine-tuning by Hugging Face) | Apache 2.0 | MEDIUM |
| `deepseek-coder:1.3b` | 1.30B | Q4_K_M (~800 MB) | ~1.6 GB | 45s–55s (Feasible) | Low (Trained for code completion/infilling; poor structured JSON adherence) | DeepSeek License | LOW |
| `qwen2.5-coder:0.5b` | 0.49B | Q4_K_M (~390 MB) | ~1.0 GB | 15s–20s (Feasible) | Very Low (Severe parameter compression; strictly inferior to 1.5B) | Apache 2.0 | VERY LOW |

---

## 7. Hardware Feasibility

Evaluating `granite3-dense:2b` against the host constraints:
1. **Memory Budget**: Model file is ~1.6 GB. In-memory RSS is estimated at ~2.4 GB. Under normal desktop load with ~1.4 GB free physical RAM, memory management will reclaim file-cache buffers, remaining within physical RAM without severe swap thrashing.
2. **CPU Latency Ceiling**:
   - `qwen2.5-coder:1.5b` (1.54B): 64.4s
   - `granite3-dense:2b` (2.63B): **Estimated 80s–95s**
   - `qwen2.5-coder:3b` (3.09B): 120.05s (timed out)
   - `llama3.2:3b` (3.21B): 118.99s
   At 2.63B, `granite3-dense:2b` sits directly in the narrow operational gap between 1.5B (which runs in 64s but fails recovery) and 3.1B (which exceeds 120s). It represents the absolute maximum parameter capacity that can theoretically execute within Emerald's 120s CPU feasibility ceiling.
3. **Storage**: ~194 GB free disk on `C:\` easily accommodates the 1.6 GB download.

---

## 8. Recommended Next Candidate

**`granite3-dense:2b`** (`ibm-granite/granite-3.0-2b-instruct`)

Classification under Decision Tree: **`DOWNLOAD_REQUIRED_DEFERRED`**
Per Phase 25 research-only rules, **no download was performed**. The model is formally recorded as deferred for future experimental authorization.

---

## 9. Why This Candidate Is Different From Previous Tests

1. **Different Architectural Objective**:
   - `qwen2.5-coder:1.5b` and `deepseek-coder:1.3b` were trained primarily on source code syntax, ASTs, and completion. They treat JSON tool calling as a superficial prompt format.
   - `granite3-dense:2b` was developed by IBM Research specifically for **enterprise agentic workflows, API invocation, and tool calling**, with dedicated pre-training loss on ToolBench and Berkeley Function Calling Leaderboard (BFCL) datasets.
2. **Parameter Regime Above 1.5B but Below 3B**:
   - All previous tests were either $\le 1.54$B (`gemma3:1b`, `qwen2.5:1.5b`, `qwen2.5-coder:1.5b`), which failed closed-loop recovery, or $\ge 3.09$B (`qwen2.5:3b`, `qwen2.5-coder:3b`, `llama3.2:3b`), which hit the CPU latency ceiling.
   - `granite3-dense:2b` (2.63B) is the **only available open-weight candidate** occupying the intermediate capacity zone.
3. **Permissive Open-Source License**:
   - Apache 2.0 license, fully satisfying Emerald's ₹0 open-source requirement.

---

## 10. What Would Falsify This Recommendation

This recommendation would be empirically falsified if:
1. **Gate A Latency Exceeds 120,000 ms**: If `granite3-dense:2b` takes $>120$s on the i3-N305 CPU, proving that the hardware feasibility ceiling is strictly $<2.6$B parameters.
2. **Schema Hallucination Persists**: If `granite3-dense:2b` still hallucinates parameter names (e.g. `filePath` instead of `path`) or invalid bounds.
3. **Recovery Repetition Persists**: If upon receiving validator rejection feedback, `granite3-dense:2b` enters the same 5-step repetition loop observed in Qwen models.
4. **Code Arithmetic Reasoning Fails**: If the model successfully edits `src/math.js` but fails to repair `a - b` to `a + b`.

---

## 11. Phase 26 Experimental Proposal

### Objective
Execute a controlled capability experiment evaluating `granite3-dense:2b` under Emerald's frozen production architecture to test whether native tool-calling pre-training at 2.63B scale enables closed-loop recovery within the 120s CPU ceiling.

### Experimental Boundaries
1. **Model**: Exactly `granite3-dense:2b` (Ollama local CPU).
2. **Baseline**: Commit `70979cf4bcbf4a237b79af3a23449a4b932104d5` (byte-for-byte frozen).
3. **Task**: Standardized `src/math.js` repair (`649544ffe153f3ec8ecb2d40c8c35788d03398b08ed525417f9507a6e41c9c58`).
4. **Gate A Ceiling**: Fixed at 120,000 ms.
5. **Gate B**: Governed loop via `AgentStepController` (`maxProposalRejections: 6`).
6. **Gate C**: Dual-gate clean-room independent verification.
7. **Gate D**: Fourfold completion gate.

*(Phase 26 is NOT executed in this phase. It is strictly proposed for future user authorization).*
