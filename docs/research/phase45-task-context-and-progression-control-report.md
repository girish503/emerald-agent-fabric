# Phase 45 — Empirical Research Report: Grounded Task Context, Progression Guidance, and Stagnation Control

## Executive Summary

Phase 45 investigated why local open-weights language models (`qwen2.5-coder:1.5b`) stalled in continuous, redundant `read_file` loops during Phase 44D despite having 100% grammar compliance under a 7-branch structured-output JSON Schema. The phase implemented and evaluated two architectural improvements:
1. **Grounded Task-Context Contract (Phase 45B)**: Prominently surfaced task titles, grounded defect explanations, target files, allowed modification boundaries, and exact verification/regression test commands into the model's outbound execution context.
2. **Bounded Progression Control (Phase 45C)**: Implemented deterministic tracking of consecutive identical reads, issuing a non-fatal progression advisory at two identical reads and enforcing hard stagnation termination at three identical reads without progress.

A single live trial of benchmark task `EAF-BM-01` was executed against local Ollama (`qwen2.5-coder:1.5b`) under strict fail-closed governance (`maxSteps: 5`, `maxProposalRejections: 3`, per-step timeout: 120s). The model proposed `read_file` on Step 1, repeated `read_file` on Step 2 (receiving the progression advisory), and repeated `read_file` on Step 3 despite having both the grounded defect instructions and the progression advisory in its context.

The runtime controller deterministically recognized stagnation and halted the trial before Step 4 with `terminalReason: "STAGNATION"`. This preempted Steps 4 and 5, saving 200,698 ms (48.7%) of runtime and 4,052 tokens (37.1%) relative to Phase 44D. No file modifications occurred, no patch was submitted, and the fail-to-pass test remained failing. The trial is classified as **`STAGNATION_TERMINATED`**. Cryptographic evidence integrity was verified by the offline auditor, but task correctness was not achieved.

---

## 1. Background & The Phase 44D Observation Loop Failure

In Phase 44 (documented in [`docs/research/phase44-structured-output-and-repair-loop-report.md`](../../docs/research/phase44-structured-output-and-repair-loop-report.md)), grammar-constrained structured output successfully eliminated the parameter-name hallucination (`filePath` vs `path`) that had caused repeated proposal rejections in Phase 43. 

However, during the live Phase 44D trial (`scratch/phase44d-repair-results.json`):
- The model proposed `read_file` for `src/calc.js` across all five allocated steps.
- Every proposal conformed to the schema and was authorized by runtime policy.
- The runtime controller observed five successful actions and detected zero errors.
- The trial ran until the hard ceiling `maxSteps: 5` halted execution with `terminalReason: "MAX_STEPS"`.
- Total wall-clock time reached 412,220 ms and consumed 10,921 tokens without a single edit proposed or executed.

---

## 2. Phase 45A: Read-Only Progression Diagnostic

Before modifying any source code, a comprehensive trace of prompt assembly, context construction, and controller execution was conducted (documented in [`docs/research/phase45-agent-progression-diagnostic.md`](../../docs/research/phase45-agent-progression-diagnostic.md)).

### Diagnostic Findings
1. **Target Content Was Never Lost**: In Step 1 of Phase 44D, `src/calc.js` was read successfully. Its full 125-byte content was serialized into a typed `TOOL_RESULT` observation and delivered into the model prompt for Steps 2 through 5. Context loss did not explain the repetition.
2. **Defect Details Were Omitted from Prompt**: In `Phase43BenchmarkRunner.executeTrial`, task registration supplied only `"Phase 43 Pilot Task: EAF-BM-01 (CODE_NAVIGATION)"`. Defect descriptions, failure logs, and test verification commands were stored in `MISSION_CONTEXT` payload JSON, but `LiveAgentBrain.buildModelRequest()` only rendered metadata (Task ID, Run ID, Sequence Number, Context Hash) under `## Task Execution Context`. The model was never instructed what defect to repair or what test must pass.
3. **No Stagnation Detection in Controller**: `AgentStepController` only tracked action execution failures (`consecutiveFailures`) and schema rejections (`proposalRejections`). Because identical reads succeeded with exit code 0, the controller treated the loop as healthy progress.

