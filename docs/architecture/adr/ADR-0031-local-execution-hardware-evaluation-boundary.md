# ADR-0031: Local Execution Hardware & Evaluation Boundary

## Status

Accepted

## Date

2026-10-18

## Context

Emerald Agent Fabric is an experimental infrastructure system designed to safely execute autonomous software-engineering agents. Throughout Phases 15 to 29, the project conducted a rigorous empirical evaluation program across 10 distinct local open-weight model configurations. This evaluation maintained a frozen architectural baseline (`70979cf4bcbf4a237b79af3a23449a4b932104d5`), an immutable ₹0-cost constraint, strictly local CPU execution, and a standardized 120,000 ms operational ceiling per agent step.

The empirical progression evaluated general-purpose reasoning models, coding-specialized models, function-calling models, and synthetic-instruction-aligned models across parameter scales from 1.0B to 8.2B:
- **Phase 15–15E**: Evaluated `qwen3:4b` (>180s latency timeout), `qwen2.5:3b` (>120s timeout), and `qwen2.5:1.5b` (49.8s–69.4s latency; achieved physical workspace mutation, but suffered from observation confusion, `contentHash` hallucinations, and infinite rejection loops).
- **Phase 16**: Validated that interface complexity was not the root bottleneck; even minimal schema projections did not resolve the reasoning depth ceiling of 1.5B models.
- **Phase 17**: Evaluated `deepseek-r1:8b` (>600s CPU prefill timeout).
- **Phase 18**: Audited local workstation acceleration and confirmed absence of discrete GPU or driver support in default local runtimes.
- **Phase 19**: Evaluated `gemma3:1b` (57.1s latency; emitted premature `isGoalReached: true` with zero physical actions).
- **Phase 20–22**: Explored external reference boundaries, re-affirming Emerald's permanent ₹0-cost and open-weight local execution mandate.
- **Phase 23**: Evaluated coding-specialized `qwen2.5-coder:1.5b` (64.4s latency; generated valid file inspection, but failed parameter grounding on file writes and entered an unrecoverable rejection loop).
- **Phase 24**: Evaluated `qwen2.5-coder:3b` (120.0s timeout at Gate A prompt prefill).
- **Phase 25–26**: Evaluated function-calling-oriented `granite3-dense:2b` (120.1s timeout at Gate A prompt prefill).
- **Phase 27–29**: Evaluated synthetic multi-turn aligned `smollm2:1.7b` (120.1s timeout at Gate A due to an unannounced 8-bit `Q8_0` distribution format saturating CPU memory bandwidth).

This extensive empirical program revealed an operational evaluation boundary on the current development host.

---

## Decision

The current CPU-only host environment is formally designated as an **empirical evaluation boundary** for Emerald's local model research under the 120,000 ms per-step operational ceiling.

Emerald Agent Fabric will immediately **halt repeated acquisition of general-purpose open-weight models** that are projected to cross the measured CPU latency boundary.

Future model capability experiments will only be authorized when one or more of the following conditions are satisfied:
1. **Verified Compatible Local Artifact**: An open-weight model artifact verified to execute within the existing CPU hardware and latency budget (e.g., $\le 1.5$B parameters at $\le \text{Q4}$ quantization).
2. **Scientifically Controlled Lower-Bit Quantization Artifact**: A canonical, reproducible quantization artifact (e.g., canonical `Q4_K_M` derived from unquantized base weights) that directly addresses a proven memory-bandwidth bottleneck while preserving tokenizer, chat template, and weight identity.
3. **Local Hardware Acceleration**: An experimentally validated local acceleration runtime (e.g., Intel OpenVINO, Intel integrated GPU/NPU runtime, or local discrete GPU) operating strictly under ₹0-cost open-source licenses.
4. **Formally Approved Evaluation Envelope Expansion**: An explicit architectural decision expanding the per-step operational timeout beyond 120,000 ms for specific research evaluations.

