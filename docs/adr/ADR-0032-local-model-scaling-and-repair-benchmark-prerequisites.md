# ADR-0032: Local Model Scaling and Repair Benchmark Prerequisites

## Document Metadata
- **Status**: Proposed — awaiting repository validation and acceptance
- **Date**: 2026-10-22
- **Scope**: Emerald Agent Fabric production repair benchmarks
- **Decision type**: Experimental feasibility and resource prerequisites
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Related Evidence**: Production V1.5–V2.0 benchmark reports and machine-readable results (`docs/research/production-repair-capability-calibration-v1.5.md`, `docs/research/production-line-anchored-editing-v1.6.md`, `docs/research/production-anchored-tool-selection-v1.7.md`, `docs/research/production-structured-proposal-interface-v1.8.md`, `docs/research/production-model-scaling-feasibility-v1.9.md`, `docs/research/production-existing-model-repair-feasibility-v2.0.md`)
- **Related Invariants**: ADR-0029, ADR-0030, GEMINI.md Rule 11, frozen Phases 1–99, Phase 10H artifact integrity

---

## 1. Context

Emerald Agent Fabric implements a governed local agent runtime with structured proposals, capability enforcement, sandboxed execution, deterministic evidence, and sovereign verification.

Production V1.8 introduced grammar-constrained structured proposal generation. This eliminated observed Stage 2 parsing failures in the reported five-task conditions, but sovereign-verified task completion remained 0/5.

Production V1.9 evaluated whether local model scaling was feasible. The host has approximately 7.63 GiB of physical RAM, with approximately 1.30 GiB free at the time of measurement. No suitable 7B coding model was installed locally. Model downloads were prohibited by the experiment's constraints.

Production V2.0 reviewed the existing evidence and established the earliest decisive failure in all five calibration tasks as inaccurate, ambiguous, or non-matching edit anchors. The review also documented secondary test assertion failures associated with fail-closed non-mutation.

These findings establish a current feasibility limitation. They do not establish a universal parameter threshold for coding competence, nor do they prove that every larger model will outperform the existing model.

---

## 2. Decision

Emerald will not initiate further model-scaling or sovereign-repair benchmark trials until the resource, model availability, and experimental validity prerequisites in this ADR are satisfied.

The project will preserve the existing exact-match editing invariants. It will not introduce fuzzy anchor matching, silent fallback to whole-file replacement, weakened workspace containment, relaxed capability checks, or reduced sovereign verification requirements to improve benchmark completion rates.

The current production runtime remains unchanged unless independent evidence justifies a narrowly scoped change that preserves all security invariants.

---

## 3. Resource Prerequisites

A future model-scaling experiment must pass a measured feasibility gate before benchmark execution.

### 3.1 Candidate Model Availability
- The candidate must already be available locally, or a separately authorized future task must explicitly permit its acquisition.
- No benchmark may silently download or substitute a model.
- The model identifier, quantization, model metadata, and inference configuration must be recorded when available.
- The model must be compatible with the existing local Ollama adapter and structured proposal interface, or any compatibility difference must be treated as an experimental variable.

### 3.2 Memory and Execution Feasibility
- Measure available physical memory, active memory pressure, available disk space, and inference-time resource usage.
- Establish that the candidate can load and complete representative inference requests without uncontrolled swapping, out-of-memory termination, or unacceptable host instability.
- Account for model weights, KV cache, runtime overhead, context length, and concurrent host processes.
- Do not treat nominal model file size as equivalent to total inference memory requirements.
- Do not assume that integrated graphics provide usable dedicated VRAM.
- Stop the experiment if safe resource feasibility cannot be demonstrated.

A host with 16 GB of RAM may be a reasonable starting point for evaluating a quantized 7B model, but 16 GB is not a universal guarantee. Actual feasibility depends on quantization, context length, runtime overhead, and concurrent memory use.

---

## 4. Repair Benchmark Prerequisites

