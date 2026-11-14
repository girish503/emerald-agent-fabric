# Phase 14: Independent Verification and Clean-Room Proof
## Architecture and Research Design Specification

**Document ID**: `EAF-RES-014`  
**Date**: 2026-10-17  
**Status**: APPROVED RESEARCH DESIGN (Implementation Strictly Deferred)  
**Baseline Frozen Commit**: `11c4208` (`feat(agent): implement governed verification stage (phase 13d)`)  
**Parent Baselines**: `63284d5` (Phase 13C), `6ac0217` (Phase 13B), `b73e470` (Phase 12), `cf4759e` (Phase 10I)  
**Author**: Antigravity (Google DeepMind Advanced Agentic Coding Team)  

---

## 1. Executive Summary

Phase 13D established that verification can be enforced as an invariant of the governed agent loop: when an untrusted model claims goal completion (`isGoalReached: true`), Emerald deterministically triggers contract-declared verification actions (`git_diff`, `run_command`) through the existing governed execution pipeline before evaluating authoritative completion.

However, Phase 13D verified the task **inside the agent's mutable workspace**. This leaves a critical architectural question unanswered:

> *Can Emerald independently prove that an agent actually solved the task, rather than merely proving that the agent's own workspace workflow reported success?*

Phase 14 designs an out-of-band, clean-room independent verification architecture. In this design, the agent's workspace state and self-attestations are treated as untrusted candidates. Emerald extracts the candidate patch, materializes a pristine baseline environment, applies the patch, and executes dual-gated verification suites ($\text{FAIL\_TO\_PASS} = 1.0 \land \text{PASS\_TO\_PASS} = 1.0$) with anti-false-positive suite execution gating (`SUITE_RAN > 0`).

Completion is granted if and only if the fourfold invariant is mathematically satisfied:
$$\text{TaskSatisfied} \land \text{VerificationPassed} \land \text{PolicySatisfied} \land \text{EvidenceComplete}$$

This document specifies the complete architectural design, threat model, candidate trade-offs, evidence schema, failure taxonomy, and test matrix for Phase 14 without modifying existing production code or Phase 13D semantics.

---

## 2. Current Phase 13D Boundary