Engineering effort is redirected from model exploration back to Emerald's core infrastructure mission: deterministic governance, multi-attempt recovery primitives, durable execution, independent verification, and audit evidence generation.

---

## Empirical Evidence

The following table summarizes the physical observations recorded across Phases 15 through 29 under Emerald's frozen execution pipeline:

| Model | Approx Params | Quantization | Gate A | Result | Capability Tested |
| :--- | ---: | :--- | ---: | :--- | :--- |
| **gemma3:1b** | ~1.0B | Q4_K_M | ~57s | Gate A passed | Partial |
| **qwen2.5:1.5b** | ~1.54B | Q4_K_M | ~20–69s | Gate A passed | Yes |
| **qwen2.5-coder:1.5b** | ~1.54B | Q4_K_M | ~64s | Gate A passed | Yes |
| **llama3.2:3b** | ~3.21B | Q4_K_M | ~119s | Boundary | Partial |
| **granite3-dense:2b** | ~2.63B | Q4_K_M | ~120s | Timeout | No |
| **qwen2.5-coder:3b** | ~3.09B | Q4_K_M | ~120s | Timeout | No |
| **qwen2.5:3b** | ~3.09B | Q4_K_M | >120s | Timeout | No |
| **qwen3:4b** | ~4.02B | Q4_K_M | >180s | Timeout | No |
| **deepseek-r1:8b** | ~8.2B | Q4_K_M | >600s | Timeout | No |
| **smollm2:1.7b** | ~1.71B | Q8_0 | ~120s | Timeout | No |

### Notes on Observed Behaviors:
- **gemma3:1b**: Gate A completed in 57.1s, but the model immediately emitted a premature `isGoalReached: true` claim without proposing any inspection, modification, or verification action.
- **qwen2.5:1.5b**: Successfully executed initial file inspection and physical modification (Step 1–2), but became trapped in a deterministic rejection loop caused by observation misunderstanding and hallucinated context parameters. Zero recoveries achieved across all trials.
- **qwen2.5-coder:1.5b**: Executed valid file inspection in 64.4s, but failed argument grounding when attempting file edits and repeated the rejected syntax indefinitely. Zero recoveries achieved.
- **llama3.2:3b**: Gate A completed in 118.9s (at the 120s boundary); emitted malformed tool arguments, triggering schema validation failure before running out of operational budget.
- **granite3-dense:2b**, **qwen2.5-coder:3b**, **qwen2.5:3b**, **qwen3:4b**, **deepseek-r1:8b**: Prompt prefill exceeded the operational ceiling, resulting in an unrecoverable timeout before token generation.
- **smollm2:1.7b**: Timed out at 120,065 ms at Gate A due to the memory footprint of its 8-bit `Q8_0` distribution.

---

## Hardware Environment

All evaluations were executed on a dedicated local developer host:
- **Processor**: Intel Core i3-N305 (Alder Lake-N architecture).
- **Cores & Threads**: 8 physical Efficient cores (E-cores), 8 logical processors, single-threaded execution per core (no hyperthreading).
- **Instruction Set**: x86-64 with AVX, AVX2, FMA3 (no AVX-512 support).
- **System Memory**: ~7.6 GiB total installed RAM (~1.4 GiB free during representative testing).
- **Graphics / Acceleration**: Intel UHD Graphics (integrated Gen12 Xe architecture, 32 EUs). No discrete GPU.
- **Inference Runtime**: Ollama (v0.40.6) running CPU-only inference execution.
- **Operational Feasibility Ceiling**: 120,000 ms per step.

### Nature of the 120,000 ms Operational Ceiling
The 120-second per-step limit is an **Emerald experimental and software-engineering constraint**, not an immutable physical law. It represents the reasonable upper bound for interactive developer workflows, test automation loops, and CI evaluation budgets. In multi-step agent trajectories requiring 8 to 12 steps, a 120s step latency results in 16 to 24 minutes per task attempt. Ceilings higher than 120s render automated closed-loop evaluation practically unviable on local development hosts.

---

## Quantization Considerations