Before reopening the benchmark, the experiment owner must:
1. Identify the precise failure category the candidate is intended to address.
2. Preserve the existing calibration tasks, mission contracts, capability policy, sandbox, budgets, and sovereign verifier.
3. Define the comparison conditions before execution.
4. Keep model changes separate from prompt changes, tool changes, and budget changes.
5. Record per-task outcomes and explicit denominators.
6. Distinguish proposal validity, anchor matching, patch application, syntax validity, test passage, and sovereign-verified completion.
7. Record resource pressure, latency, timeout counts, and infrastructure failures.
8. Preserve reproducible evidence and historical benchmark artifacts.

The primary success metric remains sovereign-verified task completion. Intermediate improvements alone do not qualify as repair capability improvements.

---

## 5. Editing and Governance Invariants

The following controls remain mandatory:
- Exact anchor matching remains fail-closed.
- Ambiguous or non-matching anchors must not authorize edits.
- Schema-valid proposals must still pass governance and capability enforcement.
- Workspace containment and optimistic concurrency checks remain enabled.
- Model output remains untrusted input.
- All mutations must use authorized runtime tools.
- The sovereign verifier remains the final authority on task completion.
- No automatic commits or pushes are introduced.
- Historical research phases and immutable artifacts remain unchanged.

If a future intervention changes editing semantics, it requires a separate design decision, threat analysis, focused tests, and explicit approval. It must not be smuggled into a model-scaling experiment.

---

## 6. Acceptance Criteria for Reopening the Benchmark

A new repair benchmark may proceed only when all of the following are true:
- [ ] A candidate model is available under the authorized local-inference constraints.
- [ ] Resource feasibility is demonstrated by measured inference behavior.
- [ ] The candidate can produce responses through the existing or explicitly controlled adapter configuration.
- [ ] The experiment has a specific hypothesis tied to the observed failure category.
- [ ] The experimental conditions and success criteria are defined in advance.
- [ ] Calibration fixtures and historical manifests remain unchanged.
- [ ] Governance, sandbox, and sovereign verification remain enabled.
- [ ] Regression and artifact integrity checks are available.
- [ ] The experiment can be conducted without external inference, unauthorized network access, or paid resources.

If any prerequisite fails, the benchmark must stop and report the blocking condition.

---

## 7. Required Verification

After adding this ADR, verify that:
- The ADR follows the repository's established decision-record conventions.
- No runtime behavior, production configuration, calibration manifest, or historical artifact was modified.
- Phases 1–99 remain frozen.
- Phase 10H historical artifacts remain byte-identical.
- Relevant production and capability-fencing tests pass.
- No model download, automatic commit, or push occurred.

The report must identify exactly which checks were executed and their actual results.

---

## 8. Consequences

### Positive Consequences
- Avoids repeatedly running infeasible scaling experiments.
- Keeps security invariants independent of model quality.
- Separates hardware limitations from semantic model failures.
- Establishes reproducible prerequisites for future experiments.
- Prevents intermediate metrics from being mistaken for verified completion.

### Trade-offs
- Autonomous repair improvements may remain unmeasured until suitable local hardware and a feasible candidate model are available.
- The current small model may remain inadequate for some multi-step repair tasks.
- The decision does not resolve the semantic anchor-generation limitation.

---

## 9. Reconsideration Triggers

Reopen the scaling decision when at least one of the following occurs:
- A suitable stronger open-weight coding model becomes available locally and passes the resource feasibility gate.
- The project gains access to an authorized, sufficiently resourced local inference host.
- New evidence supports a different intervention that preserves exact-match editing and governance invariants.

Reconsideration does not automatically authorize model downloads, cloud inference, budget increases, or changes to security policy.

---

## 10. Final Rationale

Emerald should scale its experiments only when the environment can support a valid comparison and the experiment can test a clearly defined hypothesis.

The governing principle remains:

> The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves.
