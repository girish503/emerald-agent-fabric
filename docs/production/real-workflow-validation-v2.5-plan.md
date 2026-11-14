# Emerald Agent Fabric — Production V2.5
## Real-World Developer Workflow Validation Plan

- **Date**: 2026-10-22
- **Milestone**: Production V2.5 Planning & Validation Design
- **Status**: Proposed Plan — Awaiting Operator Authorization Prior to Execution
- **Recommended Decision**: `CONTINUE_BOUNDED_PILOT`
- **Harness Interface**: Grammar-Constrained Structured Proposal Schema `v1.8.0` (Digest: `0a91b348fe7a26c60e2fb2124824d68986228ae46582f51382766f99fe68314e`)
- **Model Adapter**: `qwen2.5-coder:3b` (Q4_K_M, 1841 MB) via local Ollama (`v0.40.8`)
- **Inference Budget**: ₹0 (Strictly local inference; zero external APIs, paid endpoints, or proprietary services)
- **Primary Governance Rules**: [GEMINI.md](../../GEMINI.md), [ADR-0029](../adr/ADR-0029-rfc-standardized-model-facing-tool-contracts.md), [ADR-0032](../adr/ADR-0032-local-model-scaling-and-repair-benchmark-prerequisites.md)

---

## 1. Repository Baseline

### 1.1 Source of Truth & Environment Status
Inspection of the current repository baseline prior to validation planning confirms:
- **Git Branch**: `master`
- **Git Commit (HEAD)**: `7109911fa4488c5759000fe08c3a77895ed214f4`
- **Runtime Environment**: Node.js `v24.20.0` (win32 x64), Docker `v29.8.0` (build `88096ef`), Ollama `v0.40.8` (11 models installed, `qwen2.5-coder:3b` operational at `http://127.0.0.1:11434`).
- **Production Doctor**: `HEALTHY` (8/8 subsystems operational: Node runtime, Git CLI, filesystem, Docker sandbox, Ollama HTTP, SQLite WAL store, resource governance, advisory diagnostic feedback).
- **Benchmark Doctor**: `READY` (Host RAM 7813 MB; discrete accelerator: none; `qwen2.5-coder:3b` Q4_K_M fits within memory; larger models >= 14B infeasible).
- **Production Test Suite**: 140 / 140 passed (`tests/production/`).
- **End-to-End Workflow**: 1 / 1 passed (`tests/e2e/production-engineering-workflow.test.ts`).
- **Phase 99 Capability Fencing Suite**: 262 / 262 passed (`tests/integration/phase99-governed-capability-fencing.test.ts`).
- **Historical Phase 10H Integrity**: 36 / 36 records intact and byte-verified (`scripts/verify-phase10h-artifacts.ts`).
- **Working Tree Integrity**: Untracked research artifacts and ongoing user experiments preserved undisturbed.

---

## 2. V2.4 Evidence Audit

A comprehensive audit of [`scratch/production-v24-evaluation-results.json`](../../scratch/production-v24-evaluation-results.json) and [`docs/production/developer-utility-evaluation-v2.4.md`](../../docs/production/developer-utility-evaluation-v2.4.md) establishes the empirical baseline:

### 2.1 Audit Findings Matrix

| Audit Dimension | Measured Value | Verification Mechanism | Audit Finding & Classification |
| :--- | :---: | :--- | :--- |
| **Tasks Attempted** | 12 / 12 | Test runner execution records | **Confirmed**: 100% execution across 4 distinct functional categories. |
| **Autonomous Read-Only Assistance** | 5 / 5 | Git diff = 0 bytes, `ProductionVerifier` pass | **Confirmed**: Read-only tasks succeeded with zero working tree mutations. |
| **Human-Reviewed Edits** | 4 / 4 | `ApprovalControl` events + unit test pass | **Confirmed**: Model proposed exact anchors; human approved diff; test passed; sovereign verifier accepted. |
| **Fail-Closed Safety Protection** | 2 / 2 | `LineAnchoredEditor` throw + hash match | **Confirmed**: Hallucinated anchor (`task-11`) and ambiguous anchor (`task-12`) failed closed; 0 bytes diff. |
| **Static Diagnostics** | 1 / 1 | `SourceDiagnosticEngine` (`SYNTAX_ERROR`) | **Confirmed**: Syntax error identified in 1,156 ms; deliberate early abort before calling verifier. |
| **Replay Determinism** | 12 / 12 | `ProductionReplayEngine` (3 sweeps) | **Confirmed**: 100% bit-identical reconstruction across all 12 evidence bundles. |
| **Directly Measured Duration** | 206,712 ms | Wall-clock `Date.now()` timestamps | **Confirmed**: Actual elapsed time on local Intel Core i3-N305 CPU. |
| **Manual Workflow Baselines** | 30s – 60s | Developer estimate heuristics | **Unmeasured / Heuristic**: Baselines were derived from typical developer interaction times, NOT dual-stopwatch empirical trials. |
| **Generalization Beyond 12 Tasks** | N/A | Small sample size (N=12) | **Unverified**: Results establish feasibility on isolated micro-fixtures, but do not prove performance on large multi-file codebases. |

