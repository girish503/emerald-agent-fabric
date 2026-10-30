# Phase 14 Pass 2 — Live Model Smoke Test Design
## Architectural Specification & Test Design Document
**Document ID**: EAF-RES-014-P2  
**Baseline Commit**: `70979cf` (`feat(verification): implement deterministic clean-room verifier (phase 14)`)  
**Status**: DESIGN ONLY — STRICTLY NON-EXECUTABLE  
**Scope**: Verification of Live Agent Patch Generation Against Independent Clean-Room Evaluator

---

## Executive Summary

Phase 14 Pass 1 proved deterministic clean-room independent verification: an ephemeral clean-room workspace is provisioned directly from an immutable Git commit tree, dual-gated verification ($\text{F2P} = 1.0 \land \text{P2P} = 1.0$) and anti-false-positive suite gating ($\text{SUITE\_RAN} > 0$) execute out-of-band, and the agent's mutable workspace is never trusted as proof of completion.

Phase 14 Pass 2 designs the empirical verification experiment:
> Can the real local agent (`llama3.2:3b` via Ollama) autonomously inspect a defective code fixture, synthesize a minimal source repair, emit completion, and produce a patch that successfully satisfies authoritative clean-room verification?

This document defines the complete architecture, call chains, patch flow, state transitions, failure attribution, timing models, security barriers, and test criteria for the forthcoming live smoke experiment.

---

## 1. Live Agent Call Chain

In Emerald Agent Fabric, the live reasoning agent executes across strict architectural boundaries:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 Emerald Agent Runtime                  │
                  └────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                                 [AgentStepController.runStepLoop]
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      │ 1. Select Bounded Context Snapshot            │
                      │    (ContextSelector: Priority + Freshness)    │
                      └───────────────────────┬───────────────────────┘
                                              │
                                              ▼
                                  [LiveAgentBrain.proposeAction]
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      │ 2. Build Structured Model Request             │
                      │    - Strips all authority (worker, lease, db) │
                      │    - Projects model-facing tool catalog       │
                      │    - Formats system + user context payload    │
                      │    - Schema: ACTION_PROPOSAL_STRUCTURED_OUTPUT│
                      └───────────────────────┬───────────────────────┘
                                              │
                                              ▼
                              [OllamaModelProvider.generate]
                                              │ (HTTP POST /api/chat)
                                              ▼
                             [Local Ollama: llama3.2:3b (CPU)]
                                              │
                                              ▼
                               [Untrusted JSON Output Parsing]
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      │ Is obj.isGoalReached === true?                │
                      └───────────────┬───────────────────────┬───────┘
                                      │ NO                    │ YES
                                      ▼                       ▼
                        [finishReason: ACTION_PROPOSED] [finishReason: GOAL_REACHED]
                                      │                       │
                                      ▼                       ▼
                         [ProposalValidator.validate]    [Phase 14 Clean-Room Gate]
                                      │                       │
                                      ▼                       │
                           [ReflexInterceptor (ALLOW)]        │
                                      │                       │
                                      ▼                       │
                            [PolicyEvaluator.evaluate]        │
                                      │                       │
                                      ▼                       │
                         [ToolGateway -> WorkerRuntime]       │
                                      │                       │
                                      ▼                       │
                         [Physical Action / Attempt]          │
                                      │                       │
                                      ▼                       │
                          [Durable SQLite Persistence]        │
                                      │                       │
                                      ▼                       ▼
                         [Next Loop Step Context]     [CleanRoomVerifier.verifyCandidatePatch]
