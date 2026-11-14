# Phase 44 — Empirical Research Report: Structured Output Enforcement and Observation Loop Dynamics

## Executive Summary

Phase 44 investigated whether enforcing grammar-constrained structured output via a multi-branch JSON Schema eliminates parameter-name hallucinations in local open-weight language models (`qwen2.5-coder:1.5b`), and whether resolving this structural failure enables the model to autonomously repair benchmark task `EAF-BM-01` (`src/calc.js` off-by-one arithmetic bug) under strict fail-closed governance.

The experimental campaign spanned four sequential sub-phases:
1. **Phase 44A (Offline Contract Proof)**: Authored and executed an offline contract test suite ([`tests/contract/action-proposal-schema-parity.test.ts`](../../tests/contract/action-proposal-schema-parity.test.ts)) with 27/27 tests passing, verifying mathematical parity between the candidate 7-branch discriminated-union JSON Schema and authoritative Zod domain schemas, and proving strict rejection of extraneous keys without live model inference.
2. **Phase 44B (Production Schema Promotion)**: Promoted the 7-branch [`ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA`](../../src/application/live-agent-brain.ts#L90-L250) into production runtime code without modifying authoritative validation or policy evaluation layers.
3. **Phase 44C (Single-Request Preflight)**: Executed exactly one governed live request against local Ollama (`qwen2.5-coder:1.5b`). The Ollama GBNF grammar compiler successfully compiled the schema with zero errors, and the model emitted valid JSON referencing `"path": "src/calc.js"` instead of `"filePath"` in 63,739 ms. Classification: `PREFLIGHT_PASS`.
4. **Phase 44D (Governed Multi-Step Repair Trial)**: Executed a single full repair trial (`maxSteps: 5`, `maxProposalRejections: 3`, timeout 120,000 ms/step) on `EAF-BM-01`. The model achieved 100% schema compliance and zero proposal rejections across all 5 steps. However, it proposed `read_file` on `src/calc.js` on every step, never transitioning to `write_file` or goal completion, and exhausted its step budget. Classification: `REPAIR_FAILED`.

---

## 1. Background & The Phase 43 Parameter Collapse

In Phase 43 (documented in [`docs/research/phase43-gate-b-empirical-research-report.md`](../../docs/research/phase43-gate-b-empirical-research-report.md) and [`docs/adr/ADR-0034-governed-rejection-feedback-and-local-model-recovery-boundaries.md`](../../docs/adr/ADR-0034-governed-rejection-feedback-and-local-model-recovery-boundaries.md)), autonomous repair trials of `EAF-BM-01` with `qwen2.5-coder:1.5b` encountered a persistent parameter-key divergence:
- On Step 1 (cold start), the model successfully proposed `read_file` with `{"path": "src/calc.js"}`.
- On Step 2 and subsequent steps, after observing file contents, the model repeatedly proposed `{"filePath": "src/calc.js"}`.
- Because the authoritative runtime Zod schema enforces `.strict()`, `ProposalValidator` rejected every proposal containing `"filePath"`.
- Progressive prompt-level interventions—unstructured rejection errors (Gate B.1), raw Zod syntax errors (Gate B.2), explicit system prompt instructions (Gate B.3), and field-level actionable guidance (`expected field "path"`) (Gate B.6)—failed to resolve the divergence. The model repeatedly edited string values rather than correcting the parameter key, reaching the 3-rejection ceiling.
- Concurrently, testing `qwen2.5-coder:3b` in Gate B.4 timed out after 120,386 ms on CPU, preventing proposal completion.

Phase 44 was initiated to test an architectural alternative: constraining generation at the grammar level using JSON Schema structured output rather than relying on prompt compliance.

---

## 2. Experimental Campaign: Phase 44A through 44D

### 2.1 Phase 44A — Minimal Offline Proof & Schema Parity
- **Objective**: Prove offline that a candidate discriminated-union JSON Schema exactly mirrors domain Zod ASTs and strictly excludes extraneous keys without modifying production source code or executing live inference.
- **Implementation**: Authored [`tests/contract/action-proposal-schema-parity.test.ts`](../../tests/contract/action-proposal-schema-parity.test.ts).
- **Results**:
  - 27/27 contract tests passed in 57 ms.
  - Verified 7 distinct branches: 1 goal-completion branch (`isGoalReached: true`) and 6 tool-invocation branches (`read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, `run_command`).
  - Proved all candidate tool payloads enforce `additionalProperties: false`.
  - Confirmed that hallucination traps (`filePath`, `text`, `pattern`) are strictly disallowed by the schema.
  - Proved dual-verification parity: proposals accepted by the candidate schema were accepted by `ProposalValidator`, and invalid proposals were rejected.

### 2.2 Phase 44B — Production Schema Promotion
- **Objective**: Promote the verified 7-branch schema into production runtime code while keeping authoritative validation and security policy completely unweakened.
- **Implementation**:
  - Replaced the generic `{ type: "object" }` `inputPayload` in [`src/application/live-agent-brain.ts`](../../src/application/live-agent-brain.ts) with the 7-branch discriminated-union schema.
  - Updated Test 43 in [`tests/application/live-agent-brain.test.ts`](../../tests/application/live-agent-brain.test.ts) to assert the 7 branches and tool-specific properties.
- **Verification**:
  - Contract suite: 27/27 passed.
  - Application suite: 76/76 passed.
  - Domain and adapter suites: 73 passed, 1 skipped.
  - Zero live inference, ₹0 cost, zero Git staged changes.

### 2.3 Phase 44C — Single-Request Live Preflight
- **Objective**: Test whether the local Ollama daemon (0.5.x) compiles the 7-branch JSON Schema via GBNF grammar without error or timeout, and whether `qwen2.5-coder:1.5b` emits `"path"` instead of `"filePath"` on `EAF-BM-01`.
- **Configuration**: `maxSteps: 1`, timeout: 120,000 ms, local Ollama at `http://127.0.0.1:11434`.
- **Results** (recorded in [`scratch/phase44c-preflight-results.json`](../../scratch/phase44c-preflight-results.json)):
  - **Classification**: `PREFLIGHT_PASS`.
  - Wall-clock time: 64,167 ms (model inference: 63,739 ms).
  - Tokens: 2,064 prompt tokens, 118 completion tokens (total: 2,182).
  - Raw Output:
    ```json
    {
      "isGoalReached": false,
      "proposalId": "action-1",
      "toolName": "read_file",
      "contextSnapshotHash": "1d19a0c5fcf06ae49e362a366d5c967fd84553a0846e70e656bd5d4f22a6f7a6",
      "inputPayload": {
        "path": "src/calc.js"
      }
    }
    ```
  - `ProposalValidator`: Accepted (`proposalValid: true`, 0 rejections).
  - Tool execution: Succeeded (`actionStatus: "SUCCEEDED"`).
  - Terminal status: `TIMED_OUT` (`terminalReason: "MAX_STEPS"`), as designed for a 1-step test.

### 2.4 Phase 44D — Governed Multi-Step Repair Trial
- **Objective**: Execute a single full multi-step repair trial to observe whether structured output enables end-to-end task repair on `EAF-BM-01`.
- **Configuration**:
  - Model: `qwen2.5-coder:1.5b` (digest: `d7372fd8...`).
  - Budget: `maxSteps: 5`, `maxProposalRejections: 3`, timeout: 120,000 ms/step.
  - Local Ollama only, ₹0 budget, isolated ephemeral benchmark workspace.
- **Results** (recorded in [`scratch/phase44d-repair-results.json`](../../scratch/phase44d-repair-results.json)):
  - **Classification**: `REPAIR_FAILED`.
  - Total wall-clock duration: 412,220 ms (~6 min 52 sec).
  - Model calls: 5. Model failures: 0.
  - Total tokens: 10,269 prompt + 652 completion = 10,921 tokens.
  - Step breakdown:
    - Step 1 (69,610 ms): Proposed `read_file` with `path: "src/calc.js"` → Accepted, Succeeded.
    - Step 2 (78,573 ms): Proposed `read_file` with `path: "src/calc.js"` → Accepted, Succeeded.
    - Step 3 (96,077 ms): Proposed `read_file` with `path: "src/calc.js"` → Accepted, Succeeded.
    - Step 4 (86,073 ms): Proposed `read_file` with `path: "src/calc.js"` → Accepted, Succeeded.
    - Step 5 (81,323 ms): Proposed `read_file` with `path: "src/calc.js"` → Accepted, Succeeded.
  - Proposal rejections: **0**.
  - Patch generation: **0 bytes** (`candidatePatchBytes: 0`, `candidatePatchHash: "none"`).
  - Target file modification: `src/calc.js` remained completely unmodified (`targetFileModified: false`).
  - Clean-room verification: Dual-gate verification remained `false` (not triggered because no patch or goal completion was submitted).
  - Terminal status: `TIMED_OUT` with `terminalReason: "MAX_STEPS"`.
  - Evidence & Audit: Signed evidence bundle `e76e7a44...` produced with 45 events and 2 dual Ed25519 signatures; offline audit status `VERIFIED` (`thresholdSatisfied: true`, `failures: []`).

---

## 3. Comparative Analysis: Phase 43 vs Phase 44

| Evaluation Dimension | Phase 43 Gate B (1.5B Trials) | Phase 44D (1.5B Trial) | Delta & Impact |
| :--- | :--- | :--- | :--- |
| **Output Constraint** | Unconstrained generation + Zod prompt instructions | 7-branch JSON Schema GBNF grammar | Grammar-enforced token masking |
| **Proposal Syntax Errors** | Repeated invalid `"filePath"` key | **0 syntax errors** | Complete elimination of parameter hallucination |
| **Proposal Rejections** | 3 of 3 proposals rejected (Gate B.1, B.2, B.3, B.6) | **0 of 5 proposals rejected** | Rejection rate dropped from 100% to 0% |
| **Accepted Proposals** | 1 (Step 1 cold start only) | **5 of 5 proposals accepted** | Multi-turn proposal generation unblocked |
| **Tool Execution Actions** | 1 successful read; halted by rejection ceiling | **5 successful reads** | Autonomous loop completed all allowed steps |
| **Model Request Timeouts** | 0 timeouts in 1.5B (3B timed out at 120s in B.4) | **0 timeouts** (all requests completed in 69s–96s) | Within 120s per-step budget |
| **Workspace Modifications** | 0 files modified (target file preserved) | 0 files modified (target file preserved) | Zero unauthorized mutations maintained |
| **Patch Generated** | No (0 bytes) | No (0 bytes) | No patch produced |
| **Clean-Room Verification** | Dual-gate: `false` | Dual-gate: `false` | Repair not achieved |
| **Terminal Reason** | `REJECTION_LIMIT_EXCEEDED` / `CONSECUTIVE_REJECTIONS` | `MAX_STEPS` | Shift from syntax failure to reasoning stagnation |
| **Final Classification** | `TRIAL_FAILED` / `RECOVERY_FAILED` | **`REPAIR_FAILED`** | Clean-room repair remained unachieved |
| **Evidence Bundle Status** | `VERIFIED` (dual-signed, `fourfoldSatisfied: false`) | **`VERIFIED`** (dual-signed, `fourfoldSatisfied: false`) | Full cryptographic auditability preserved |

---

## 4. Key Findings and Diagnostic Interpretations

### 4.1 Finding 1: Structured Output Eliminates Parameter-Name Hallucination
In all multi-turn Phase 43 trials, `qwen2.5-coder:1.5b` collapsed into proposing `"filePath"` once file contents were present in context. Under the Phase 44 7-branch schema, `"filePath"` was legally impossible for the tokenizer to emit because the grammar allowed only `"path"`, `"offsetLine"`, `"limitLines"`, and `"maxBytes"`. Across all 5 turns in Phase 44D, the model emitted strictly valid keys and passed `ProposalValidator` without a single rejection.

### 4.2 Finding 2: Structural Validity Does Not Imply Semantic Progress
While structured output completely guarantees that model output conforms to the type envelope and parameter constraints of the tool catalog, it exerts zero causal force on tool selection or task planning:
- The grammar permitted 7 valid branches: goal completion, `read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, and `run_command`.
- On every turn (Steps 1 through 5), the model selected `read_file` targeting `src/calc.js`.
- Having inspected the file in Step 1, the model did not synthesize a diagnosis, formulate an edit, or invoke `write_file`. Instead, it re-read the identical file four additional times.

### 4.3 Finding 3: Observation Loop as a Distinct Failure Mode
Phase 44D exposes a distinct failure mode in small local models:
- **Phase 43 Failure Mode (Syntax Rejection Loop)**: The model wants to proceed, but emits malformed keys, triggering runtime rejections until the rejection ceiling halts execution.
- **Phase 44 Failure Mode (Observation Stagnation Loop)**: The model emits strictly valid proposals, but repeatedly requests information it already possesses, exhausting its step budget without modifying the codebase.

---

## 5. Critical Distinctions and Guardrails

To prevent misinterpreting the empirical results, the following technical distinctions must be maintained:

1. **Schema Validity vs. Semantic Correctness**:
   Generating valid JSON that matches the action proposal schema is a transport-level achievement. It proves the model can adhere to grammatical constraints, not that it understands the code, diagnoses bugs, or plans solutions.
2. **Successful Tool Execution vs. Benchmark Task Success**:
   Executing five successful `read_file` operations demonstrates that `WorkerRuntime`, permissions, path containment, and adapters function correctly. It does not mean the agent made progress toward fixing the defect.
3. **Evidence Integrity vs. Task Correctness**:
   The offline auditor's `VERIFIED` status certifies that the evidence bundle has not been tampered with, all event hashes match, and authorized keys signed the bundle. It does not certify that the code was repaired. The evidence bundle accurately recorded `fourfoldSatisfied: false`.
4. **Per-Request Timeout vs. Maximum Step Exhaustion**:
   The terminal status `TIMED_OUT` with `terminalReason: "MAX_STEPS"` indicates that the 5-step budget was exhausted. Zero model requests timed out; all 5 inference calls completed between 69.5s and 95.9s, well within the 120,000 ms budget.
5. **Observed Run Scope vs. Universal Model Capability**:
   Phase 44D demonstrated that `qwen2.5-coder:1.5b` failed to transition from reading to writing within this specific five-step run on `EAF-BM-01` under the given prompts. This finding does not establish that the model is universally incapable of repair under all prompt structures, scratchpad designs, or task contexts.

---

## 6. Limitations & Alternative Explanations

The observed observation loop may be influenced by several interacting factors:
1. **Lack of State Progression Guidance**: The runtime prompt provided the task description and tool catalog, but did not explicitly prompt the model regarding state progression (e.g., "You have already read `src/calc.js`. Propose `write_file` to fix the defect or `run_command` to test").
2. **Context Accumulation Format**: In multi-turn context, previous observations show the file contents, but the model may lack the internal reasoning depth at 1.5B parameters to deduce that re-reading provides zero new entropy.
3. **Parameter Scale Boundaries**: Sub-2B parameter models have constrained reasoning capacity. While grammar constraints prevent them from generating invalid tokens, they do not enhance logical deduction or planning horizons.

---

## 7. Next Research Direction

With structural parameter hallucinations resolved by structured output, research must focus on the reasoning and planning transition:
- Investigate the context engine and prompt state representation read-only.
- Determine whether providing structured turn progression (e.g., tracking inspected files in context) enables small models to advance from observation to action.
- Evaluate whether larger parameter scales (e.g., `qwen2.5-coder:3b` under relaxed timeouts or hardware acceleration) exhibit the same observation loop or naturally progress to patch authoring.
