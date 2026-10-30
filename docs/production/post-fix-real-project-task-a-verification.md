# Emerald Agent Fabric — Post-Fix Real-Project Task A Verification Report

## Executive Summary

- **Status**: COMPLETE & RECORDED
- **Evaluation Decision**: `INCONCLUSIVE` (with `INVALID_PROPOSAL_REPRODUCED` for unaligned script prompt)
- **Date**: 2026-10-22
- **Model**: Local Ollama `qwen2.5-coder:3b` (HTTP `http://127.0.0.1:11434`, ₹0 cost)
- **Primary Script**: `scripts/run-task-a-real-project.ts`
- **Post-Fix Evidence File**: `scratch/bounded-real-project-task-a-post-fix-results.json`
- **Original Baseline Evidence File**: `scratch/bounded-real-project-task-a-results.json` (Preserved intact)

---

## 1. Objective & Context

Following the canonical prompt alignment change implemented in the production prompt builders (`src/production/benchmark/benchmark-manifest.ts` and `src/production/benchmark/calibration-manifest.ts`), this evaluation reran the existing read-only real-project Task A workflow (`scripts/run-task-a-real-project.ts`) to determine whether the correction resolved the argument-schema failure under genuine project conditions.

---

## 2. Preflight Inspection & Architectural Findings

1. **Git State**:
   - HEAD commit: `7109911fa4488c5759000fe08c3a77895ed214f4` on `master`.
   - All pre-existing user work, uncommitted files, and untracked artifacts were preserved.
2. **Schema Invariant**:
   - `ReadFileInputSchema` in `src/production/adapter/structured-proposal-schema.ts` strictly enforces:
     ```typescript
     export const ReadFileInputSchema = z
       .object({
         path: z.string().min(1, "Path cannot be empty").max(1024, "Path exceeds maximum length"),
       })
       .strict();
     ```
   - No relaxation or silent argument stripping was permitted or introduced.
3. **Prompt Construction Path Mismatch**:
   - In the prior maintenance task, the canonical `read_file` contract (`{"path": string}`) was applied to `BenchmarkManifestLoader.buildUntrustedPromptForModel()` and `CalibrationManifestLoader.buildUntrustedPromptForModel()`.
   - Preflight inspection of `scripts/run-task-a-real-project.ts` revealed that the script **does not invoke** `BenchmarkManifestLoader` or `CalibrationManifestLoader`.
   - Instead, `scripts/run-task-a-real-project.ts` manually constructs an ad-hoc local prompt on lines 117–129 and reprompt on lines 161–165:
     ```typescript
     // scripts/run-task-a-real-project.ts:120-128
     "Do NOT edit or write to any files. Do NOT include 'content' in toolInput. Propose a read_file action with limitLines=50.",
     ...
     toolInput: { path: targetFile, offsetLine: 1, limitLines: 50 }

     // scripts/run-task-a-real-project.ts:164
     "Fix this error. toolInput must contain ONLY: path, offsetLine, limitLines. Output NO other fields."
     ```
   - In accordance with the preflight instructions (*"Do not silently change the script or production code to force the experiment to use the new path"*), the script was executed as written to capture authentic empirical measurements.

---

## 3. Directly Measured Trial Results

The execution completed with the following empirical measurements:

| Metric | Measured Value | Notes |
| :--- | :--- | :--- |
| **Model** | `qwen2.5-coder:3b` | Local Ollama inference |
| **Target File** | `src/production/diagnostics/source-diagnostic-engine.ts` | Genuine production code |
| **Initial File Digest** | `376834853423c8f3084fc96590634d2a45949a619ee99db4f17041ecdb71d81d` | SHA-256 |
| **Final File Digest** | `376834853423c8f3084fc96590634d2a45949a619ee99db4f17041ecdb71d81d` | Byte-identical (`true`) |
| **Turn 1 Schema Validation** | FAILED (`INVALID_ARGUMENTS`) | `Unrecognized key(s) in object: 'content'` |
| **Turn 2 Schema Validation** | FAILED (`INVALID_ARGUMENTS`) | `Unrecognized key(s) in object: 'content', 'expectedDigest'` |
| **Model Produced Usable Proposal** | `false` | Blocked at validation gate |
| **Tool Dispatched / Executed** | `none` (`modelOutputSnippet: ""`) | Read operation did NOT execute |
| **Total Prompt Turns** | 2 (1 initial + 1 reprompt) | Bounded retry loop |
| **Model Inference Duration** | 167,595 ms (~2m 47s) | ~84s per inference turn on CPU |
| **Total Wall Clock Duration** | 167,684 ms | Clean process termination |
| **Sovereign Verification** | `true` | Verified 0 modifications |
| **Replay Verification** | `true` | 3 independent sweeps bit-identical |
| **Evidence Bundle Digest** | `3349e6ab18936904fa6acdabf37373ce0209818633f37d376f79355b52ffda77` | Recorded |

---

## 4. Comparison: Baseline Trial vs. Post-Fix Rerun

| Parameter | Baseline Task A (`scratch/bounded-real-project-task-a-results.json`) | Post-Fix Task A (`scratch/bounded-real-project-task-a-post-fix-results.json`) | Comparison Analysis |
| :--- | :--- | :--- | :--- |
| **Prompt Path Used** | Ad-hoc script template (`offsetLine`, `limitLines`) | Ad-hoc script template (`offsetLine`, `limitLines`) | Identical unaligned path (bypassed corrected prompt loader) |
| **Turn 1 Outcome** | Failed schema validation | Failed schema validation (`'content'`) | Exactly reproduced |
| **Turn 2 Outcome** | Failed schema validation (`'content'`, `'expectedDigest'`) | Failed schema validation (`'content'`, `'expectedDigest'`) | Exactly reproduced |
| **Schema Conformance** | `false` | `false` | Consistent fail-closed enforcement |
| **Tool Execution** | No execution (`modelOutputSnippet: ""`) | No execution (`modelOutputSnippet: ""`) | Identical safety behavior |
| **Model Inference Time** | 89,291 ms | 167,595 ms | 2 turns executed in post-fix run |
| **Target Modification** | 0 bytes (Digest intact) | 0 bytes (Digest intact) | Invariant preserved |
| **Sovereign Verification**| `PASSED` | `PASSED` | Invariant preserved |
| **Deterministic Replay** | `PASSED` | `PASSED` | Invariant preserved |

---

## 5. Distinction Analysis

1. **Valid Proposal Generation**:
   - In production prompt tests (`scripts/verify-read-file-prompt-alignment.ts`), where the canonical prompt builder was used, `qwen2.5-coder:3b` generated a 100% valid proposal (`{"path": "src/calculator.js"}`) with zero extraneous keys.
   - In `scripts/run-task-a-real-project.ts`, the proposal failed validation because the script's prompt explicitly models non-canonical keys (`offsetLine`, `limitLines`), inducing the model to emit extraneous write keys (`content`, `expectedDigest`).
2. **Tool Execution**:
   - The intended read operation did NOT execute.
3. **End-to-End Task Completion**:
   - End-to-end read-only assistance was NOT established in this script run because the model proposal never passed the strict validation gate.
4. **Verification & Replay**:
   - Verification and replay mechanisms operated correctly and authoritatively confirmed that zero unauthorized mutations occurred.

---

## 6. Decision & Next Step Recommendation

### Decision: `INCONCLUSIVE`
- **Core Reason**: The corrected production prompt construction path (`BenchmarkManifestLoader.buildUntrustedPromptForModel`) was not exercised by the primary script (`scripts/run-task-a-real-project.ts`).
- **Secondary Finding (`INVALID_PROPOSAL_REPRODUCED`)**: Running the unaligned script confirmed that prompt-schema divergence reliably induces `qwen2.5-coder:3b` to emit extraneous keys, re-proving the necessity of prompt canonicality.

### Recommended Next Step
- Authorize aligning the prompt construction in `scripts/run-task-a-real-project.ts` to either invoke `BenchmarkManifestLoader.buildUntrustedPromptForModel()` directly or adopt the canonical tool contract `{"path": string}`.
