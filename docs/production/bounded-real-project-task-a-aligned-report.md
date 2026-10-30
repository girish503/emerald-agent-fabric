# Emerald Agent Fabric — Bounded Real-Project Task A Aligned Trial Report

## Executive Summary

- **Overall Outcome**: `END_TO_END_READ_SUCCESS`
- **Date**: 2026-10-22
- **Model**: Local Ollama `qwen2.5-coder:3b` (HTTP `http://127.0.0.1:11434`)
- **Cost**: ₹0.00 (100% local CPU inference)
- **Primary Change**: Applied minimal prompt alignment to [`scripts/run-task-a-real-project.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scripts/run-task-a-real-project.ts) to instruct and exemplify canonical `read_file` tool input `{"path": string}`, eliminating unmodeled `offsetLine` and `limitLines` parameters while preserving strict Zod runtime validation (`ReadFileInputSchema.strict()`).
- **Trial Outcome**: `qwen2.5-coder:3b` generated a 100% valid proposal on Turn 1 (zero reprompts). The `read_file` tool executed successfully, returned genuine production file contents, and completed sovereign verification and 3-sweep deterministic replay with zero workspace mutations.

---

## 1. Minimal Correction Scope & Architectural Rationale

### A. Minimal Script Correction
The change was confined strictly to [`scripts/run-task-a-real-project.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scripts/run-task-a-real-project.ts):
1. **Initial Prompt Alignment (lines 120–128)**: Removed `"Propose a read_file action with limitLines=50."` and replaced the example toolInput `{ path: targetFile, offsetLine: 1, limitLines: 50 }` with the canonical contract `{ path: targetFile }`.
2. **Repair Reprompt Alignment (line 164)**: Aligned correction guidance from `"toolInput must contain ONLY: path, offsetLine, limitLines"` to `"toolInput must contain ONLY: path"`.
3. **Evidence Artifact Separation (line 301)**: Directed output to `scratch/bounded-real-project-task-a-aligned-results.json` to prevent overwriting prior evidence.

### B. Preservation of Invariants
- Runtime Zod validator (`ReadFileInputSchema` in `src/production/adapter/structured-proposal-schema.ts`) was **not relaxed** and remains strictly `.strict()`.
- Production tool runtime, capability fencing, sovereign verifier, and replay engine were **unmodified**.
- Historical benchmark/phase artifacts and pre-existing user files were **untouched**.

---

## 2. Focused Verification

Prior to executing the trial, focused tests were executed:
- Suite: `tests/production/structured-proposal-interface.test.ts`
- Result: **15 / 15 passed**
- Key Verifications:
  - Canonical `{ path: "index.js" }` passes strict validation cleanly.
  - Proposals with unexpected fields (`content`, `expectedDigest`, `offsetLine`, `limitLines`) fail closed with `INVALID_ARGUMENTS`.
  - Phase 10H historical diagnostic artifacts verified 100% byte-for-byte intact (36/36 records).

---

## 3. Real-Project Task A Three-Run Comparison

| Parameter | Run 1: Baseline Trial | Run 2: Post-Fix Rerun (Unaligned Script) | Run 3: Aligned Prompt Trial |
| :--- | :--- | :--- | :--- |
| **Evidence Path** | `scratch/bounded-real-project-task-a-results.json` | `scratch/bounded-real-project-task-a-post-fix-results.json` | `scratch/bounded-real-project-task-a-aligned-results.json` |
| **Prompt Contract Used** | Ad-hoc script (`offsetLine`, `limitLines`) | Ad-hoc script (`offsetLine`, `limitLines`) | **Canonical `{ path: string }`** |
| **Model** | `qwen2.5-coder:3b` | `qwen2.5-coder:3b` | `qwen2.5-coder:3b` |
| **Target File** | `src/production/diagnostics/source-diagnostic-engine.ts` | `src/production/diagnostics/source-diagnostic-engine.ts` | `src/production/diagnostics/source-diagnostic-engine.ts` |
| **Prompt Count** | 2 (1 initial + 1 reprompt) | 2 (1 initial + 1 reprompt) | **1 (0 reprompts)** |
| **Turn 1 Schema Validation** | FAILED (`INVALID_ARGUMENTS`) | FAILED (`INVALID_ARGUMENTS`) | **PASSED (`valid: true`)** |
| **Turn 1 Extraneous Fields** | `'content'`, `'expectedDigest'` | `'content'` | **None** |
| **Turn 2 (Reprompt)** | FAILED (`INVALID_ARGUMENTS`) | FAILED (`INVALID_ARGUMENTS`) | **N/A (Succeeded on Turn 1)** |
| **Model Inference Latency**| 89,291 ms | 167,595 ms | **54,969 ms** |
| **Wall Clock Latency** | 89,325 ms | 167,684 ms | **55,068 ms** |
| **Tool Dispatched** | `none` | `none` | **`read_file`** |
| **Tool Arguments** | None | None | **`{"path": "src/production/diagnostics/source-diagnostic-engine.ts"}`** |
| **Tool Execution Output** | None (`""`) | None (`""`) | **Returned real file header snippet (200 bytes)** |
| **Target File Digest** | `376834853423...` (Intact) | `376834853423...` (Intact) | **`376834853423...` (Byte-identical)** |
| **Workspace Modifications**| 0 bytes | 0 bytes | **0 bytes** |
| **Sovereign Verification** | PASSED | PASSED | **PASSED** |
| **3-Sweep Deterministic Replay** | PASSED | PASSED | **PASSED** |
| **Evidence Bundle Digest** | `943d4fc43f6d...` | `3349e6ab1893...` | **`d7d6d851d3a024aebc3a1e26833c794f1a98fa486354124c6463837c0b119179`** |
| **Overall Trial Outcome** | Blocked at validation gate | `INCONCLUSIVE` (unaligned script) | **`END_TO_END_READ_SUCCESS`** |

---

## 4. Key Distinctions

1. **Proposal Validation Success**:
   - `schemaValidationPassed: true` on the very first prompt turn.
   - The model output strictly adhered to `{"version": "v1.8.0", "thought": "...", "toolName": "read_file", "toolInput": {"path": "..."}, "isGoalReached": false}` without hallucinating write or offset keys.
2. **Actual `read_file` Tool Execution Success**:
   - Governance evaluated the proposal under capability fence `fence-real-task-a` (`READ_WORKSPACE`), granting authorization.
   - `ProductionToolGateway.executeTool("read_file", ...)` executed cleanly and returned real source code from `src/production/diagnostics/source-diagnostic-engine.ts`.
3. **Successful Project Inspection**:
   - Real-world file reading was accomplished end-to-end against an actual production module.
4. **Safety & Evidence Integrity**:
   - Invariants strictly preserved: zero file mutations, sovereign verification confirmed clean working tree, deterministic 3-sweep replay verified bit-identical execution reconstruction.

---

## 5. Limitations & Next Steps

1. **Scope Limitation**:
   - This trial validates read-only code understanding. It does not certify autonomous multi-file editing, defect localization, or code repair.
2. **Inference Latency**:
   - Local CPU execution of `qwen2.5-coder:3b` requires ~55s per turn.
3. **Next Recommended Step**:
   - With read-only code inspection established end-to-end on genuine repository modules, proceed to evaluate human-approved anchored editing (Task B) under controlled governance.