### The Two-Dimensional Constraint
The experimental program proved that **parameter count alone is insufficient to predict inference latency**. Latency on memory-bandwidth-bound CPU architectures is governed by the two-dimensional interaction between **model parameter scale** and **quantization precision / memory footprint**:

1. **qwen2.5:1.5b (1.54B, Q4_K_M, 986 MB)**: Completed Gate A in 49.8s–69.4s (feasible).
2. **qwen2.5-coder:1.5b (1.54B, Q4_K_M, 986 MB)**: Completed Gate A in 64.4s (feasible).
3. **granite3-dense:2b (2.63B, Q4_K_M, 1.60 GB)**: Timed out at 120.1s (infeasible).
4. **smollm2:1.7b (1.71B, Q8_0, 1.82 GB)**: Timed out at 120.1s (infeasible).

At 1.71B parameters, `smollm2:1.7b` has 35% fewer parameters than `granite3-dense:2b` (2.63B), but because it was distributed in `Q8_0` (1.82 GB) rather than `Q4_K_M` (estimated ~1.05 GB), its active memory footprint exceeded that of the 2.63B model, resulting in CPU memory bus saturation and a prompt prefill timeout.

### SmolLM2 Qualification
Phase 28 did **NOT** demonstrate a failure of SmolLM2's agentic or recovery capabilities. It demonstrated an **operational CPU latency failure (`ENVIRONMENT_FAILURE`) caused by the default `Q8_0` distribution format**.

Because inference halted before emitting a proposal:
- Tool grounding was **NOT TESTED**.
- Proposal validation was **NOT TESTED**.
- Recovery after rejection was **NOT TESTED**.
- Code editing and diff generation were **NOT TESTED**.
- Clean-room verification was **NOT TESTED**.

SmolLM2 cannot be classified as a failed agent model based on Phase 28 evidence.

### Q4 Quantization Boundary
Phase 29 audited the feasibility of evaluating a `Q4_K_M` SmolLM2 artifact:
1. **Integrity Requirements**: A scientifically rigorous `Q4_K_M` experiment requires converting original unquantized base weights (`BF16`/`FP16` Safetensors, ~3.4 GB) via canonical `llama.cpp` conversion and quantization tooling. This guarantees exact calibration of k-quant scales and preserves tokenizer structures.
2. **Rejection of Lossy-on-Lossy Re-quantization**: Transcoding directly from `Q8_0` to `Q4_K_M` introduces uncontrolled compound rounding errors, degrades model perplexity, and is rejected as scientifically invalid.
3. **Latency Projection**: A 42.3% reduction in memory footprint (from 1,820 MB to ~1,050 MB) suggests a plausible Gate A latency in the range of **70s to 90s**. This figure is strictly an **ESTIMATE** based on memory bandwidth modeling, not an empirical measurement. Because the unquantized weights and compiler binaries were absent from the host disk, the experiment could not be conducted without external acquisitions.

---

## Scientific Interpretation

To maintain rigorous scientific standards, this ADR strictly separates demonstrated empirical evidence from working hypotheses:

### Empirically Demonstrated (Observed on this Host)
- On an Intel Core i3-N305 running Ollama CPU-only inference, models with active memory footprints $\ge 1.6$ GB (whether due to parameter count $\ge 2.6$B at Q4 or 8-bit precision at 1.7B) consistently exceed the 120,000 ms operational ceiling during prompt prefill on Emerald's standardized context (~7 KB / ~2,200 tokens).
- Sub-2B models at 4-bit quantization (`qwen2.5:1.5b`, `qwen2.5-coder:1.5b`) reliably pass Gate A within 49s–69s on this host.
- Tested sub-2B models demonstrated the ability to inspect files and generate syntactically valid JSON tool calls.
- Tested sub-2B models failed to achieve closed-loop recovery after validator rejections, repeatedly emitting identical invalid syntax across multiple consecutive steps until budgets expired.
- Emerald's governance pipeline (ProposalValidator, Reflex, PolicyEvaluator, ToolGateway, CleanRoomVerifier) deterministically contained every malformed action, prevented invalid tool executions, and halted unverified completion attempts without false approvals.

