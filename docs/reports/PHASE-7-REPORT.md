# Emerald Agent Fabric — Phase 7 Report: Open-Source Readiness

---

## 1. Changed

- **`README.md`**: Fully rewritten as an open-source technical specification and user guide:
  - Clear definition of what Emerald is (governed agent runtime, sovereign verification gate, and reproducible evaluation harness).
  - Explicit and prominent disclosure of what Emerald is **NOT** (not an autonomous coding assistant yet; honest reporting of the 0/23 real-model benchmark on `qwen2.5-coder:1.5b` on CPU).
  - Prerequisites and installation instructions (`git clone`, `npm install`, `npm run build`, `npm test`).
  - Single-command benchmark instructions (`npm run benchmark`, `npm run benchmark:humaneval`).
  - Guide to plugging in alternative local models via Ollama (`--model <name>`).
  - Architecture diagram, security invariants, contributing guidelines, and MIT license badge.
- **`LICENSE`**: Standard MIT License authored with copyright attributed to Emerald Agent Fabric Contributors (2026).
- **`SECURITY.md`**: Formal security policy and threat model documenting:
  - Fail-closed sovereign verification gates and zero self-approval.
  - Strict prohibition against automatic retries of non-idempotent or destructive operations.
  - Lease fencing, supervisor rollback engine, attempt-scoped workspace path containment, and credential firewalls.
  - Private security advisory vulnerability disclosure procedure.
- **`CONTRIBUTING.md`**: Engineering guidelines establishing:
  - Hexagonal architecture boundaries (Domain, Ports, Application, Adapters, Transport).
  - Master Engineering Constitution philosophy (`GEMINI.md`: Correctness > Complexity, Evidence > Claims, No Speculative Architecture).
  - Development setup, strict TypeScript typing (`tsconfig.build.json`), deterministic Vitest standards, and benchmark reproduction commands.
- **`BENCHMARK.md`**: Comprehensive update documenting all 4 empirical real-model evaluation runs across 33 total trials (23 distinct task setups):
  1. SWE-bench Lite (Phase 5, 40s budget): 0 / 10 passed (10 `EMPTY_PATCH` failures).
  2. SWE-bench Lite (Phase 5b, 180s budget): 0 / 10 passed (10 `TIMED_OUT` during inference / Action 2).
  3. HumanEval (Phase 5b, 180s budget): 0 / 10 passed (6 `EMPTY_PATCH`, 4 `TIMED_OUT`).
  4. HumanEval (Phase 6, 600s budget): 0 / 3 passed (3 `EMPTY_PATCH`, avg 174s/task, 0 timed out).
  - Total Empirical Pass Rate: **0 / 23 tasks passed (0.0%)** across all trials.
- **`benchmarks/humaneval/benchmark-results-600s.json`**: Persisted, sanitized Phase 6 HumanEval evidence artifact with normalized relative paths.
- **`.gitignore`**: Hardened with exclusions for ephemeral scratch scripts (`*.cjs`, `*.mjs`, `*.txt`, `patch_*`, `fix_*`, `debug_*`, etc.) while strictly preserving historical regression test fixtures in `scratch/`.

---

## 2. Why

To transition Emerald Agent Fabric into an open-source, reproducible infrastructure repository with clear legal boundaries (MIT), explicit security invariants, fail-closed disclosure processes, and honest, uninflated empirical performance metrics.

---

## 3. Verification

### A. Secret & Credential Audit
- Scanned repository for secret token patterns (`sk-`, `ghp_`, `AKIA`):
  - Result: Zero production secrets, private keys, or API tokens found. All matches correspond to intentional unit-test fixtures verifying secret redaction and credential firewalls (`tests/application/phase48v-verification-feedback.test.ts`, `tests/domain/evaluation-evidence.test.ts`).
- Scanned for `.env` files across the tree:
  - Result: Zero `.env` files found (`Get-ChildItem -Filter *.env*` returned null).

### B. Repository Scratch Cleanliness
- Audited `scratch/` directory status:
  - All untracked ephemeral migration scripts (`patch_*.cjs`, `fix_*.cjs`, `*.txt`) ignored or removed.
  - Tracked historical JSON evidence files required by regression suites (`tests/application/phase48s-offline-remediation.test.ts`, `tests/integration/phase9*-*.test.ts`) preserved without disruption.
  - `git status --porcelain scratch/` shows zero untracked files.