### 2.1 What Phase 13D Proves
1. **Model Independence of Verification**: An untrusted model (`llama3.2:3b`) does not need to voluntarily propose verification tools. The active `MissionContract` declares verification requirements (`requireMutation: true`, `requireDiff: true`, `EXIT_CODE_ZERO`).
2. **Governed Interception**: When the model proposes `finishReason: "GOAL_REACHED"`, Emerald intercepts the completion claim and verifies whether contract requirements have been physically satisfied.
3. **Physical Tool Execution**: Outstanding verification requirements execute physically through [`WorkerRuntime.executeAction`](../../src/application/worker-runtime.ts#L980-L1050), producing visible `Action` and `Attempt` records.
4. **Completion Authority**: `MODEL_GOAL_REACHED ≠ RUN_COMPLETED` is strictly preserved. Failed physical tests (`exitCode !== 0` or timeout) reject completion and return the agent to the step loop.

### 2.2 What Phase 13D Does NOT Prove
1. **Workspace Purity**: Verification runs in the agent's active workspace (`ws-${runId}`). Any temporary files, modified environment settings, altered build configurations, or node_modules mutations made during agent steps remain present during verification.
2. **Anti-Tampering Protection**: If the agent maliciously or accidentally modifies the test runner file (e.g. replacing `assert.strictEqual(add(2, 3), 5)` with `process.exit(0)` in `test/math.test.js`), the in-workspace verification runner will execute the tampered test and report success.
3. **Regression Immunity ($\text{PASS\_TO\_PASS}$)**: Phase 13D verified only that the target test command passed. It did not evaluate whether existing baseline functionality was broken elsewhere in the codebase.
4. **Baseline Failure Reproducibility ($\text{FAIL\_TO\_PASS}$)**: Phase 13D never confirmed that the target test actually failed on the pristine baseline commit prior to the patch.
5. **Patch Portability**: Phase 13D never tested whether the agent's code change can be serialized as a clean unified diff and successfully applied to an external, clean checkout of the repository.
6. **Non-Zero Test Suite Gating (`SUITE_RAN`)**: Phase 13D verified `exitCode === 0`. If a command exited 0 because 0 tests matched a filter, Phase 13D would have accepted it as passing.

---

## 3. Independence Threat Model

In an autonomous coding runtime, trusting in-workspace verification introduces multiple attack vectors and false-positive modes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AGENT ACTIVE WORKSPACE                          │
│                                                                        │
│   src/math.js ─────────────► Modified by Agent                         │
│   test/math.test.js ───────► TAMPERED? (e.g. assertions deleted)      │
│   node_modules/ ───────────► CONTAMINATED? (e.g. patched globally)     │
│   .env / temp files ───────► LEAKED STATE?                             │
│                                                                        │
│   In-Workspace Test Runner:  node test/math.test.js                    │
│   Result: EXIT CODE 0  (FALSE POSITIVE!)                              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
                Phase 13D Completion Gate Accepts Run
                 (Unsound Task Resolution Granted)
```

### Threat Taxonomy
- **Threat T1: Test Neutralization (Cheating Agent)**  
  The agent uses `write_file` to edit the test file itself, stripping assertions or mocking results so that the verification command exits with code 0 without exercising the code.
- **Threat T2: Regression Masking (Careless Fix)**  
  The agent modifies a shared function to fix the target bug, but breaks two other dependent components. Because only the target test command is verified, the regression is undetected.
- **Threat T3: Environment & Cache Pollution (Flaky Success)**  
  The agent compiles an intermediate artifact, installs an uncommitted global package, or leaves an untracked cache file. The test passes in `ws-${runId}` but fails on any clean machine.
- **Threat T4: Empty Test Suite Execution (False Green)**  
  A test runner argument misconfiguration or syntax quirk causes the test runner to skip all test cases and exit 0.
- **Threat T5: Unreproducible Patch (Broken Diff)**  
  The agent's workspace changes rely on conflicting hunks, untracked binary files, or operating system-specific path separators that fail when converted into a unified diff.

---

## 4. Existing Infrastructure Inventory

Emerald Agent Fabric already possesses the architectural primitives required to construct a clean-room verification harness without introducing external frameworks:

| Primitive | Existing Location | Current Role | Phase 14 Clean-Room Role |
| :--- | :--- | :--- | :--- |
| **`RunStatus`** | [`src/domain/invariants.ts`](../../src/domain/invariants.ts#L3-L15) | Lifecycle enum includes `"VERIFYING"` | Formal transition from `RUNNING → VERIFYING` before `COMPLETED` |
| **`EvidenceSource`** | [`src/domain/evidence.ts`](../../src/domain/evidence.ts#L18) | Already defines `"INDEPENDENT_OBSERVER"` | Tags clean-room evidence distinctly from provider outputs |
| **`DeterministicVerifier`** | [`src/domain/verification.ts`](../../src/domain/verification.ts#L74-L120) | Pure deterministic spec-matching engine | Evaluates clean-room F2P/P2P test assertions |
| **`RepositorySource`** | [`src/domain/workspace.ts`](../../src/domain/workspace.ts#L49-L53) | Defines `type`, `location`, immutable `revision` SHA | Guarantees pristine checkout of baseline commit |
| **`WorkspacePort`** | [`src/ports/workspace.port.ts`](../../src/ports/workspace.port.ts#L26-L61) | Provisions & disposes isolated host directories | Provisions ephemeral `ws-verify-${runId}` clean-room sandbox |
| **`DockerExecutionProvider`** | [`src/adapters/execution/docker-execution-provider.ts`](../../src/adapters/execution/docker-execution-provider.ts) | Hardened container runner with resource limits | Executes baseline and patched tests in pristine containers |
| **`GitDiffToolAdapter`** | [`src/adapters/tools/git-diff.tool-adapter.ts`](../../src/adapters/tools/git-diff.tool-adapter.ts) | Pure in-memory Git diff generator | Extracts canonical unified candidate patch & SHA-256 hash |
| **`SqliteStateStore`** | [`src/adapters/persistence/sqlite-state-store.ts`](../../src/adapters/persistence/sqlite-state-store.ts) | ACID event store with lease fencing | Persists independent evidence, events, and verification logs |

---

## 5. Candidate Architectures

We evaluate four structural patterns for establishing independent verification:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CANDIDATE ARCHITECTURES                         │
│                                                                        │
│  Option A: In-Workspace Re-execution                                  │
│            [Agent Workspace] ──► Rerun tests in same workspace        │
│                                                                        │
│  Option B: Workspace Reset and Re-apply                                │
│            [Agent Workspace] ──► git reset --hard ──► git apply       │
│                                                                        │
│  Option C: Ephemeral Clean-Room Materialization (RECOMMENDED)          │
│            [Agent Workspace] ──► git_diff ──► Candidate Patch         │
│                                                     │                  │
│            [Baseline Commit] ──► [Clean-Room WS] ◄──┘                  │
│                                         │                              │
│                                   Dual Gated Tests                     │
│                                                                        │
│  Option D: Distributed Multi-Node Verification Cluster                 │
│            [Agent Machine]   ──► Network Dispatch ──► Remote Cluster   │
└────────────────────────────────────────────────────────────────────────┘
```

### Comparative Evaluation Matrix

| Criteria | Option A: In-Workspace | Option B: Reset in Place | Option C: Clean-Room WS | Option D: Distributed Cluster |
| :--- | :---: | :---: | :---: | :---: |
| **Independence Degree** | None (0/5) | Low (2/5) | **Complete (5/5)** | Complete (5/5) |
| **Anti-Tampering** | Vulnerable | Partial | **Absolute** | Absolute |
| **State Bleed Risk** | High | Moderate (caches remain) | **Zero (pristine dir)** | Zero |
| **Preserves Agent Trace**| Yes | No (destroys workspace) | **Yes (read-only diff)**| Yes |
| **Implementation Scope** | Zero | Medium | **Small deterministic**| Extreme |
| **Local CPU / ₹0 Fit** | High | High | **High (< 100MB disk)** | Failed (needs servers) |
| **Hardware Overhead** | 0s overhead | ~5s | **~10-25s Docker start**| Network / VM setup |
| **Deterministic Replay** | No | Fragile | **Exact commit SHA** | Variable |

### Evaluation of Options
- **Option A (In-Workspace)**: Already used in Phase 13D. Inadequate for independent proof.
- **Option B (Reset in Place)**: Destructive. Wiping the agent's workspace destroys the evidence of intermediate actions and attempts before the audit trail is sealed. If `git reset` fails or untracked ignored files remain, isolation is breached.
- **Option D (Distributed Cluster)**: Violates Constitution Rule 5 (No Speculative Architecture) and Rule 30 (CPU-First Requirement). Introduces networking, external credentials, and cloud costs.
- **Option C (Ephemeral Clean-Room Materialization)**: **SELECTED**. Extracts the candidate patch as an immutable data artifact, provisions a dedicated clean-room workspace directly from the baseline commit SHA, executes tests via the existing `DockerExecutionProvider`, and immediately disposes of the verification workspace.

---

## 6. Recommended Architecture: Ephemeral Clean-Room Verification

### 6.1 Architectural Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                        STEP LOOP CONCLUDED                             │
│  Model proposes finishReason: "GOAL_REACHED"                           │
│  AgentStepController extracts candidate unified diff                   │
│  Candidate patch SHA-256 computed: sha256(diff)                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               RUN COORDINATOR: TRANSITION TO VERIFYING                 │
│  tx.transitionRun(runId, "START_VERIFICATION")                         │
│  RunStatus: RUNNING ────────► VERIFYING                                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              CLEAN-ROOM VERIFICATION ORCHESTRATION                     │
│  (Executed via WorkerRuntime within active lease boundary)             │
│                                                                        │
│  1. Provision pristine workspace: ws-verify-${runId}                   │
│  2. Materialize baseline repository at exact contract revision         │
│  3. Execute Baseline Diagnostic:                                       │
│     - Run F2P tests ──► MUST FAIL (reproduce defect)                   │
│     - Run P2P tests ──► MUST PASS (verify baseline stability)          │
│  4. Apply candidate patch:                                             │
│     - Execute 'git apply' inside clean container                       │
│     - If reject / conflict ──► FAIL (APPLY_PATCH_FAIL)                 │
│  5. Execute Post-Patch Verification:                                   │
│     - Run F2P tests ──► MUST PASS (assert F2P == 1.0)                  │
│     - Run P2P tests ──► MUST PASS (assert P2P == 1.0)                  │
│     - Verify SUITE_RAN matched non-zero test executions (> 0)          │
│  6. Static Policy Audit:                                               │
│     - Verify touched files strictly match contract allowedPaths        │
│  7. Assemble Independent Evidence:                                     │
│     - Source: "INDEPENDENT_OBSERVER"                                   │
│     - Cryptographic evidence bundle committed to SQLite                │
│  8. Dispose workspace: ws-verify-${runId} (guaranteed cleanup)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 AUTHORITATIVE COMPLETION DECISION                      │
│                                                                        │
│  DeterministicVerifier evaluates independent evidence:                 │
│  IF (F2P == 1.0 ∧ P2P == 1.0 ∧ SuiteRan ∧ PolicyOK ∧ EvidenceComplete) │
│       ──► tx.completeRun(runId) ──► Status: COMPLETED                  │
│  ELSE                                                                  │
│       ──► tx.failRun(runId, reason) ──► Status: FAILED                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Key Architectural Invariants
1. **Zero Model Authority**: The model's completion claim is only a trigger to initiate independent evaluation. The model has zero influence over which tests run, how the baseline is acquired, or whether completion is accepted.
2. **Read-Only Inspection of Agent Workspace**: The agent workspace (`ws-${runId}`) is treated as read-only during the verification stage. No files are modified or deleted in the agent workspace.
3. **Pristine Baseline Source of Truth**: The verification environment is allocated fresh from `MissionContract.spec.repositorySource` (`commitSha`), guaranteeing immunity from local agent contamination.
4. **Governed Execution Seam**: All verification actions (baseline test, git apply, patched test) run through `WorkerRuntime.executeAction` and `DockerExecutionProvider`. No raw host process execution (`exec`, `spawn`, `shell`) is permitted.
5. **Fail-Closed Semantics**: Any failure (patch conflict, test failure, test timeout, zero tests executed, policy breach) immediately produces a `FAILED` verdict.

---

## 7. Verification Contract & Dual-Gated Gating

The `MissionContract` must express independent verification requirements deterministically:

```typescript
export interface CleanRoomVerificationSpec {
  readonly specId: string;
  readonly baselineCommitSha: string;
  readonly failToPass: {
    readonly testCommand: readonly string[]; // e.g. ["node", "test/math.test.js", "--test-name-pattern=add"]
    readonly expectedBaselineExitCode: number; // Must be non-zero (defect reproduced)
    readonly expectedPatchedExitCode: 0;        // Must be zero (defect resolved)
    readonly minTestCount: number;             // Must be >= 1 (anti-zero-test guard)
    readonly suiteRanRegex: string;            // e.g. "PASS|passing|ok|[1-9]\\d* tests"
  };
  readonly passToPass: {
    readonly testCommand: readonly string[]; // e.g. ["node", "test/regression.test.js"]
    readonly expectedBaselineExitCode: 0;       // Must pass on baseline
    readonly expectedPatchedExitCode: 0;        // Must remain passing on patched code
    readonly minTestCount: number;             // e.g. >= 5
    readonly suiteRanRegex: string;
  };
  readonly allowedPathPatterns: readonly string[]; // e.g. ["src/**/*.js"]
  readonly timeoutMs: number;
}
```

### Mathematical Definitions

1. **`FAIL_TO_PASS` (F2P)**:
   $$\text{F2P} = \frac{|\text{Target Tests Passing After Patch} \cap \text{Target Tests Failing on Baseline}|}{|\text{Target Tests Declared in Contract}|} = 1.0$$
   If even one F2P test fails or is skipped, $\text{F2P} < 1.0$ and verification fails.

2. **`PASS_TO_PASS` (P2P)**:
   $$\text{P2P} = \frac{|\text{Regression Tests Passing After Patch} \cap \text{Regression Tests Passing on Baseline}|}{|\text{Regression Tests Declared in Contract}|} = 1.0$$
   If any regression test fails after applying the patch, $\text{P2P} < 1.0$ and verification fails (Regression Detected).

3. **`SUITE_RAN` Gating**:
   $$\text{SuiteRanVerified} \iff \text{stdout} \cup \text{stderr} \text{ matches } \text{suiteRanRegex} \land \text{testsExecuted} \ge \text{minTestCount}$$
   Guards against early process exits or misconfigured test runner flags that report exit code 0 without executing assertions.

---

## 8. Evidence Model

Independent clean-room verification produces a typed, content-hashed evidence entity committed to SQLite:

```typescript
export interface IndependentVerificationEvidencePayload {
  readonly runId: string;
  readonly taskId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly baselineCommitSha: string;
  readonly candidatePatchHash: string; // SHA-256 of unified diff
  readonly candidatePatchBytes: number;
  readonly touchedFiles: readonly string[];
  
  // Phase 1: Baseline Verification
  readonly baselineDiagnostic: {
    readonly f2pExitCode: number | null;
    readonly f2pOutputHash: string;
    readonly p2pExitCode: number | null;
    readonly p2pOutputHash: string;
    readonly baselineValid: boolean; // f2p failed AND p2p passed
  };

  // Phase 2: Patch Application
  readonly patchApplication: {
    readonly status: "APPLIED" | "CONFLICT" | "EMPTY" | "MALFORMED";
    readonly exitCode: number;
    readonly outputText: string;
  };

  // Phase 3: Clean-Room Verification
  readonly cleanRoomEvaluation: {
    readonly f2pExitCode: number | null;
    readonly f2pTestsExecuted: number;
    readonly f2pTestsPassed: number;
    readonly f2pRatio: number; // Must be 1.0
    readonly f2pSuiteRanMatched: boolean;

    readonly p2pExitCode: number | null;
    readonly p2pTestsExecuted: number;
    readonly p2pTestsPassed: number;
    readonly p2pRatio: number; // Must be 1.0
    readonly p2pSuiteRanMatched: boolean;
  };

  // Phase 4: Policy & Scope Audit
  readonly policyAudit: {
    readonly allowedPathsCompliant: boolean;
    readonly disallowedFilesTouched: readonly string[];
  };

  // Final Verdict
  readonly overallStatus: "VERIFIED" | "FAILED";
  readonly failureReasonCode?: 
    | "BASELINE_DEFECT_NOT_REPRODUCED"
    | "BASELINE_REGRESSION_PREEXISTING"
    | "EMPTY_PATCH"
    | "APPLY_PATCH_FAIL"
    | "TARGET_TEST_FAILED"
    | "REGRESSION_DETECTED"
    | "TEST_SUITE_NEVER_RAN"
    | "POLICY_PATH_VIOLATION"
    | "EXECUTION_TIMEOUT"
    | "INFRA_ENVIRONMENT_FAILURE";
  readonly verifiedAt: string;
}
```

---

## 9. Failure Semantics (Fail-Closed Decision Matrix)

The clean-room harness evaluates the pipeline sequentially. Any violation causes immediate termination and a `FAILED` verdict:

```
[Start Verification]
        │
        ▼
Is patch non-empty? ─────────────────────────────────► NO  ──► FAILED (EMPTY_PATCH)
        │ YES
        ▼
Does patch apply to baseline commit? ────────────────► NO  ──► FAILED (APPLY_PATCH_FAIL)
        │ YES
        ▼
Did baseline F2P test fail as expected? ─────────────► NO  ──► FAILED (BASELINE_DEFECT_NOT_REPRODUCED)
        │ YES
        ▼
Did baseline P2P test pass as expected? ─────────────► NO  ──► FAILED (BASELINE_REGRESSION_PREEXISTING)
        │ YES
        ▼
Did patched F2P test execute & pass (F2P == 1.0)? ───► NO  ──► FAILED (TARGET_TEST_FAILED)
        │ YES
        ▼
Did patched P2P test execute & pass (P2P == 1.0)? ───► NO  ──► FAILED (REGRESSION_DETECTED)
        │ YES
        ▼
Did test runner execute > 0 tests (SUITE_RAN)? ──────► NO  ──► FAILED (TEST_SUITE_NEVER_RAN)
        │ YES
        ▼
Are all changed files within contract allowedPaths? ─► NO  ──► FAILED (POLICY_PATH_VIOLATION)
        │ YES
        ▼
VERIFIED (All Four Conditions Satisfied ──► Transition Run to COMPLETED)
```

---

## 10. Minimal Deterministic Fixture

To validate clean-room verification without external dependencies or heavy repos, Phase 14 requires a small, multi-suite JavaScript fixture:

### Repository Structure
```text
repo-root/
├── package.json
├── src/
│   ├── math.js              # Defective unit under test
│   └── utils.js             # Stable utility unit
└── test/
    ├── math.target.test.js  # F2P suite (exercises math.js defect)
    └── math.regress.test.js # P2P suite (exercises existing utils and math invariants)
```

### Initial Defective Baseline (`src/math.js`)
```javascript
function add(a, b) {
  // Defect: subtracts instead of adds
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
```

### Target Bug Test (`test/math.target.test.js`) — `FAIL_TO_PASS`
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

### Regression Test (`test/math.regress.test.js`) — `PASS_TO_PASS`
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

### Expected Baseline Outcome
- `node test/math.target.test.js` $\rightarrow$ Exit Code `1` (Fails, reproducing defect).
- `node test/math.regress.test.js` $\rightarrow$ Exit Code `0` (Passes, confirming baseline health).

### Expected Patched Clean-Room Outcome
- Candidate patch modifies `src/math.js` to `return a + b;`.
- `node test/math.target.test.js` $\rightarrow$ Exit Code `0` ($\text{F2P} = 1.0$).
- `node test/math.regress.test.js` $\rightarrow$ Exit Code `0` ($\text{P2P} = 1.0$).
- $\text{SUITE\_RAN}$ matches `"PASS: 2 of 2"` and `"PASS: 3 of 3"$.

---

## 11. Phase 14 Test Matrix

Phase 14 must implement a deterministic test suite verifying every branch of the clean-room decision tree:

| Test ID | Test Scenario | Expected Outcome | Verified Mechanism |
| :--- | :--- | :---: | :--- |
| **Test 14.1** | **Happy Path Clean Verification**<br>Agent produces correct patch; clean baseline materializes, F2P=1.0, P2P=1.0. | `COMPLETED` | Pristine workspace allocation, patch application, dual test execution, state transition. |
| **Test 14.2** | **Zero Code Mutation (No-op Goal Claim)**<br>Agent emits `isGoalReached: true` without calling `write_file`. | `FAILED`<br>(`EMPTY_PATCH`) | Verifier detects empty diff; rejects run without running clean-room tests. |
| **Test 14.3** | **Unsuccessful Bug Fix**<br>Agent modifies code, but target test still fails in clean-room. | `FAILED`<br>(`TARGET_TEST_FAILED`) | $\text{F2P} < 1.0$; verifier records assertion failure evidence; run fails. |
| **Test 14.4** | **Regression Introduced**<br>Agent fixes bug in `math.js`, but deletes or alters `multiply()`, breaking regression tests. | `FAILED`<br>(`REGRESSION_DETECTED`) | $\text{F2P} = 1.0$, but $\text{P2P} < 1.0$; verifier rejects patch due to regression. |
| **Test 14.5** | **Test File Tampering in Agent Workspace**<br>Agent modified `test/math.target.test.js` in its own workspace to exit 0. | `FAILED`<br>(`TARGET_TEST_FAILED`) | Clean-room runs un-tampered test from baseline commit; fails immediately. |
| **Test 14.6** | **Zero-Test Execution Gating**<br>Test command exits 0 without running assertions (e.g. filtered suite). | `FAILED`<br>(`TEST_SUITE_NEVER_RAN`) | `SUITE_RAN` regex fails to match required test count pattern. |
| **Test 14.7** | **Patch Conflict / Rejection**<br>Patch was corrupted or built against mismatched tree; `git apply` fails. | `FAILED`<br>(`APPLY_PATCH_FAIL`) | Patch application non-zero exit halts verification immediately. |
| **Test 14.8** | **Policy Path Scope Violation**<br>Agent modifies files outside contract `allowedPaths` (e.g. `package.json`). | `FAILED`<br>(`POLICY_PATH_VIOLATION`) | Static path audit detects out-of-bounds mutation; rejects completion. |
| **Test 14.9** | **Docker Clean-Room Timeout**<br>Test execution in clean container exceeds timeout budget. | `FAILED`<br>(`EXECUTION_TIMEOUT`) | Container execution timeout halts verification cleanly without hang. |
| **Test 14.10**| **Double Clean-Room Isolation**<br>Verify agent workspace filesystem is completely untouched during clean-room verification. | `PASS` | Inodes, hashes, and timestamps of files in `ws-${runId}` are identical before and after. |

---

## 12. The Fourfold Completion Invariant

Emerald's Master Constitution mandates that task completion requires satisfying four independent predicates:

$$\text{TaskCompleted} \iff \text{TaskSatisfied} \land \text{VerificationPassed} \land \text{PolicySatisfied} \land \text{EvidenceComplete}$$

```
                                  ┌──────────────────────────────┐
                                  │   TaskSatisfied (Model)      │
                                  │  - finishReason: GOAL_REACHED│
                                  └──────────────┬───────────────┘
                                                 │
                                                 ▼
┌──────────────────────────────┐                 │                ┌──────────────────────────────┐
│  VerificationPassed (Clean)  │                 │                │    PolicySatisfied (Rules)   │
│  - F2P == 1.0 ∧ P2P == 1.0   │◄────────────────┼───────────────►│  - Paths in allowedPaths     │
│  - SUITE_RAN > 0             │                 │                │  - No capabilities breached │
│  - Clean git apply           │                 │                │  - Budgets respected         │
└──────────────────────────────┘                 │                └──────────────────────────────┘
                                                 ▼
                                  ┌──────────────────────────────┐
                                  │  EvidenceComplete (Durable)  │
                                  │  - SQLite actions/attempts   │
                                  │  - Clean-room evidence log   │
                                  │  - SHA-256 bundle sealed     │
                                  └──────────────┬───────────────┘
                                                 │
                                                 ▼
                                        RUN COMPLETED
```

### Operational Definitions:
1. **`TaskSatisfied`**:
   The model explicitly signaled completion (`isGoalReached === true` with valid rationale).
2. **`VerificationPassed`**:
   An independent clean-room sandbox was allocated from the pristine baseline commit, the candidate patch applied cleanly without conflicts, target tests achieved $\text{F2P} = 1.0$, regression tests achieved $\text{P2P} = 1.0$, and non-zero test execution was confirmed via `SUITE_RAN`.
3. **`PolicySatisfied`**:
   Static diff analysis confirms that 100% of modified files match `MissionContract.spec.policy.allowedPaths`. No protected files, configuration, or credentials were created or altered.
4. **`EvidenceComplete`**:
   All step transcripts, actions, attempts, tool results, diff hashes, clean-room logs, and verification verdicts are transactionally committed to SQLite under lease fencing.

---

## 13. Security and Authority Boundaries

The clean-room verifier is an **observer and evidence generator**, not an execution authority:

1. **No Direct State Mutation**:
   The verifier cannot directly set `Run.status = "COMPLETED"`. It generates an immutable `Evidence` domain entity with `source: "INDEPENDENT_OBSERVER"`. The existing [`RunCoordinator`](../../src/application/run-coordinator.ts) and completion gate evaluate this evidence transactionally.
2. **Strict Workspace Boundaries**:
   The clean-room workspace is provisioned through [`WorkspacePort`](../../src/ports/workspace.port.ts). Symlink path resolution and boundary traversal checks prevent any patch from writing outside the assigned directory.
3. **Container Confinement**:
   Independent tests execute inside `DockerExecutionProvider` with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, read-only root filesystems, `--net=none`, and explicit memory (256m) and CPU (0.5) limits.
4. **Zero Shell Injection**:
   Patch application and test execution use discrete `argv` tokens without string concatenation or shell evaluation (`sh -c`).

---

## 14. Resource and Performance Risks

1. **Clean-Room Materialization Overhead**:
   - Disk space: Allocating a second workspace directory for verification requires ~1–10 MB for small fixtures (negligible).
   - Creation latency: Copying a small baseline repository template takes $< 50\text{ms}$.
2. **Docker Cold-Start Latency**:
   - Spinning up an ephemeral container for independent verification adds ~2–5 seconds on Linux and ~15–25 seconds on Windows with Docker Desktop WSL2.
   - *Mitigation*: Verification occurs **exactly once per run** (at completion time), not on every step. Total verification overhead is bounded at $< 30\text{s}$.
3. **CPU-First Budget Alignment**:
   - Running verification tests in a Docker container consumes negligible CPU compared to local model inference (~25s test vs ~240s model inference).
   - Total run wall-clock easily remains within the standard 30-minute lease ceiling (`1_800_000ms`).

---

## 15. ₹0 Architecture Feasibility

The Phase 14 design strictly maintains the ₹0 cost profile:
- **Zero Paid APIs**: No OpenAI, Anthropic, or external inference APIs.
- **Zero Cloud Infrastructure**: Operates entirely on the local developer machine using Node.js, SQLite, local Ollama, and local Docker.
- **Zero Heavy Repositories**: Utilizes lightweight, deterministic in-repo fixtures rather than multi-gigabyte SWE-bench benchmarks.
- **Open Source Standards**: Adopts the grading rigor of SWE-bench while eliminating its heavy infrastructure dependencies.

---

## 16. Future Implementation Scope

When explicitly authorized to implement Phase 14, modifications will be strictly confined to:

1. **Domain Layer**:
   - `src/domain/verification.ts`: Add `CleanRoomVerificationSpec` interface and extend `DeterministicVerifier` to evaluate dual-gated test outcomes.
2. **Application Layer**:
   - `src/application/agent-step-controller.ts`: Connect the `RUNNING → VERIFYING` stage to initiate clean-room materialization and independent evaluation.
   - `src/application/clean-room-verifier.ts` (NEW isolated application service): Implements the clean-room lifecycle (materialize baseline, apply patch, run dual tests, gather independent evidence, dispose workspace).
3. **Tests**:
   - `tests/integration/phase14-independent-verification.test.ts`: Complete test suite covering Tests 14.1 through 14.10.
4. **Harness / Smoke**:
   - `scripts/run-phase14-smoke.ts`: Live smoke runner with the math fixture verifying clean-room proof under local Ollama.

**Zero modifications** will be made to:
- SQLite persistence schema or transaction model
- Worker lease fencing architecture
- Docker execution provider confinement parameters
- Tool execution gateway authorization semantics
- Model provider adapters or prompt projection

---

## 17. Acceptance Gates

Phase 14 implementation will be complete if and only if the following gates pass:

- [ ] **Gate 1: Pristine Sandbox Isolation**  
  Verification executes in a dedicated workspace (`ws-verify-${runId}`) allocated fresh from the baseline commit. The agent's workspace is completely unmodified.
- [ ] **Gate 2: Clean Patch Application**  
  The candidate patch is extracted via pure in-memory `git_diff` and applied via `git apply` in the clean-room environment. Malformed or conflicting patches fail closed.
- [ ] **Gate 3: Dual-Gated Test Enforcement**  
  Verification asserts $\text{F2P} = 1.0$ (100% target bug tests pass) AND $\text{P2P} = 1.0$ (100% regression tests pass). Any regression causes immediate failure.
- [ ] **Gate 4: Anti-False-Positive Test Gating (`SUITE_RAN`)**  
  Test runs must match a contract-defined regex confirming non-zero test execution. Tests exiting 0 without running assertions fail closed (`TEST_SUITE_NEVER_RAN`).
- [ ] **Gate 5: Anti-Tampering Proof**  
  Altering test files in the agent workspace has zero effect on clean-room verification because tests are materialized directly from the baseline commit.
- [ ] **Gate 6: Fourfold Invariant Sealed in SQLite**  
  `COMPLETED` status is granted if and only if all four predicates are satisfied. Verification results are persisted with `source: "INDEPENDENT_OBSERVER"`.
- [ ] **Gate 7: Full Regression Safety**  
  100% of Phase 11, 12, 13, 13B, 13C, and 13D integration tests continue to pass. All 9 historical evaluation artifacts remain byte-for-byte identical.

---

## 18. Stop Conditions

Emerald must reject the implementation and halt immediately if:
1. Clean-room verification requires modifying the active worker lease or state-store transaction boundaries.
2. Patch application requires running raw shell commands (`exec`, `spawn`, `sh -c`) on the host machine.
3. Clean-room test execution cannot run within existing Docker resource and network limits (`--net=none`).
4. Hardware overhead on CPU developer laptops exceeds reasonable bounds (e.g. disk usage $> 500\text{MB}$ or verification latency $> 60\text{s}$).
5. Verification requires creating a second database or independent background daemon.

---

## 19. Research Conclusion

> **Does Phase 14 materially increase confidence that Emerald proves task correctness independently?**

**YES.**

Phase 13D eliminated the model's voluntary omission of verification, but it remained susceptible to workspace pollution, test tampering, and regression blindness. Phase 14 decouples the verification environment entirely from the agent's mutable execution trace.

By establishing that a candidate patch must apply cleanly to a pristine baseline and satisfy both `FAIL_TO_PASS` (defect resolution) and `PASS_TO_PASS` (regression protection) under non-zero test gating, Emerald transforms agent verification from **self-reported process compliance** into **reproducible, tamper-proof, clean-room mathematical proof**.
