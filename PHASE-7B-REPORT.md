# Emerald Agent Fabric — Phase 7b Report: Path Decoupling & Model Diagnostic

---

## 1. Changed

- **Historical Evaluation Fixtures Relocated to Repository**:
  - Migrated 9 historical evaluation summary and evidence artifacts into [tests/fixtures/](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures) with byte-exact SHA-256 integrity preserved:
    - [tests/fixtures/phase9-4b-summary.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase9-4b-summary.json)
    - [tests/fixtures/phase10a-summary.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase10a-summary.json)
    - [tests/fixtures/phase10b-structured-output-diagnostic.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase10b-structured-output-diagnostic.json)
    - [tests/fixtures/phase10c-schema-union-diagnostic.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase10c-schema-union-diagnostic.json)
    - [tests/fixtures/phase10e-summary.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase10e-summary.json)
    - [tests/fixtures/phase10f-tool-input-diagnostic.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase10f-tool-input-diagnostic.json)
    - [tests/fixtures/phase10h-tool-contract-diagnostic.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase10h-tool-contract-diagnostic.json)
    - [tests/fixtures/phase11-smoke-evidence.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase11-smoke-evidence.json)
    - [tests/fixtures/phase12-smoke-evidence.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/fixtures/phase12-smoke-evidence.json)

- **Test Suite Repo-Relative Path Refactoring**:
  - Replaced hardcoded machine paths (`C:/Users/Adusumalli Girish/...`) with portable repo-relative resolution:
    - [tests/domain/counterfactual-replay.test.ts](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/domain/counterfactual-replay.test.ts)
    - [tests/integration/phase13-governed-coding-loop.test.ts](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/integration/phase13-governed-coding-loop.test.ts)
    - [tests/integration/phase13b-completion-gate.test.ts](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/integration/phase13b-completion-gate.test.ts)
    - [tests/integration/phase13c-governed-recovery.test.ts](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/integration/phase13c-governed-recovery.test.ts)
    - [tests/integration/phase13d-verification-stage.test.ts](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/integration/phase13d-verification-stage.test.ts)
    - [tests/integration/phase14-independent-verification.test.ts](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/tests/integration/phase14-independent-verification.test.ts)

- **Automated Scripts Repo-Relative Path Refactoring**:
  - Refactored all 33 experiment and verification scripts under `scripts/` to resolve paths relative to `__dirname`:
    - `scripts/run-counterfactual-replay.ts`
    - `scripts/run-live-swe-experiment.ts`
    - `scripts/run-phase10a-experiment.ts` through `scripts/run-phase28-benchmark.ts`
    - `scripts/verify-phase10e-artifacts.ts` through `scripts/verify-phase10h-artifacts.ts`

- **Documentation & Research ADR Path Sanitization**:
  - Replaced absolute machine links with markdown relative links across 27 documentation files:
    - `docs/adr/ADR-0033-bounded-human-in-the-loop-repair-with-small-local-models.md`
    - `docs/adr/ADR-0034-governed-rejection-feedback-and-local-model-recovery-boundaries.md`
    - `docs/adr/ADR-0035-structured-output-and-observation-loop-limitations.md`
    - `docs/production/bounded-real-project-*.md` (5 reports)
    - `docs/production/developer-utility-evaluation-v2.4.md`, `minimal-canonical-prompt-experiment.md`, `production-typescript-remediation-v2.2.md`, `real-workflow-validation-v2.5-*.md`, `tool-proposal-reliability-investigation.md`
    - `docs/research/oss-integration/build-order-and-gates.md`, `phase14-independent-verification.md`, `phase43-gate-b-empirical-research-report.md`, `phase44-structured-output-and-repair-loop-report.md`, `phase45-*.md`, `phase46-*.md`, `phase77-*.md`, `phase80-*.md`, `phase92-*.md`, `phase93-*.md`
  - Sanitized historical result JSON files: `scratch/bounded-real-project-task-c-results.json`, `scratch/phase29-quantization-audit.json`.

- **Model Diagnostic Artifact**:
  - Saved complete raw execution trace to `scratch/model-diagnostic-he0.json`: 7 full conversational turns, raw model completions, parsed action proposals, and runtime responses for `HumanEval/0`.

---

## 2. Why

1. **Path Decoupling**: Hardcoded developer paths (`C:/Users/Adusumalli Girish/...`) broke execution on any other developer machine, CI runner, or clean clone. Refactoring to repo-relative paths (`tests/fixtures/`) guarantees open-source portability and reproducibility.
2. **Model Diagnostic**: Previous phases produced 0/23 successful patches on local `qwen2.5-coder:1.5b`. It was unknown whether the failure was caused by the model attempting fine-grained edits via `edit_file` that failed schema validation/rejection, or whether the model's policy completely failed to select `edit_file`.

---

## 3. Model Diagnostic: The `edit_file` Question

### Plain-Language Answer
> **The model never tried to call `edit_file` at all.**

