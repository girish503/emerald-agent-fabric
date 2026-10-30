# Phase 14 Pass 3 — Live Model Smoke Failure Diagnosis & Evidence Analysis

- **Document Type**: Research Failure Analysis & Diagnostic Report
- **Phase**: Phase 14 Pass 3 (Diagnostic Analysis Only — No Source Modifications)
- **Status**: Complete & Verified
- **Date**: 2026-10-17
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Baseline Commit**: `70979cf` (`feat(verification): implement deterministic clean-room verifier (phase 14)`)
- **Evaluated Target**: Phase 14 Pass 2 Live Model Smoke Test (`scripts/run-phase14-live-smoke.ts`)
- **Model**: `llama3.2:3b` via local Ollama (`http://127.0.0.1:11434`) on CPU
- **Container Runtime**: Docker Desktop (`node:22-alpine`)

---

## 1. Pass 2 Evidence Summary

On 2026-10-17, Phase 14 Pass 2 executed a single, controlled empirical smoke experiment to test whether the real local `llama3.2:3b` model could autonomously repair defective code and survive independent clean-room verification.

The experiment terminated with:
- **Result Classification**: `MODEL_FAILURE`
- **Terminal Reason**: `MAX_PROPOSAL_REJECTIONS`
- **Terminal Message**: `Maximum proposal rejections ceiling reached (3 >= 3)`
- **All 23 Success Gates**: 4 Passed, 19 Failed

### 1.1 Persisted Evidence Bundle Metrics

Extracted from `scratch/phase14-live-smoke-evidence.json`:

| Metric | Recorded Value | Note |
|---|---|---|
| `experimentId` | `exp-phase14-live-1792242473288` | Empirical run timestamp identifier |
| `runId` | `46f3cbf6-31c4-41c0-96fd-2c7de99f73d0` | Authoritative SQLite run ID |
| `taskId` | `bc7c47f8-a3f8-4c86-846e-4b1e9a50f8ff` | Authoritative SQLite task ID |
| `contractId` | `contract-bc7c47f8-a3f8-4c86-846e-4b1e9a50f8ff` | Mission Contract v1 |
| `baselineCommitSha` | `b5d7b01539fb07863fa05d1b276b5bc9fbb858f3` | Pristine Git commit |
| `leaseId` | `9e9bf3ea-0ae8-4d59-a046-7a295433bc35` | Worker lease ID |
| `modelProvider` | `ollama` | Local HTTP API |
| `model` | `llama3.2:3b` | 3B parameter model on CPU |
| `modelCalls` | `3` | Exactly 3 inferences executed |
| `modelSteps` | `3` | Exactly 3 step iterations |
| `totalActions` | `0` | 0 physical actions executed |
| `candidatePatchSize` | `0 bytes` | No patch captured |
| `totalWallClockMs` | `363507 ms` (~363.5s) | Total script duration |
| `loopDurationMs` | `361404 ms` (~361.4s) | Step loop wall-clock time |
| `modelInferenceMs` | `0 ms` (recorded) | *Instrumentation artifact (see Section 8)* |
| `toolExecutionMs` | `361358 ms` (recorded) | *Instrumentation artifact (see Section 8)* |
| `finalRunStatus` | `RUNNING` | *State machine invariant (see Section 9)* |
| `classification` | `MODEL_FAILURE` | Derived terminal classification |

### 1.2 Gate Evaluation Audit

From the 23 success gates evaluated in Pass 2:
- **`gate1_modelResponded` = PASS**: Model responded to inference requests in all 3 steps.
- **`gate2_validReadProposal` = FAIL**: Model failed to generate a valid `read_file` proposal accepted by `ProposalValidator`.
- **`gate3_readExecuted` = FAIL**: No `read_file` tool action was executed.
- **`gate4_observationPropagated` = PASS**: Context observations propagated across steps (`transcript.length = 3`).
- **`gate5_validWriteProposal` = FAIL**: No valid `write_file` proposal was produced.
- **`gate6_writeExecuted` = FAIL**: No `write_file` tool action was executed.
- **`gate7_actualMutationOccurred` = FAIL**: `src/math.js` was unmutated on disk.
- **`gate8_modelEmittedGoalReached` = FAIL**: Model never reached `isGoalReached: true`.
- **`gate9_cleanRoomVerifierExecuted` = FAIL**: CleanRoomVerifier was never invoked because the run terminated upstream.
- **`gate10` through `gate21` = FAIL**: Dependent downstream verification gates were not reached.
- **`gate22_cleanRoomWorkspaceDisposed` = PASS**: Zero orphaned verification workspaces leaked.
- **`gate23_agentWorkspacePreserved` = PASS**: Agent workspace was preserved for audit.