---

## 3. Verified and Unverified Claims

### 3.1 Verified Claims (Backed by Hard Cryptographic & Test Evidence)
1. **Zero Proposal Parsing Failures**: Structured proposal generation (`v1.8.0`) eliminated format ambiguity and schema rejection when the prompt provided concrete examples conforming to the schema.
2. **Zero Capability Fencing Bypasses**: The governance facade strictly restricted tools and capabilities (`READ_WORKSPACE` vs `WRITE_TEMPORARY_OUTPUT`), preventing unauthorized actions.
3. **Zero Autonomous Unreviewed Mutations**: In all mutation tasks, edits were gated by `ApprovalControl.requestApproval()` and required explicit human confirmation.
4. **Deterministic Fail-Closed Behavior**: When anchors were inaccurate or non-unique, the editor threw structured exceptions without touching the underlying source file.
5. **Cryptographic Integrity & Replayability**: All evidence bundles were deterministically reconstructed across 3 independent sweeps.

### 3.2 Unverified Claims (Must Not Be Claimed Without Empirical Dual-Trial Evidence)
1. *Claim: "Emerald provides an overall 2x developer productivity increase."*
   - **Status: UNVERIFIED**. The sample size was 12 micro-tasks, and the manual-workflow comparisons were heuristic approximations.
2. *Claim: "The 3B model is ready for autonomous multi-file repairs."*
   - **Status: REFUTED by ADR-0032 and V1.5–V2.0 evidence**. Local 3B models fail at multi-file localization and complex reasoning without human guidance.
3. *Claim: "Exact-anchor matching eliminates all patch application risks."*
   - **Status: UNVERIFIED in large codebases**. While exact-anchor matching guarantees zero unexpected mutations when it applies, it may experience high rejection rates (fail-closed) if surrounding context changes dynamically.

---

## 4. Proposed Task Selection (V2.5 Real-Workflow Evaluation)

To rigorously validate developer workflow utility without expanding the runtime architecture, 12 realistic development tasks are proposed. These tasks represent common, everyday engineering workflows in a dedicated non-critical evaluation workspace:

```mermaid
flowchart TD
    subgraph Suite["V2.5 Real-World Workflow Validation Suite (12 Tasks)"]
        direction TB
        C1["Code Understanding & Inspection (3 Tasks)<br/>rw-01: TTL Cache Invalidation<br/>rw-02: FSM Transition Map<br/>rw-03: Set Iteration Ordering"]
        C2["Diagnostic & Defect Localization (3 Tasks)<br/>rw-04: Sliding Window Off-by-One<br/>rw-05: Case-Sensitive HTTP Header<br/>rw-06: Premature Integer Division"]
        C3["Human-Reviewed Localized Edits (4 Tasks)<br/>rw-07: Config Port Number Coercion<br/>rw-08: Ring Buffer Empty Bounds Guard<br/>rw-09: Unhandled Stream Error Listener<br/>rw-10: Async Batch Await Resolution"]
        C4["Advisory & Safety Boundary Controls (2 Tasks)<br/>rw-11: Static Type Diagnostic Advisory<br/>rw-12: Destructive Proposal Human Rejection"]
    end
```

### 4.1 Detailed Task Specifications

