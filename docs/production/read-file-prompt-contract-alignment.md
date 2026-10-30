# Emerald Agent Fabric — Minimal Production Prompt Contract Alignment Report

## Executive Summary

- **Status**: COMPLETE & VERIFIED
- **Date**: 2026-10-22
- **Model**: Local Ollama `qwen2.5-coder:3b` (HTTP `http://127.0.0.1:11434`)
- **Cost**: ₹0.00 (100% local CPU inference)
- **Primary Change**: Aligned active production prompt builder examples for `read_file` to strictly match the canonical runtime Zod schema (`{"path": string}`).
- **Enforcement Invariant**: Runtime Zod validation in `ReadFileInputSchema` remained strictly unchanged (`.strict()`), continuing to fail-closed on any extraneous or unmodeled keys.

---

## 1. Root Cause Addressed

During the bounded real-project trial, local inference with `qwen2.5-coder:3b` generated extraneous fields (`content` and `expectedDigest`) on `read_file` proposals, resulting in fail-closed rejection with `INVALID_ARGUMENTS`.

The root-cause investigation (`docs/production/tool-proposal-reliability-investigation.md`) and controlled prompt experiment (`docs/production/minimal-canonical-prompt-experiment.md`) proved that this failure stemmed from prompt-schema divergence:
1. The active prompt builders advertised speculative/legacy optional parameters:
   `- read_file: inspect file contents ({"path": string, "offsetLine"?: number, "limitLines"?: number})`
2. Meanwhile, the runtime Zod schema in `src/production/adapter/structured-proposal-schema.ts` strictly enforces:
   `ReadFileInputSchema = z.object({ path: z.string().min(1) }).strict()`
3. In Ollama/llama.cpp structured grammar generation, presenting conflicting or optional properties in the prompt causes the 3B model to hallucinate additional write-oriented properties (`content`, `expectedDigest`), whereas presenting the canonical schema achieves 100% adherence (3/3 valid proposals in Condition B).

---

## 2. Scope & Boundaries

This maintenance change adhered strictly to the following boundaries:
- **Modified**: ONLY the `read_file` prompt signature in production prompt builders.
- **Unmodified**:
  - Runtime validation schemas (`ReadFileInputSchema` remains `.strict()`).
  - Tool execution implementations.
  - Capability fencing, sovereign verification, and policy engines.
  - Other tool descriptions (`edit_file_anchor`, `write_file`, `search_code`, `git_status`, `git_diff`).
  - Pre-existing user modifications and untracked work.

---

## 3. Implementation Details

### Files Modified

1. `src/production/benchmark/benchmark-manifest.ts`
   - Updated both the line-anchored editing and default prompt builder branches:
     - Line 85: replaced `({"path": string, "offsetLine"?: number, "limitLines"?: number})` with canonical `({"path": string})`.
     - Line 123: replaced `({"path": string, "offsetLine"?: number, "limitLines"?: number})` with canonical `({"path": string})`.

2. `src/production/benchmark/calibration-manifest.ts`
   - Updated both the line-anchored editing and default prompt builder branches:
     - Line 140: replaced `({"path": string, "offsetLine"?: number, "limitLines"?: number})` with canonical `({"path": string})`.
     - Line 177: replaced `({"path": string, "offsetLine"?: number, "limitLines"?: number})` with canonical `({"path": string})`.

3. `tests/production/structured-proposal-interface.test.ts`
   - Added focused unit tests verifying:
     - Canonical `{ path: "index.js" }` proposal passes strict validation.
     - Extraneous fields `{ path: "index.js", content: "..." }` fail closed with `INVALID_ARGUMENTS`.
     - Extraneous fields `{ path: "index.js", offsetLine: 1, limitLines: 50 }` fail closed with `INVALID_ARGUMENTS`.

4. `scripts/verify-read-file-prompt-alignment.ts`
   - Created live verification script testing prompt generation and live Ollama local inference.

### Before vs. After Prompt Text

```diff
  AVAILABLE TOOLS:
- - read_file: inspect file contents ({"path": string, "offsetLine"?: number, "limitLines"?: number})
+ - read_file: inspect file contents ({"path": string})
  - edit_file_anchor: precisely replace a unique text snippet without rewriting whole file ({"path": string, "searchAnchor": string, "replacementText": string})
  - write_file: write complete file ({"path": string, "content": string})
  - search_code: search code patterns in workspace ({"pattern": string})
  - git_status: check working tree modifications ({})
  - git_diff: review working tree patch ({})
```

---

## 4. Verification Results

### A. Focused Unit Tests
- Suite: `tests/production/structured-proposal-interface.test.ts`
- Result: **15 / 15 passed**
- Specific tests:
  - `accepts canonical read_file input with only path`: PASSED
  - `rejects read_file proposal with extraneous content or expectedDigest fields`: PASSED (`INVALID_ARGUMENTS`)
  - `rejects read_file proposal with extraneous offsetLine or limitLines fields`: PASSED (`INVALID_ARGUMENTS`)

### B. Live Local Inference Verification
- Script: `scripts/verify-read-file-prompt-alignment.ts`
- Environment: Local Ollama `qwen2.5-coder:3b` at `http://127.0.0.1:11434`
- Prompt Builder Checks:
  - Benchmark manifest prompt: Verified canonical `{"path": string}`; zero legacy fields.
  - Calibration manifest prompt: Verified canonical `{"path": string}`; zero legacy fields.
- Model Proposal Output:
```json
{
  "thought": "First, inspect src/calculator.js using read_file.",
  "toolName": "read_file",
  "toolInput": {
    "path": "src/calculator.js"
  },
  "isGoalReached": false
}
```
- Inference Latency: 53,799 ms
- Zod Strict Validation: **PASSED (`valid: true`)**

### C. Full Regression Suite

| Test Suite / Gate | Scope | Status | Outcome |
| :--- | :--- | :--- | :--- |
| Production Test Suite | `tests/production/` | PASSED | 140 / 140 tests passed across 9 suites |
| E2E Workflow Test | `tests/e2e/production-engineering-workflow.test.ts` | PASSED | 1 / 1 passed |
| Phase 99 Capability Fencing | `tests/integration/phase99-governed-capability-fencing.test.ts` | PASSED | 262 / 262 passed |
| Phase 10H Artifact Integrity | `scripts/verify-phase10h-artifacts.ts` | PASSED | 36 / 36 records intact, byte-for-byte SHA-256 match |
| Emerald Doctor | `node bin/emerald.js doctor` | PASSED | Status: HEALTHY |

---

## 5. Working-Tree Hygiene & Audit

- **Baseline Commit**: `7109911fa4488c5759000fe08c3a77895ed214f4` (`master`).
- **Target Changes**: Limited strictly to prompt builders, regression unit tests, verification script, and documentation.
- **Pre-existing Work**: All pre-existing user files, diagnostic artifacts, and test logs preserved without overwriting.
- **Git Operations**: Zero automated commits or pushes executed.

---

## 6. Risks & Limitations

1. **Tool Scope Restriction**: Only `read_file` prompt contracts were aligned. `edit_file_anchor`, `write_file`, and `search_code` contracts already match their respective schemas and were not modified.
2. **Local CPU Inference Latency**: Local execution of `qwen2.5-coder:3b` via Ollama requires ~50–60s per inference on CPU. This is expected for local developer environments without hardware acceleration.
3. **Fail-Closed Guarantee**: The runtime Zod validator was not made permissive. If a model generates non-canonical fields in the future, the system will continue to reject the action fail-closed rather than silently stripping arguments.