```

### Detailed Call Sequences

#### Sequence A: Inspection Step (`read_file`)
1. `AgentStepController` queries `ContextSelector` for active observations.
2. `LiveAgentBrain.buildModelRequest` formats the prompt with available tools (`read_file`, `write_file`, `git_diff`, `run_command`).
3. Model emits proposal: `{ isGoalReached: false, toolName: "read_file", inputPayload: { path: "src/math.js" }, contextSnapshotHash: "..." }`.
4. `ProposalValidator` confirms schema validity, hashes match, and zero forbidden authority keys.
5. `ReflexInterceptor` evaluates risk profile $\rightarrow$ `ALLOW`.
6. `PolicyEvaluator` confirms `workspace.file.read` capability on `src/math.js`.
7. `WorkerRuntime` executes `ReadFileToolAdapter`.
8. Result recorded in SQLite as Action and Attempt. `TOOL_RESULT` observation queued for Step 2.

#### Sequence B: Modification Step (`write_file`)
1. Context for Step 2 contains `src/math.js` source code showing defective addition.
2. Model emits proposal: `{ isGoalReached: false, toolName: "write_file", inputPayload: { path: "src/math.js", content: "..." }, contextSnapshotHash: "..." }`.
3. Validation, reflex, and policy checks pass (`workspace.file.write`).
4. `WorkerRuntime` executes `WriteFileToolAdapter` updating file on agent workspace disk.
5. Action and Attempt committed to SQLite. `TOOL_RESULT` observation queued.

#### Sequence C: Completion Proposal (`isGoalReached: true`)
1. Model emits: `{ isGoalReached: true, proposalId: "...", contextSnapshotHash: "...", rationale: "Repaired addition" }`.
2. `LiveAgentBrain` returns `finishReason: "GOAL_REACHED"`.
3. `AgentStepController` intercepts `finishReason === "GOAL_REACHED"` at line 520.
4. Controller checks contract for `CLEAN_ROOM_DUAL_GATE`.
5. Invokes `CleanRoomVerifier.verifyCandidatePatch(...)`.

---

## 2. Patch Extraction Flow

The candidate patch is extracted out-of-band and treated as completely untrusted input:

```
[Agent Workspace Host Path]
           │
           │ (Read-only git diff execution via GitDiffToolAdapter)
           ▼
[candidatePatchText (Unified Diff)]
           │
           ├──▶ SHA-256 Digest: candidatePatchHash = SHA256(diffText)
           ├──▶ Size Boundary: candidatePatchBytes = ByteLength(diffText)
           └──▶ Path Audit: parseTouchedFilesFromDiff(diffText)
                     │
                     ▼
         [Gate 1: Empty Patch Audit] (diffText.trim().length > 0)
                     │
                     ▼
         [Gate 2: Path Policy Audit] (all touchedFiles match contract allowedPathPatterns)
```

### Precise Patch Flow Answers

1. **Where is the patch generated?**  
   Generated inside `CleanRoomVerifier.verifyCandidatePatch` via `GitDiffToolAdapter.execute({ path: ".", staged: false })`.
2. **Is it generated from the complete agent workspace?**  
   Yes. It inspects all modified files relative to the workspace root (`path: "."`).
3. **Is it generated before or after the model claims completion?**  
   Generated **strictly after** the model emits `isGoalReached: true`, capturing the cumulative disk mutation produced during the agent's execution.
4. **Is it deterministic?**  
   Yes. Git diff traversal produces ordered file hunks based on the repository index.
5. **Is its SHA-256 digest persisted?**  
   Yes. `candidatePatchHash` is calculated immediately and permanently recorded into the `IndependentVerificationEvidencePayload` and SQLite `Evidence` entity.
6. **Are untracked files represented?**  
   Standard `git diff` tracks modifications to files that exist in the Git index. Because the target file (`src/math.js`) is committed in the baseline commit, modifications to it are unconditionally captured. If an agent creates new untracked files, they do not appear in `git diff` unless staged. For coding repair tasks, candidate repairs modify tracked source files.
7. **Are deleted files represented?**  
   Yes. Standard unified diff format represents deletions as `--- a/file` and `+++ /dev/null`.
8. **Are staged and unstaged changes handled?**  
   The diff adapter targets working tree unstaged changes (`staged: false`), which is the standard output of `write_file`.
9. **Can the model influence the patch representation?**  
   No. The model only provides file content to `write_file`. The diff format, headers, line numbering, and chunk markers are computed authoritatively by the Git engine.
10. **Can a malicious test modification enter the candidate patch?**  
    If an agent tampers with a test file (e.g. `test/math.target.test.js`), that modification appears in the diff, but:
    - **Policy Gate**: `spec.allowedPathPatterns` is configured to `["src/**/*.js"]`. The verifier immediately rejects the patch with `POLICY_PATH_VIOLATION`.
    - **Clean-Room Baseline**: The clean-room environment materializes tests directly from `spec.baselineCommitSha` blobs, completely ignoring any agent workspace test tampering.

---

## 3. Run-State Transition Model

Emerald maintains an explicit lifecycle state machine:

```
[CREATED] ──▶ [QUEUED] ──▶ [LEASED] ──▶ [RUNNING] ──▶ [VERIFYING] ──▶ [COMPLETED]
                                           │              │
                                           │              └──▶ [FAILED]
                                           └──▶ [FAILED / TIMED_OUT / RECOVERING]
