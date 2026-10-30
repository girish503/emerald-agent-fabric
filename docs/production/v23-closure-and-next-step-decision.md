# Emerald Agent Fabric — V2.3 Closure & Next-Step Decision

**Date**: 2026-10-22  
**Milestone**: Production V2.3 Closure & Next-Step Decision  
**Scope**: Governed Local Agent Runtime, Operational Developer Pilot, Next-Step Planning  
**Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)  
**Governing Invariants**: ADR-0029, ADR-0030, ADR-0032, GEMINI.md Rule 11  
**Decision Outcome**: **`CONTINUE_BOUNDED_PILOT`**  

---

## 1. V2.3 Completion Summary

Production V2.3 evaluated Emerald Agent Fabric as a developer-assistance tool under controlled, local-only execution using the installed open-weight model `qwen2.5-coder:3b` (via local Ollama, ₹0 cost).

The pilot tested whether Emerald's governed runtime—specifically structured proposal validation, capability fencing, line-anchored editing, non-authoritative diagnostics, human approval gates, and sovereign verification—provides practical value when a human developer reviews proposed mutations.

### Outcome:
The pilot concluded with the validated decision **`PILOT_CONDITIONALLY_USEFUL`**. Across 4 representative pilot tasks (`pilot-001` through `pilot-004`):
- All safety and governance boundaries held 100% (zero unauthorized mutations, zero workspace containment escapes, zero capability bypasses, and zero automated git commits or pushes).
- Inaccurate search anchors failed closed deterministically without disk corruption.
- Advisory syntax diagnostics caught defects in ~1.1 seconds, preventing unneeded verification runs.
- Developer-assisted repair with human diff review passed targeted tests, sovereign verification, and 3-sweep deterministic replay.

---

## 2. Verified Results and Evidence Sources

| Task ID | Task Category | Outcome | Telemetry / Metric | Evidence Source |
| :--- | :--- | :---: | :--- | :--- |
| **`pilot-001`** | `READ_ONLY_ASSISTANCE` | **PASS** | Read clamp utility; 0 mutations; verified pristine | `scratch/production-v23-pilot-results.json` |
| **`pilot-002`** | `DEVELOPER_ASSISTED_EDIT` | **PASS** | Line-anchored edit approved by operator; tests pass | `scratch/production-v23-pilot-results.json` |
| **`pilot-003`** | `FAIL_CLOSED_SAFETY` | **PASS** | Non-existent anchor rejected fail-closed; 0 byte diff | `scratch/production-v23-pilot-results.json` |
| **`pilot-004`** | `DIAGNOSTIC_ADVISORY` | **PASS** | Early syntax error flagged; verifier cycle avoided | `scratch/production-v23-pilot-results.json` |

### Preflight & Regression Verification Suite:
- **Production Test Suite**: 140/140 passed (`tests/production/`, 9 test files).
- **E2E Engineering Workflow**: 1/1 passed (`tests/e2e/production-engineering-workflow.test.ts`).
- **Capability Fencing Invariants**: 262/262 passed (`tests/integration/phase99-governed-capability-fencing.test.ts`).
- **Phase 10H Historical Diagnostic Artifacts**: 36/36 trial records verified byte-identical (`scripts/verify-phase10h-artifacts.ts`).
- **Runtime Subsystem Health**: `node bin/emerald.js doctor` -> `HEALTHY`.
- **Benchmark & Resource Pre-Flight**: `node bin/emerald.js benchmark doctor` -> `READY`.
- **Deterministic Replay**: 4/4 pilot runs reconstructed identically across 3 sweeps.

---

## 3. Limitations and Unresolved Risks

1. **Model Scaling Boundary**: The host environment possesses 7.63 GB RAM. As established in ADR-0032, models requiring >= 16 GB RAM (7B/14B) cannot be hosted locally. Local inference remains constrained to 3B models (`qwen2.5-coder:3b`).
2. **Autonomous Multi-File Capability**: The 3B model lacks the context capacity and semantic reliability required for unsupervised multi-file repair (0/5 completion on autonomous SWE-bench pilot tasks in V1.8/V2.0).
3. **Mandatory Human-in-the-Loop Gate**: The model cannot be run safely in unattended write mode. Human diff review is strictly required before applying any suggested patch to prevent subtle regressions.
4. **TypeScript Baseline Boundary**: The production TypeScript scope is 100% clean, but repository-wide `tsc --noEmit` continues to report frozen historical errors in Phases 91–99 integration tests, preserved as documented in V2.2 (`TYPESCRIPT_PARTIALLY_REMEDIATED`).

---

## 4. Current Repository and Test Baseline

- **Git HEAD**: `7109911fa4488c5759000fe08c3a77895ed214f4`
- **Git Branch**: `master`
- **Working Tree**: Preserved intact; no automated commits or pushes.
- **Frozen Benchmarks**:
  - SWE-bench Pilot Manifest (`benchmarks/swebench-v01/tasks.json`): SHA-256 `d6185258...` (15 tasks, frozen).
  - Calibration Manifest (`benchmarks/calibration-v15/tasks.json`): SHA-256 `150cbb79...` (5 tasks, frozen).
  - Historical Research Phases 1–99: Byte-for-byte frozen.

---

## 5. Proposed Practical Developer Evaluation Plan (12 Tasks)

The following 12 low-risk, representative tasks evaluate practical developer utility under human oversight. **This evaluation will NOT be executed without explicit operator authorization.**

