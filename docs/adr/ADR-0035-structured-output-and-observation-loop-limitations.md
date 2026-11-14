# ADR-0035: Structured Output Adoption and Observation Loop Operating Boundaries

## Document Metadata
- **Status**: Proposed — awaiting maintainer decision (Empirically Validated via Phase 44A–44D)
- **Date**: 2026-10-26
- **Scope**: Emerald Agent Fabric model provider transport, proposal validation boundaries, step loop budgeting, and local agent repair evaluation
- **Decision Type**: Architectural transport contract, validation authority preservation, failure classification, and repair loop boundaries
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Related Evidence**:
  - Phase 44 Research Report: [`docs/research/phase44-structured-output-and-repair-loop-report.md`](../../docs/research/phase44-structured-output-and-repair-loop-report.md)
  - Phase 44C Preflight Record: [`scratch/phase44c-preflight-results.json`](../../scratch/phase44c-preflight-results.json)
  - Phase 44D Repair Trial Record: [`scratch/phase44d-repair-results.json`](../../scratch/phase44d-repair-results.json)
  - Offline Parity Suite: [`tests/contract/action-proposal-schema-parity.test.ts`](../../tests/contract/action-proposal-schema-parity.test.ts)
- **Related ADRs**:
  - ADR-0001: Master Engineering Constitution
  - ADR-0003: Workspace and Typed Tools
  - ADR-0008: Agent Brain Action Proposal Boundary
  - ADR-0009: Governed Autonomous Step Controller
  - ADR-0010: Model Provider Boundary
  - ADR-0011: Live Agent Brain Boundary
  - ADR-0029: Standardized Model-Facing Tool Contracts
  - ADR-0032: Local Model Scaling and Repair Benchmark Prerequisites
  - ADR-0034: Governed Proposal-Rejection Feedback and Local Model Recovery Boundaries

---

## 1. Context

During Phase 43 (ADR-0034), evaluations of local open-weight models (`qwen2.5-coder:1.5b`) on benchmark task `EAF-BM-01` uncovered persistent parameter hallucination: once files were read, the model collapsed into proposing `{"filePath": ...}` instead of `{"path": ...}` across all multi-turn interactions. Prompt-only interventions reached saturation, while unconstrained generation allowed the model to emit tokens outside the valid tool schema.

In Phase 44, Emerald Agent Fabric tested grammar-constrained decoding by promoting a 7-branch discriminated-union JSON Schema (`ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA`) into `LiveAgentBrain`.

Empirical trials established that:
1. **Structural Parameter Hallucinations Were Completely Eliminated**: In Phase 44C (single-step) and Phase 44D (5-step trial), Ollama compiled the 7-branch JSON Schema via GBNF grammar without error. Across all 5 steps in Phase 44D, the model generated valid JSON referencing `"path": "src/calc.js"`, resulting in 0 proposal rejections (down from 100% in Phase 43 multi-turn turns).
2. **Structural Validity Did Not Prevent an Observation Loop**: In Phase 44D, having successfully read `src/calc.js` on Step 1, the model re-read the identical file in Steps 2, 3, 4, and 5. It never proposed `write_file` or goal completion, exhausting its 5-step budget (`terminalReason: "MAX_STEPS"`). No patch was produced, and clean-room verification remained `false`.

To guide future runtime and benchmark development, this ADR formalizes the architectural status of structured output and defines boundaries for addressing the observation loop failure mode.

---

## 2. Decision

Emerald Agent Fabric formally adopts the following architectural decisions:

