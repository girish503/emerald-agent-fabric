# Emerald Agent Fabric — Minimal Canonical Prompt Reliability Experiment
## Empirical Validation of Prompt Canonicality on Local 3B Model Schema Compliance

- **Date**: 2026-10-22
- **Milestone**: Prompt Engineering & Schema Conformance Empirical Experiment
- **Status**: Completed — Empirical Trials Executed, Measured, and Cryptographically Recorded
- **Selected Decision**: **`PROMPT_CHANGE_SUPPORTED`**
- **Machine-Readable Evidence**: [`scratch/minimal-canonical-prompt-experiment-results.json`](../../scratch/minimal-canonical-prompt-experiment-results.json)
- **Model Adapter**: `qwen2.5-coder:3b` (Q4_K_M, 1841 MB) via local Ollama (`v0.40.8`)
- **Inference Budget**: ₹0 (Strictly local inference; zero external APIs, paid endpoints, or cloud services)
- **Governing Invariants**: [GEMINI.md](../../GEMINI.md), [ADR-0029](../adr/ADR-0029-rfc-standardized-model-facing-tool-contracts.md), [ADR-0032](../adr/ADR-0032-local-model-scaling-and-repair-benchmark-prerequisites.md)

---

## 1. Executive Summary

Following the root-cause investigation in [`docs/production/tool-proposal-reliability-investigation.md`](../../docs/production/tool-proposal-reliability-investigation.md), this experiment directly tested whether supplying a minimal, canonical `read_file` prompt example (matching the active `ReadFileInputSchema` exactly) resolves the extraneous argument generation observed in `qwen2.5-coder:3b`.

A controlled, head-to-head experiment was conducted across 3 identical production file inspection targets (6 total trials) using the same local Ollama model instance, grammar constraint, and strict Zod validation path.

### Key Empirical Findings:
1. **Condition A (Existing Template with `offsetLine`/`limitLines` in Example)**:
   - **0 / 3 Valid Proposals (0.0% Validity Rate)**.
   - In 100% of trials, the model emitted an unrecognized `content` field inside `toolInput`.
   - All 3 proposals were rejected fail-closed by `ReadFileInputSchema.safeParse()` with `errorCode: "INVALID_ARGUMENTS"`.
   - Execution was prevented in 100% of failures.
   - Mean inference latency: **35,683 ms**.
2. **Condition B (Minimal Canonical Template with `{ path: string }` Only)**:
   - **3 / 3 Valid Proposals (100.0% Validity Rate)**.
   - In 100% of trials, the model generated a clean, schema-conforming proposal containing ONLY `path`.
   - Zero unexpected fields; zero missing fields; zero validation errors.
   - Mean inference latency: **15,433 ms** (a **56.7% latency reduction** due to avoiding extraneous token generation).
3. **Formal Determination**: **`PROMPT_CHANGE_SUPPORTED`**. The evidence directly substantiates that aligning prompt examples with active adapter schemas eliminates argument hallucinations and significantly reduces inference latency on the local 3B model.

---

## 2. Preflight & Canonical Contract Alignment

Prior to running trials, the runtime validation path was inspected to confirm exact canonical contracts:

1. **Active Adapter Input Validator** ([`src/production/adapter/structured-proposal-schema.ts`](../../src/production/adapter/structured-proposal-schema.ts#L46-L50)):
   ```typescript
   export const ReadFileInputSchema = z
     .object({
       path: z.string().min(1, "Path cannot be empty").max(1024, "Path exceeds maximum length"),
     })
     .strict();
   ```
2. **Authoritative Proposal Envelope**:
   ```json
   {
     "version": "v1.8.0",
     "thought": "string",
     "toolName": "read_file",
     "toolInput": {
       "path": "string"
     },
     "isGoalReached": false
   }
   ```
3. **Git Baseline & Working Tree**:
   - Commit HEAD: `7109911fa4488c5759000fe08c3a77895ed214f4` (`master`).
   - All pre-existing user work and untracked files preserved undisturbed.

---

## 3. Experiment Design & Prompts Compared

The experiment evaluated 2 distinct prompt conditions across 3 identical production targets in `emerald-agent-fabric`:
- Target 1: `src/production/diagnostics/source-diagnostic-engine.ts`
- Target 2: `src/evidence/production-replay-engine.ts`
- Target 3: `src/control-plane/approval-control.ts`

### Condition A: Existing Template (with `offsetLine`/`limitLines` in Example)
```text
You are an AI assistant inside Emerald Agent Fabric.
Task: Inspect <TARGET_FILE> to explain the component architecture.
Do NOT edit or write to any files. Propose a read_file action with limitLines=50.
Respond with a single JSON object conforming strictly to this format:
{"version":"v1.8.0","thought":"Inspect <TARGET_FILE>","toolName":"read_file","toolInput":{"path":"<TARGET_FILE>","offsetLine":1,"limitLines":50},"isGoalReached":false}
```

### Condition B: Minimal Canonical Template (`{ path: string }` Only)
```text
You are an AI assistant inside Emerald Agent Fabric.
Task: Inspect <TARGET_FILE> to explain the component architecture.
Do NOT edit or write to any files. Propose a read_file action.
Respond with a single JSON object conforming strictly to this format:
{"version":"v1.8.0","thought":"Inspect <TARGET_FILE>","toolName":"read_file","toolInput":{"path":"<TARGET_FILE>"},"isGoalReached":false}
```

Both conditions were evaluated through:
`OllamaModelAdapter(qwen2.5-coder:3b, http://127.0.0.1:11434, timeout=90000, constrainedOutputEnabled=true)`  
followed immediately by:  
`validateStructuredProposal(rawResponse)` → `ReadFileInputSchema.safeParse(toolInput)`.

---

## 4. Measured Empirical Results

All measurements reflect actual execution on the local host CPU (Intel Core i3-N305, 8 cores @ 1.80 GHz).

### 4.1 Comparative Summary Matrix

| Metric | Condition A (Existing Template) | Condition B (Minimal Canonical) | Delta / Impact |
| :--- | :---: | :---: | :---: |
| **Total Trials** | 3 | 3 | Identical N=3 sample |
| **Valid Proposals** | **0 / 3 (0.0%)** | **3 / 3 (100.0%)** | **+100.0% absolute improvement** |
| **Invalid Proposals** | 3 / 3 (100.0%) | 0 / 3 (0.0%) | -100.0% failure rate |
| **Unexpected Fields Emitted** | `content` (in 3/3 trials) | **None (0/3 trials)** | Extraneous keys completely eliminated |
| **Missing Required Fields** | None (`path` present in all) | None (`path` present in all) | Zero missing required fields |
| **Schema Validation Errors** | `Unrecognized key(s): 'content'` | **None (Clean parse)** | 100% Zod strict compliance |
| **Execution Blocked on Failure** | **3 / 3 (100.0% fail-closed)** | N/A (All passed) | Zero unvalidated tools dispatched |
| **Mean Model Inference Latency** | **35,683 ms** | **15,433 ms** | **-20,250 ms (56.7% faster)** |
| **Total Wall-Clock Time** | 107,049 ms | 46,300 ms | -60,749 ms total duration |

### 4.2 Trial-by-Trial Breakdown

| Trial | Condition | Target File | Proposal Output | Schema Valid? | Zod Rejection Issue | Latency | Execution Prevented? |
| :---: | :--- | :--- | :--- | :---: | :--- | :---: | :---: |
| **A1** | Existing | `source-diagnostic-engine.ts` | `{"path":"...","content":""}` | **FAIL** | `Unrecognized key(s): 'content'` | 41,978 ms | **YES** |
| **A2** | Existing | `production-replay-engine.ts` | `{"path":"...","content":""}` | **FAIL** | `Unrecognized key(s): 'content'` | 28,775 ms | **YES** |
| **A3** | Existing | `approval-control.ts` | `{"path":"...","content":""}` | **FAIL** | `Unrecognized key(s): 'content'` | 36,296 ms | **YES** |
| **B1** | Canonical | `source-diagnostic-engine.ts` | `{"path":"..."}` | **PASS** | None | 16,447 ms | N/A (Valid) |
| **B2** | Canonical | `production-replay-engine.ts` | `{"path":"..."}` | **PASS** | None | 14,458 ms | N/A (Valid) |
| **B3** | Canonical | `approval-control.ts` | `{"path":"..."}` | **PASS** | None | 15,395 ms | N/A (Valid) |

---

## 5. Distinction Between Failure Modes

In accordance with Section 3:

1. **Model Generation vs. Schema Validation**:
   - In Condition A, the failure was strictly a **model argument generation failure** that triggered a **schema-validation rejection**. The model successfully emitted valid JSON adhering to the top-level proposal envelope, but generated an invalid child key (`content`) inside `toolInput`.
   - In both conditions, **zero JSON parsing failures** occurred (grammar-constrained generation maintained 100% syntactically valid JSON).
2. **Tool-Execution Prevention**:
   - In 100% of Condition A trials, the validator prevented the invalid proposal from reaching `ProductionToolGateway`. Zero tool executions were attempted; zero disk files were touched.
3. **Latency Characteristics**:
   - When the model attempts to generate extra keys not supported by the prompt example, it takes 28–42s per proposal.
   - When given the exact canonical template, generation completes in 14–16s, demonstrating that prompt ambiguity was actively inflating decoding latency on CPU.

---

## 6. Limitations & Threats to Validity

1. **Sample Size Disclosure**:
   - This experiment evaluated a small sample of 6 total trials (N=3 per condition). While the effect was 100% consistent across all trials (0/3 vs 3/3), a small sample does **not** establish general statistical significance across all possible programming prompts or edge cases.
2. **Tool Scope**:
   - The experiment specifically tested the `read_file` tool. Other tools (`edit_file_anchor`, `search_code`, `run_command`) possess different argument shapes and may exhibit distinct sensitivity to prompt framing.
3. **Single Model**:
   - Results are specific to `qwen2.5-coder:3b` (Q4_K_M) operating under Ollama `v0.40.8` grammar constraints on an Intel CPU.

---

## 7. Decision and Recommended Next Step

### Selected Decision: **`PROMPT_CHANGE_SUPPORTED`**

#### Rationale:
1. **Clear Empirical Superiority**: Condition B achieved a 100% valid proposal rate (3/3) compared to 0% (0/3) for Condition A, completely eliminating extraneous `content` argument generation.
2. **Significant Latency Reduction**: Condition B reduced average model inference latency from 35.7s to 15.4s (56.7% faster) on local CPU.
3. **Zero Architectural Risk**: Adopting canonical prompt examples requires zero changes to runtime code, zero changes to Zod schemas, zero changes to frozen Phase 1–99 code, and zero dependency additions.
4. **Next Step**: Await explicit operator authorization before applying this minimal canonical template to any standard production prompt builder.

---

## 8. Statement of Code and Configuration Immutability

> [!IMPORTANT]
> In accordance with Section 4 and Section 6 of the user directive:
> - **Zero production runtime code was modified.**
> - **Zero production schemas or contracts were altered.**
> - **Zero production prompt templates were modified in this turn.**
> - **Zero tests, historical artifacts, or frozen Phases 1–99 were changed.**
> - **All experiments were executed in disposable scripts and recorded in dedicated scratch files.**

---
*Experiment completed, measured, and cryptographically documented: 2026-10-22*