### Hypothesized (Not Proven on this Host)
- *Hypothesis 1*: A canonical `Q4_K_M` variant of `smollm2:1.7b` would complete Gate A in 70s–90s on this CPU. (Plausible from memory bandwidth ratios, but unmeasured).
- *Hypothesis 2*: Small models ($\le 3$B) are fundamentally incapable of closed-loop agentic recovery regardless of prompt scaffolding or training alignment. (Unproven; only specific tested models failed recovery).
- *Hypothesis 3*: Larger models (7B–14B) would successfully recover and complete tasks under Emerald's governance if sufficient compute were available. (Unproven on this host due to latency boundaries).
- *Hypothesis 4*: Hardware acceleration (e.g. OpenVINO, NPU, or discrete GPU) would reduce 3B model latency to $<30$s on this workstation. (Unproven without physical implementation and measurement).

---

## Consequences

### Positive Consequences
1. **Preservation of Engineering Resources**: Eliminates time spent downloading and testing general-purpose models that are mathematically certain to exceed the CPU latency boundary.
2. **Methodological Rigor**: Prevents conflating host hardware latency limits (`ENVIRONMENT_FAILURE`) with intrinsic model reasoning capability (`MODEL_CAPABILITY_FAILURE`).
3. **Focus on Core Differentiation**: Directs engineering bandwidth toward Emerald's architectural primitives: recovery state machines, durable worker leases, deterministic replay, and independent clean-room verification.
4. **Preservation of ₹0-Cost Mandate**: Upholds the project's permanent ban on paid cloud inference APIs and proprietary vendor dependencies.

### Negative / Limiting Consequences
1. **Frozen Live Inference Capability Testing**: Controlled end-to-end coding evaluations using local models are paused on this workstation until hardware acceleration or verified lower-bit artifacts are introduced.
2. **Reliance on Synthetic and Replay Harnesses**: Ongoing recovery and verification development must rely on deterministic mock providers, simulated execution traces, and pre-recorded replay datasets rather than live local LLM inference.

---

## Model Search Policy

Emerald Agent Fabric adopts the following **Model Search Stop Rule**:

> Emerald will not download or evaluate additional general-purpose open-weight models solely to search for a model that happens to fit the current CPU boundary unless the candidate provides materially different information value from previously tested models.

To qualify for evaluation in future phases, a proposed model must satisfy all five criteria:
1. **Meaningful Training Differentiation**: Documented, verified architectural or training specialization for agentic tool use, multi-turn recovery, or closed-loop software repair (e.g., specialized synthetic multi-turn fine-tuning), rather than generic text generation.
2. **Clear Open-Weight Licensing**: Permissive open-source or open-weight license (e.g., Apache 2.0, MIT, Llama 3.2 Community License) without proprietary API gating.
3. **Local Runtime Support**: Direct compatibility with local inference runtimes without proprietary SDKs or cloud dependencies.
4. **Plausible Hardware Feasibility**: Demonstrated or mathematically projected memory footprint $\le 1.1$ GB (or validated execution on an authorized hardware acceleration runtime) to ensure Gate A completion $<120$s.
5. **High Expected Information Gain**: Testing the candidate must resolve an open architectural question rather than duplicating known performance characteristics of the 10 models already evaluated.

---

## Future Hardware Evaluation

Any future investigation into local hardware acceleration must adhere to strict research controls:
- **Scope**: Must evaluate local, zero-cost acceleration runtimes only (e.g., Intel OpenVINO toolkit, Intel Gen12 Xe integrated GPU/NPU drivers, or local discrete open-source compute runtimes).
- **No Speculative Architecture**: Acceleration runtimes must not be integrated into production paths without an independent, measurable latency baseline.
- **Single-Variable Evaluation**: Any hardware acceleration trial must evaluate a previously tested model (e.g., `granite3-dense:2b` or `qwen2.5-coder:3b`) holding prompt, task, and validation layers byte-for-byte identical, with inference runtime as the sole independent variable.
- **Strict ₹0-Cost and Local Invariants**: No cloud accelerators, proprietary remote instances, or paid SaaS services may be introduced.