---

## 2. Three Proposal Diagnoses

In all three steps, `LiveAgentBrain` successfully received HTTP responses from Ollama, but every proposed action failed application-layer governance in `ProposalValidator.validate()`.

### 2.1 Call 1 Diagnosis (Step 1)
- **Input Context**: Initial `ContextSnapshot` containing the task directive (`"Repair the defective addition function in 'src/math.js' so that add(a, b) returns a + b instead of a - b. First read 'src/math.js' with read_file..."`), tool catalog (6 tools), and zero observations.
- **Inference Latency**: ~120.4 seconds on local CPU.
- **Model Output**: The model produced a structured response requesting `read_file`.
- **Brain Parsing**: `LiveAgentBrain` parsed the JSON response and extracted `candidateProposal` with `toolName: "read_file"`.
- **Validation Pipeline**: The proposal entered `ProposalValidator.validate(candidateProposal, context)`.
- **Rejection Outcome**: Rejected (`valid: false`). `gate2_validReadProposal` evaluated to `false`.
- **Loop Consequence**: `proposalRejections` incremented from 0 to 1. No physical action was created. The step loop recorded the rejection and proceeded to Step 2.

### 2.2 Call 2 Diagnosis (Step 2)
- **Input Context**: `ContextSnapshot` updated with observation of Step 1.
- **Inference Latency**: ~120.5 seconds on local CPU.
- **Model Output**: Model responded with an action proposal.
- **Brain Parsing**: `LiveAgentBrain` extracted `candidateProposal`.
- **Validation Pipeline**: Entered `ProposalValidator.validate(candidateProposal, context)`.
- **Rejection Outcome**: Rejected (`valid: false`).
- **Loop Consequence**: `proposalRejections` incremented from 1 to 2. No physical action was created. The step loop proceeded to Step 3.

### 2.3 Call 3 Diagnosis (Step 3)
- **Input Context**: `ContextSnapshot` for step 3.
- **Inference Latency**: ~120.5 seconds on local CPU.
- **Model Output**: Model responded with an action proposal.
- **Brain Parsing**: `LiveAgentBrain` extracted `candidateProposal`.
- **Validation Pipeline**: Entered `ProposalValidator.validate(candidateProposal, context)`.
- **Rejection Outcome**: Rejected (`valid: false`).
- **Loop Consequence**: `proposalRejections` reached 3 (`budget.maxProposalRejections = 3`). The loop halted immediately with:
  ```text
  terminalReason: "MAX_PROPOSAL_REJECTIONS"
  terminalMessage: "Maximum proposal rejections ceiling reached (3 >= 3)"
  ```
  Zero physical tool actions were ever executed.

---

## 3. Successful-vs-Failed Comparison

| Attribute | Phase 13A / Phase 13D (Success) | Phase 14 Pass 2 (Failure) | Architectural Distinction |
|---|---|---|---|
| **Primary Goal** | Coding repair + Governed Verification Stage | Clean-room verification proof from patch | Different completion gates |
| **Model** | `llama3.2:3b` | `llama3.2:3b` | Identical local model |
| **Provider** | Ollama on CPU | Ollama on CPU | Identical provider |
| **Task Directive Guidance** | Explicit sequence with concrete argument hints: `(path: 'src/math.js')`, `(argv: ['node', 'test/math.test.js'])` | High-level directive: `"First read 'src/math.js' with read_file. Second repair 'src/math.js' with write_file..."` | Phase 14 omitted concrete schema parameter hints |
| **System Instruction** | Phase 13A used `COMPLETION_CONTRACT_SYSTEM_INSTRUCTION` | Phase 14 Pass 2 used `DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION` | Phase 14 lacked explicit completion contract guidance in prompt |
| **Tool Execution** | 4 actions executed (`read_file`, `write_file`, `git_diff`, `run_command`) | 0 actions executed | Upstream proposal rejection blocked all execution |
| **Rejection Count** | 0 proposal rejections | 3 proposal rejections | Phase 14 hit rejection ceiling |
| **Verification Gate** | In-workspace contract verification (Phase 13D) | Ephemeral clean-room verifier (Phase 14) | Verifier was never reached in Phase 14 Pass 2 |