### 2.1 Structured Output Adopted as Standard Proposal Transport Contract
The 7-branch discriminated-union JSON Schema (`ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA` in `src/application/live-agent-brain.ts`), covering goal completion and the six core tools (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`), is adopted as the standard transport-level contract for model providers supporting JSON Schema / grammar-constrained output.

### 2.2 Independent Governance and Strict Validation Invariance
Transport-level schema constraints do **not** replace, weaken, or bypass runtime governance:
- `ProposalValidator` remains fully authoritative and executes all validation stages on every proposal regardless of whether the model provider used constrained decoding.
- `PolicyEvaluator` remains authoritative for capability, permission, and tool authorization.
- Pure lexical workspace path sanitization (rejecting `..`, drive letters, and sandbox escapes) must be enforced unconditionally.
- Clean-room verification in an isolated workspace remains the sole authoritative gate for benchmark repair success.

### 2.3 Strict Separation of Structural Validity from Semantic Progress
The runtime and evaluation frameworks shall formally treat schema compliance and task progress as orthogonal dimensions:
- **Structural Validity**: Certifies that an emitted proposal conforms to envelope and typing requirements (e.g., valid JSON, required keys present, no extraneous keys).
- **Semantic Progress**: Certifies that an action advances the agent toward task resolution (e.g., transitioning from code inspection to patch application).
No trial or component shall report progress or success based merely on generating valid proposals or successfully executing read-only tools.

### 2.4 Formal Classification of the Observation Loop Failure Mode
Emerald Agent Fabric formally distinguishes between two failure modes in autonomous execution:
1. **Syntax / Schema Rejection Loop**: The model repeatedly emits proposals that violate schema rules, triggering validator rejections until the rejection limit (`maxProposalRejections`) halts execution.
2. **Observation Stagnation Loop**: The model repeatedly emits schema-valid read proposals for previously observed data, making no state-modifying attempts until the step limit (`maxSteps`) halts execution.

Both modes result in task non-completion, but represent distinct underlying causes: syntax failure (addressed by grammar constraints) versus planning/reasoning stagnation (requiring state or prompt progression).

### 2.5 Mandatory Step Budgets and Fail-Closed Halts
To protect host resources and prevent unbounded execution in observation loops, the autonomous step loop must enforce strict, non-bypassable resource ceilings:
- Step limits (`maxSteps: 5` in pilot tasks) must trigger immediate halt with `terminalReason: "MAX_STEPS"`.
- Wall-clock budgets (`maxWallClockMs`) and per-step timeouts (`stepTimeoutMs: 120000`) must be strictly enforced.
- The runtime shall not grant automatic turn extensions or backoff loops to agents idling in observation loops.

### 2.6 Distinction Between Evidence Integrity and Benchmark Repair Success
An offline audit verdict of `status: "VERIFIED"` certifies strictly that:
- The evidence bundle is authentic, structurally intact, and uncorrupted.
- Authorized threshold keys (2-of-2 Ed25519) signed the payload.
- All recorded events conform to canonical hashing.

It does **not** certify that the bug was fixed. A task is successful **only** when clean-room verification passes (`fourfoldSatisfied: true`).

### 2.7 Boundaries for Future Repair-Loop Research
Any future modifications to address the observation loop must adhere to the following constraints:
1. **No Speculative Architecture**: Do not introduce multi-agent committees, unverified heuristic planners, or complex secondary reasoning engines.
2. **Read-Only Inspection First**: Code and context paths must be inspected before designing interventions.
3. **Local-First & Zero Cost**: All experiments must run locally under ₹0 budget without cloud dependencies.
4. **Offline Proof Before Live Trial**: Any proposed change must be validated by offline unit and regression tests before requesting authorization for a live inference trial.

---

## 3. Consequences

### Positive
- **Deterministic Token Masking**: Grammar constraints eliminate parameter hallucinations at the generation level, removing the need for fragile rejection-guidance heuristic tuning for basic schema compliance.
- **Clear Evaluation Taxonomy**: Distinguishing between syntax errors and observation loops enables precise measurement of where small models fail.
- **Architectural Safety**: Governance layers (`ProposalValidator`, `PolicyEvaluator`, `CleanRoomVerifier`) remain strictly intact and independent of model or provider mechanisms.

### Negative / Trade-offs
- **Grammar Compilation Overhead**: Local inference engines incur a modest initial compilation cost when compiling multi-branch `anyOf` JSON Schemas.
- **Exposed Reasoning Ceiling**: Eliminating syntax errors immediately reveals the planning and reasoning limitations of sub-2B models, which cannot be solved by schema constraints alone.

---

## 4. Revisit Conditions

This ADR may be revisited if:
1. Future benchmark evaluations on larger parameter models (e.g., `qwen2.5-coder:3b` or `7b`) demonstrate different transition dynamics between observation and editing under structured output.
2. An offline-verified task state progression interface is designed that reliably guides models from inspection to repair without weakening autonomy or governance.
3. Local inference runtimes introduce native multi-schema tool calling interfaces that supersede JSON Schema GBNF grammar translation.
