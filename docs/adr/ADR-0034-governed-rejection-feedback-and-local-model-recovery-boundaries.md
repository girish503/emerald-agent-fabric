# ADR-0034: Governed Proposal-Rejection Feedback and Local Model Recovery Boundaries

## Document Metadata
- **Status**: Proposed — awaiting maintainer decision (Empirically Validated via Phase 43 Gates B.1–B.6)
- **Date**: 2026-10-26
- **Scope**: Emerald Agent Fabric execution runtime, proposal validation, feedback loops, and local model benchmarking
- **Decision Type**: Architectural runtime governance, validation feedback policy, and local model operating boundaries
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Related Evidence**:
  - Phase 43 Gate B Research Report: [`docs/research/phase43-gate-b-empirical-research-report.md`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/docs/research/phase43-gate-b-empirical-research-report.md)
  - Gate B.1 Trial Record: [`scratch/phase43-gate-b1-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b1-trial-results.json)
  - Gate B.2 Trial Record: [`scratch/phase43-gate-b2-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b2-trial-results.json)
  - Gate B.3 Trial Record: [`scratch/phase43-gate-b3-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b3-trial-results.json)
  - Gate B.4 Trial Record: [`scratch/phase43-gate-b4-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b4-trial-results.json)
  - Gate B.6 Trial Record: [`scratch/phase43-gate-b6-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b6-trial-results.json)
- **Related ADRs**:
  - ADR-0001: Master Engineering Constitution
  - ADR-0003: Workspace and Typed Tools
  - ADR-0004: Tool Execution Gateway and Adapter Boundary
  - ADR-0008: Agent Brain Action Proposal Boundary
  - ADR-0009: Governed Autonomous Step Controller
  - ADR-0010: Model Provider Boundary
  - ADR-0029: Standardized Model-Facing Tool Contracts
  - ADR-0032: Local Model Scaling and Repair Benchmark Prerequisites
  - ADR-0033: Bounded Human-in-the-Loop Repair with Small Local Models

---

## 1. Context

Emerald Agent Fabric is an experimental infrastructure system for safely executing autonomous software-engineering agents. The architecture is founded upon the principle that model output is untrusted and never authoritative (ADR-0001, Section 9). Execution must proceed through typed validation, policy verification, capability fencing, and independent clean-room verification.

During the Phase 43 live benchmark campaign on local commodity CPU hardware (Intel Core i3-N305, 8 cores, 7.63 GiB RAM, ₹0 budget, local Ollama), autonomous repair task `EAF-BM-01` (`src/calc.js` off-by-one error) was evaluated across six controlled gates (Gates B.1 through B.6). The trials revealed two recurring dynamics:

1. **Parameter Hallucination Persistence in `qwen2.5-coder:1.5b`**:
   While the model successfully cold-started with a valid `read_file` proposal (`{"path": "src/calc.js"}`) on Step 1, its subsequent turns collapsed into repeatedly proposing `{"filePath": ...}` instead of `path`. Across progressive interventions—uninformed rejections (B.1), raw Zod syntax feedback (B.2), explicit system prompt instructions (B.3), and field-specific actionable guidance (B.6)—the model consistently modified the string value rather than correcting the invalid key name.
2. **CPU Inference Latency Boundary in `qwen2.5-coder:3b`**:
   Evaluating ~2,050 prompt tokens at 3B scale on CPU took >120 seconds, triggering client-side request timeout aborts (B.4) prior to proposal completion.

To maintain architectural integrity, avoid unbounded prompt micro-tuning, and preserve constitutional safety invariants, this ADR establishes formal operating boundaries for proposal validation, structured feedback loops, and local model evaluation.

---

## 2. Decision

Emerald Agent Fabric formally adopts the following nine architectural and operating decisions:

### 2.1 Strict Authoritative Schema Validation Remains Mandatory
Runtime Zod input schemas (`src/domain/tool-schemas.ts`) remain the sole authoritative gate for tool proposals. The runtime shall **never** loosen, relax, or make optional any schema requirements to accommodate model shortcomings. Unknown keys must be strictly rejected via `.strict()`. Pure lexical path sanitization (prohibiting path traversal `..`, drive letters, and sandbox escapes) must be enforced unconditionally.

### 2.2 Actionable Rejection Feedback Without Silent Proposal Mutation
The runtime may generate structured, actionable cognitive guidance for rejected proposals using deterministic, tool-specific mappings (`deriveActionableValidationGuidance()` in `src/application/agent-step-controller.ts`). However:
- The runtime shall **never** silently rewrite, repair, or mutate an invalid proposal.
- Guidance must be derived strictly from the authoritative tool schema or deterministic mappings scoped per-tool (e.g., `text → content` strictly on `write_file`; `pattern → query` strictly on `search_code`).
- Unknown keys, missing fields, path traversal attempts, or policy denials shall **never** be translated into speculative guidance; they must fall back safely to sanitized raw validator messages (`null` guidance).

### 2.3 Requirement of a New Schema-Valid Proposal Before Action Execution
No tool action may be scheduled, leased, or executed following a proposal rejection until the model independently generates a brand-new proposal that passes all 11 stages of `ProposalValidator`. A rejected proposal is terminal for that turn; it cannot be partially executed or patched by runtime heuristics.

### 2.4 Preservation of Rejection Ceilings and Fail-Closed Halts
The cumulative proposal rejection ceiling (`maxProposalRejections: 3`) remains invariant. If an agent emits 3 invalid proposals within a single run, the execution loop must terminate immediately with `terminalStatus: "FAILED"` and `terminalReason: "MAX_PROPOSAL_REJECTIONS"`. The runtime shall not grant automatic retries, backoff loops, or infinite turns to ungrounded agents.

### 2.5 Distinction Between Offline Evidence Integrity and Task Completion
An offline audit verdict of `status: "VERIFIED"` certifies only that the produced evidence bundle is structurally intact, cryptographically signed by authorized threshold keys (2-of-2 Ed25519), and authentic. It does **not** certify task success. A task is successful **only** when `fourfoldSatisfied === true`, requiring clean-room dual-gate proof (`FAIL_TO_PASS` exit code 0, `PASS_TO_PASS` exit code 0, non-empty patch within allowed file boundaries). The runtime must never report a failed run as successful merely because its evidence bundle is valid.

### 2.6 Independent Evaluation of CPU Inference Feasibility vs. Model Capability
Inference latency feasibility on developer CPU hardware must be evaluated as an independent system dimension separate from semantic reasoning capability:
- Hardware latency limits (>120s prompt evaluation) represent an environmental resource boundary.
- Hardware boundaries must be recorded as `ENVIRONMENT_FAILURE` or `BRAIN_FAILURE (TIMEOUT)`, and must not be conflated with semantic tool-reasoning defects or policy rejections.

### 2.7 Cessation of Prompt-Only Tuning for `qwen2.5-coder:1.5b` on the Observed Failure
Empirical evidence from Gates B.2, B.3, and B.6 establishes that `qwen2.5-coder:1.5b` on `EAF-BM-01` has reached prompt-tuning saturation regarding the multi-turn `filePath` parameter collapse. Further prompt wording adjustments or feedback phrasing iterations for this specific model/task pairing are **prohibited** without a materially different architectural hypothesis (e.g., grammar-constrained decoding or few-shot exemplar caching).

### 2.8 Clarification of the 3B 120-Second Timeout Boundary
The Gate B.4 timeout failure of `qwen2.5-coder:3b` at 120,386 ms is recognized as a measured feasibility result under that specific timeout ceiling on CPU hardware. It is **not** proof of universal hardware incompatibility or model incapacity. Testing 3B capability requires either an explicitly authorized extended latency budget (e.g., 240s–300s) or hardware acceleration.

### 2.9 Mandatory Explicit Authorization for Any New Live Inference Trials
Because live model inference consumes host CPU resources, locks developer workstations, and incurs non-trivial execution duration (4–5 minutes per trial), **no live model inference may be initiated autonomously**. Every live trial requires separate, bounded, prior user authorization specifying the exact model, task, timeout, and step limits.

---

## 3. Alternatives Considered

### Alternative 1: Silent Runtime Parameter Translation (Auto-Aliasing)
- *Description*: Modify `ProposalValidator` or `WorkerRuntime` to automatically rename incoming keys (e.g., silently translating `inputPayload.filePath` to `inputPayload.path` before schema validation).
- *Reason for Rejection*: Violates the core constitutional principle of Authority Separation (ADR-0001, Section 6). If the runtime silently corrects model output, the model's true lack of grounding is masked, security auditing is corrupted, and the risk of unpredictable semantic drift on complex tools increases exponentially. Untrusted output must be validated as-is.

### Alternative 2: Unbounded Feedback Loops and Dynamic Retries
- *Description*: Allow the step controller to loop indefinitely or expand `maxProposalRejections` until the model eventually stumbles upon a valid proposal.
- *Reason for Rejection*: Violates Bounded Resource Invariants (ADR-0009). On CPU hardware, each model invocation requires 60–80 seconds. Unbounded retries cause CPU lockup, exhaust loop budgets, and produce low-quality wandering trajectories without improving recovery probability.

### Alternative 3: Conflating Cryptographic Bundle Validity with Task Success
- *Description*: Allowing benchmark dashboards to display runs as "Passed" if the evidence bundle achieves `offlineAudit.status === "VERIFIED"`.
- *Reason for Rejection*: Categorically rejected. An untampered record of a failed execution is forensic proof of failure, not proof of software repair. Task success demands physical dual-gate verification in an isolated clean-room container.

---

## 4. Consequences & Operating Invariants

### 4.1 Positive Consequences
1. **Uncompromised Safety**: Zero unauthorized file writes, zero path traversals, and zero corrupted working trees occur from hallucinating models.
2. **Transparent Diagnostics**: The system truthfully records model failures and preserves exact raw completions and validator violations for research inspection.
3. **Reproducibility**: Deterministic unit and integration test fixtures (Gates A.11a–A.11f) verify the feedback and validation mechanics with fake transports in milliseconds without requiring expensive Ollama execution.
4. **Audit Integrity**: Evidence bundles remain verifiable forensic records regardless of task outcome.

### 4.2 Negative Consequences & Trade-offs
1. **Zero Autonomous Completion on Weak Models**: Models that cannot recover from parameter hallucinations will consistently fail tasks under Emerald, even if more permissive frameworks (which silently coerce arguments) might let them proceed.
2. **Developer Latency on CPU**: Evaluating models >=3B locally on CPU requires extended timeouts (>240s) or hardware accelerators.

---

## 5. Conditions for Revisit

This decision shall be revisited only when at least one of the following conditions is met:

1. **Constrained Decoding Integration**: When Ollama or local inference backends support rigid context-free grammar (GBNF) or JSON Schema enforcement at the sampler/token level, structurally eliminating schema-invalid keys before generation.
2. **Hardware Acceleration Availability**: When dedicated NPU or discrete GPU execution is available, reducing 3B+ prompt evaluation latency to <15 seconds per turn.
3. **Alternative Small-Model Evaluation**: When evaluating alternative sub-2B model architectures (`smollm2:1.7b`, `granite3-dense:2b`) with demonstrably different pre-training priors under an authorized comparative protocol.
4. **Bounded Human-in-the-Loop Orchestration**: When executing under the ADR-0033 human-approval operating posture, where parameter corrections are confirmed interactively by a developer.