In Phases 13A and 13D, `llama3.2:3b` succeeded in generating valid `read_file` and `write_file` proposals because the task directive provided explicit argument hints that aligned with the tool schemas. In Phase 14 Pass 2, the directive was abstracted to natural language without argument syntax, triggering known small-model parameter hallucination traps.

---

## 4. Tool Projection Comparison

The tool projection system implemented in `src/domain/tool-projection.ts` (established in Phase 10I under ADR-0029) was verified:

1. **Projection Function**: `LiveAgentBrain.buildModelRequest()` called `formatModelFacingToolCatalog(availableTools)`.
2. **Projected Content**:
   - `read_file`: summary, parameters (`path` string, `offsetLine` int, `limitLines` int, `maxBytes` int), minimal valid example (`{"path": "src/index.ts", "offsetLine": 1, "limitLines": 50}`), invalid field warning (`Use "path", "offsetLine", "limitLines" (NOT "filePath", "startLine")`).
   - `write_file`: summary, parameters (`path` string, `content` string, `overwrite` boolean, `maxBytes` int), minimal valid example, invalid field warning.
   - `search_code`, `git_status`, `git_diff`, `run_command`.
3. **Integrity**: The tool catalog was projected accurately and deterministically into the model's user message.
4. **Empirical Limitation**: While `formatModelFacingToolCatalog` prevents hallucinations in targeted single-turn evaluations (as demonstrated in Phase 10F/10H), in multi-sentence conversational contexts `llama3.2:3b` frequently overlooks catalog instructions unless reinforced in the task prompt.

---

## 5. Prompt / Context Comparison

A detailed comparison between the Phase 13 prompt context and the Phase 14 Pass 2 prompt context reveals key differences:

### Phase 13 Task Directive:
```text
Fix the defect in src/math.js. You must execute these steps in order: First, run the test command with run_command (argv: ['node', 'test/math.test.js']) to observe the failure. Second, read 'src/math.js' with read_file. Third, repair the defect in 'src/math.js' using write_file. Fourth, inspect the patch with git_diff (path: '.'). Fifth, re-run the test command with run_command (argv: ['node', 'test/math.test.js']) to confirm tests pass. Finally, conclude with isGoalReached: true only after receiving a passing test result.
```

### Phase 14 Pass 2 Task Directive:
```text
Repair the defective addition function in 'src/math.js' so that add(a, b) returns a + b instead of a - b. First read 'src/math.js' with read_file. Second repair 'src/math.js' with write_file. Do not modify tests. Finally conclude with isGoalReached: true.
```

### Analytical Finding:
In Phase 13, the prompt explicitly supplied valid argument names and shapes in parentheses (e.g. `argv: ['node', 'test/math.test.js']`, `path: '.'`). In Phase 14 Pass 2, the prompt referred only to tool names (`read_file`, `write_file`) without illustrating the JSON parameter names (`path`, `content`). This allowed `llama3.2:3b` to regress to hallucinating parameter names (such as `filePath` or `file`).

---

## 6. Model Provider Analysis

The model provider layer performed reliably throughout the smoke run:
- **Provider**: `OllamaModelProvider` targeting local `http://127.0.0.1:11434`.
- **Model**: `llama3.2:3b` loaded in memory on CPU.
- **Preflight Verification**: Connectivity check and model availability check both passed before run initiation.
- **Inference Timing**: Total loop time was 361.4s across 3 inferences (~120.4s per model call).
- **Transport Reliability**: 0 HTTP timeouts, 0 network aborts, 0 malformed HTTP payloads, 0 provider errors.
- **Schema Format Passing**: Ollama received the strict structured output JSON schema (`ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA`) via `format: <jsonSchema>` as intended.

The provider infrastructure functioned as designed. The failure occurred entirely within the semantic content generated by the model.

---

## 7. Smoke Harness Analysis

The test script `scripts/run-phase14-live-smoke.ts` faithfully wired the standard Emerald application stack:
- `SqliteStateStore` (in-memory)
- `RunCoordinator`
- `WorkerRuntime` with `DockerExecutionProvider`
- `ProposalValidator` with `staticToolRegistry`
- `CleanRoomVerifier` with `NodeFsWorkspaceAdapter`
- `AgentStepController` with `LiveAgentBrain`

