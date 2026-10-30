# ADR-0030: External Reference Inference Evaluation

## Document Information

- **Document Type**: Architecture Decision Record
- **Document Status**: Proposed (Research Contract Baseline — Phase 20)
- **Date**: 2026-10-18
- **Governing Constitution**: [GEMINI.md](../../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Upstream ADRs**:
  - [ADR-0001: Adoption of Master Engineering Constitution and Architectural Boundaries](../../adr/ADR-0001-master-engineering-constitution.md)
  - [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](../../adr/ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
  - [ADR-0008: Agent Brain Action Proposal Boundary](../../adr/ADR-0008-agent-brain-action-proposal-boundary.md)
  - [ADR-0010: Model Provider Boundary & Provider-Neutral Inference Port](../../adr/ADR-0010-model-provider-boundary.md)
  - [ADR-0011: LiveAgentBrain Boundary, Context Translation, and Untrusted Action Proposal Pipeline](../../adr/ADR-0011-live-agent-brain-boundary.md)
  - [ADR-0029: Standardized Model-Facing Tool Contracts](../../adr/ADR-0029-rfc-standardized-model-facing-tool-contracts.md)
- **Related Evidence**:
  - Phase 14: `scratch/phase13d-verification-stage-evidence.json`
  - Phase 15E: `scratch/phase15e-benchmark-evidence.json`
  - Phase 16: `scratch/phase16-interface-complexity-report.json`
  - Phase 17: `scratch/phase17-reference-model-report.json`
  - Phase 18: `scratch/phase18-accelerator-feasibility-report.json`
  - Phase 19: `scratch/phase19-gemma3-1b-report.json`

---

## 1. Context

### 1.1 Empirical Evidence Chain (Phases 14–19)

Emerald Agent Fabric has conducted an extensive series of controlled empirical evaluations of local models on a dedicated developer workstation:

- **Phase 14 (`llama3.2:3b` on CPU)**: The model produced valid structured output, generated 5 sequential actions, and achieved physical file mutations in the workspace. However, it exhibited severe coding and planning failure: it replaced real code with placeholder comments and attempted premature completion without running verification. Emerald's clean-room verifier correctly contained and rejected the attempt. Inference latency was ~120s/step.
- **Phase 15 / 15B / 15C (`qwen3:4b` on CPU)**: The 4B model consistently exceeded the 180s–600s CPU timeout ceilings during prompt evaluation (prefill). Classification: `ENVIRONMENT_FAILURE` (CPU latency infeasibility).
- **Phase 15D (`qwen2.5:3b` on CPU)**: The 3B model consistently timed out at >120s per step on CPU, failing Gate A. Classification: `ENVIRONMENT_FAILURE`.
- **Phase 15E (`qwen2.5:1.5b` on CPU)**: Responded in 49.8s–69.4s and achieved depth 5 (physical workspace mutation), but became trapped in an infinite `contentHash` hallucination loop on observation consumption. Classification: `MODEL_CAPABILITY_FAILURE`.
- **Phase 16 (`qwen2.5:1.5b` Interface Complexity Experiment)**: Tested whether simplified schemas or minimal prompts enabled multi-step reasoning. Confirmed that interface complexity was not the root cause: the 1.5B model possesses a hard reasoning depth ceiling of ~5 steps regardless of prompt scaffolding.
- **Phase 17 (`deepseek-r1:8b` on CPU)**: Exceeded the 600-second Gate A ceiling (took 600,453ms) without completing first-token generation. Classification: `ENVIRONMENT_FAILURE`.
- **Phase 18 (Hardware Accelerator Feasibility)**: Formal audit established that the development machine (Intel Core i3-N305, 8 E-cores, 8 GB RAM) has only an integrated Intel UHD GPU. Ollama does not support Intel iGPU acceleration; it requires CUDA, ROCm, or Metal. Classification: `ACCELERATOR_UNAVAILABLE`.
- **Phase 19 (`gemma3:1b` on CPU)**: Evaluated the lower bound. The ~1B model responded in 57.1s at Gate A, but immediately emitted a premature `{"isGoalReached": true}` claim without proposing any inspection or repair action. Classification: `MODEL_SCHEMA_FAILURE`.

### 1.2 The Capability Boundary Dilemma

The local empirical evidence reveals a clear dichotomy:
1. **CPU-feasible models (≤1.5B)**: Respond within acceptable latency (45–70s), but suffer from severe cognitive deficits: premature goal claims, parameter hallucination loops, or inability to sustain multi-step repair trajectories.
2. **Potentially capable models (≥3B)**: Exceed acceptable wall-clock latency on CPU (>120s to >600s), causing timeouts and environment failures.
3. **Hardware acceleration**: Unavailable on the current development machine.

Throughout all trials, Emerald's governance, verification, and execution architecture functioned correctly:
- Invalid schemas were rejected at Stage 1–3
- Stale or corrupted context hashes were caught at Stage 4
- Path traversals were blocked at Stage 9
- Premature completions were rejected by the fourfold completion gate
- Dirty working tree and test failures were flagged by `CleanRoomVerifier`
- Complete audit trails were persisted to SQLite

The scientific question is whether the barrier to end-to-end task completion is **model capability** (H1) or **Emerald architecture deficiency** (H2).

---

## 2. Decision Drivers

Evaluating whether to introduce an external reference inference capability requires weighing 14 distinct drivers:

1. **₹0 Local Reproducibility**: Emerald's founding premise is open-source, local, zero-cost developer infrastructure. External inference must not compromise the integrity of the local CPU baseline.
2. **Coding Capability**: The model must accurately parse code, identify defects, edit files precisely without placeholders, and verify fixes.
3. **Tool-Schema Adherence**: The model must conform to strict JSON schemas, discriminate `anyOf` branches, and construct valid tool payloads without inventing fields.
4. **Latency**: Per-step inference must complete well within the 120s budget ceiling (ideally <15s) to allow multi-step agent trajectories.
5. **Determinism / Repeatability**: The evaluation harness requires reproducible behaviors across benchmark trials for scientific validity.
6. **Privacy**: Source code and workspace contents must be protected. Cloud inference transmits code over external networks.
7. **Credentials**: API keys must be strictly segregated from execution sandboxes, logs, events, and persistence.
8. **Vendor Lock-in**: Emerald must not depend structurally on any single commercial provider (OpenAI, Anthropic, Google, etc.).
9. **Architecture Isolation**: The model must remain an untrusted proposal generator behind `ModelProviderPort`. Zero authority may leak.
10. **Observability**: Full token counts, latency breakdowns, and per-step costs must be captured and persisted.
11. **Evidence Integrity**: All actions, attempts, decisions, and diffs must produce verifiable evidence bundles regardless of inference origin.
12. **Clean-Room Verification**: Independent post-run clean-room proof (`CleanRoomVerifier`) must remain unchanged and unbypassable.
13. **Ability to Substitute Providers**: Switching between local Ollama and external reference adapters must require only configuration changes.
14. **Future Production Viability**: An infrastructure system must understand the performance characteristics of both local and cloud-scale models.

---

## 3. Considered Options

### Option A: Continue CPU-Only Local Models
Continue benchmarking existing or newly released sub-3B local models on CPU (e.g., `phi-3-mini`, `smollm2`, `tinyllama`).
- **Pros**: ₹0 cost, 100% local, zero network dependency, zero credential management, perfect privacy.
- **Cons**: Phase 18 and 19 proved that sub-3B models lack the reasoning depth for multi-step governed coding, while ≥3B models are CPU-infeasible. This option cannot test the upper capability frontier or falsify H1 vs H2.

### Option B: Acquire / Use Stronger Local GPU Hardware
Procure a dedicated workstation with a CUDA-compatible GPU (e.g., RTX 4060/4090 with 16GB+ VRAM) to run 7B–14B models locally.
- **Pros**: Maintains local execution, zero ongoing API cost, high privacy, eliminates network variability.
- **Cons**: High capital expenditure (₹30,000 to ₹150,000+), procurement lead time, physical hardware dependencies, does not solve the research question on the existing machine.

### Option C: External Reference Inference Adapter
Implement a single-model, provider-neutral external inference adapter behind the existing `ModelProviderPort` interface to execute a controlled reference experiment.
- **Pros**: Immediately accesses frontier coding capabilities (e.g., GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro, DeepSeek V3), achieves <10s inference latency, isolates model capability as the sole independent variable, directly tests H1 vs H2.
- **Cons**: Non-zero API cost (metered per token), requires internet access, introduces API credentials, external API non-determinism, code leaves the local machine.

### Option D: Hybrid Local + External Provider Architecture
Design Emerald to route routine/simple cognitive steps (e.g., status checks, formatting) to local SLMs, while routing complex multi-file planning and code generation to external reference models.
- **Pros**: Optimizes cost and latency, leverages strengths of both local and cloud execution.
- **Cons**: Speculative architecture at this phase (violates Constitution Section 5); premature optimization before baseline reference viability is empirically proven.

### Option E: Do Not Add External Inference and Stop at Current Research Boundary
Conclude research at Phase 19, documenting that local governed software engineering is currently bounded by local CPU hardware limits.
- **Pros**: ₹0 expenditure, respects strict local-only boundary, zero complexity addition.
- **Cons**: Leaves the central research question unanswered (unable to separate H1 model limits from H2 architecture defects); abandons scientific closure on Emerald's core thesis.

---

## 4. Architectural Principle: Strict Port Isolation

If an external reference provider is introduced, it **MUST** reside strictly behind the existing [`ModelProviderPort`](../../../src/ports/model-provider.port.ts) abstraction:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ AgentStepController / LiveAgentBrain (Application Layer - UNCHANGED)   │
│   - Constructs ContextSnapshot & system instructions                   │
│   - Enforces structured output schema (action_proposal anyOf)          │
│   - Enforces 120s step ceiling & AbortSignal cancellation              │
│   - Treats ALL model output as strictly UNTRUSTED                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ ModelProviderPort.generate(request)
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │             ModelProviderPort (Port Interface)           │
       │   - Single-attempt semantics (zero internal retries)    │
       │   - Zero execution authority                            │
       │   - Provider-neutral request / response domain types    │
       └──────────────┬───────────────────────────┬──────────────┘
                      │                           │
                      ▼                           ▼
       ┌──────────────────────────────┐ ┌──────────────────────────────┐
       │ OllamaModelProvider (Local)  │ │ ExternalReferenceAdapter     │
       │   - http://127.0.0.1:11434   │ │   - HTTPS external API       │
       │   - Local CPU/GPU execution  │ │   - Managed credentials      │
       │   - ₹0 inference             │ │   - Metered token accounting │
       └──────────────────────────────┘ └──────────────────────────────┘
```

### Invariant: Zero Authority Transfer
The external provider adapter must receive **ZERO authority** over:
- `workerId` / `leaseId`
- `contractBinding` / `MissionContract`
- `CapabilityPolicy`
- `resourceLimits`
- `workspacePath`
- `ExecutionProvider` / Docker sandbox
- `ToolExecutionGateway`
- `CleanRoomVerifier`
- Run completion state (`COMPLETED`, `FAILED`)

Governance, schema validation, capability checks, Reflex monitoring, physical execution, and clean-room verification remain 100% authoritative and internal to Emerald.

---

## 5. Required Comparison Table: Cross-Model Empirical Baseline

| Dimension | `gemma3:1b` | `qwen2.5:1.5b` | `llama3.2:3b` | `qwen2.5:3b` | `qwen3:4b` | `deepseek-r1:8b` | External Reference Model |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Parameters** | 999.89M (~1B) | 1.54B | 3.21B | 3.09B | 4.02B | 8.2B | TBD (≥30B recommended) |
| **Local Model Size** | 815 MB | 986 MB | 2.0 GB | 1.9 GB | 2.5 GB | 5.2 GB | Remote API (N/A) |
| **CPU Latency** | 57.1s | 49.8s–69.4s | ~120s/step | >120s (timeout) | >180s–600s (timeout) | >600s (timeout) | Remote (~2s–10s expected) |
| **Gate A** | PASS (response) | PASS (response) | PASS (response) | FAIL (timeout) | FAIL (timeout) | FAIL (timeout) | TBD |
| **Valid Proposal** | FAIL (`isGoalReached: true`) | PASS (Action proposal) | PASS (Action proposal) | N/A (timeout) | N/A (timeout) | N/A (timeout) | TBD |
| **Physical Mutation** | NO | YES | YES | NO | NO | NO | TBD |
| **Capability Depth** | 0 | 5 | 5 | 0 | 0 | 0 | TBD (Target: 8) |
| **Primary Failure** | `MODEL_SCHEMA_FAILURE` | `MODEL_CAPABILITY_FAILURE` | `MODEL_CAPABILITY_FAILURE` | `ENVIRONMENT_FAILURE` | `ENVIRONMENT_FAILURE` | `ENVIRONMENT_FAILURE` | TBD |
| **Clean-Room Reached**| NO | NO | NO | NO | NO | NO | TBD |
| **Final Verification**| NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | TBD |
| **Environment Class.**| Local CPU (₹0) | Local CPU (₹0) | Local CPU (₹0) | Local CPU (₹0) | Local CPU (₹0) | Local CPU (₹0) | External Managed API |

---

## 6. Decision Matrix

| Option | Capability | Cost | Reproducibility | Privacy | Research Value | Production Value |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CPU-only** | Low (≤1.5B ceiling) | Zero (₹0) | High (deterministic seeds) | High (local host only) | Moderate (boundary found) | Low (insufficient for real SWE) |
| **Local GPU** | Moderate (7B–14B) | High Capex (₹30K–150K) | High (local weights) | High (local host only) | High | Moderate-High |
| **External reference**| Very High (Frontier) | Low Opex (<₹500/eval) | Moderate (provider drift) | Low (code sent over HTTPS) | Critical (tests H1 vs H2) | High (industry standard) |
| **Hybrid** | High (routed) | Variable | Moderate | Mixed | High (future work) | High (cost-optimized) |
| **Stop** | None | Zero (₹0) | None | High | Low (leaves question open) | Low |

---

## 7. Threats to Validity

1. **Only One Coding Task**: Evaluations currently use the standardized math repair task. Performance on this single task may not generalize to complex multi-file software engineering tasks.
2. **Limited Model Sample**: Tested local models represent specific architectures (Llama, Qwen, Gemma, DeepSeek). Other architectures of similar parameter scale might exhibit different failure modes.
3. **Parameter Count Is Not Capability**: Architecture, training data, instruction tuning, and quantization methods significantly affect capability beyond raw parameter count.
4. **Different Model Families**: Local models belong to distinct families with different pre-training objectives and prompt sensitivities.
5. **Quantization Differences**: Local models were evaluated at Q4_K_M quantization; full-precision (FP16/FP32) weights could exhibit higher coherence.
6. **CPU Hardware Specificity**: All benchmarks ran on an Intel Core i3-N305 with 8 E-cores; performance and latency are specific to this processor architecture.
7. **One Local Host**: Memory bandwidth, OS thread scheduling, and background services on the host machine influence observed prefill and eval throughput.
8. **External Providers May Be Nondeterministic**: Cloud APIs may exhibit sampling variance even at temperature 0.0 due to MoE routing, concurrency, or infrastructure optimizations.
9. **Provider Models Can Change Over Time**: Commercial APIs frequently update underlying model weights and system prompts without changing model identifiers.
10. **API Latency Can Vary**: Network jitter, geographic distance, and provider load introduce latency variance absent in local inference.
11. **Temperature Alone Does Not Guarantee Deterministic Output**: Floating-point non-associativity in parallel batch inference can introduce minor token divergence across identical requests.
12. **Coding Benchmark Is Narrow**: Unit-test repair in a small JavaScript fixture is a necessary but not sufficient indicator of end-to-end repository engineering capability.
13. **One Successful Task Does Not Prove General SWE Capability**: Passing this benchmark proves only that the model crossed the immediate capability threshold under Emerald's governance, not that autonomous agent coding is solved.

---

## 8. Architectural Recommendation

1. **Adopt Option C (External Reference Inference Adapter) as a controlled experimental capability**, strictly governed by the Phase 20 Evaluation Contract (`docs/research/phase20-external-reference-evaluation.md`).
2. **Preserve Option A (CPU-Only Local Models) as the default production configuration**, ensuring Emerald remains fully functional at ₹0 out-of-the-box.
3. **Defer Option D (Hybrid)** until external reference evidence definitively proves or disproves H1.
4. **Reject Option E (Stop)** because establishing whether failure is caused by model limits vs governance design is the central scientific purpose of the project.

---

## 9. References

- [ModelProviderPort](../../../src/ports/model-provider.port.ts)
- [OllamaModelProvider](../../../src/adapters/models/ollama-model-provider.ts)
- [LiveAgentBrain](../../../src/application/live-agent-brain.ts)
- [CleanRoomVerifier](../../../src/application/clean-room-verifier.ts)
- [Master Engineering Constitution](../../../GEMINI.md)
