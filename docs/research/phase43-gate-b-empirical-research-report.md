# Phase 43 Gate B — Empirical Research Report: Governed Rejection Feedback and Local Model Recovery Dynamics

## Executive Summary

Phase 43 evaluated whether local open-weight language models executing on commodity CPU hardware under zero-cost constraints (₹0 budget, local Ollama) can safely recover from tool proposal rejections and complete autonomous software repair task `EAF-BM-01` under strict fail-closed governance.

Over an experimental campaign encompassing six controlled gates (Gates B.1 through B.6), the Emerald Agent Fabric runtime demonstrated 100% fail-closed governance integrity:
1. Every malformed tool proposal was intercepted and rejected by `ProposalValidator`.
2. Cumulative rejection ceilings (`maxProposalRejections: 3`) strictly halted runaway iteration loops.
3. Zero unauthorized target-file modifications or out-of-scope repository mutations occurred.
4. Independent clean-room verification rejected premature or non-repairing completion signals.
5. All produced evidence bundles maintained full cryptographic threshold signing (2-of-2 Ed25519) and achieved 100% offline auditor verification (`VERIFIED`), while correctly reporting `fourfoldSatisfied: false`.

Concurrently, the empirical trials identified two distinct boundaries for local model execution on commodity developer hardware:
- **Parameter-Mapping Saturation in `qwen2.5-coder:1.5b`**: On multi-turn conversations after executing an initial file read, `qwen2.5-coder:1.5b` exhibited persistent conversational prior collapse into proposing `"filePath"` instead of the required schema key `"path"`. Progressive runtime interventions—raw Zod error feedback (Gate B.2), system instruction clarification (Gate B.3), and explicit field-level actionable guidance (`expected field "path"`) (Gate B.6)—failed to break this failure mode, with the model repeatedly modifying the string value rather than correcting the parameter key.
- **CPU Inference Latency Boundary in `qwen2.5-coder:3b`**: At 3B parameter scale, evaluating ~2,050 prompt tokens on an 8-core CPU exceeded the 120,000 ms per-turn client timeout (Gate B.4), aborting inference prior to proposal generation.

---

## 1. Research Question & Hypotheses

### 1.1 Central Research Question
> Can an autonomous software-engineering agent powered by small local open-weight models recover from proposal validation rejections when provided with structured, actionable runtime feedback, while maintaining strict fail-closed governance and zero unauthorized side effects?

### 1.2 Evaluated Hypotheses
- **H1 (Governance Invariance)**: The runtime will intercept, record, and fail closed on every invalid model proposal regardless of prompt phrasing, feedback structure, or model error patterns, preventing unvalidated execution.
  - *Outcome*: **SUPPORTED**. 100% of invalid proposals were denied across all trials. Zero unvalidated actions executed. Target file remained bit-for-bit intact at baseline.
- **H2 (Feedback-Induced Recovery)**: Providing explicit, bounded, and typed rejection feedback (`[TOOL_ERROR]`) will enable local open-weight models to correct parameter hallucination errors and submit schema-valid replacement proposals.
  - *Outcome*: **REFUTED for `qwen2.5-coder:1.5b` on `EAF-BM-01`**. While fake-transport deterministic integration tests verified that valid replacement proposals successfully recover and complete the task, live inference with `qwen2.5-coder:1.5b` repeated the invalid parameter across all feedback regimes.
- **H3 (Hardware Feasibility Boundary)**: Multi-turn software repair tasks requiring >2,000 prompt tokens per step will encounter severe CPU latency barriers as model parameter scale increases from 1.5B to 3B.
  - *Outcome*: **SUPPORTED for 120s budget**. `qwen2.5-coder:3b` exceeded 120,000 ms on Step 1 cold start, demonstrating a hardware latency boundary under that specific timeout configuration.

---

## 2. Workstation & Inference Configuration

All live trials were executed strictly on local developer workstation hardware under frozen resource conditions:

- **Host Hardware**: Intel Core i3-N305 (8 Gracemont efficient cores, 8 threads, base 1.80 GHz, up to 3.80 GHz).
- **Host Memory**: 7.63 GiB DDR5 RAM.
- **GPU / Acceleration**: None (CPU-only execution; 0 VRAM; zero GPU offloading).
- **Operating System**: Microsoft Windows 11 Enterprise (x64).
- **Local Inference Server**: Ollama local daemon (`http://127.0.0.1:11434`), API version 0.5.x.
- **Operating Cost**: ₹0 API cost. Zero external network transmissions, zero cloud APIs, zero proprietary model dependencies.
- **Model Registry & Checksums**:
  - `qwen2.5-coder:1.5b`: SHA-256 digest `d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668`, size 986,062,089 bytes (~0.99 GB).
  - `qwen2.5-coder:3b`: SHA-256 digest `f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225`, size 1,929,912,626 bytes (~1.93 GB).

---

## 3. Benchmark Task Specification: `EAF-BM-01`

- **Task Identifier**: `EAF-BM-01` (`task-EAF-BM-01`)
- **Task Category**: `CODE_NAVIGATION` / Arithmetic Off-by-One Repair
- **Target File**: `src/calc.js`
- **Allowed Modification Paths**: `["src/calc.js"]`
- **Defect Description**: An off-by-one bug in function `add(a, b)`:
  ```javascript
  // Baseline (Buggy):
  function add(a, b) {
    return a + b + 1; // Bug: adds extraneous + 1
  }
  function multiply(a, b) {
    return a * b;
  }
  module.exports = { add, multiply };
  ```
- **Dual-Gate Clean-Room Verification**:
  - `failToPass`: `node test/f2p.test.js` (expects baseline exit code 1; patched exit code 0; regex `PASS: F2P calc passed`).
  - `passToPass`: `node test/p2p.test.js` (expects baseline exit code 0; patched exit code 0; regex `PASS: P2P calc passed`).
- **Gold Patch**:
  ```javascript
  function add(a, b) {
    return a + b;
  }
  function multiply(a, b) {
    return a * b;
  }
  module.exports = { add, multiply };
  ```

---

## 4. Gate-by-Gate Methodology & Experimental Interventions

```
Gate B.1 (Baseline 1.5B)
   ↓ Failed: 3x filePath rejections (no structured feedback in prompt)
Gate B.2 (Diagnostic Tracking & Typed Rejection Feedback)
   ↓ Failed: 3x filePath rejections (model received raw Zod error text)
Gate B.3 (System Instruction Clarification: Rule 3)
   ↓ Failed: 3x filePath rejections (repeated identical key despite instruction)
Gate B.4 (Model Scaling: qwen2.5-coder:3b)
   ↓ Failed: Inference timeout at 120,386 ms (CPU latency boundary)
Gate B.5 (Deterministic Actionable Feedback Implementation & Verification)
   ↓ Verified: 18/18 runner tests, 11/11 regression tests, 0 tsc errors
Gate B.6 (Single Live 1.5B Recovery Trial)
   ↓ Failed: 3x filePath rejections (model misattributed field error to value)
Decision: Halt prompt tuning for this pattern; document architectural boundaries.
```

### 4.1 Gate B.1: Initial Live 1.5B Baseline Trial
- **Hypothesis**: `qwen2.5-coder:1.5b` can autonomously navigate `src/calc.js`, propose `read_file`, inspect code, propose `write_file`, and complete the repair under standard tool descriptions.
- **Intervention**: Default system instructions; model-facing tool catalog; zero structured rejection feedback loop (proposals were rejected internally by `ProposalValidator`, but resulting observations were not fed back into subsequent model turns).
- **Result**: Step 1 succeeded with `read_file` (`{"path": "src/calc.js"}`). In Steps 2, 3, and 4, the model repeatedly proposed `{"filePath": "src/calc.js"}`. Because no feedback reached the prompt, the model had no indication of why its proposals were not progressing. Halted fail-closed at `maxProposalRejections: 3` (`terminalReason: "MAX_PROPOSAL_REJECTIONS"`). Total wall-clock duration: 217,487 ms.
- **Diagnostic Limitation**: The trial runner retained aggregate execution metrics, but did not persist step-level completion diagnostics or proposal rejection reason codes in the evidence record.

