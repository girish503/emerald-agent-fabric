# Integration Brief: SWE-bench Benchmark Discipline — Starter Benchmark, Failure Taxonomy, and Improvement Protocol

**Document ID**: `EAF-OSS-004`  
**Date of Inspection**: 2026-10-16  
**Status**: APPROVED FOR DESIGN (Execution strictly deferred to Phase 17)  
**Role**: Senior AI Infrastructure Engineer & Technical Co-Founder  
**Upstream System**: [SWE-bench](https://github.com/SWE-bench/SWE-bench)  
**Inspected Commit SHA**: [`02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`](https://github.com/SWE-bench/SWE-bench/commit/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e)  

---

## 1. Executive Summary

Evaluating autonomous coding agents requires rigorous scientific discipline. Anecdotal demos and "vibe checks" provide zero engineering signal. SWE-bench pioneered benchmark discipline by converting historical GitHub issues into standardized, reproducible test tasks where every instance has a pinned git commit, an exact problem statement, and an automated verification oracle.

For Emerald Agent Fabric, benchmark discipline governs **Phase 17 (Curated Benchmark)**. This brief specifies:
1. A strongly-typed **Starter Task Schema** that bridges SWE-bench test specifications with Emerald's immutable `MissionContract`.
2. A curated **12-Task Starter Mix** balanced across 8 fundamental software engineering categories (specifically designed for local CPU verification).
3. A 12-category **Failure Taxonomy** with strict assignment rules and observable evidence criteria.
4. An empirical **Improvement Protocol** based on single-variable controlled trials, ensuring harness changes are driven by root-cause data rather than subjective guessing.

---

## 2. Research Question

> How does SWE-bench structure reproducible software tasks and evaluate candidate agents objectively, and how can Emerald construct a CPU-compatible starter benchmark of 10–20 tasks with a deterministic 12-category failure taxonomy and single-variable improvement loop without relying on massive 100GB Docker images or unverified grading?

---

## 3. Upstream Inspected Source Files

The following files from [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) at commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` were inspected:

1. **[`swebench/types.py`](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/types.py)**:
   - Data models for `TestSpec` and `Prediction`:
     ```python
     class TestSpec:
         instance_id: str
         repo: str
         version: str
         base_commit: str
         problem_statement: str
         hints_text: str
         test_patch: str
         FAIL_TO_PASS: list[str]
         PASS_TO_PASS: list[str]
         eval_type: str
     ```
2. **[`swebench/harness/run_evaluation.py`](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/run_evaluation.py)**:
   - Pipeline for loading dataset splits, running test commands, and generating summary tables.
3. **[`swebench/harness/grading.py`](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py)**:
   - Scoring formulas for pass-to-pass, fail-to-pass, and resolution reporting.

---

## 4. Starter Task Schema

Emerald's starter benchmark tasks are formalized as typed JSON structures that directly populate Emerald's `MissionContractSpec`:

```typescript
export interface EmeraldBenchmarkTask {
  readonly taskId: string;                  // e.g. "EAF-BENCH-001"
  readonly category: BenchmarkCategory;     // e.g. "BOUNDARY_CONDITION"
  readonly repository: {
    readonly name: string;                 // e.g. "emerald-agent-fabric" or public repo
    readonly pinnedCommit: string;         // Full 40-char SHA
    readonly cleanCloneUrl: string;        // Pinned local or remote URL
  };
  readonly problemStatement: string;       // Exact task description given to model
  readonly expectedScope: {
    readonly targetFiles: readonly string[]; // Allowed modification paths
    readonly maxFilesModified: number;       // Scope bounding
  };
  readonly setupRequirements: {
    readonly command: string;              // e.g. "npm install" or "npm ci"
    readonly timeoutMs: number;
  };
  readonly testSpecification: {
    readonly runner: "vitest" | "pytest" | "cargo";
    readonly testCommand: string;          // e.g. "npm test -- tests/math.test.ts"
    readonly failToPass: readonly string[];// Test cases that MUST transition from FAIL to PASS
    readonly passToPass: readonly string[];// Test cases that MUST remain PASS
    readonly suiteRanRegex: string;        // Non-zero execution guard
  };
  readonly resourceLimits: {
    readonly maxStepBudget: number;        // e.g. 10 steps
    readonly stepTimeoutMs: number;        // e.g. 120,000 ms
    readonly totalRunTimeoutMs: number;    // e.g. 600,000 ms
    readonly maxMemoryBytes: number;       // e.g. 1 GB
  };
  readonly provenance: {
    readonly source: "INTERNAL_SYNTHETIC" | "SWE_BENCH_LITE" | "PUBLIC_OSS";
    readonly originalIssueUrl?: string;
    readonly license: string;              // e.g. "Apache-2.0" | "MIT"
    readonly knownLimitations: string;
  };
}
```

### 4.1 Handling Tasks Without Reliable Test Oracles
If a software engineering task lacks an automated test oracle (e.g. pure documentation changes or ambiguous visual styling):
- **Rule**: Such tasks are **prohibited** from the benchmark suite.
- An agent cannot be scored on tasks without deterministic, automated verification.
- In Emerald, if no automated test oracle exists, the task must be rejected during contract creation: `NO_VERIFIABLE_ORACLE`.

---

## 5. Curated 12-Task Starter Benchmark Mix

The initial benchmark consists of 12 small, CPU-friendly tasks designed to execute within 15–45 seconds per verification run:

| Task ID | Category | Target Codebase | Description | Target Scope | Oracle Type | Provenance |
|---|---|---|---|---|---|---|
| `EAF-BM-01` | Code Navigation | `emerald/calculator` | Locate off-by-one addition bug using `search_code` and report line | `src/calc.ts` | 1 F2P test | INTERNAL_SYNTHETIC |
| `EAF-BM-02` | Localized Bug Fix | `chalk/chalk` (pinned) | Fix hex color parsing edge case on 3-char shorthand | `source/index.js` | 1 F2P, 12 P2P | PUBLIC_OSS (MIT) |
| `EAF-BM-03` | Input Validation | `expressjs/cors` (pinned) | Reject origin strings with CRLF injection characters | `lib/index.js` | 2 F2P, 8 P2P | PUBLIC_OSS (MIT) |
| `EAF-BM-04` | Boundary Conditions | `emerald/semver-lite` | Handle pre-release tags containing hyphenated numbers | `src/version.ts` | 2 F2P, 15 P2P | INTERNAL_SYNTHETIC |
| `EAF-BM-05` | Boundary Conditions | `sindresorhus/is-ip` | Validate IPv6 addresses with compressed double colons | `index.js` | 2 F2P, 20 P2P | PUBLIC_OSS (MIT) |
| `EAF-BM-06` | Regression Fix | `emerald/kv-store` | Fix race condition where delete returns old key during flush | `src/store.ts` | 1 F2P, 18 P2P | INTERNAL_SYNTHETIC |
| `EAF-BM-07` | Regression Fix | `lodash/lodash` (pinned) | Prevent prototype pollution in `deepSet` utility | `lodash.js` | 1 F2P, 30 P2P | PUBLIC_OSS (MIT) |
| `EAF-BM-08` | Small Refactor | `emerald/logger` | Extract JSON formatter into separate pure function | `src/logger.ts` | 0 F2P, 14 P2P | INTERNAL_SYNTHETIC |
| `EAF-BM-09` | Test Repair | `emerald/event-emitter` | Update out-of-sync test assertions after event payload rename | `tests/event.test.ts`| 1 F2P, 5 P2P | INTERNAL_SYNTHETIC |
| `EAF-BM-10` | Failure Recovery | `emerald/fs-scanner` | Handle `EACCES` permission denied gracefully without throwing | `src/scanner.ts` | 1 F2P, 9 P2P | INTERNAL_SYNTHETIC |
| `EAF-BM-11` | Localized Bug Fix | `swe-bench-lite/pallets-flask` | Fix missing url scheme validation in test client | `src/flask/testing.py`| 1 F2P, 42 P2P | SWE_BENCH_LITE (BSD-3) |
| `EAF-BM-12` | Boundary Conditions | `swe-bench-lite/requests` | Prevent header leakage on 301 cross-origin redirects | `requests/sessions.py`| 1 F2P, 60 P2P | SWE_BENCH_LITE (Apache-2.0)|

*Note: All INTERNAL_SYNTHETIC tasks are explicit internal test packages created to evaluate specific compiler, runtime, or failure edge cases on CPU without external network dependencies.*

---

## 6. Comprehensive 12-Category Failure Taxonomy

When an Emerald run fails or fails verification, it must be classified into exactly one **Primary Root Cause** and optional **Contributing Factors**.

```
                           ┌───────────────────┐
                           │   Observed Run    │
                           │      Failure      │
                           └─────────┬─────────┘
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼                                                       ▼
┌──────────────────┐                                   ┌──────────────────┐
│ Infrastructure / │                                   │ Cognitive /      │
│ System Fault     │                                   │ Execution Fault  │
└────────┬─────────┘                                   └────────┬─────────┘
         │                                                      │
         ├─ INFRASTRUCTURE                                      ├─ MODEL_REASONING
         ├─ TIMEOUT                                             ├─ TOOL_SELECTION
         └─ RECOVERY                                            ├─ TOOL_ARGUMENT
                                                                ├─ CONTEXT_SELECTION
                                                                ├─ EDITING
                                                                ├─ EXECUTION
                                                                ├─ POLICY
                                                                ├─ REFLEX
                                                                └─ VERIFICATION
```

### Taxonomy Classification Matrix

| Category | Observable Evidence | Assignment Rule | Primary or Contributing | Example |
|---|---|---|---|---|
| `MODEL_REASONING` | Model makes invalid deduction, ignores explicit instructions, or declares goal reached when work is unfinished. | Assigned when prompt contained sufficient context and tool arguments were valid, but the plan was logically defective. | Primary | Model hallucinates that a bug is fixed without inspecting code. |
| `TOOL_SELECTION` | Model requests the wrong tool for the task (e.g. calling `write_file` to search for a string). | Model proposes an existing tool that cannot logically satisfy the sub-goal. | Primary | Proposing `run_command` with grep when `search_code` is available. |
| `TOOL_ARGUMENT` | `ProposalValidator` returns `INVALID_TOOL_INPUT` or arguments violate tool schema. | Structured output is well-formed, but input payload has missing or extra properties. | Primary | Proposing `search_code({ pattern: "foo" })` instead of `{ query: "foo" }`. |
| `CONTEXT_SELECTION` | Necessary file or error output was omitted from the prompt context snapshot. | ContextEngine truncation or filtering excluded the critical information needed to solve the problem. | Contributing or Primary | Truncating the test failure stack trace so the model cannot see line numbers. |
| `EDITING` | Edit failed to apply, corrupted file syntax, or deleted unintended lines. | `write_file` creates non-compiling file or introduces broken syntax. | Primary | Model emits truncated TypeScript file with missing closing brackets. |
| `EXECUTION` | Tool executed successfully in sandbox, but command failed due to runtime bug or test failure. | Adapter returns non-zero exit code or error output during legitimate operation. | Primary or Contributing | Test runner fails with `TypeError: cannot read properties of undefined`. |
| `POLICY` | `PolicyEvaluator` denied the proposal with `POLICY_DENIED`. | Action attempted to access files outside `allowedPaths` or execute forbidden binary. | Primary | Model attempts to write to `.github/workflows/ci.yml`. |
| `REFLEX` | Reflex threshold was not met, triggering unintended escalation or premature halt. | Reflex confidence score fell below threshold on safe, valid action. | Primary | Reflex halts on safe `read_file` due to low state confidence. |
| `VERIFICATION` | Independent verification sandbox rejected patch (`F2P < 1.0` or `P2P < 1.0`). | Agent claimed success, but pristine verification failed test assertions. | Primary | Patch passed agent's local test but broke 2 P2P regression tests in clean sandbox. |
| `RECOVERY` | Lease expired, worker crashed, or recovery mechanism failed to reconcile state. | StateStore indicates lost lease or unhandled crash state. | Primary | Worker process restart leaves action in unresolved `UNKNOWN` status. |
| `TIMEOUT` | Operation exceeded configured deadline (`durationMs > timeoutMs`). | Model call, tool execution, or verification timed out. | Primary | `llama3.2:3b` model inference takes $> 120\text{s}$ on large context prompt. |
| `INFRASTRUCTURE` | Docker daemon error, host OOM kill (`^Killed$`), or disk full. | System-level failure unrelated to model reasoning or repository code. | Primary | Docker engine socket severed mid-container execution. |

---

## 7. The Single-Variable Improvement Protocol

To prevent chaotic "prompt thrashing" and speculative changes, Emerald mandates the following **Scientific Improvement Protocol**:

```
┌────────────────────────────────────────────────────────┐
│ 1. Run Baseline Benchmark (e.g., 12 Tasks × 3 Trials)  │
└──────────────────────────┬─────────────────────────────┘
                           │ Compute Failure Distribution
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Identify Dominant Failure Category                  │
│    (e.g., TOOL_ARGUMENT = 65% of all failures)         │
└──────────────────────────┬─────────────────────────────┘
                           │ Formulate Hypothesis
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Formulate Single-Variable Intervention Hypothesis   │
│    "Standardizing schema projection will eliminate     │
│     TOOL_ARGUMENT failures without increasing latency" │
└──────────────────────────┬─────────────────────────────┘
                           │ Implement in Isolated Branch
                           ▼
┌────────────────────────────────────────────────────────┐
│ 4. Execute Controlled Comparative Benchmark            │
│    Keep frozen: model, prompts, tasks, hardware, seeds │
│    Vary ONLY: the single independent variable          │
└──────────────────────────┬─────────────────────────────┘
                           │ Compare Metrics
                           ▼
┌────────────────────────────────────────────────────────┐
│ 5. Evaluate Decision Gate                              │
│    - Did the target failure category decrease?         │
│    - Did task-level verified pass rate increase?       │
│    - Did regression rate remain 0%?                    │
│    If YES → Promote to Immutable Harness Version       │
│    If NO  → Reject and Revert                          │
└────────────────────────────────────────────────────────┘
```

### Metrics To Report
Every benchmark run must report these distinct metrics:
1. **Verified Resolution Rate**: Percentage of tasks achieving `ResolvedStatus.FULL` in clean-room verification.
2. **Tool-Input Conformance Rate**: Percentage of model proposals passing `ProposalValidator` without error.
3. **Execution Reach Rate**: Percentage of tasks reaching at least one governed tool execution.
4. **Latency Profile**: Mean, p50, and p95 step duration and total run duration.
5. **Model Call Economy**: Mean model calls and tokens consumed per resolved task.

---

## 8. Conformance Test Specifications

For Phase 17 benchmark harness certification:

1. **Test 17.1: Deterministic Failure Classification**:
   - Ingest 12 synthetic test run logs representing each of the 12 taxonomy categories.
   - Run classifier algorithm.
   - Assert: Exactly 12/12 logs are classified into their expected category without ambiguity.

2. **Test 17.2: Benchmark Replay Reproducibility**:
   - Execute benchmark runner on a fixed 3-task subset with mock deterministic model outputs.
   - Assert: Scoring output is byte-identical across two consecutive runs (`resolutionStatus`, `evidenceHashes`, `failureCodes`).

---

## 9. Dependencies & Sequencing

- **Pre-requisite**: **Phase 14 (Independent Verification)**.
- **Direct Target**: **Phase 17 (Curated Benchmark)**.
- **Strict Stop Condition**: Never execute Phase 17 until Phase 14 has successfully demonstrated verified patch generation.
