# Integration Brief: SWE-bench Harness — Independent Verification and Grading

**Document ID**: `EAF-OSS-003`  
**Date of Inspection**: 2026-10-16  
**Status**: APPROVED FOR DESIGN (Implementation strictly deferred to Phase 14)  
**Role**: Senior AI Infrastructure Engineer & Technical Co-Founder  
**Upstream System**: [SWE-bench](https://github.com/SWE-bench/SWE-bench)  
**Inspected Commit SHA**: [`02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`](https://github.com/SWE-bench/SWE-bench/commit/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e)  

---

## 1. Executive Summary

SWE-bench is the gold standard benchmark for evaluating autonomous software engineering agents on real-world GitHub issues. Its integrity rests on a single inviolable architectural rule: **an agent's self-assessment is never authoritative**. Whether an agent claims "I have solved the bug" is completely irrelevant to the outcome. Resolution is determined solely by an out-of-band, clean-room verification harness that applies candidate patches to pristine repository revisions and executes dual-gated test suites (`FAIL_TO_PASS` and `PASS_TO_PASS`).

For Emerald Agent Fabric, SWE-bench's grading and infrastructure classification mechanics directly define **Phase 14 (Independent Verification)**. Emerald must formalize the fourfold verification rule:
$$\text{TaskSatisfied} \land \text{VerificationPassed} \land \text{PolicySatisfied} \land \text{EvidenceComplete}$$
This brief specifies the exact verification pipeline, log parsing rules, anti-false-positive guards (`SUITE_RAN`), and post-hoc failure classification (`TIER_ENVIRONMENT` vs `TIER_AMBIGUOUS`) to ensure Emerald never fabricates success or conflates environment breakdowns with agent failure.

---

## 2. Research Question

> How does the SWE-bench evaluation harness independently establish whether a software patch resolves a task without false positives or regression, and how can those verification criteria be executed by Emerald's `DockerExecutionProvider` and `DeterministicVerifier` without altering frozen domain models or compromising sandbox confinement?

---

## 3. Upstream Inspected Source Files

The following files from [`SWE-bench/SWE-bench`](https://github.com/SWE-bench/SWE-bench) at commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` were inspected:

1. **[`swebench/harness/grading.py`](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py)**:
   - Lines 25–45: `SUITE_RAN` regular expression ensuring test runners executed $> 0$ tests before parsing output (preventing empty suites from passing).
   - Lines 85–110: `test_passed`, `test_maintained`, and `test_failed` functions resolving case IDs and handling `SKIPPED` tests.
   - Lines 113–150: `get_logs_eval` checking for `APPLY_PATCH_FAIL`, `RESET_FAILED`, `TESTS_ERROR`, and `TESTS_TIMEOUT`.
   - Lines 208–285: `get_eval_tests_report` computing pass/fail distributions across gold test lists.
   - Lines 288–325: `compute_fail_to_pass`, `compute_pass_to_pass`, and `get_resolution_status` returning `ResolvedStatus.FULL`, `PARTIAL`, or `NO`.
   - Lines 340–395: `get_eval_report` top-level report construction, tying patch presence and log classification together.

2. **[`swebench/harness/infra_failure.py`](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/infra_failure.py)**:
   - Lines 20–26: Explicit tier definitions: `TIER_ENVIRONMENT` vs `TIER_AMBIGUOUS`.
   - Lines 27–66: `INFRA_FAILURE_SIGNATURES` matching OOM (`OutOfMemoryError`), daemon death (`Cannot connect to the Docker daemon`), DNS failure (`Temporary failure in name resolution`), missing modules, and timeouts.
   - Lines 69–87: `classify_text` and `classify_logs` post-hoc advisory log classifiers.

3. **[`swebench/harness/run_evaluation.py`](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/run_evaluation.py)**:
   - Container provisioning, test script generation, patch injection via `git apply`, execution under strict timeout, and log capture.

---

## 4. Verified Upstream Findings

### 4.1 Anti-False-Positive Test Runner Gating (`SUITE_RAN`)
In `swebench/harness/grading.py` (lines 25–45), SWE-bench explicitly guards against a catastrophic evaluation bug: test runners that crash immediately without running any tests.
```python
SUITE_RAN = re.compile(
    r"Executed [1-9]\d* of \d+"
    r"|TOTAL: [1-9]\d* (?:SUCCESS|FAILED)"
    r"|[1-9]\d* passing"
    r"|Tests:\s+[1-9]\d*"
    r"|Test Suites:\s+(?:\\d+ \\w+, )*[1-9]\d* total"
    r"|^# tests [1-9]\d*"
)
```
If a test framework starts and exits cleanly without matching `SUITE_RAN` (e.g. 0 tests executed), SWE-bench treats the status map as unconfirmed, preventing an empty log from scoring all expected tests as resolved.

### 4.2 Dual-Gated Resolution Logic
SWE-bench categorizes tests into two distinct gold sets:
1. **`FAIL_TO_PASS` (F2P)**: Tests that reproduce the issue. Before the patch, they fail. With the patch, **100% of these tests must pass** ($\text{F2P} = 1.0$). If even one F2P test is skipped or fails, resolution is rejected.
2. **`PASS_TO_PASS` (P2P)**: Regression tests covering existing functionality. Before the patch, they pass. With the patch, **100% of these tests must remain passing or skipped** ($\text{P2P} = 1.0$). If any P2P test fails, the patch introduced a regression.

Only when $\text{F2P} = 1.0 \land \text{P2P} = 1.0$ is the status `ResolvedStatus.FULL`.

### 4.3 Post-Hoc Infrastructure Failure Triage
In `swebench/harness/infra_failure.py`, failures are separated post-hoc into:
- **`TIER_ENVIRONMENT`**: Definitively not the model's fault. Signatures include Docker daemon disconnections, host out-of-memory kills (`^Killed$`), X-server display failures, and DNS timeouts.
- **`TIER_AMBIGUOUS`**: Could be a bad model patch (e.g. deleting an import) or environment defect (e.g. uninstalled dependency).
Crucially, classification is **read-only and advisory**: it never changes the denominator of evaluated instances, but it alerts engineers that a benchmark run was corrupted by infrastructure.

---

## 5. Emerald Integration Design

### 5.1 Independent Verification Workflow

Emerald must not verify patches inside the agent's active workspace, because the workspace may have been contaminated with temporary scripts, modified environment variables, or partial files.

The verification workflow for **Phase 14**:

```
┌────────────────────────────────────────────────────────┐
│            AgentStepController completes run           │
│  - Model proposes isGoalReached: true                  │
│  - Run state transitions: RUNNING → VERIFYING          │
└──────────────────────────┬─────────────────────────────┘
                           │ candidate patch (git diff)
                           ▼
┌────────────────────────────────────────────────────────┐
│       VerificationOrchestrator (Phase 14 Engine)       │
├────────────────────────────────────────────────────────┤
│ 1. Extract unified diff from active workspace          │
│ 2. Provision PRISTINE verification workspace/sandbox   │
│ 3. Check base commit matches MissionContract           │
│ 4. Apply candidate patch (git apply)                   │
│    - If patch fails: VERIFICATION_FAILED (PatchReject) │
│ 5. Execute F2P tests in isolated Docker container      │
│    - Verify SUITE_RAN matches non-zero tests           │
│    - Assert 100% F2P passed                            │
│ 6. Execute P2P tests in isolated Docker container      │
│    - Assert 0% P2P regressions                         │
│ 7. Run static policy audit on changed files            │
│ 8. Compute cryptographic evidence bundle hash          │
└──────────────────────────┬─────────────────────────────┘
                           │ VerificationResult
                           ▼
┌────────────────────────────────────────────────────────┐
│               RunCoordinator / StateStore              │
│  - If ALL 4 conditions met: COMPLETED                  │
│  - If ANY condition fails: FAILED (with reason code)   │
└────────────────────────────────────────────────────────┘
```

### 5.2 Establishing the Fourfold Rule

Emerald's Constitution mandates:
$$\text{TaskSatisfied} \land \text{VerificationPassed} \land \text{PolicySatisfied} \land \text{EvidenceComplete}$$

Each condition is independently established:

1. **`TaskSatisfied`**:
   - The model explicitly proposed `isGoalReached === true`.
   - The proposed change satisfies all textual requirements specified in the `MissionContract`.
2. **`VerificationPassed`**:
   - Pristine sandbox provisioned by `DockerExecutionProvider`.
   - Candidate patch applied cleanly without rejection.
   - Test execution logs match `SUITE_RAN` $> 0$.
   - $\text{F2P} = 1.0$ (all targeted bug tests pass).
   - $\text{P2P} = 1.0$ (zero regression test failures).
   - Exit code of verification test runner is 0.
3. **`PolicySatisfied`**:
   - `PolicyEvaluator` confirms that all modified files fall within the contract's permitted path glob (`MissionContract.executionPolicy.allowedPaths`).
   - No prohibited files (e.g. credentials, CI workflows, binary executables) were touched.
   - Resource limits (CPU time, memory, disk footprint) were not exceeded.
4. **`EvidenceComplete`**:
   - All `actions`, `attempts`, `step_transcripts`, and verification logs are durably committed in SQLite.
   - SHA-256 hash of the candidate diff matches the evaluated artifact.
   - Verification evidence bundle is signed and persisted.

### 5.3 A. Adopt (What Emerald Adopts)
1. **Clean-Room Verification Sandbox**: Running verification outside the agent workspace.
2. **Anti-False-Positive `SUITE_RAN` Check**: Requiring regex verification of non-zero test counts before parsing results.
3. **Dual F2P/P2P Test Gating**: Strictly enforcing that bug resolution cannot be achieved by breaking regression tests.
4. **`TIER_ENVIRONMENT` vs `TIER_AMBIGUOUS` Advisory Classification**: Tagging failures so host OOM or Docker drops are recorded accurately.

### 5.4 B. Adapt (Mapping to Emerald Interfaces)
- **`DeterministicVerifier`**: Implement the verification logic against `ExecutionProvider` and `WorkspacePort`.
- **`MissionContract`**: Ensure `MissionContractSpec` supports declaring `failToPass` and `passToPass` test command vectors.
- **Evidence Schema**: Embed `VerificationReport` (`f2pResults`, `p2pResults`, `suiteRanVerified`, `patchApplied`, `infraClassification`) into Emerald's `EvidenceBundle`.

### 5.5 C. Skip (What Emerald Explicitly Rejects)
1. **Conda/Heavy Linux Distro Images**: SWE-bench uses 20GB+ Docker images per Python repo. Emerald targets lightweight, CPU-first Node.js and Python environments with minimal base footprints.
2. **Loose Regular Expression Case Matching**: SWE-bench includes heuristic fallbacks for truncated parameterized pytest names. Emerald requires exact, deterministic test case identifiers.

---

## 6. Conformance Test Specifications

For Phase 14 certification, the following verification tests must pass:

1. **Test 14.1: End-to-End Verified Success**:
   - Valid candidate patch resolves failing test in pristine sandbox.
   - F2P: 2/2 passed. P2P: 10/10 passed. `SUITE_RAN`: matched.
   - Assert: `VerificationResult.status === "VERIFIED"`.
   - Assert: Run transitions `VERIFYING → COMPLETED`.

2. **Test 14.2: Patch Application Failure**:
   - Candidate patch has conflicting hunks against base commit.
   - Assert: `VerificationResult.status === "FAILED"`, `reason === "APPLY_PATCH_FAIL"`.
   - Assert: Zero tests are executed; pristine workspace cleaned up.
   - Assert: Run transitions `VERIFYING → FAILED`.

3. **Test 14.3: Regression Detection (P2P Failure)**:
   - Candidate patch fixes the bug (F2P: 1/1 passed) but breaks an unrelated component (P2P: 1 failed out of 5).
   - Assert: `VerificationResult.status === "FAILED"`, `reason === "REGRESSION_DETECTED"`.
   - Assert: Run transitions `VERIFYING → FAILED`.

4. **Test 14.4: Anti-False-Positive Zero-Test Gating**:
   - Model submits patch that causes test runner to exit 0 without executing tests (e.g. pytest filter matching nothing).
   - `SUITE_RAN` regex fails to match non-zero test count.
   - Assert: `VerificationResult.status === "FAILED"`, `reason === "TEST_SUITE_NEVER_RAN"`.
   - Assert: Run transitions `VERIFYING → FAILED`.

5. **Test 14.5: Infrastructure Failure Triage**:
   - Docker container killed by host OOM (`Killed` in log).
   - Assert: Failure classified as `TIER_ENVIRONMENT` (`out_of_memory`).
   - Assert: Run transitions `VERIFYING → FAILED` with explicit infrastructure failure metadata attached to evidence.

---

## 7. Productization Lessons from SWE-bench

1. **Objective Metrics Build Trust**: SWE-bench gained global adoption because its metrics are mathematically verifiable: either the tests ran and passed, or they did not. Subjective model evaluation is poison for engineering tools.
2. **Regression Prevention is 50% of the Job**: In software engineering, fixing a bug while breaking two others is worse than doing nothing. Gating on `PASS_TO_PASS` is non-negotiable.
3. **Environment Isolation Protects Integrity**: Never evaluate code inside the directory where the agent made the edits. Contaminated build caches and stray files create silent false passes.

---

## 8. Dependencies & Sequencing

- **Pre-requisite**: **Phase 13 (Coding-Agent Task Loop)**.
- **Direct Target**: **Phase 14 (Independent Verification)**.
- **Downstream Consumer**: **Phase 17 (Curated Benchmark)**.

---

## 9. Open Questions & Technical Uncertainties

1. **Test Execution Latency on CPU**: Running both F2P and full P2P suites in a pristine container on CPU can take 30–90 seconds. Does this fit comfortably within task timeout budgets?
   - Recommendation: Pinned SWE tasks must have lightweight test suites ($< 15\text{s}$ total execution time).
