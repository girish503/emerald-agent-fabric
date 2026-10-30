# Emerald Agent Fabric — Bounded Real-Project Task B Validation Report

## Executive Summary

- **Final Outcome**: `VERIFIED_HUMAN_APPROVED_EDIT`
- **Date**: 2026-10-23
- **Model**: Local Ollama `qwen2.5-coder:3b` (HTTP `http://127.0.0.1:11434`)
- **Cost**: ₹0.00 (100% local CPU inference)
- **Target File**: [`src/tools/production-tools.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/tools/production-tools.ts)
- **Primary Script**: [`scripts/run-task-b-real-project.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scripts/run-task-b-real-project.ts)
- **Evidence Artifact**: [`scratch/bounded-real-project-task-b-results.json`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/scratch/bounded-real-project-task-b-results.json)
- **Prior Artifacts Preserved**: Task A baseline, post-fix, and aligned reports remain byte-for-byte intact.

---

## 1. Selected Change & Justification

### A. Candidate Selection
- **File**: `src/tools/production-tools.ts`
- **Function**: `private async toolReadFile(input: Record<string, unknown>, context: ToolExecutionContext): Promise<string>`
- **Observed Problem**: In `toolReadFile`, the tool checked `!fs.existsSync(safePath)` but lacked a directory check. Passing a directory path (e.g. `"src"` or `"tests"`) caused `fs.readFileSync` to throw an unhandled Node.js raw OS exception (`EISDIR: illegal operation on a directory, read`).
- **Architectural Contract Alignment**: In `src/production/repair/line-anchored-editor.ts` (lines 109–112), the established invariant is to verify regular file status before disk I/O:
  ```typescript
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) {
    throw new Error(`Target path is not a regular file: ${targetFile}`);
  }
  ```
- **Acceptance Criteria**:
  1. `toolReadFile` performs regular file validation using `fs.statSync(safePath).isFile()`.
  2. Attempted reads of directory paths throw a clean, bounded domain error: `Target path is not a regular file: ${rawPath}`.
  3. Search anchor matches uniquely (1 occurrence).
  4. Targeted vitest tests pass and existing 140 production tests continue to pass.

### B. Isolation
The change introduces 5 lines inside `toolReadFile` in a mutable production-owned tool file without touching external interfaces, schemas, or frozen research phases.

---

## 2. Governed Execution Chronology

### Step 1: Read-Only Inspection
- The agent runtime initialized a bounded mission and capability fence `fence-real-task-b` granting `READ_WORKSPACE` and `WRITE_TEMPORARY_OUTPUT`.
- `ProductionToolGateway.executeTool("read_file", ...)` inspected `src/tools/production-tools.ts`.
- Pre-edit SHA-256 digest recorded: `d0c7c8e7d5ee2d0f328e9dfdb01935932f9a5a06327bd823b7539e842bad252b`.

### Step 2: Model Proposal Generation & Validation
- Prompt dispatched to local `qwen2.5-coder:3b` requesting an `edit_file_anchor` proposal.
- Model Inference Latency: 96,738 ms on CPU.
- Proposal returned with `toolName: "edit_file_anchor"` and exact anchor arguments.
- Runtime Zod validator (`EditFileAnchorInputSchema.strict()`) validated the proposal: **`schemaValidationPassed: true`**.

### Step 3: Exact Anchor Matching
- Search anchor:
  ```typescript
      if (!fs.existsSync(safePath)) {
        throw new Error(`File not found: ${rawPath}`);
      }

      const content = fs.readFileSync(safePath, "utf8");
  ```
- Scanned across `src/tools/production-tools.ts`: exactly **1 occurrence matched** (`anchorMatchedUniquely: true`).

### Step 4: Human Approval Gate
- An approval request was created in `ApprovalControl`: ID `appr-1792694353311-1`.
- Proposed diff presented to human operator.
- Operator reviewed and granted explicit approval (`humanReviewedDiff: true`, `humanReviewApproved: true`).