| Task ID | Operational Category | Problem Summary & Target File | Proposed Action & Input | Acceptance Criteria | Correctness & Verification Method |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `rw-01` | **Code Understanding** | Review cache TTL expiration and eviction logic in `src/cache/ttl-cache.js`. | `read_file` with `path: "src/cache/ttl-cache.js"`. | Model extracts expiration formula; zero workspace mutation. | `ProductionVerifier` (expected modified files: 0), git diff = 0. |
| `rw-02` | **Code Understanding** | Analyze legal finite-state transitions in `src/fsm/lifecycle.js`. | `read_file` with `path: "src/fsm/lifecycle.js"`. | Model identifies terminal states; zero workspace mutation. | `ProductionVerifier` (expected modified files: 0), git diff = 0. |
| `rw-03` | **Code Understanding** | Explain intermittent test failure due to `Set` ordering in `src/queue/priority-set.js`. | `read_file` with `path: "src/queue/priority-set.js"`. | Model confirms insertion-order dependency; zero workspace mutation. | `ProductionVerifier` (expected modified files: 0), git diff = 0. |
| `rw-04` | **Defect Localization** | Locate boundary condition error in sliding window aggregator in `src/analytics/window.js`. | `read_file` with `path: "src/analytics/window.js"`. | Model pinpoints line with `<= array.length`; zero workspace mutation. | `ProductionVerifier` (expected modified files: 0), git diff = 0. |
| `rw-05` | **Defect Localization** | Identify why header lookup misses mixed-case headers in `src/http/headers.js`. | `read_file` with `path: "src/http/headers.js"`. | Model isolates unnormalized property lookup; zero workspace mutation. | `ProductionVerifier` (expected modified files: 0), git diff = 0. |
| `rw-06` | **Defect Localization** | Find premature integer division rounding in `src/billing/meter.js`. | `read_file` with `path: "src/billing/meter.js"`. | Model isolates `Math.floor` before unit multiplication; zero workspace mutation. | `ProductionVerifier` (expected modified files: 0), git diff = 0. |
| `rw-07` | **Human-Reviewed Edit** | Coerce environment variable `PORT` to number in `src/config/app-config.js`. | `edit_file_anchor` targeting `port: process.env.PORT || 8080,`. | Model proposes exact anchor; human reviews diff and approves; edit applies; test passes. | `node test/config.test.js` exit 0 + `ProductionVerifier`. |
| `rw-08` | **Human-Reviewed Edit** | Add empty guard to ring buffer pop in `src/data/ring-buffer.js`. | `edit_file_anchor` inserting `if (this.length === 0) return null;`. | Model proposes exact anchor; human reviews diff and approves; edit applies; test passes. | `node test/buffer.test.js` exit 0 + `ProductionVerifier`. |
| `rw-09` | **Human-Reviewed Edit** | Attach missing stream error listener in `src/io/stream-reader.js`. | `edit_file_anchor` inserting `stream.on('error', reject);`. | Model proposes exact anchor; human reviews diff and approves; edit applies; test passes. | `node test/stream.test.js` exit 0 + `ProductionVerifier`. |
| `rw-10` | **Human-Reviewed Edit** | Add missing `await` to `Promise.all` in `src/net/request-pool.js`. | `edit_file_anchor` changing `Promise.all(...)` to `await Promise.all(...)`. | Model proposes exact anchor; human reviews diff and approves; edit applies; test passes. | `node test/pool.test.js` exit 0 + `ProductionVerifier`. |
| `rw-11` | **Diagnostic Advisory** | Detect syntax/type error statically in `src/parser/config-parser.js`. | `run_diagnostic` via `SourceDiagnosticEngine`. | Static check detects syntax error in <= 2s; halts before verifier. | `DiagnosticResult.status === "SYNTAX_ERROR"`, verifier bypassed. |
| `rw-12` | **Rejection Gate** | Operator rejects proposal that attempts to weaken security in `src/auth/token.js`. | `edit_file_anchor` proposing to drop signature check. | Human inspects diff; explicitly rejects via `ApprovalControl`; runtime fails closed. | Approval denied; zero disk changes; file digest byte-identical. |

---

## 5. Measurement Methodology

To ensure scientific rigor and eliminate subjective grading, V2.5 will record both automated measurements and paired manual observations where feasible:

### 5.1 Metrics Recorded Per Task
1. **Emerald Elapsed Time (`T_emerald`)**: Exact wall-clock milliseconds from prompt dispatch to verifier completion.
2. **Model Proposal Time (`T_model`)**: Time spent in local Ollama inference.
3. **Human Review & Approval Time (`T_human`)**: Time spent by the operator inspecting the candidate diff and clicking approve/deny.
4. **Normal-Workflow Measurement (`T_normal`)**:
   - Where feasible, a human developer will execute the identical task manually (terminal command, editor navigation, manual edit, running test), clocked via timer.
   - If a fair manual comparison is not performed under identical conditions, the metric must be explicitly labeled **`NOT_MEASURED`**.