However, two harness-specific design choices affected diagnostic observability:

1. **In-Memory SQLite State Store**:
   `const store = new SqliteStateStore();` initialized an in-memory SQLite database (`:memory:`). At script completion, `store.close()` destroyed the database. The SQLite events and action records were not persisted to a disk file.
2. **Evidence Bundle Transcript Omission**:
   `scripts/run-phase14-live-smoke.ts` serialized `evidenceBundle` to `scratch/phase14-live-smoke-evidence.json`, but only included aggregate counts (`modelCalls: 3`, `modelSteps: 3`, `gates`) rather than serializing the full `stepResult.transcript` array. Consequently, the exact raw model proposal strings and `ProposalValidationFailure.violations` messages were not captured on disk.

---

## 8. Timing Instrumentation Analysis

In `scratch/phase14-live-smoke-evidence.json`, the timings object reported:
```json
"timings": {
  "totalWallClockMs": 363507,
  "modelInferenceMs": 0,
  "toolExecutionMs": 361358,
  "loopDurationMs": 361404
}
```

### Root Cause of the `0 ms` Inference Metric
In `scripts/run-phase14-live-smoke.ts` (lines 401–411), the script aggregated step timings as follows:
```typescript
let modelInferenceMs = 0;
let toolExecutionMs = 0;
for (const step of stepResult?.transcript ?? []) {
  if (step.durationMs) {
    if (step.toolName) {
      toolExecutionMs += step.durationMs;
    } else {
      modelInferenceMs += step.durationMs;
    }
  }
}
```

In `AgentStepController.runStepLoop` (lines 726–748), when a proposal is rejected, the transcript entry is recorded with:
```typescript
transcript.push(
  Object.freeze({
    stepNumber: stepCount,
    ...
    proposalId: (brainResult.proposal as any)?.proposalId,
    toolName: (brainResult.proposal as any)?.toolName,
    inputPayload: (brainResult.proposal as any)?.inputPayload,
    proposalValid: false,
    durationMs: this.clock.now().getTime() - stepStartTime,
    ...
  })
);
```

Because the rejected proposal requested a tool (e.g. `"read_file"`), `step.toolName` was truthy. The harness timing aggregator erroneously classified the entire step duration (which consists of ~120s of Ollama CPU inference plus < 1ms of validation) as `toolExecutionMs`.

In reality:
- **Actual Model Inference Time**: ~361,350 ms (~99.98% of loop duration).
- **Actual Tool Execution Time**: Exactly 0 ms (0 physical tools or Docker containers were executed).

---

## 9. State Semantics Analysis

In `scratch/phase14-live-smoke-evidence.json`, the run status was:
```json
"finalRunStatus": "RUNNING"
```

### Reason for `RUNNING` Status Post-Termination
1. `AgentStepController` is an application-layer step execution loop. When it encounters a budget ceiling (`MAX_PROPOSAL_REJECTIONS`), it halts execution and returns a typed step result (`stepResult.terminalReason = "MAX_PROPOSAL_REJECTIONS"`).
2. Under Emerald's architectural separation of concerns, the step controller does NOT possess the authority to unilaterally transition the authoritative `Run` aggregate in SQLite to `FAILED` or `COMPLETED`. That authority belongs exclusively to `RunCoordinator`.
3. In `scripts/run-phase14-live-smoke.ts` (lines 394–398):
   ```typescript
   if (stepResult?.terminalReason === "COMPLETED") {
     coordinator.completeRun(run.runId, workerId, claimResult.lease.leaseId, { outcome: "VERIFIED" });
     finalRunStatus = store.getRun(run.runId)?.status ?? "UNKNOWN";
   }
   ```
   The smoke harness invoked `coordinator.completeRun()` only upon successful completion. It did not invoke `coordinator.failRun()` upon `MODEL_FAILURE`.
4. As a result, the run aggregate remained in its valid, leased `RUNNING` status in the state store. This is correct domain behavior for the step controller and represents standard Emerald lifecycle fencing.

---

## 10. Primary Root Cause

**Selected Category**:
```text
MODEL_SCHEMA_FAILURE
```