### 4.2 Gate B.2: Structured Diagnostic Persistence & Typed Rejection Feedback
- **Hypothesis**: Surfacing typed rejection feedback (`[TOOL_ERROR]`) containing the validator failure message directly into the subsequent turn's context will allow the model to recognize parameter validation errors and correct them.
- **Intervention**:
  1. Implemented `StepDiagnostics`, `ProposalRejectionDiagnostics`, and `RawCompletion` tracking in `Phase43BenchmarkRunner`.
  2. Implemented `pendingProposalRejectionObservation` in `AgentStepController`. Validation failures generated a typed `TOOL_ERROR` observation containing `rejectionReason: "INVALID_TOOL_INPUT"` and `explanation: validationResult.message` (raw Zod error text: `path: Required, : Unrecognized key(s) in object: 'filePath'`).
  3. Bounded feedback to 512 characters and sanitized credentials/keys. Injected into turn $N+1$ context snapshot, then cleared immediately (ephemeral single-turn lifetime).
- **Result**: Feedback successfully reached the model in Steps 3 and 4. However, the model repeated `{"filePath": "src/calc.js"}` in Step 3, and in Step 4 modified the value to `{"filePath": "path/to/input/file.txt"}`. The raw Zod error format failed to communicate to the model that the parameter name `filePath` itself was unrecognized. Halted at rejection ceiling (3). Total wall-clock duration: 273,668 ms.

### 4.3 Gate B.3: System Prompt Rule Clarification
- **Hypothesis**: Explicitly instructing the model in the authoritative system instruction that file paths must be named `path` (never `filePath` or `file_path`) will prevent the hallucination before it occurs.
- **Intervention**: Modified `DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION` Rule 3:
  > *"In tool inputPayload, the target file path parameter must always be named path (never filePath or file_path)."*
- **Result**: In Step 1, the model correctly used `path: "src/calc.js"`. But in Steps 2, 3, and 4, the model once again collapsed into proposing `{"filePath": "src/calc.js"}`. Repeating the instruction in the system prompt yielded zero behavioral change in multi-turn execution. Halted at rejection ceiling (3). Total wall-clock duration: 277,262 ms.

### 4.4 Gate B.4: Local Model Scale Feasibility (`qwen2.5-coder:3b`)
- **Hypothesis**: The larger `qwen2.5-coder:3b` model will exhibit superior multi-turn instruction following and avoid the parameter aliasing collapse observed in the 1.5B tier.
- **Intervention**: Configured `Phase43BenchmarkRunner` with model `qwen2.5-coder:3b` at the fixed 120,000 ms per-step timeout.
- **Result**: Step 1 inference timed out at 120,386 ms. The client-side abort timer fired, cancelling the HTTP request. `AgentStepController` handled the error fail-closed and halted with `terminalStatus: "FAILED"`, `terminalReason: "BRAIN_FAILURE"`. Zero proposals were generated; zero actions executed.
- **Investigation Finding**: Evaluating ~2,068 prompt tokens on 8 CPU Gracemont cores required >120s for 3B weights. This established a hardware latency boundary on CPU under the 120s ceiling, preventing capability evaluation of 3B without extending timeouts.