---

## Non-Decisions

To avoid over-generalization, this ADR explicitly specifies what is **NOT** decided:
- **No Final Model Selection**: This ADR does not select or recommend a permanent model provider or model family for Emerald.
- **No Commitment to Hardware Acceleration**: This ADR does not mandate installing OpenVINO, acquiring a discrete GPU, or modifying driver environments.
- **No Decision on SmolLM2 Q4**: This ADR does not decide whether a canonical `Q4_K_M` SmolLM2 experiment should be scheduled; it only establishes that such an experiment cannot be derived locally from current host state.
- **No Universal GPU Requirement**: This ADR does not claim that autonomous software engineering fundamentally requires GPU compute in production.
- **No Final Conclusion on Small Model Viability**: This ADR does not declare that sub-3B models are permanently incapable of agentic coding; it records only that the tested configurations failed recovery on this host.
- **No Claim Regarding Long-Term Inference Bottlenecks**: This ADR does not determine whether model inference latency will remain the dominant bottleneck as local runtime software evolves.

---

## Next Research Direction

With the local CPU model evaluation boundary established, Emerald Agent Fabric refocuses development on the foundational architectural guarantees that make an agent platform reliable, observable, and verifiable:

### A. Multi-Attempt Recovery Primitives
Hardening deterministic recovery state transitions in `Action` and `Attempt` lifecycles, ensuring the engine can systematically recover from transient tool failures, unknown attempt statuses, and governance rejections without relying on model intelligence.

### B. Durable Worker Recovery
Implementing robust worker lease expiration, heartbeat fencing, crash recovery, and transaction boundaries so that agent runs survive host crashes and process restarts without state corruption.

### C. Deterministic Replay Engine
Building exact replay mechanisms capable of reconstructing execution state, context windows, tool outputs, and verification results from immutable SQLite event streams and evidence bundles.

### D. Independent Clean-Room Verification
Expanding the `CleanRoomVerifier` architecture to enforce pristine baseline isolation, tamper-proof regression testing, and zero-test fail-closed guarantees across diverse language stacks.

### E. Evidence Bundle Generation
Standardizing inspectable cryptographic evidence bundles that link every model proposal directly to its governing policy decision, physical tool action, execution attempt, observation payload, and clean-room proof.

### F. Failure Taxonomy Hardening
Refining the explicit classification engine to reliably categorize every run termination as `MODEL_FAILURE`, `ENVIRONMENT_FAILURE`, `POLICY_FAILURE`, `VERIFICATION_FAILURE`, or `INTERNAL_ERROR`.

### G. Infrastructure Benchmarking
Establishing automated benchmark suites that evaluate agent fabric reliability, recovery correctness, and governance overhead independently of live model variance.

---

## Core Architectural Principle

> **Emerald Agent Fabric must remain useful, safe, and recoverable even when the underlying model is unreliable.**

The language model is treated as an untrusted, stochastic, potentially adversarial component in the execution loop. Emerald's core value does not derive from model reasoning; it derives from:
- **Bounded Authority**: Ensuring the model has zero ambient authority and can only propose typed actions.
- **Explicit Policy Governance**: Enforcing multi-stage structural validation, risk analysis, and permission gating before execution.
- **Deterministic State Transitions**: Maintaining strict lifecycle invariants across Actions, Attempts, and Runs.
- **Durable Recoverability**: Guaranteeing system resilience against execution timeouts, tool crashes, and worker failures.
- **Independent Clean-Room Verification**: Authoritatively verifying software modifications in pristine environments without trusting the agent's self-reported goal claims.
- **Cryptographic Evidence & Replay**: Producing complete, auditable evidence trails connecting proposals to verified outcomes.