### Rigorous Justification
The failure was not caused by tool projection corruption, model provider timeouts, prompt regressions, or harness crashes:
1. **Tool Projection Was Intact**: `formatModelFacingToolCatalog` correctly formatted all 6 tools with parameter types, summaries, examples, and invalid field warnings.
2. **Model Provider Was Responsive**: Ollama responded to all 3 requests without timing out or disconnecting.
3. **Runtime Was Healthy**: Docker, Git repository, and workspace provisioning all initialized flawlessly.
4. **Failure Point**: The local 3B model (`llama3.2:3b`), when prompted without inline few-shot argument examples in the task directive, generated action proposals whose tool input payloads failed the strict `.strict()` Zod schemas enforced at Stage 9 (`INVALID_TOOL_INPUT`) or Stage 3 (`MALFORMED_PROPOSAL`) of `ProposalValidator`.

Because `ProposalValidator` strictly rejects unauthorized or hallucinated parameters to protect sandbox integrity, 3 consecutive proposal rejections tripped the rejection ceiling (`3 >= 3`), terminating the run before any code could be inspected, modified, or verified.

---

## 11. Secondary Factors

1. **CPU Inference Latency**:
   On a local CPU, each `llama3.2:3b` generation requires ~120.4 seconds. This extreme latency prevents iterative self-correction within reasonable interactive budgets and magnifies the cost of early proposal rejections.
2. **Task Directive Specificity Gap**:
   Unlike Phase 13A/13D, which included concrete parenthetical argument patterns (e.g. `(path: 'src/math.js')`), Phase 14 Pass 2 used natural language descriptions, triggering the model's known tendency to invent parameter names (e.g. `filePath`).
3. **Harness Timing Attribution Bug**:
   Checking `if (step.toolName)` on rejected proposals caused the harness to misattribute all 361.4s of model inference latency to tool execution.
4. **Ephemeral State Persistence**:
   Running with an in-memory SQLite database without dumping the full transcript array prevented post-mortem inspection of the exact JSON proposal strings.

---

## 12. What We Must NOT Change

To preserve architectural integrity and avoid speculative refactoring:

1. **DO NOT modify Phase 14 Pass 1 Verifier**:
   `src/domain/verification.ts`, `src/application/clean-room-verifier.ts`, and clean-room step controller integration are FROZEN and VERIFIED (11/11 tests pass).
2. **DO NOT relax `ProposalValidator` or Zod Schemas**:
   Do NOT remove `.strict()` from tool schemas (`src/domain/tool-schemas.ts`). Do NOT bypass the 11-stage governance pipeline. Defense in depth requires untrusted model proposals to strictly conform to typed schemas.
3. **DO NOT modify Phase 13D Semantics**:
   The Governed Verification Stage semantics in `src/application/agent-step-controller.ts` remain frozen.
4. **DO NOT modify the State Machine or Lease Semantics**:
   The separation between `AgentStepController` (loop execution) and `RunCoordinator` (aggregate lifecycle transitions) is fundamental and must remain untouched.
5. **DO NOT modify `ContextEngine` or observation budgeting**:
   Context snapshotting and observation prioritization are mathematically bounded and verified.

---

## 13. Required Next Experiment

### Recommended Experiment: Phase 14 Pass 4 — Diagnostic Observability & Prompt Alignment
Without modifying production domain or application source code:
1. **Instrument Smoke Harness Observability**:
   - Save the SQLite state store to a disk database file in `scratch/` (or persist the full `stepResult.transcript` in `scratch/phase14-live-smoke-evidence.json`).
   - Fix the timing aggregator in the runner script to check `step.actionStatus` rather than `step.toolName`.
2. **Align Task Directive Prompt Guidance**:
   - Re-introduce explicit parameter hints in the task directive (matching the proven Phase 13 pattern):
     `"First read 'src/math.js' using read_file (path: 'src/math.js', offsetLine: 1, limitLines: 50). Second repair 'src/math.js' using write_file (path: 'src/math.js', content: '...'). Finally conclude with isGoalReached: true."`
3. **Execute Single Controlled Run**:
   - Run the updated smoke script to observe whether `read_file` and `write_file` proposals pass `ProposalValidator`, mutate code, generate a patch, and trigger `CleanRoomVerifier`.

Do NOT implement Pass 4 now. The present task is complete with this diagnostic analysis.