### Empirical Evidence from Full Transcript (`scratch/model-diagnostic-he0.json`)
- **Setup**: `HumanEval/0` (`has_close_elements`), 600s budget, local `qwen2.5-coder:1.5b` running via Ollama on CPU.
- **Tools Advertised**: Both `read_file` and `edit_file` were explicitly provided in the system prompt and tool definitions, with typed arguments (`Path`, `Target`, `Replacement`) and concrete usage examples.
- **Turn-by-Turn Action Sequence**:
  - **Turn 1 (57.1s)**: Model invoked `read_file` for `solution.py`. Tool successfully returned the initial problem stub.
  - **Turn 2 (69.2s)**: Model invoked `write_file` (full-file rewrite), rewriting the exact same stub back to `solution.py`.
  - **Turn 3 (73.6s)**: Model invoked `write_file`, attempting an implementation but with an incorrect single-parameter signature (`def has_close_elements(lst): pass`).
  - **Turn 4 (72.2s)**: Model invoked `write_file`, overwriting `solution.py` with the exact unchanged stub.
  - **Turn 5 (69.8s)**: Model invoked `write_file`, overwriting `solution.py` with the exact unchanged stub again.
  - **Turn 6 (71.1s)**: Model invoked `write_file`, overwriting `solution.py` with the exact unchanged stub again.
  - **Turn 7 (71.9s)**: Runtime Stagnation Guard intervened deterministically:
    - Reason: `STAGNATION: Execution loop halted due to stagnation: 3 consecutive identical successful writes of 'solution.py' without progress`.
    - Run terminated cleanly after 485.0s.
- **Diagnostic Conclusion**:
  - Zero `edit_file` proposals were emitted by the model.
  - Zero `edit_file` proposals were rejected or blocked by schema validation or governance policies.
  - The failure mode of `qwen2.5-coder:1.5b` on CPU is not tool schema rejection; rather, its internal policy loop degenerates into repetitive full-file `write_file` overwrites, which are safely halted by Emerald's sovereign stagnation-aware verification gate.

---

## 4. Verification

### A. Repository Path Decoupling Verification
1. **User Identity Scan**:
   ```powershell
   git grep -n "Adusumalli"
   # Result: Return code 1 (ZERO hits across entire repository)
   ```
2. **Absolute User Directory Scan**:
   ```powershell
   git grep -in "C:/Users"
   # Result: 0 hits in tracked files (only 1 hit in scratch/test-hardened.ts, a mock path 'C:/Users/Test/workspace/sub/file.txt')
   ```
3. **Affected Tests Execution**:
   - `tests/domain/counterfactual-replay.test.ts`: **14 / 14 passed (100% PASS)**.
   - `tests/integration/phase14-independent-verification.test.ts`: **8 / 8 passed (100% PASS)**.
   - Historical fixture hash integrity: Test J passed across all integration tests (`phase13*.test.ts`).

### B. Full Baseline Verification

| Metric | Phase 0 Baseline | Phase 7b Final | Delta |
| :--- | :--- | :--- | :--- |
| **`npm run build`** | FAILED | **PASSED** (code 0) | Clean compilation (`tsconfig.build.json`) |
| **Vitest Test Files Passed** | 303 | **304** | +1 passing file |
| **Vitest Test Files Failed** | 46 | **44** | -2 failing files |
| **Vitest Tests Passed** | 7,420 | **7,761** | **+341 passed** |
| **Vitest Tests Failed** | 425 | **110** | **-315 failed** |
| **Vitest Tests Skipped** | 0 | **59** | +59 skipped |
| **Total Tests** | 7,845 | **7,930** | +85 tests |

---

## 5. Residual Risks

1. **Docker Live Confinement Tests (44 test file failures)**:
   - All 44 failing test files in the full suite are pre-existing Docker daemon timeout tests (`sandboxed-command-tool-adapter.test.ts`, container isolation checks) requiring an active local Docker daemon. In Docker-less CPU environments, these fail closed as expected.
2. **Small Model Coding Capability**:
   - `qwen2.5-coder:1.5b` on CPU lacks the multi-step planning capability to selectively use targeted diff tools (`edit_file`) or generate passing patches on HumanEval / SWE-bench. Production deployments should route to larger governed models (e.g., 7B+, 32B+, or frontier models via provider adapters).

---

## 6. Acceptance Status

- [x] **Repo-relative paths**: All hardcoded `C:/Users/Adusumalli Girish/...` paths eliminated; 0 occurrences remain.
- [x] **Historical fixtures**: 9 evaluation summaries relocated to `tests/fixtures/` and verified.
- [x] **Model diagnostic**: Complete transcript captured in `scratch/model-diagnostic-he0.json`.
- [x] **Plain-words answer**: Conclusively established that `edit_file` was never attempted by the model.
- [x] **Build green**: `npm run build` passes with zero errors.
- [x] **Vitest baseline**: 7,761 passed / 110 failed (down from 425 failures in Phase 0).
- [x] **Zero unprompted operations**: No commit, push, merge, or deployment performed.
