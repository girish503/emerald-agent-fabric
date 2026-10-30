# Emerald Agent Fabric — Production V1.6
## Line-Anchored Editing and Patch Integrity Research Report

**Date**: 2026-10-22  
**Harness Version**: `production-v1.6`  
**Model Under Test**: `qwen2.5-coder:3b` (Local Ollama inference, ₹0 cost)  
**Conditions Evaluated**: Baseline B3 (Whole-File `write_file`) vs. Treatment B4 (Line-Anchored `edit_file_anchor`)  
**Evaluation Set**: Calibration Suite (`benchmarks/calibration-v15/tasks.json`, 5 tasks, SHA-256 `150cbb79005a238fe4d8712b4a7d0ced1ce9ebe031c33101990027be63236676`)  
**Replay Verification**: 3 deterministic sweeps per completed trial  

---

## 1. Motivation & Context (V1.5 Failure Evidence)

In Production V1.5 (Controlled Repair Capability Calibration), human reference solutions executed through Pipeline Control C achieved **5/5 (100.0%) sovereign verified completions**, confirming that the Emerald runtime, tool gateway, and clean-room verification pipeline are completely sound.

However, when `qwen2.5-coder:3b` was evaluated under Conditions B2 and B3, **80.0% of failures (4/5 tasks)** were attributed directly to `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`. When asked to repair localized bugs, the small model consistently attempted to rewrite whole files from memory, frequently omitting critical module headers, import/export declarations, or emitting unescaped markdown blocks that clobbered the target source files.

Production V1.6 was designed to investigate whether providing a constrained, line-anchored search-and-replace editing tool (`edit_file_anchor`) would reduce malformed edits, prevent collateral overwriting of unrelated code lines, and improve patch integrity.

---

## 2. Tool Architecture and Security Boundaries

The `LineAnchoredEditor` (`src/production/repair/line-anchored-editor.ts`) provides a bounded, surgical mutation capability conforming strictly to the repository's defense-in-depth principles:

### 2.1 Request Schema
```typescript
export interface LineAnchoredEditInput {
  readonly path: string;                  // Workspace-relative path
  readonly searchAnchor: string;          // Exact, unique target text span
  readonly replacementText: string;       // Replacement text
  readonly expectedDigest?: string;       // Optional SHA-256 optimistic concurrency precondition
  readonly allowMultipleMatches?: boolean;// Defaults to false (unique match enforced)
}
```

### 2.2 Security and Integrity Safeguards
1. **Workspace Containment**: All file paths are strictly validated using `resolveSafePath()`. Traversal attempts (`..`) or absolute paths escaping the workspace root are rejected fail-closed.
2. **File Existence Requirement**: The tool only mutates pre-existing files; it cannot create new files ex nihilo (preserving `write_file` for intentional creation).
3. **Unique Match Enforcement**: If `searchAnchor` matches 0 times or >1 times (without explicit `allowMultipleMatches: true`), the operation is rejected fail-closed with zero disk modification.
4. **Byte-for-Byte Preservation**: Text outside the selected anchor is preserved character-for-character with zero reformatting or clobbering.
5. **Optimistic Concurrency**: If `expectedDigest` is provided and does not match the target file's current SHA-256 digest, the edit is aborted fail-closed (`Stale edit precondition failed`).
6. **Atomic Mutation**: Changes are written to a temporary sibling file and committed via atomic rename (`fs.renameSync`).
7. **No Fallback Invariant**: The engine never silently falls back to whole-file replacement when an anchor fails.
8. **Governance Gate Integration**: `edit_file_anchor` maps to `WRITE_TEMPORARY_OUTPUT` and crosses `ProductionGovernanceFacade`, checking capability fences and mission contract hashes before disk access.
9. **Telemetry Sanitization**: Evidence events (`repair.file_anchored_edit` and `repair.file_anchored_edit_failed`) record file paths, digests, and span lengths, strictly omitting file contents and potential secrets.

---

## 3. Experimental Methodology

To ensure strict scientific control, the evaluation held all experimental variables constant except for the editing interface:
- **Model**: `qwen2.5-coder:3b` via local Ollama HTTP API (`temperature: 0.1`, `num_predict: 512`, `top_p: 0.9`).
- **Tasks**: The 5 frozen calibration tasks (`calib-001` through `calib-005`).
- **Budgets**: Max 4 steps, max 4 attempts, max 4,096 bytes feedback, 45s timeout.
- **Diagnostics & Verification**: Active non-authoritative diagnostics and sovereign clean-room verification.