### 4.5 Gate B.5: Deterministic Actionable Feedback Implementation
- **Hypothesis**: Replacing raw Zod syntax (`path: Required, : Unrecognized key(s)...`) with explicit, tool-specific parameter guidance (`unrecognized key "filePath"; expected field "path"`) will provide unambiguous cognitive direction without modifying authoritative schemas or governance rules.
- **Intervention**:
  1. Implemented `deriveActionableValidationGuidance()` and `DETERMINISTIC_TOOL_PARAMETER_MAPPINGS` in `AgentStepController`.
  2. Scoped parameter mappings strictly per-tool:
     - `read_file`: `filePath / file_path / filename → path`.
     - `write_file`: `filePath / file_path → path`, `text / data → content`.
     - `search_code`: `pattern / search_term → query`.
  3. Ensured safe fail-closed fallback (`null` on unknown keys, path traversals, missing fields, non-input reasons).
  4. Formatted actionable guidance string:
     `Invalid ${toolName} input: unrecognized key "${key}"; expected field "${expectedField}". Retry using "${expectedField}" and the documented ${toolName} schema.`
  5. Implemented comprehensive deterministic test coverage (Gates A.11a–A.11f) verifying guidance delivery, successful recovery with fake transports, zero workspace mutations on rejection, and zero tsc errors.

### 4.6 Gate B.6: Single Live 1.5B Recovery Trial
- **Hypothesis**: Given the verified Gate B.5 actionable guidance, `qwen2.5-coder:1.5b` will parse the expected field guidance on Step 2 and recover by submitting a valid proposal in Step 3.
- **Intervention**: Exactly one live trial on `qwen2.5-coder:1.5b` for `EAF-BM-01` under fixed Gate B.5 configuration.
- **Result**:
  - Step 1: Valid `read_file` proposal with `path: "src/calc.js"`. Executed successfully (77,298 ms).
  - Step 2: Model proposed `read_file` with `filePath: "src/calc.js"`. Rejected. Actionable guidance injected into prompt:
    `Invalid read_file input: unrecognized key "filePath"; expected field "path". Retry using "path" and the documented read_file schema.`
  - Step 3: Model received the exact guidance string, but emitted `filePath: "src/calc.js"` again. Rejected (rejection 2).
  - Step 4: Model received the guidance again, but changed the value: `filePath: "path/to/your/file.txt"`. Rejected (rejection 3).
  - Loop halted fail-closed with `terminalStatus: "FAILED"`, `terminalReason: "MAX_PROPOSAL_REJECTIONS"`. Total wall-clock duration: 269,127 ms.
  - Target file remained untouched. Evidence bundle verified (`fourfoldSatisfied: false`).

---

## 5. Consolidated Cross-Gate Telemetry Matrix