---

## 3. Phase 45B: Grounded Task-Context Contract & Progression Guidance

To eliminate model guessing and provide clear task objectives, Phase 45B established a typed, grounded contract from benchmark fixtures to prompt construction without modifying frozen benchmark definitions (`PHASE43_PILOT_TASKS`).

### Implementation Details
- **Benchmark Runner Registration**: In [`src/production/benchmark/phase43-benchmark-runner.ts`](../../src/production/benchmark/phase43-benchmark-runner.ts#L740-L766), `executeTrial()` constructs a grounded task description from invariant fixture fields:
  ```text
  Task: Core Arithmetic Off-by-One Fix
  Category: CODE_NAVIGATION
  Target File: src/calc.js
  Allowed Modification Scope: src/calc.js
  Objective: Repair the defect in 'src/calc.js'.
  Verification Criteria:
  - Verification test 'node test/f2p.test.js' must pass with exit code 0.
  - Regression test 'node test/p2p.test.js' must pass with exit code 0.
  ```
- **Context Injection**: In [`src/application/live-agent-brain.ts`](../../src/application/live-agent-brain.ts#L614-L627), `buildModelRequest()` extracts `taskDetails` from the `MISSION_CONTEXT` observation and injects `- Task Title: ...` and `\n### Task Objective & Criteria\n...` under `## Task Execution Context`.
- **Offline Contract Verification**: Authored [`tests/contract/task-context-contract.test.ts`](../../tests/contract/task-context-contract.test.ts). Verified across `EAF-BM-01`, `EAF-BM-02`, and `EAF-BM-03` that outbound model requests receive the exact criteria, navigation tasks without descriptions preserve baseline prompts, and benchmark fixtures remain immutable (3/3 tests passed).

---

## 4. Phase 45C: Bounded Stagnation Control Implementation

To prevent unbounded loops on repetitive actions, Phase 45C added deterministic stagnation detection and progression feedback to [`src/application/agent-step-controller.ts`](../../src/application/agent-step-controller.ts).

### Mechanisms
1. **Identical Read Tracking**: Tracks `consecutiveCount` for successful `read_file` actions where the relative file path, input argument hash (`inputHash`), and output content hash (`outputHash`) match the immediately preceding read action.
2. **Ephemeral Progression Advisory**: At `consecutiveCount === 2` (`REPEATED_IDENTICAL_READ_ADVISORY_THRESHOLD`), the controller creates an advisory observation (`SYSTEM_EVENT`, `feedbackKind: "REPEATED_IDENTICAL_READ"`):
   > *"The same read_file request for '<path>' returned identical content in consecutive successful actions. The information is already available in context; choose a justified next action or read a meaningfully different range/file."*
3. **Hard Stagnation Termination**: Added `maxConsecutiveIdenticalReads` (default: 3) to `StepControllerBudget`. If consecutive identical reads reach this threshold, the loop terminates before invoking the brain for the next step with:
   - `terminalReason: "STAGNATION"`
   - `terminalMessage: "Execution loop halted due to stagnation: 3 consecutive identical successful reads of '<path>' without progress"`
4. **Deterministic Counter Resets**: The stagnation counter resets to 1 if the model reads a different file path, reads a different line range, or if the file content on disk changes. The counter resets to 0 if any non-read tool executes (`write_file`, `search_code`, `run_command`, etc.) or if an action fails.
5. **Offline Test Verification**: Added Section 22 to [`tests/application/agent-step-controller.test.ts`](../../tests/application/agent-step-controller.test.ts#L1142-L1419) with 6 unit tests covering default ceiling termination, content change resets, range exploration, path exploration, intervening writes, and custom budget overrides (30/30 tests passed).

---

## 5. Live Empirical Evaluation: Phase 45C Trial

### 5.1 Trial Configuration
- **Suite**: [`tests/integration/phase45c-repair-live.test.ts`](../../tests/integration/phase45c-repair-live.test.ts)
- **Authoritative Record**: [`scratch/phase45c-repair-results.json`](../../scratch/phase45c-repair-results.json)
- **Benchmark Task**: `EAF-BM-01` (`src/calc.js` off-by-one arithmetic defect)
- **Model**: `qwen2.5-coder:1.5b` (local Ollama digest `d7372fd82851...`)
- **Budgets**: `maxSteps: 5`, `maxProposalRejections: 3`, `maxConsecutiveIdenticalReads: 3`, `stepTimeoutMs: 120,000`
- **Cost**: ₹0 (100% local CPU inference)

### 5.2 Step-by-Step Chronology
- **Step 1 (74,071 ms)**:
  - Model received prompt containing full task objective, criteria, and tool definitions.
  - Model proposed: `read_file` with `path: "src/calc.js"`.
  - Proposal validated (0 rejections), authorized, and executed. Full file content returned.
  - Stagnation state: `consecutiveCount = 1`.
- **Step 2 (62,565 ms)**:
  - Model received context containing Step 1 `TOOL_RESULT` with complete `src/calc.js` code.
  - Model proposed: `read_file` with `path: "src/calc.js"`.
  - Proposal validated and executed. Output was byte-for-byte identical.
  - Stagnation state: `consecutiveCount = 2`.
  - Controller generated `obs-progress-repeated-read-step-2` (`SYSTEM_EVENT`) with advisory message.
- **Step 3 (74,519 ms)**:
  - Model received context containing the `SYSTEM_EVENT` advisory explicitly stating the content is already in context and requesting a justified next action.
  - Model proposed: `read_file` with `path: "src/calc.js"`.
  - Proposal validated and executed. Output was byte-for-byte identical.
  - Stagnation state: `consecutiveCount = 3` (ceiling reached).
- **Termination (Before Step 4)**:
  - Controller evaluated budget check 7: `consecutiveIdenticalReads >= maxConsecutiveIdenticalReads` (3 >= 3).
  - Loop halted immediately without invoking the model for Steps 4 or 5.
  - Terminal Reason: `STAGNATION`.
  - Authoritative Status: `FAILED`.

### 5.3 Trial Telemetry & Resource Savings
| Metric | Phase 44D (Baseline) | Phase 45C (Progression Control) | Delta / Savings |
| :--- | :--- | :--- | :--- |
| **Model Invocations** | 5 | 3 | -2 calls (-40.0%) |
| **Model Steps Executed** | 5 | 3 | -2 steps (-40.0%) |
| **Wall-Clock Duration** | 412,220 ms (~6m 52s) | 211,522 ms (~3m 31s) | **-200,698 ms (-48.7%)** |
| **Prompt Tokens** | 10,269 | 6,504 | -3,765 tokens (-36.7%) |
| **Completion Tokens** | 652 | 365 | -287 tokens (-44.0%) |
| **Total Tokens** | 10,921 | 6,869 | **-4,052 tokens (-37.1%)** |
| **Proposal Rejections** | 0 | 0 | 0 (100% schema compliant) |
| **Write Actions** | 0 | 0 | 0 |
| **Candidate Patch** | 0 bytes | 0 bytes | 0 bytes |
| **Target File Modified** | False | False | False (zero unauthorized writes) |
| **F2P Test Status** | Failed (exit code 1) | Failed (exit code 1) | Failed (exit code 1) |
| **Clean-Room Verification** | Dual-gate: `false` | Dual-gate: `false` | Not triggered |
| **Terminal Reason** | `MAX_STEPS` (exhausted) | **`STAGNATION`** (preempted) | Bounded fail-closed halt |
| **Classification** | `REPAIR_FAILED` | **`STAGNATION_TERMINATED`** | Graceful progression halt |

---

## 6. Evidence Integrity vs Task Correctness

A critical architectural distinction in Emerald Agent Fabric is separating evidence integrity from task correctness:

1. **Evidence Integrity: VERIFIED**
   - The trial produced Evidence Bundle `b397b43953b2904338db9ba2d64afb5509559f47b8615669eb38385b66df63c9`.
   - Contains 29 canonical domain events covering run creation, lease acquisition, action executions, observation captures, and terminal transition.
   - Dual-signed with valid Ed25519 signatures from `WORKER_PRODUCER` and `SUPERVISOR`.
   - Provenance root: `6d28c386b644affb0aae537e4620d5bb12372935d8067223c4120d5cb4335ecf`.
   - Independent [`OfflineAuditor`](../../src/application/offline-auditor.ts) verified the bundle with status `VERIFIED` (`thresholdSatisfied: true`, `failures: []`).
2. **Task Correctness: UNVERIFIED / FAILED**
   - The model never proposed `write_file`.
   - The candidate patch length was 0 bytes.
   - `src/calc.js` remained in its baseline state (`function add(a, b) { return a + b + 1; }`).
   - The Fail-to-Pass verification test (`node test/f2p.test.js`) was not satisfied.
   - Clean-room dual-gate verification remained `false`.

The system's governance and evidence pipeline operated correctly by recording an unforgeable, audited proof that the agent stalled in observation and was halted without modifying the software environment.

---

## 7. Comparative Evolution: Phase 43 through Phase 45

```
Phase 43 (Prompting Only)
   │
   ├── Model hallucinates parameter name ("filePath" instead of "path")
   ├── ProposalValidator rejects proposal (.strict() Zod schema)
   ├── Model enters recovery loop, edits string values instead of keys
   └── Loop halts at 3 proposal rejections (REJECTION_LIMIT_EXCEEDED)

Phase 44 (Structured Output JSON Schema)
   │
   ├── GBNF grammar forces JSON output into 1 of 7 valid branches
   ├── 0 proposal rejections; model emits valid "path"
   ├── Model proposes read_file on Step 1, receives file content in context
   ├── Model repeatedly proposes read_file on Steps 2, 3, 4, 5
   └── Loop exhausts 5-step budget (MAX_STEPS in 412s)

Phase 45 (Task Context + Bounded Progression Control)
   │
   ├── Prompt supplies grounded defect description and verification test criteria
   ├── Model proposes read_file on Step 1 (count: 1)
   ├── Model repeats read_file on Step 2 (count: 2) -> Advisory injected for Step 3
   ├── Model ignores advisory and repeats read_file on Step 3 (count: 3)
   └── Controller halts loop before Step 4 (STAGNATION in 211s, -48.7% time, -37.1% tokens)
```

---

## 8. Remaining Uncertainties & Research Boundaries

The experimental evidence from Phases 43, 44, and 45 establishes several precise boundaries:

1. **Model Scope Limitation**: These trials evaluate `qwen2.5-coder:1.5b` with specific system instructions, tool definitions, and temperature settings on `EAF-BM-01`. These findings demonstrate repeated observation stagnation for *this specific configuration*, not a universal limitation of all sub-2B models or all small models generally.
2. **Action-Selection vs Parameter Compliance**: Grammar-constrained structured output completely solves parameter-level syntactic validity, but does not solve semantic action selection. A model constrained to valid JSON can still generate valid calls to the wrong tool.
3. **Passive Inspection Bias**: Small models pre-trained heavily on code completion or chat may default to passive file reading when given an open tool palette containing `read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, and `run_command`. Providing advisory observations in natural language was insufficient to redirect `qwen2.5-coder:1.5b` away from its preferred read action.
4. **Tool Palette Surface Area**: Exposing six tools simultaneously may dilute the probability mass across tool selection branches. Evaluating whether narrowing the available tools (e.g., dynamically removing `read_file` once the file is fully cached in context, or presenting a two-phase "inspect then edit" tool interface) remains an open research question.
5. **Model Scale vs Architectural Support**: Whether a 3B+ parameter model (such as `qwen2.5-coder:3b` or `granite3-dense:2b`) would transition to `write_file` under identical prompts, or whether it requires accelerator support (GPU/Metal) to avoid CPU timeouts observed in Phase 43 Gate B.4, remains unverified.

---

## 9. Conclusion & Next Recommendation

Phase 45 successfully established grounded task-context propagation and bounded progression control. The runtime controller proved capable of detecting observation stagnation and terminating redundant execution deterministically, saving significant time and token budget while maintaining 100% fail-closed safety and cryptographic evidence integrity.

**Highest-Value Next Action**:
- Submit Phase 45 documentation for review.
- Prioritize an offline structural exploration of **Active Tool Masking / Dynamic Tool Availabilities** (disallowing `read_file` for paths already present in context snapshot memory) to determine if removing the redundant action branch forces model progression toward code modification before authorizing further live inference trials.