### Conditions:
- **Baseline (Condition B3)**: Prompt presents `write_file` as the editing mechanism.
- **Treatment (Condition B4)**: Prompt presents `edit_file_anchor` as the preferred surgical editing tool, instructing the model to replace only the exact buggy lines without whole-file replacement.

---

## 4. Empirical Evaluation Results

### 4.1 Comparative Metrics (N = 5 tasks per condition, Total = 10 trials)

| Metric | Baseline B3 (`write_file`) | Treatment B4 (`edit_file_anchor`) | Delta |
| :--- | :---: | :---: | :---: |
| **Total Trials** | 5 | 5 | 0 |
| **Valid Model Proposals** | 20 (100.0%) | 20 (100.0%) | 0 |
| **Anchored Edit Requests** | 0 | 0 | 0 |
| **Unique Anchor Success Rate** | N/A | 0.0% | 0.0% |
| **Patch Application Rate** | 20.0% (1/5) | 0.0% (0/5) | -20.0% |
| **Unintended Modifications** | 0 | 0 | 0 |
| **Test Pass Rate** | 0.0% (0/5) | 0.0% (0/5) | 0.0% |
| **Sovereign Verified Completions** | 0/5 (0.0%) | 0/5 (0.0%) | 0.0% |
| **Mean Duration per Task** | 87,950 ms | 74,257 ms | -13,693 ms |
| **Replay Consistency (3 sweeps)** | 100.0% (5/5) | 100.0% (5/5) | 0 |

---

### 4.2 Raw Per-Task Trial Results

#### Baseline Condition B3:
- `calib-001`: Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-002`: Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-003`: Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-004`: Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-005`: Patch: YES | Verified: NO | Stage: `STAGE_7_TEST_EXECUTION (TEST_ASSERTION_FAILED)`

#### Treatment Condition B4:
- `calib-001`: Anchored: 0 | Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-002`: Anchored: 0 | Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-003`: Anchored: 0 | Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-004`: Anchored: 0 | Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`
- `calib-005`: Anchored: 0 | Patch: NO | Verified: NO | Stage: `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)`

---

## 5. Analysis and Root Cause Findings

1. **Tool Invocation Inertia in Small Open-Weight Models**:
   Despite clear prompt instructions explicitly prioritizing `edit_file_anchor`, `qwen2.5-coder:3b` **generated 0 requests for `edit_file_anchor`**. The 3B model's base instruction-tuning is heavily biased toward full-file code generation and standard markdown blocks (` ```javascript ... ``` `). It failed to adopt the structured search-and-replace interface autonomously.
2. **Persistence of Stage 3 Failure Modes**:
   Because the model continued attempting full-file writes or raw markdown emissions, it remained trapped in `STAGE_3_PATCH_APPLICATION (PATCH_SYNTAX_ERROR)` in 100% of treatment trials.
3. **No Collateral Damage or Safety Regressions**:
   All 19 required security, atomicity, path containment, and capability tests passed cleanly (`tests/production/line-anchored-editing.test.ts`). The tool infrastructure itself operates with complete correctness; the failure is entirely driven by the model's tool-selection behavior.

---

## 6. Formal Decision

**Decision**: **`ANCHORED_EDITING_REJECTED`**

**Rationale**:
Under controlled experimental comparison on the 5 calibration tasks, presenting the `edit_file_anchor` tool interface did not improve repair outcomes or patch application. The 3B parameter model did not autonomously utilize the line-anchored edit tool, and overall patch application dropped from 20% to 0%. Verified completion remained 0/5 in both conditions.

---

## 7. Recommended Next Steps

1. **Structured Tool Calling Protocol (Few-Shot Prompt Calibration)**:
   Investigate whether providing a concrete 1-shot in-context demonstration of an `edit_file_anchor` JSON proposal overcomes the 3B model's full-file generation inertia.
2. **Model Parameter Scaling Threshold**:
   Benchmark a 7B parameter open-weight model (`qwen2.5-coder:7b`) under the identical calibration setup to assess whether larger local models possess the requisite reasoning capacity to select and execute line-anchored edits.