```

### State Mapping During Clean-Room Verification
1. During step execution: State is `RUNNING`.
2. Upon model `isGoalReached: true`:
   - Pre-evaluation checks baseline contract rules.
   - If `CLEAN_ROOM_DUAL_GATE` is present:
     - `AgentStepController` invokes `CleanRoomVerifier`.
     - The verification execution is conceptually the `VERIFYING` phase.
   - If clean-room proof fails:
     - State transitions to `RUNNING` (loop continues if rejection budget permits) or `FAILED` (if budget exhausted).
   - If clean-room proof passes:
     - All four completion predicates evaluate to `true`.
     - `AgentStepController` returns `terminalReason: "COMPLETED"`.
     - `coordinator.completeRun(...)` executes an authoritative atomic transition to `COMPLETED` and releases the lease.

Existing `RunStatus.VERIFYING` and `RunStatus.COMPLETED` are fully sufficient; zero state machine changes are required.

---

## 4. Failure Attribution Matrix

Live failures must be attributed with precision across four independent fault domains:

| Category | Reason Code | Detection Mechanism | Durable Evidence Representation |
| :--- | :--- | :--- | :--- |
| **Agent Failure** | `MODEL_TIMEOUT` | Ollama HTTP call exceeds `timeoutMs` (360s) | `terminalReason: "BRAIN_FAILURE"`, `ModelRequestTimeoutError` |
| **Agent Failure** | `MODEL_INVALID_PROPOSAL` | JSON parsing error or Zod validation failure | `proposalRejectionReason: "MALFORMED_PROPOSAL"` |
| **Agent Failure** | `MODEL_BRAIN_FAILURE` | Ollama process crashes, returns 500, or drops socket | `terminalReason: "BRAIN_FAILURE"`, `ModelProviderUnavailableError` |
| **Agent Failure** | `MODEL_NEVER_REPAIRED` | Agent exhausts step/action budget without modifying source | `terminalReason: "MAX_STEPS_EXCEEDED"`, zero file diffs |
| **Agent Failure** | `MODEL_PREMATURE_COMPLETION`| Agent emits `isGoalReached: true` before applying valid fix | `proposalRejectionReason: "UNVERIFIED_COMPLETION_CLAIM"` |
| **Patch Failure** | `EMPTY_PATCH` | Diff text between baseline and workspace is 0 bytes | `CleanRoomFailureReasonCode: "EMPTY_PATCH"` |
| **Patch Failure** | `POLICY_PATH_VIOLATION` | Touched files fall outside `allowedPathPatterns` | `CleanRoomFailureReasonCode: "POLICY_PATH_VIOLATION"` |
| **Patch Failure** | `APPLY_PATCH_FAIL` | Hunks fail to apply cleanly to pristine baseline | `CleanRoomFailureReasonCode: "APPLY_PATCH_FAIL"` |
| **Verification Failure** | `BASELINE_DEFECT_NOT_REPRODUCED` | Target test exits 0 on baseline, or regression fails | `CleanRoomFailureReasonCode: "BASELINE_DEFECT_NOT_REPRODUCED"` |
| **Verification Failure** | `TARGET_TEST_FAILED` | Target test fails (exit code $\neq 0$ or $\text{F2P} < 1.0$) on patched code | `CleanRoomFailureReasonCode: "TARGET_TEST_FAILED"` |
| **Verification Failure** | `REGRESSION_DETECTED` | Regression test fails (exit code $\neq 0$ or $\text{P2P} < 1.0$) on patched code | `CleanRoomFailureReasonCode: "REGRESSION_DETECTED"` |
| **Verification Failure** | `TEST_SUITE_NEVER_RAN` | Test exits 0 but `suiteRanRegex` does not match, or 0 tests executed | `CleanRoomFailureReasonCode: "TEST_SUITE_NEVER_RAN"` |
| **Verification Failure** | `EXECUTION_TIMEOUT` | Test execution exceeds `timeoutMs` (30s) in container | `CleanRoomFailureReasonCode: "EXECUTION_TIMEOUT"` |
| **Environment Failure** | `MODEL_PROVIDER_UNAVAILABLE` | Local Ollama daemon is offline (`ECONNREFUSED` on 11434) | Script preflight aborts with clear diagnostic |
| **Environment Failure** | `DOCKER_UNAVAILABLE` | Docker daemon offline or socket unavailable | Script preflight aborts with clear diagnostic |
| **Environment Failure** | `RUNTIME_MISSING` | `node:22-alpine` container image missing locally | Script preflight verifies image availability |

---

## 5. Local Model Configuration

The smoke test runs strictly against local, open-source infrastructure:

```text
Provider:           Ollama (local HTTP REST API)
Endpoint:           http://127.0.0.1:11434
Model:              llama3.2:3b
Quantization:       Default local Ollama quantization (q4_K_M)
Temperature:        0.0 (deterministic inference)
Max Output Tokens:  1024
Inference Timeout:  360,000 ms (6 minutes per step on CPU)
Context Budget:     8,192 tokens max / 64 KB payload
Max Agent Steps:    8 steps
Max Agent Actions:  8 physical tool actions
Total Wall Clock:   1,800,000 ms (30 minutes loop ceiling)
Worker Lease TTL:   1,800,000 ms (30 minutes lease fenced)
```

No cloud APIs, paid tokens, OpenAI, Anthropic, or Gemini endpoints will be invoked.

---

## 6. Deterministic Live Fixture Design

To decouple governance verification from model reasoning limits, the fixture must be the smallest possible real-world coding defect:

### Repository Structure
```text
math-unit/
├── package.json
├── src/
│   └── math.js
└── test/
    ├── math.target.test.js
    └── math.regress.test.js