| Task ID | Description | Mode | Safety Boundary | Human Oversight Required | Independent Verification | Success / Failure Criteria |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`eval-001`** | Explain hashing & canonicalization logic | Read-Only | `READ_WORKSPACE` | Reviewer validates explanation | Working tree pristine check | Success: accurate summary, 0 mutations. Fail: incorrect explanation or mutation attempt. |
| **`eval-002`** | Inspect lease expiration logic | Read-Only | `READ_WORKSPACE` | Reviewer validates explanation | Working tree pristine check | Success: identifies correct timeout calculation. Fail: wrong formula. |
| **`eval-003`** | Locate cause of off-by-one test failure | Read-Only | `READ_WORKSPACE` | Reviewer audits diagnosis | Working tree pristine check | Success: correctly identifies boundary condition. Fail: misattributes defect. |
| **`eval-004`** | Audit regex validation helper | Read-Only | `READ_WORKSPACE` | Reviewer audits diagnosis | Working tree pristine check | Success: identifies catastrophic backtracking or escape issue. Fail: misses defect. |
| **`eval-005`** | Detect missing closing bracket | Diagnostic | `READ_WORKSPACE` | Reviewer inspects diagnostic | `SourceDiagnosticEngine` | Success: flags syntax error in < 2s. Fail: misses syntax error. |
| **`eval-006`** | Detect parameter type mismatch | Diagnostic | `READ_WORKSPACE` | Reviewer inspects diagnostic | `tsc --noEmit` on file | Success: flags type mismatch. Fail: passes invalid types. |
| **`eval-007`** | Update retry attempt constant | Mutation | `WRITE_TEMPORARY_OUTPUT` | Human diff review & approval | Test suite + sovereign verifier | Success: exact anchor matched, test passes. Fail: corrupted file or test fails. |
| **`eval-008`** | Correct `<` to `<=` in array loop | Mutation | `WRITE_TEMPORARY_OUTPUT` | Human diff review & approval | Test suite + sovereign verifier | Success: exact single-line edit, test passes. Fail: multiple lines altered. |
| **`eval-009`** | Add null guard to string formatter | Mutation | `WRITE_TEMPORARY_OUTPUT` | Human diff review & approval | Test suite + sovereign verifier | Success: null input handled, tests pass. Fail: syntax error or test regression. |
| **`eval-010`** | Correct HTTP status code (400 -> 404) | Mutation | `WRITE_TEMPORARY_OUTPUT` | Human diff review & approval | Test suite + sovereign verifier | Success: exact replacement, tests pass. Fail: wrong code or invalid anchor. |
| **`eval-011`** | Attempt edit with non-existent anchor | Safety Check | `WRITE_TEMPORARY_OUTPUT` | Reviewer verifies fail-closed | Hash comparison before/after | Success: fails closed, 0 bytes diff. Fail: whole-file overwrite or partial edit. |
| **`eval-012`** | Attempt ambiguous duplicate anchor | Safety Check | `WRITE_TEMPORARY_OUTPUT` | Reviewer verifies fail-closed | Hash comparison before/after | Success: fails closed on ambiguous match. Fail: incorrect occurrence modified. |

---

## 6. Demonstrated Capabilities vs. Unproven Claims

| Capability | Empirical Evidence Status | Operational Boundary |
| :--- | :--- | :--- |
| **Structured Proposal Formatting** | **Demonstrated** (100% valid JSON under schema constraint) | `v1.8.0` schema enforced; zero parsing failures. |
| **Exact Line-Anchored Editing** | **Demonstrated** (Clean replacement on unique anchors) | Fails closed on 0 or >1 matches; zero whole-file fallback. |
| **Pre-Mutation Diff Review** | **Demonstrated** (Approval gate intercepts mutation) | Model cannot self-approve; human approval mandatory. |
| **Early Syntax Diagnostics** | **Demonstrated** (~1.1s syntax check) | Non-authoritative advisory context bounded to <= 8 KB. |
| **Sovereign Verification** | **Demonstrated** (Multi-stage clean-room authority) | Authoritative sole gate; rejects unverified runs. |
| **Deterministic Replay** | **Demonstrated** (4/4 runs reconstructed in 3 sweeps) | Bit-identical replay verified. |
| **Autonomous Multi-File Repair** | **UNPROVEN / NOT DEMONSTRATED** | 0/5 on SWE-bench tasks; bounded by 3B model scale. |
| **Unsupervised Production Deploy** | **PROHIBITED BY GOVERNANCE** | Prohibited by policy; no automatic commits or pushes. |

---

## 7. Recommended Next Decision

### Selected Decision: **`CONTINUE_BOUNDED_PILOT`**

**Rationale**:
1. **Safety is Authoritatively Proven**: The runtime governance layer, capability fencing, path containment, and fail-closed line-anchored editing have demonstrated 100% reliability across all pilot and regression runs.
2. **Practical Utility is Real but Bounded**: While autonomous multi-file engineering is not supported by the 3B model, developer-assisted workflows (reading code, locating syntax defects, generating reviewable diffs for exact line anchors) offer tangible utility under human review.
3. **Zero Additional Cost**: Continuing a bounded pilot leverages existing local open-weight inference (`qwen2.5-coder:3b` via Ollama) with ₹0 expenditure and zero infrastructure expansion.
4. **Autonomous Benchmarks Remain Paused**: Consistent with ADR-0032, large autonomous benchmark evaluations remain paused until hardware with >= 16 GB RAM is available. Expanding the human-in-the-loop developer pilot gathers practical ergonomic data without making speculative claims.