### Step 5: Governed Line-Anchored Edit Execution
- Governance facade verified authorization under `WRITE_TEMPORARY_OUTPUT`.
- `ProductionToolGateway.executeTool("edit_file_anchor", ...)` invoked `LineAnchoredEditor.applyEdit()`.
- Result: **`applied: true`**, occurrences: 1, replaced: 1.
- Post-edit SHA-256 digest: `fb5cd4e45fce7b763a9b4dbfb4ec9109be4194ede19fcbdb70dd4cf0341a0196`.

---

## 3. Independent Verification & Diagnostics

1. **Git Diff Audit**:
   ```diff
   --- a/src/tools/production-tools.ts
   +++ b/src/tools/production-tools.ts
   @@ -177,6 +177,11 @@ export class ProductionToolGateway {
          throw new Error(`File not found: ${rawPath}`);
        }
    
   +    const stat = fs.statSync(safePath);
   +    if (!stat.isFile()) {
   +      throw new Error(`Target path is not a regular file: ${rawPath}`);
   +    }
   +
        const content = fs.readFileSync(safePath, "utf8");
   ```
   Confirmed the actual disk diff matches the approved proposal byte-for-byte.

2. **Targeted Regression Tests**:
   - Executed: `npx.cmd vitest run tests/production/production-components.test.ts`.
   - Result: **20 / 20 passed** (including all `ProductionToolGateway` suites).

3. **Full Production Test Suite**:
   - Executed: `npx.cmd vitest run tests/production/`.
   - Result: **140 / 140 passed** across 9 test files.

4. **Sovereign Verification**:
   - Clean-room verification by `ProductionVerifier`: **`sovereignVerified: true`**.

5. **Deterministic Replay**:
   - `ProductionReplayEngine` reconstructed the timeline and bundle hashes deterministically across 3 independent sweeps: **`replayVerified: true`**.

6. **Historical Invariant Audit**:
   - Phase 99 capability fencing tests: **262 / 262 passed**.
   - Phase 10H historical diagnostic records: **36 / 36 records intact and byte-verified**.
   - `node bin/emerald.js doctor`: **`HEALTHY`**.
   - Zero automatic Git commits or pushes.

---

## 4. Empirical Performance Measurements

| Metric | Measured Value | Verification Mechanism |
| :--- | :---: | :--- |
| **Model Inference Duration** | 96,738 ms | Local Ollama HTTP request duration |
| **Total Wall-Clock Duration** | 114,708 ms | Overall runner execution duration |
| **Proposal Turns** | 1 (0 reprompts) | Recorded turn counter |
| **Strict Schema Validation** | **PASS** | Zod strict parser (`.strict()`) |
| **Anchor Uniqueness** | **1 Occurrence** (Zero fuzzy matching) | `LineAnchoredEditor` |
| **Human Approval** | **APPROVED** | `ApprovalControl` gate |
| **Targeted Vitest Suite** | **20 / 20 PASSED** | `production-components.test.ts` |
| **Full Production Suite** | **140 / 140 PASSED** | 9 test files |
| **E2E Engineering Workflow** | **1 / 1 PASSED** | `production-engineering-workflow.test.ts` |
| **Sovereign Verification** | **PASS** | `ProductionVerifier` |
| **Deterministic Replay** | **PASS** | `ProductionReplayEngine` (3 sweeps) |

---

## 5. Limitations & Evidence-Based Recommendation

### Limitations
1. **Single-File Bounded Scope**:
   This trial validates a single, human-reviewed, line-anchored edit to a production utility. It does not certify autonomous multi-file editing or unsupervised patch generation.
2. **Inference Latency**:
   Local CPU inference with `qwen2.5-coder:3b` requires ~96s per turn.

### Evidence-Based Recommendation
- **Recommended Next Step**: Continue bounded real-project usability trials by validating defect localization (Task C) under read-only diagnostic governance, maintaining the established human approval and capability fencing standards.