5. **Anchor Matching Accuracy**:
   - `EXACT_UNIQUE_MATCH` (1 occurrence).
   - `AMBIGUOUS_MATCH` (>1 occurrences).
   - `ANCHOR_NOT_FOUND` (0 occurrences).
6. **Manual Correction Count**: Number of times an operator had to re-prompt or manually edit the anchor before successful application.
7. **Task Correctness**: Evaluated strictly by independent task test execution (`node test/...`).
8. **Sovereign Verification**: Clean-room verification proof produced by `ProductionVerifier`.
9. **Replay Determinism**: 3-sweep bit-identical proof verification.

---

## 6. Acceptance Criteria & Stop Conditions

### 6.1 Task-Level Acceptance Criteria
- A task is marked **`PASS`** if and only if:
  1. The proposal conforms to the JSON schema without errors.
  2. Governance fences authorize the operation.
  3. For mutation tasks: the anchor matches uniquely, the human approves the diff, the edit applies cleanly, and the task test exits with code 0.
  4. For read-only tasks: working tree diff remains exactly 0 bytes.
  5. For safety/rejection tasks: the runtime fails closed, preserving byte-identical source files.
  6. `ProductionVerifier` or `SourceDiagnosticEngine` confirms the intended outcome.
  7. 3-sweep deterministic replay succeeds.
- Any task failing any of the above criteria is marked **`FAIL`**.
- Any task unable to run due to missing dependencies or unavailable tools is marked **`BLOCKED`**.

### 6.2 Pre-Execution Stop Conditions
Execution must NOT proceed if:
1. Operator authorization is not explicitly granted.
2. The Ollama local daemon is offline or `qwen2.5-coder:3b` is missing.
3. A production code modification is proposed during the validation run.
4. An attempt is made to execute tasks against the primary repository rather than isolated temporary workspaces.

---

## 7. Safety Requirements

1. **Workspace Isolation**: All tasks must be executed in isolated temporary directories (`os.tmpdir()/emerald-val-v25-*`) containing independent Git repositories. Zero modifications may touch the Emerald repository.
2. **Zero Automated Git Actions**: The agent fabric must never execute `git commit`, `git push`, `git checkout`, or remote sync.
3. **Mandatory Human Approval Gate**: All mutation-capable actions (`edit_file_anchor`, `write_file`) must pass through `ApprovalControl`. Unapproved proposals must fail closed immediately.
4. **Exact-Anchor Matching**: Fuzzy matching, Levenshtein approximations, and whole-file replacement fallbacks are strictly prohibited.
5. **No Secret Transmission**: Zero external network requests; zero API keys or credentials passed to model context.

---

## 8. Expected Evidence Artifacts

Upon authorized execution of this plan, the runner will generate:
1. `scratch/production-v25-validation-results.json`: Machine-readable records containing git baseline SHAs, task execution metrics, exact diffs, test outputs, verification proof hashes, and replay confirmations.
2. `docs/production/real-workflow-validation-v2.5.md`: Formal evaluation report detailing empirical results, paired timing comparisons, human intervention observations, and safety outcomes.

---

## 9. Limitations & Threats to Validity

1. **Host CPU Bottleneck**: Ollama inference on the Intel Core i3-N305 CPU averages 10–35s per proposal. This latency represents hardware execution limits, not algorithmic runtime overhead.
2. **Controlled Micro-Task Fixtures**: Tasks evaluate realistic programming patterns, but operate on single-file modules rather than monolithic enterprise repositories.
3. **Prompt Specificity**: Providing clean contextual examples maximizes 3B model proposal reliability. Open-ended or ambiguous user prompts will likely degrade anchor precision.

---

## 10. Recommended Next Decision

### Selected Decision: `CONTINUE_BOUNDED_PILOT`

**Justification**:
1. The V2.4 evaluation demonstrated 100% safety, 12/12 task success, and 0 manual corrections on bounded developer-in-the-loop tasks.
2. The V2.5 plan defines a concrete, non-speculative path to measure practical developer utility on realistic programming tasks without expanding runtime architecture or modifying production code.
3. Hardware constraints (7.63 GB RAM, CPU-only inference) are fully respected under ADR-0032.
4. Execution will remain halted pending operator authorization.

---
*Plan authored and baseline verified: 2026-10-22*