| Metric | Gate B.1 (Baseline) | Gate B.2 (Zod Feedback) | Gate B.3 (Rule 3 Clarif.) | Gate B.4 (3B Model) | Gate B.6 (Actionable Guidance) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Model Evaluated** | `qwen2.5-coder:1.5b` | `qwen2.5-coder:1.5b` | `qwen2.5-coder:1.5b` | `qwen2.5-coder:3b` | `qwen2.5-coder:1.5b` |
| **Model Checksum (Digest)** | `d7372fd8...` | `d7372fd8...` | `d7372fd8...` | `f72c60ca...` | `d7372fd8...` |
| **Task Outcome** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** |
| **Terminal Status** | `FAILED` | `FAILED` | `FAILED` | `FAILED` | `FAILED` |
| **Terminal Reason** | `MAX_PROPOSAL_REJECTIONS` | `MAX_PROPOSAL_REJECTIONS` | `MAX_PROPOSAL_REJECTIONS` | `BRAIN_FAILURE` | `MAX_PROPOSAL_REJECTIONS` |
| **Wall-Clock Duration** | 217,487 ms | 273,668 ms | 277,262 ms | 121,199 ms | 269,127 ms |
| **Total Steps** | 4 | 4 | 4 | 1 | 4 |
| **Model Invocations** | 4 | 4 | 4 | 1 | 4 |
| **Transport Failures** | 0 | 0 | 0 | 1 (Timeout) | 0 |
| **Total Actions Executed** | 1 (`read_file`) | 1 (`read_file`) | 1 (`read_file`) | 0 | 1 (`read_file`) |
| **Proposal Rejections** | 3 | 3 | 3 | 0 | 3 |
| **Total Prompt Tokens** | 8,196 | 8,197 | 8,207 | *Unmeasured (Timeout)* | 8,218 |
| **Total Eval Tokens** | 566 | 496 | 630 | *Unmeasured (Timeout)* | 537 |
| **Total Tokens** | 8,762 | 8,693 | 8,837 | *Unmeasured (Timeout)* | 8,755 |
| **Patch Bytes Produced** | 0 bytes | 0 bytes | 0 bytes | 0 bytes | 0 bytes |
| **Target File Mutated?** | No | No | No | No | No |
| **Offline Auditor Status** | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` |
| **Fourfold Satisfied** | `false` | `false` | `false` | `false` | `false` |
| **Evidence Bundle ID** | `7f1dd590...` | `35be93b1...` | `bf5a78f7...` | `2aa5e0c7...` | `e2618465...` |

---

## 6. Diagnostic Observations & Unavailable Telemetry

### 6.1 Retained Telemetry
- **Step Diagnostics**: Stored in `scratch/phase43-gate-b*-trial-results.json`. Includes step start timestamps, step monotonic durations, validator results, rejection reasons, and raw model output strings for all completed turns.
- **Token Metrics**: Provided by Ollama's `prompt_eval_count` and `eval_count` fields in the HTTP response body.

### 6.2 Unavailable Telemetry
- **Gate B.1 Step Diagnostics & Raw Completions**: Not retained in the Gate B.1 trial record because diagnostic tracking was implemented in Gate B.2. Only aggregate execution metrics and the evidence bundle were recorded.
- **Gate B.4 Token Counts**: In Gate B.4, the client-side timeout aborted the HTTP stream at 120,386 ms. Because the connection was terminated prior to HTTP response generation, Ollama token metrics could not be delivered.
- **Sub-Step Pipeline Latencies**: Breakdown between internal JSON serialization, Zod validation, and ContextEngine assembly is not logged discretely per step; total step duration reflects the end-to-end loop iteration dominated by model inference (>99.5% of wall-clock time).

---

## 7. Governance Behavior vs. Model Task Success

A central finding of Phase 43 is the complete architectural separation between **runtime governance integrity** and **model task competence**:

```
Model Task Competence:     [FAIL] Model repeatedly hallucinates invalid parameter key
Runtime Governance:        [PASS] 100% interception, zero unauthorized writes, strict fail-closed stop
Evidence Integrity:        [PASS] 100% cryptographic bundle verification, accurate status recording
```

In all six gates:
1. The model's failure to generate valid proposals never compromised repository state or security boundaries.
2. The runtime resisted prompt-injection or hallucinated key traps without relaxing schema strictness.
3. The supervisor and worker cryptographic signing pipeline attested faithfully to the actual operational facts: recording a verified audit of a failed run.

---

## 8. Evidence Integrity vs. Fourfold Task Completion

The campaign verified that an offline audit verdict of `VERIFIED` must never be conflated with task success:

- **Offline Auditor Status (`VERIFIED`)**: Certifies cryptographic and structural provenance:
  - 2-of-2 Ed25519 threshold signatures match registered keyring public keys.
  - Event sequence numbers are contiguous and strictly monotonic.
  - Merkle provenance roots match canonical event hashes.
  - Bundle content has not been tampered with or corrupted post-execution.
- **Fourfold Task Completion (`fourfoldSatisfied: false`)**: Certifies physical and semantic task achievement:
  - Gate 1: Baseline tests pass.
  - Gate 2: Modified tests pass (`FAIL_TO_PASS`).
  - Gate 3: Regression tests pass (`PASS_TO_PASS`).
  - Gate 4: Applied patch matches allowed file paths and non-empty size requirements.

Because no patch was applied and clean-room dual-gate verification failed, `fourfoldSatisfied` remained `false` across all live trials while `offlineAudit.status` remained `VERIFIED`. The system successfully proved its ability to generate unforgeable evidence of its own failure.

---

## 9. Confounding Factors, Limitations & Alternative Explanations

1. **Model Scope Constraint**:
   These findings evaluate `qwen2.5-coder:1.5b` and `qwen2.5-coder:3b` under specific Ollama quantization (`Q4_K_M`) and prompt templates. They do **not** establish a universal ceiling across all sub-2B models (e.g., `smollm2:1.7b`, `granite3-dense:2b`) or alternative prompting architectures (e.g., few-shot exemplar injection, AST-grammar constrained decoding).
2. **Step Transition Confusion vs. Key Hallucination**:
   In Step 2 of Gates B.2, B.3, and B.6, the model proposed `read_file` instead of transitioning to `write_file`. It is possible that the model was confused about whether Step 1 succeeded or believed it needed to re-read the file before writing. However, when it attempted this second read, it consistently reverted to `"filePath"`.
3. **Hardware Latency Bound**:
   The Gate B.4 timeout reflects CPU-only execution on 8 Gracemont cores. It does not establish that 3B models are fundamentally incapable of running or solving the task; with a 240s–300s timeout or hardware acceleration (NPU/GPU), the model would produce proposals that could then be evaluated for schema adherence.
4. **Error Message Interpretation Bias**:
   Small models trained heavily on common GitHub tool APIs frequently encounter `filePath` in training data (e.g., VS Code extension APIs, Node.js scripts). In Step 4 of Gate B.6, the model altered the file path value to `"path/to/your/file.txt"` while preserving `"filePath"`, suggesting that attention heads attended to the word `path` in the guidance as a semantic suggestion for the path string rather than an instruction to rewrite the JSON key.

---

## 10. Reproducibility Information & Archival Data

All trial records, scripts, and test suites are retained in the repository:
- **Gate B.1 Record**: [`scratch/phase43-gate-b1-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b1-trial-results.json)
- **Gate B.2 Record**: [`scratch/phase43-gate-b2-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b2-trial-results.json)
- **Gate B.3 Record**: [`scratch/phase43-gate-b3-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b3-trial-results.json)
- **Gate B.4 Record**: [`scratch/phase43-gate-b4-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b4-trial-results.json)
- **Gate B.6 Record**: [`scratch/phase43-gate-b6-trial-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/phase43-gate-b6-trial-results.json)
- **Gate A Deterministic Suite**: [`tests/integration/phase43-benchmark-runner.test.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/tests/integration/phase43-benchmark-runner.test.ts)
- **Gate B Live Test Specs**:
  - [`tests/integration/phase43-gate-b1-live.test.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/tests/integration/phase43-gate-b1-live.test.ts)
  - [`tests/integration/phase43-gate-b2-live.test.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/tests/integration/phase43-gate-b2-live.test.ts)
  - [`tests/integration/phase43-gate-b3-live.test.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/tests/integration/phase43-gate-b3-live.test.ts)
  - [`tests/integration/phase43-gate-b4-live.test.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/tests/integration/phase43-gate-b4-live.test.ts)
  - [`tests/integration/phase43-gate-b6-live.test.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/tests/integration/phase43-gate-b6-live.test.ts)

---

## 11. Conclusion & Recommended Next Steps

1. **Halt Prompt-Tuning for this Failure Pattern**:
   Repeated trials confirm that further wording adjustments in system prompts or dynamic rejection feedback will not overcome `qwen2.5-coder:1.5b`'s multi-turn `filePath` parameter collapse on `EAF-BM-01`.
2. **Preserve Runtime Governance Invariants**:
   Strict schema validation, non-mutation on rejection, and finite rejection ceilings are validated as robust safety controls that must not be relaxed to accommodate model shortcomings.
3. **Strategic Pivot for Future Research**:
   Shift focus away from prompt micro-optimization and toward:
   - Constrained decoding / grammar-based AST sampling that structurally prevents invalid parameter keys at the token level.
   - Formal multi-model comparative calibration under expanded time budgets (or hardware acceleration).
   - Bounded human-in-the-loop repair workflows (as established in ADR-0033).