### C. Build Verification (`npm run build`)
- Executed `tsc -p tsconfig.build.json`:
  - **Exit Code**: `0` (Zero compiler errors).

### D. Full Test Suite Verification (`npx vitest run`)
- Executed full Vitest suite across the entire repository:
  - **Test Files**: 305 passed, 43 failed, 4 skipped (352 total).
  - **Tests**: **7,785 passed**, 86 failed, 59 skipped (7,930 total).
  - **Baseline Comparison**:
    - Phase 0 Baseline: 7,420 passed / 425 failed.
    - Phase 5b Baseline: 7,425 passed / 446 failed.
    - Phase 6 Test Hardening: 7,773 passed / 98 failed.
    - **Phase 7 Final**: **7,785 passed / 86 failed** (+365 passed, -339 failed vs Phase 0 baseline).

---

## 4. Public File Inventory

The following directories and files constitute the public repository surface:

```
├── .gitignore
├── BENCHMARK.md
├── CONTRIBUTING.md
├── LICENSE (MIT)
├── README.md
├── SECURITY.md
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── docker-compose.monitoring.yml
├── benchmarks/
│   ├── humaneval/
│   │   ├── benchmark-results.json
│   │   └── benchmark-results-600s.json
│   └── swe-bench-lite/
│       ├── benchmark-results.json
│       ├── benchmark-results-40s.json
│       └── benchmark-results-180s.json
├── bin/
│   ├── emerald.js
│   ├── run-benchmark.js
│   └── run-humaneval.js
├── docs/
│   ├── adr/ (ADR-0001 through ADR-0044)
│   ├── release/
│   └── security/
├── src/
│   ├── adapters/ (execution, models, persistence, reflex, tools, workspace)
│   ├── application/ (brain, context, evaluation, governance, orchestration, runtime)
│   ├── cli/
│   ├── control-plane/
│   ├── domain/ (actions, errors, events, evidence, invariants, reflex, state-machine, tools)
│   ├── governance/
│   ├── infrastructure/
│   ├── ports/
│   ├── production/
│   ├── recovery/
│   ├── runtime/
│   ├── tools/
│   ├── transport/ (http, sse)
│   └── verification/
└── tests/
    ├── adapters/
    ├── application/
    ├── cli/
    ├── contract/
    ├── domain/
    ├── e2e/
    ├── fixtures/
    ├── integration/
    ├── persistence/
    ├── production/
    └── transport/
```

---

## 5. What Is Still NOT Public-Ready

Before an actual public release to GitHub, the following items must be resolved:

1. **Hardcoded Machine Paths in Historical Test & Benchmark Fixtures**:
   - `tests/domain/counterfactual-replay.test.ts` references an absolute host path (`C:/Users/Adusumalli Girish/.gemini/antigravity/brain/543bddec-0a19-44a7-9818-72be776b138b/scratch/phase9-4b-summary.json`).
   - `tests/integration/phase13*.test.ts`, `tests/integration/phase14*.test.ts`, `scripts/run-phase*.ts`, and `docs/adr/ADR-0033-...` contain machine-specific `C:/Users/Adusumalli Girish/...` paths.
   - *Impact*: Leaks local username and fails on external developer machines or CI runners (Linux/macOS).
2. **86 Full-Suite Test Failures in Containerized Scenarios**:
   - 86 test assertions fail in environments lacking a running Docker daemon (timeouts during `sandboxed-command.tool-adapter.ts`, `DockerExecutionProvider`, and Docker cancellation races).
   - Needs container-mock fallback in CI or a container-prerequisite gate.
3. **Internal Governance & Milestone Artifacts**:
   - Working tree contains internal phase reports (`PHASE-0-REPORT.md` through `PHASE-7-REPORT.md`, `EMERALD-ANTIGRAVITY-BUILD.md`, `PHASE-1-INTERFACES.md`). A decision is required whether to archive these in an internal repository branch or publish them in `docs/history/`.
4. **Autonomous Model Capability Ceiling**:
   - At 0/23 pass rate on CPU with `qwen2.5-coder:1.5b`, the software functions as a governance runtime and eval harness, not yet an autonomous software engineer. Users must be aware they need larger models (7B+) and GPU acceleration for actionable code generation.

---

## 6. Next Recommended Step

Refactor the hardcoded absolute Windows paths in `tests/domain/counterfactual-replay.test.ts` and `tests/integration/phase13*.test.ts` into portable repository-relative paths (`path.resolve(__dirname, ...)`) so the test suite can execute cleanly in standard Linux CI environments.