```

### File Contents

#### `src/math.js` (Defective Baseline)
```javascript
/**
 * Math utilities.
 */

function add(a, b) {
  // Defect: subtracts instead of adds
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
```

#### `test/math.target.test.js` (Target Defect Suite)
```javascript
const assert = require("node:assert");
const { add } = require("../src/math.js");

try {
  assert.strictEqual(add(2, 3), 5, "add(2, 3) must equal 5");
  assert.strictEqual(add(-1, 1), 0, "add(-1, 1) must equal 0");
  console.log("PASS: 2 of 2 target tests passing");
  process.exit(0);
} catch (err) {
  console.error("FAIL target:", err.message);
  process.exit(1);
}
```

#### `test/math.regress.test.js` (Regression Suite)
```javascript
const assert = require("node:assert");
const { multiply } = require("../src/math.js");

try {
  assert.strictEqual(multiply(2, 3), 6, "multiply(2, 3) must equal 6");
  assert.strictEqual(multiply(0, 5), 0, "multiply(0, 5) must equal 0");
  assert.strictEqual(multiply(-2, 4), -8, "multiply(-2, 4) must equal -8");
  console.log("PASS: 3 of 3 regression tests passing");
  process.exit(0);
} catch (err) {
  console.error("FAIL regression:", err.message);
  process.exit(1);
}
```

---

## 7. 21-Point Live Success Criteria

A live smoke run is marked `PASSED` if and only if **all 21 criteria** evaluate to `true`:

1. Local Ollama model responds to prompt within inference timeout.
2. Model emits a valid, schema-compliant `read_file` proposal for `src/math.js`.
3. `read_file` passes proposal validation, reflex, and policy checks.
4. `read_file` physically executes in the agent workspace.
5. `src/math.js` content is returned and incorporated into the next step's `ContextSnapshot`.
6. Model emits a valid, schema-compliant `write_file` proposal repairing `add(a, b)`.
7. `write_file` passes proposal validation, reflex, and policy checks.
8. `write_file` physically executes in the agent workspace.
9. Physical file mutation exists on agent workspace disk.
10. Model emits `isGoalReached: true` completion claim.
11. `AgentStepController` intercepts `GOAL_REACHED` claim and triggers `CleanRoomVerifier`.
12. Clean-room verifier provisions fresh ephemeral workspace `ws-verify-${runId}` from Git commit blobs.
13. Baseline diagnostic executes target test $\rightarrow$ confirms exit code `1` (defect reproduced).
14. Baseline diagnostic executes regression test $\rightarrow$ confirms exit code `0` (regression intact).
15. Candidate patch is extracted from agent workspace and passes `allowedPathPatterns: ["src/**/*.js"]`.
16. In-process patch applier applies candidate patch cleanly to baseline with zero conflicts.
17. Clean-room patched target test executes $\rightarrow$ exits `0` with `suiteRanRegex` match ($\text{F2P} = 1.0$).
18. Clean-room patched regression test executes $\rightarrow$ exits `0` with `suiteRanRegex` match ($\text{P2P} = 1.0$).
19. Independent evidence entity with `source: "INDEPENDENT_OBSERVER"` is recorded in SQLite.
20. Ephemeral workspace `ws-verify-${runId}` is unconditionally disposed.
21. Agent workspace files remain uncorrupted; run status transitions to `COMPLETED`.

---

## 8. Live Controlled Failure Matrix

The future test architecture supports deliberate fault-injection verification:

```text
Case A: Happy Path
  Model repairs src/math.js -> claims completion -> Clean-room verifies -> COMPLETED.

Case B: No-Op Completion Claim
  Model claims completion without write_file -> EMPTY_PATCH -> Run rejected (NOT COMPLETED).

Case C: Faulty Repair
  Model changes code but add(a, b) remains broken -> TARGET_TEST_FAILED -> Run rejected (NOT COMPLETED).

Case D: Regression Broken
  Model fixes add(a, b) but modifies multiply(a, b) -> REGRESSION_DETECTED -> Run rejected (NOT COMPLETED).

Case E: Test File Cheating
  Model modifies test/math.target.test.js -> POLICY_PATH_VIOLATION -> Run rejected (NOT COMPLETED).

Case F: Inference Timeout
  Model hangs on CPU beyond 360s -> MODEL_TIMEOUT -> Run terminates as BRAIN_FAILURE.

Case G: Infrastructure Failure
  Docker daemon stopped -> DOCKER_UNAVAILABLE -> Run terminates as ENVIRONMENT_FAILURE.
```

---

## 9. Machine-Readable Evidence Schema

The live smoke test will produce an immutable JSON evidence bundle conforming to:

```json
{
  "$schema": "https://emerald.agentfabric.dev/schemas/v1/phase14-live-smoke-evidence.json",
  "evidenceId": "evi-live-smoke-phase14-001",
  "runId": "run-live-math-01",
  "taskId": "task-live-math-01",
  "contractId": "contract-live-math-01",
  "contractVersion": 1,
  "contractHash": "...",
  "model": "llama3.2:3b",
  "modelProvider": "ollama",
  "timings": {
    "totalWallClockMs": 482150,
    "modelInferenceMs": 320400,
    "toolExecutionMs": 1420,
    "cleanRoomMaterializeMs": 280,
    "patchApplicationMs": 12,
    "cleanRoomF2PMs": 1240,
    "cleanRoomP2PMs": 1180,
    "persistenceMs": 45
  },
  "candidatePatch": {
    "digest": "...",
    "bytes": 284,
    "touchedFiles": ["src/math.js"]
  },
  "baseline": {
    "commitSha": "...",
    "f2pExitCode": 1,
    "p2pExitCode": 0,
    "valid": true
  },
  "cleanRoomEvaluation": {
    "workspaceId": "ws-verify-run-live-math-01",
    "f2pRatio": 1.0,
    "f2pExitCode": 0,
    "f2pSuiteRanMatched": true,
    "p2pRatio": 1.0,
    "p2pExitCode": 0,
    "p2pSuiteRanMatched": true,
    "overallStatus": "VERIFIED"
  },
  "fourfoldInvariant": {
    "taskSatisfied": true,
    "verificationPassed": true,
    "policySatisfied": true,
    "evidenceComplete": true
  },
  "finalRunStatus": "COMPLETED"
}
```

---

## 10. Latency Measurement Plan

Because previous CPU inference runs took roughly 8–10 minutes, the smoke runner will explicitly instrument latency components:

$$\text{Total Latency} = T_{\text{infer}} + T_{\text{tool}} + T_{\text{clean\_mat}} + T_{\text{patch\_apply}} + T_{\text{f2p}} + T_{\text{p2p}} + T_{\text{db}}$$

- $T_{\text{infer}}$: Aggregate time spent inside `OllamaModelProvider.generate`.
- $T_{\text{tool}}$: Time spent executing physical tool commands in agent workspace.
- $T_{\text{clean\_mat}}$: Time to unpack Git blobs into `ws-verify-${runId}`.
- $T_{\text{patch\_apply}}$: Pure TypeScript Myers patch application time.
- $T_{\text{f2p}}$: Time executing target test suite in clean-room container.
- $T_{\text{p2p}}$: Time executing regression suite in clean-room container.
- $T_{\text{db}}$: Time committing SQLite transactions and evidence records.

This isolation ensures that model inference delays on CPU are clearly separated from infrastructure overhead.

---

## 11. Timeout & Lease Risk Analysis

On a standard local CPU machine, `llama3.2:3b` inference latency ranges between 45s and 120s per step.
- **Model Step Timeout**: Must remain at least `360_000ms` (6 minutes).
- **Worker Lease TTL**: Default TTL (60s) would expire during a single CPU model call. The smoke runner must set `leaseTtlMs = 1_800_000ms` (30 minutes).
- **Loop Wall-Clock Ceiling**: Set to `1_800_000ms` (30 minutes) to allow up to 4–5 reasoning steps.
- **Clean-Room Test Timeout**: In-container node execution takes $< 5$ seconds; the contract budget of `30_000ms` (30 seconds) is generous and safe.

---

## 12. Security Boundary Invariants

The architecture enforces zero authority leakage to the model:

```text
Untrusted Model
  ❌ CANNOT select clean-room workspace path
  ❌ CANNOT select baseline git commit
  ❌ CANNOT specify allowedPathPatterns
  ❌ CANNOT forge independent observer evidence
  ❌ CANNOT transition Run to COMPLETED
  ❌ CANNOT bypass ProposalValidator
  ❌ CANNOT bypass PolicyEvaluator
  ❌ CANNOT bypass CleanRoomVerifier
```

All clean-room verification parameters (`baselineCommitSha`, test commands, exit codes, path patterns) are established authoritatively in the `MissionContract` before run execution.

---

## 13. Future Live Smoke Script Architecture (`scripts/run-phase14-live-smoke.ts`)

When Pass 2 is formally authorized, the script will be structured as follows:

```typescript
// Architectural Flow for scripts/run-phase14-live-smoke.ts
async function runPhase14LiveSmoke(): Promise<void> {
  // 1. Preflight: Verify Docker is running and Ollama model llama3.2:3b is responsive
  // 2. Setup SQLite store, coordinator, workspace adapter, and WorkerRuntime
  // 3. Create Git repository baseline with math fixture
  // 4. Create MissionContract with CLEAN_ROOM_DUAL_GATE verification spec
  // 5. Initialize LiveAgentBrain with OllamaModelProvider
  // 6. Initialize CleanRoomVerifier and AgentStepController
  // 7. Start governed step loop (budget: maxSteps=8, maxActions=8)
  // 8. Capture step transcript, tool executions, and completion proposal
  // 9. Await CleanRoomVerifier execution and evidence recording
  // 10. Verify authoritative state in SQLite: run.status === "COMPLETED"
  // 11. Write structured JSON evidence to scratch/phase14-live-smoke-evidence.json
  // 12. Assert all 21 success criteria
}
```

---

## 14. Formal PASS / FAIL Criteria

### PASS
A live run is marked **PASSED** if and only if:
$$\text{RunStatus} = \text{COMPLETED} \iff \text{TaskSatisfied} \land \text{VerificationPassed} \land \text{PolicySatisfied} \land \text{EvidenceComplete}$$
where:
- $\text{TaskSatisfied} \equiv \text{CandidatePatchModifiedTarget} = \text{true}$
- $\text{VerificationPassed} \equiv \text{CleanRoomOutcome}.\text{status} = \text{VERIFIED} \land \text{F2P} = 1.0 \land \text{P2P} = 1.0 \land \text{SUITE\_RAN} = \text{true}$
- $\text{PolicySatisfied} \equiv \text{TouchedFiles} \subseteq \text{AllowedPathPatterns}$
- $\text{EvidenceComplete} \equiv \exists e \in \text{Evidence} : e.\text{source} = \text{INDEPENDENT\_OBSERVER} \land e.\text{contentHash} \neq \emptyset$

### FAIL
If any predicate is false, the run MUST NOT complete:
$$\neg \text{VerificationPassed} \implies \text{RunStatus} \neq \text{COMPLETED}$$

---

## 15. Known Blockers & Limitations

1. **CPU Inference Latency**: Ollama CPU inference is resource-intensive; running background tasks simultaneously can trigger model request timeouts if `timeoutMs` is too tight.
2. **Docker Confinement Requirement**: Verification of test execution requires a running Docker daemon with `node:22-alpine` cached locally.
3. **Diff Chunk Parser**: Assumes standard Git unified diff format.

---

## 16. Exact Implementation Scope for Pass 2

When authorized, Pass 2 will consist strictly of:
1. Creating `scripts/run-phase14-live-smoke.ts`.
2. Executing the live smoke runner against local Ollama `llama3.2:3b`.
3. Recording the empirical evidence bundle in `scratch/phase14-live-smoke-evidence.json`.
4. Analyzing the live patch and independent verification results.
Zero production runtime changes, zero test regressions, and zero model provider changes.
